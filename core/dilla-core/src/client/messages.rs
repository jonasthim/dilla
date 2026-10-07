//! Prepared sends, delivery confirmation, outbox and timeline reads.

use super::error::{E_CORE_INPUT, E_CORE_MLS, E_CORE_NOT_FOUND, E_CORE_STATE, E_CORE_STORAGE};
use super::fold::{self, FoldTrigger};
use super::groups::{STATE_ACTIVE, STATE_GONE, checked, group_row};
use super::{ClientCore, ClientError, Own, wire};
use crate::cbor::Encoder;
use crate::envelope::{Envelope, EnvelopeType};
use crate::ids::MsgId;
use crate::mls::StorageError;
use openmls_traits::OpenMlsProvider;
use openmls_traits::random::OpenMlsRand;
use rusqlite::{OptionalExtension, params};

pub(crate) const OUTBOX_QUEUED: i64 = 0;
pub(crate) const OUTBOX_IN_FLIGHT: i64 = 1;
pub(crate) const OUTBOX_FAILED: i64 = 2;
pub(crate) const STATUS_OK: i64 = 0;
pub(crate) const STATUS_CANNOT_DECRYPT: i64 = 1;
pub(crate) const STATUS_DELETED: i64 = 2;
pub(crate) const REASON_PRUNED: &str = "E_PRUNED";
pub(crate) const REASON_OWN_UNKNOWN: &str = "E_OWN_UNKNOWN";
pub(crate) const REASON_SENDER_MISMATCH: &str = "E_SENDER_MISMATCH";

pub(super) const TIMELINE_SQL: &str = "SELECT m.seq,m.epoch,m.recv_ts,m.status,m.reason,m.sender_user,m.sender_device, \
     m.sender_kind,m.sender_tier,m.msg_id,m.type,m.body,m.edit_body,m.edit_seq,m.reply_to,m.envelope,m.mention, \
     NOT EXISTS (SELECT 1 FROM app_messages e INDEXED BY app_messages_by_msg WHERE e.group_id=m.group_id AND e.msg_id=m.msg_id \
     AND e.type=0 AND e.status IN (0,2) AND e.seq<m.seq) \
     AND NOT EXISTS (SELECT 1 FROM app_messages r INDEXED BY app_messages_by_pin WHERE r.group_id=m.group_id \
     AND r.reply_to=m.msg_id AND r.type IN (0,1,2,3,4,5,6) AND r.seq<m.seq) \
     FROM app_messages m WHERE m.group_id=?1 AND (m.type IS NULL OR m.type=0) \
     AND (?2=0 OR m.seq<?2) ORDER BY m.seq DESC LIMIT ?3";

pub(super) struct StoredMessage<'a> {
    pub group_id: &'a [u8; 16],
    pub seq: u64,
    pub epoch: u64,
    pub recv_ts: u64,
    pub status: i64,
    pub reason: &'a str,
    pub sender_user: Option<&'a [u8; 16]>,
    pub sender_device: &'a [u8; 16],
    pub sender_leaf: Option<u32>,
    pub sender_kind: Option<u8>,
    pub sender_tier: Option<u8>,
    pub msg_id: Option<&'a [u8; 16]>,
    pub ty: Option<u8>,
    pub reply_to: Option<&'a [u8; 16]>,
    pub body: &'a str,
    pub envelope: Option<&'a [u8]>,
    pub franking_tag: &'a [u8; 32],
    pub mention: bool,
}
pub(super) fn insert_message(
    c: &rusqlite::Connection,
    m: &StoredMessage<'_>,
) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_messages \
         (group_id,seq,epoch,recv_ts,status,reason,sender_user,sender_device, \
          sender_leaf,sender_kind,sender_tier,msg_id,type,body,envelope,franking_tag,mention,reply_to) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        params![
            m.group_id.as_slice(),
            m.seq as i64,
            m.epoch as i64,
            m.recv_ts as i64,
            m.status,
            m.reason,
            m.sender_user.map(|v| v.as_slice()),
            m.sender_device.as_slice(),
            m.sender_leaf,
            m.sender_kind,
            m.sender_tier,
            m.msg_id.map(|v| v.as_slice()),
            m.ty,
            m.body,
            m.envelope,
            m.franking_tag.as_slice(),
            i64::from(m.mention),
            m.reply_to.map(|v| v.as_slice()),
        ],
    )?;
    Ok(())
}

pub(super) fn refold_insert(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    seq: u64,
    env: &Envelope,
    sender_user: &[u8; 16],
    sender_device: &[u8; 16],
    own: Option<&Own>,
) -> Result<(), StorageError> {
    let ty = env.kind.as_u8();
    let target = fold::target_of(
        Some(i64::from(ty)),
        Some(*env.msg_id.as_bytes()),
        env.reply_to.as_ref().map(|m| *m.as_bytes()),
    );
    if let Some(target) = target {
        fold::refold(
            c,
            group_id,
            &target,
            &fold::scope_of(Some(i64::from(ty)), Some(*sender_user), &env.body),
            Some(&FoldTrigger {
                seq,
                ty,
                sender_user: *sender_user,
                sender_device: *sender_device,
            }),
            own,
        )?;
    }
    Ok(())
}
#[allow(dead_code)] // The creation time is part of the persisted row for later sync operations.
pub(super) struct OutboxRow {
    pub group_id: [u8; 16],
    pub envelope: Vec<u8>,
    pub created: i64,
    pub state: i64,
    pub epoch: i64,
}
pub(super) fn outbox_row(
    c: &rusqlite::Connection,
    id: &[u8; 16],
) -> Result<Option<OutboxRow>, StorageError> {
    c.query_row(
        "SELECT group_id,envelope,created,state,epoch FROM app_outbox WHERE msg_id=?1",
        [id.as_slice()],
        |r| {
            Ok(OutboxRow {
                group_id: r.get(0)?,
                envelope: r.get(1)?,
                created: r.get(2)?,
                state: r.get(3)?,
                epoch: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}
fn not_found() -> ClientError {
    ClientError::new(E_CORE_NOT_FOUND, "")
}

fn no_attachment() -> ClientError {
    ClientError::new(E_CORE_NOT_FOUND, "no such attachment")
}

impl ClientCore {
    /// `read` behind one non-generic instance: each reader of web-2b adds its closure body and not
    /// another copy of the storage unit (wasm size, the task 3 budget).
    #[inline(never)]
    fn read_dyn(
        &self,
        f: &mut dyn FnMut(&rusqlite::Connection) -> Result<(), StorageError>,
    ) -> Result<(), ClientError> {
        self.read(f)
    }

    /// `write` for a statement-only unit behind one non-generic instance (wasm size).
    #[inline(never)]
    fn write_dyn(
        &mut self,
        f: &mut dyn FnMut(&rusqlite::Connection) -> Result<(), StorageError>,
    ) -> Result<(), ClientError> {
        self.write(|_, u| u.with_conn(f).map_err(Into::into))
    }

    /// `read_dyn` for a closure that produces a value.
    fn read_one<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
    ) -> Result<T, ClientError> {
        let mut f = Some(f);
        let mut out = None;
        self.read_dyn(&mut |c| {
            if let Some(f) = f.take() {
                out = Some(f(c)?);
            }
            Ok(())
        })?;
        out.ok_or_else(|| ClientError::new(E_CORE_STORAGE, "the read produced no value"))
    }

    /// Advance this device's read marker, clamped to the group's current head.
    pub fn mark_read(&mut self, id: &[u8; 16], seq: u64, now: u64) -> Result<(), ClientError> {
        self.own()?;
        let now = checked("now", now)?;
        let row = self.read(|c| group_row(c, id))?.ok_or_else(not_found)?;
        if row.state == STATE_GONE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", row.state),
            ));
        }
        let target = seq.min((row.next_seq - 1) as u64);
        let target = checked("seq", target)?;
        self.write(|_, u| {
            u.with_conn(|c| {
                c.execute(
                    "INSERT INTO app_read_state (group_id, last_read_seq, last_read_at) VALUES (?1, ?2, ?3) \
                     ON CONFLICT (group_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq), \
                     last_read_at = excluded.last_read_at",
                    params![id.as_slice(), target, now],
                )?;
                Ok(())
            })?;
            Ok(())
        })
    }

    /// Per-group unread and mention counts for joined or resyncing groups.
    pub fn activity(&self) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        type ActivityRow = ([u8; 16], i64, i64, i64, i64, i64);
        let rows: Vec<ActivityRow> = self.read(|c| {
            let mut stmt = c.prepare(
                "SELECT g.group_id, \
                 (SELECT COUNT(*) FROM app_messages m WHERE m.group_id = g.group_id AND m.status = 0 AND m.type = 0 \
                    AND m.sender_user <> ?1 AND m.seq > COALESCE(r.last_read_seq, 0)), \
                 (SELECT COUNT(*) FROM app_messages m WHERE m.group_id = g.group_id AND m.status = 0 AND m.type = 0 \
                    AND m.sender_user <> ?1 AND m.seq > COALESCE(r.last_read_seq, 0) AND m.mention = 1), \
                 COALESCE((SELECT m.seq FROM app_messages m WHERE m.group_id = g.group_id AND m.status = 0 AND m.type = 0 \
                    AND m.sender_user <> ?1 AND m.seq > COALESCE(r.last_read_seq, 0) ORDER BY m.seq DESC LIMIT 1), 0), \
                 COALESCE((SELECT m.recv_ts FROM app_messages m WHERE m.group_id = g.group_id AND m.status = 0 AND m.type = 0 \
                    AND m.sender_user <> ?1 AND m.seq > COALESCE(r.last_read_seq, 0) ORDER BY m.seq DESC LIMIT 1), 0), \
                 COALESCE(r.last_read_seq, 0) \
                 FROM app_groups g LEFT JOIN app_read_state r ON r.group_id = g.group_id \
                 WHERE g.state IN (2, 3) ORDER BY g.group_id",
            )?;
            stmt.query_map([own.user_id.as_slice()], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for (id, unread, mentions, last_seq, last_ts, last_read_seq) in rows {
            e.array(6)
                .bytes(&id)
                .uint(unread as u64)
                .uint(mentions as u64)
                .uint(last_seq as u64)
                .uint(last_ts as u64)
                .uint(last_read_seq as u64);
        }
        Ok(e.into_vec())
    }
}
fn outbox_state(s: i64) -> ClientError {
    ClientError::new(E_CORE_STATE, format!("outbox row in state {s}"))
}
#[allow(clippy::too_many_arguments)] // The persisted row draws fields from all three inputs.
fn own_message<'a>(
    own: &'a Own,
    g: &'a [u8; 16],
    seq: u64,
    epoch: u64,
    recv_ts: u64,
    tag: &'a [u8; 32],
    env: &'a Envelope,
    bytes: &'a [u8],
    leaf: Option<u32>,
) -> StoredMessage<'a> {
    StoredMessage {
        group_id: g,
        seq,
        epoch,
        recv_ts,
        status: STATUS_OK,
        reason: "",
        sender_user: Some(&own.user_id),
        sender_device: &own.device_id,
        sender_leaf: leaf,
        sender_kind: Some(own.kind),
        sender_tier: Some(own.tier),
        msg_id: Some(env.msg_id.as_bytes()),
        ty: Some(env.kind.as_u8()),
        reply_to: env.reply_to.as_ref().map(MsgId::as_bytes),
        body: &env.body,
        envelope: Some(bytes),
        franking_tag: tag,
        mention: false,
    }
}

/// true when `body` contains "<@" + the 32 lower-case hex characters of `user_id` + ">", or "<@everyone>",
/// or "<@here>" — the readable mention syntax of protocol/09 (`<@(everyone|here|[0-9a-f]{32})>`), matched
/// literally (no regex, no case folding; upper-case hex does not match).
///
/// It refuses nothing: a member who types `<@everyone>` raises a count, which is the readable
/// syntax's meaning (Q09, Q20).
pub fn mentions_me(body: &str, user_id: &[u8; 16]) -> bool {
    // A byte search: every needle is ASCII, so a byte match is a match of the same characters.
    // (`str::contains` would add its two-way searcher to the browser build.)
    let has = |n: &[u8]| body.as_bytes().windows(n.len()).any(|w| w == n);
    has(&mention_needle(user_id)) || has(b"<@everyone>") || has(b"<@here>")
}

/// Matches the own user's and known role mentions using the literal lower-case token syntax.
pub fn mentions_me_with_roles(body: &str, user_id: &[u8; 16], roles: &[[u8; 16]]) -> bool {
    mentions_me(body, user_id)
        || roles.iter().any(|role| {
            let needle = mention_needle(role);
            body.as_bytes().windows(needle.len()).any(|w| w == needle)
        })
}

/// `mentions_me`'s needle for one user: "<@" + the 32 lower-case hex characters + ">".
pub(super) fn mention_needle(user_id: &[u8; 16]) -> [u8; 35] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut needle = *b"<@0123456789abcdef0123456789abcdef>";
    for (i, b) in user_id.iter().enumerate() {
        needle[2 + 2 * i] = HEX[usize::from(b >> 4)];
        needle[3 + 2 * i] = HEX[usize::from(b & 0x0f)];
    }
    needle
}

impl ClientCore {
    /// `request` = [type uint 0..=6, reply_to b16|null, body tstr,
    ///              attachments [[blob_id b32, key b32, nonce b12, size uint, mime tstr, w uint|null, h uint|null, thumb bstr|null, name tstr]]]
    /// (the L-CORE-30 attachment element, in order). Returns [msg_id b16] as before. Phase 2; the group must be in state 2.
    /// Every refusal writes nothing (L-CORE-36).
    pub fn send_prepare(
        &mut self,
        id: &[u8; 16],
        request: &[u8],
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        let now = checked("now", now)?;
        let t = wire::decode_send_request(request)?;
        if t.ty > 6 {
            return Err(ClientError::new(E_CORE_INPUT, "type is out of range"));
        }
        if t.ty != 0 && !t.attachments.is_empty() {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "only a message carries attachments",
            ));
        }
        // One read: the group row, then the target (the ledger's resolution, `fold::resolve`).
        let (row, target) = self.read_one(|c| {
            let row = group_row(c, id)?;
            let target = match (&row, t.reply_to) {
                (Some(_), Some(reply_to)) => fold::resolve(c, id, &reply_to)?,
                _ => None,
            };
            Ok((row, target))
        })?;
        let row = row.ok_or_else(not_found)?;
        if row.state != STATE_ACTIVE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", row.state),
            ));
        }
        let input = |detail: &'static str| Err(ClientError::new(E_CORE_INPUT, detail));
        let unheld = || ClientError::new(E_CORE_NOT_FOUND, "target is not held");
        if t.ty == 0 {
            if t.body.trim().is_empty() && t.attachments.is_empty() {
                return input("body is empty");
            }
            if t.reply_to.is_some() && target.is_none() {
                return Err(unheld());
            }
        } else {
            if t.reply_to.is_none() {
                return input("reply_to is required");
            }
            let target = target.ok_or_else(unheld)?;
            if target.status != STATUS_OK {
                return Err(ClientError::new(E_CORE_STATE, "the target is deleted"));
            }
            if t.ty <= 2 && target.sender_user != Some(own.user_id) {
                return input("only the author may edit or delete");
            }
            match t.ty {
                1 if t.body.trim().is_empty() => return input("body is empty"),
                3 | 4 if t.body.is_empty() || t.body.len() > 32 => {
                    return input("emoji must be 1..=32 bytes");
                }
                2 | 5 | 6 if !t.body.is_empty() => return input("body must be empty"),
                _ => {}
            }
        }
        let msg_id = self
            .provider
            .rand()
            .random_array::<16>()
            .map_err(|_| ClientError::new(E_CORE_MLS, "random failed"))?;
        let k_f = self
            .provider
            .rand()
            .random_array::<32>()
            .map_err(|_| ClientError::new(E_CORE_MLS, "random failed"))?;
        let env = Envelope {
            v: 1,
            msg_id: MsgId::from_bytes(msg_id),
            kind: EnvelopeType::from_u64(t.ty)?,
            thread_id: None,
            reply_to: t.reply_to.map(MsgId::from_bytes),
            body: t.body,
            attachments: t.attachments,
            previews: vec![],
            k_f,
        };
        env.validate()?;
        let bytes = env.encode()?;
        self.write(|_, u| {
            u.with_conn(|c| {
                c.execute(
                    "INSERT INTO app_outbox(msg_id,group_id,envelope,created,state) \
                     VALUES(?1,?2,?3,?4,0)",
                    params![msg_id.as_slice(), id.as_slice(), bytes, now],
                )?;
                Ok(())
            })?;
            Ok(())
        })?;
        let mut e = Encoder::new();
        e.array(1).bytes(&msg_id);
        Ok(e.into_vec())
    }

    pub fn send_encrypt(&mut self, msg_id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let o = self
            .read(|c| outbox_row(c, msg_id))?
            .ok_or_else(not_found)?;
        if o.state != OUTBOX_QUEUED {
            return Err(outbox_state(o.state));
        }
        let id = o.group_id;
        let r = self.read(|c| group_row(c, &id))?.ok_or_else(not_found)?;
        if r.state != STATE_ACTIVE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", r.state),
            ));
        }
        let (in_flight, proposals): (i64, i64) = self.read(|c| {
            Ok((
                c.query_row(
                    "SELECT COUNT(*) FROM app_outbox WHERE group_id=?1 AND state=1",
                    [id.as_slice()],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT COUNT(*) FROM app_proposals WHERE group_id=?1",
                    [id.as_slice()],
                    |r| r.get(0),
                )?,
            ))
        })?;
        if in_flight > 0 {
            return Err(ClientError::new(
                E_CORE_STATE,
                "a message of this group is in flight",
            ));
        }
        if proposals > 0 {
            return Err(ClientError::new(E_CORE_STATE, "proposals are pending"));
        }
        self.retry_reload(&id, |this| {
            let mut group = this.take_group(&id)?.ok_or_else(not_found)?;
            if group.has_pending_commit() {
                this.keep_group(id, group);
                return Err(ClientError::new(E_CORE_STATE, "a commit is pending"));
            }
            let env = Envelope::decode(&o.envelope)
                .map_err(|_| ClientError::new(E_CORE_STORAGE, "outbox envelope does not decode"))?;
            let result = this.write(|ctx, u| {
                let epoch = group.epoch();
                let message = group.create_message(
                    ctx.provider,
                    ctx.signer
                        .ok_or_else(|| ClientError::new(super::error::E_CORE_NO_IDENTITY, ""))?,
                    &env,
                )?;
                u.with_conn(|c| {
                    c.execute(
                        "UPDATE app_outbox SET state=1,epoch=?2 WHERE msg_id=?1",
                        params![msg_id.as_slice(), epoch as i64],
                    )?;
                    Ok(())
                })?;
                let mut body = Encoder::new();
                body.array(2).uint(epoch).bytes(&wire::tls(&message)?);
                Ok(body.into_vec())
            });
            if result.is_ok() {
                this.keep_group(id, group);
            }
            let body = result?;
            let mut e = Encoder::new();
            e.array(2).bytes(&id).bytes(&body);
            Ok(e.into_vec())
        })
    }

    pub fn send_confirm(
        &mut self,
        msg_id: &[u8; 16],
        response: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        let response = wire::decode_send_response(response)?;
        checked("seq", response.seq)?;
        checked("recv_ts", response.recv_ts)?;
        let o = self.read(|c| outbox_row(c, msg_id))?;
        let (id, seq) = if let Some(o) = o {
            if o.state != OUTBOX_IN_FLIGHT {
                return Err(outbox_state(o.state));
            }
            let id = o.group_id;
            let occupant: Option<(i64, Vec<u8>, Option<Vec<u8>>)> = self.read(|c| {
                c.query_row(
                    "SELECT status,sender_device,msg_id FROM app_messages \
                     WHERE group_id=?1 AND seq=?2",
                    params![id.as_slice(), response.seq as i64],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(Into::into)
            })?;
            if let Some((status, device, stored_msg)) = occupant {
                // The deleted marker of this device's upload at that seq (the echo of the deletion
                // came first): the server stored the message, so the row is done, never resent.
                let own_deleted = status == STATUS_DELETED
                    && device == own.device_id
                    && stored_msg.as_deref().is_none_or(|m| m == msg_id);
                self.write(|_, u| {
                    u.with_conn(|c| {
                        if own_deleted {
                            c.execute(
                                "UPDATE app_messages SET msg_id=?3 \
                                 WHERE group_id=?1 AND seq=?2 AND msg_id IS NULL",
                                params![id.as_slice(), response.seq as i64, msg_id.as_slice()],
                            )?;
                            c.execute(
                                "DELETE FROM app_outbox WHERE msg_id=?1",
                                [msg_id.as_slice()],
                            )?;
                        } else {
                            // Another row holds the seq the server names for this upload: the
                            // answer contradicts what is stored. The row leaves flight as failed,
                            // so the group sends on and nothing is resent without the person.
                            c.execute(
                                "UPDATE app_outbox SET state=2,error=?2 WHERE msg_id=?1",
                                params![msg_id.as_slice(), E_CORE_STATE],
                            )?;
                        }
                        Ok(())
                    })?;
                    Ok(())
                })?;
                if !own_deleted {
                    return Err(ClientError::new(E_CORE_STATE, "message seq exists"));
                }
                let mut e = Encoder::new();
                e.array(2).bytes(&id).uint(response.seq);
                return Ok(e.into_vec());
            }
            // A stored group that does not match its row has no leaf of this row: NULL, as when
            // no MLS group is stored.
            let mut group = match self.take_group(&id) {
                Err(e) if e.code == E_CORE_STATE => None,
                other => other?,
            };
            let leaf = group.as_ref().map(|g| g.own_leaf_index().u32());
            let env = Envelope::decode(&o.envelope)
                .map_err(|_| ClientError::new(E_CORE_STORAGE, "outbox envelope does not decode"))?;
            let result = self.write(|_, u| {
                u.with_conn(|c| {
                    insert_message(
                        c,
                        &own_message(
                            &own,
                            &id,
                            response.seq,
                            o.epoch as u64,
                            response.recv_ts,
                            &response.franking_tag,
                            &env,
                            &o.envelope,
                            leaf,
                        ),
                    )?;
                    refold_insert(
                        c,
                        &id,
                        response.seq,
                        &env,
                        &own.user_id,
                        &own.device_id,
                        Some(&own),
                    )?;
                    c.execute(
                        "DELETE FROM app_outbox WHERE msg_id=?1",
                        [msg_id.as_slice()],
                    )?;
                    Ok(())
                })?;
                Ok(())
            });
            if result.is_ok()
                && let Some(g) = group.take()
            {
                self.keep_group(id, g);
            }
            result?;
            (id, response.seq)
        } else {
            self.read(|c| {
                c.query_row(
                    "SELECT group_id,seq FROM app_messages \
                     WHERE msg_id=?1 AND sender_device=?2 ORDER BY seq DESC LIMIT 1",
                    params![msg_id.as_slice(), own.device_id.as_slice()],
                    |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64)),
                )
                .optional()
                .map_err(Into::into)
            })?
            .ok_or_else(not_found)?
        };
        let mut e = Encoder::new();
        e.array(2).bytes(&id).uint(seq);
        Ok(e.into_vec())
    }

    fn outbox_transition(
        &mut self,
        id: &[u8; 16],
        from: &[i64],
        to: Option<(i64, &str)>,
    ) -> Result<(), ClientError> {
        self.own()?;
        let row = self.read(|c| outbox_row(c, id))?.ok_or_else(not_found)?;
        if !from.contains(&row.state) {
            return Err(outbox_state(row.state));
        }
        self.write(|_, u| {
            u.with_conn(|c| {
                if let Some((state, error)) = to {
                    c.execute(
                        "UPDATE app_outbox SET state=?2,error=?3 WHERE msg_id=?1",
                        params![id.as_slice(), state, error],
                    )?;
                } else {
                    c.execute("DELETE FROM app_outbox WHERE msg_id=?1", [id.as_slice()])?;
                }
                Ok(())
            })?;
            Ok(())
        })
    }
    pub fn send_requeue(&mut self, id: &[u8; 16]) -> Result<(), ClientError> {
        self.outbox_transition(id, &[OUTBOX_IN_FLIGHT], Some((OUTBOX_QUEUED, "")))
    }
    pub fn send_fail(&mut self, id: &[u8; 16], error: &str) -> Result<(), ClientError> {
        self.own()?;
        if error.len() > 64 {
            return Err(ClientError::new(E_CORE_INPUT, "error exceeds 64 bytes"));
        }
        self.outbox_transition(
            id,
            &[OUTBOX_QUEUED, OUTBOX_IN_FLIGHT],
            Some((OUTBOX_FAILED, error)),
        )
    }
    pub fn send_retry(&mut self, id: &[u8; 16]) -> Result<(), ClientError> {
        self.outbox_transition(id, &[OUTBOX_FAILED], Some((OUTBOX_QUEUED, "")))
    }
    pub fn send_discard(&mut self, id: &[u8; 16]) -> Result<(), ClientError> {
        self.outbox_transition(id, &[OUTBOX_QUEUED, OUTBOX_FAILED], None)
    }

    /// [[msg_id b16, state uint, error tstr, created uint, body tstr, type uint, reply_to b16|null,
    /// attachments [[blob_id b32, size uint, mime tstr, name tstr]]]] (L-CORE-37): no key, nonce or
    /// thumbnail leaves the outbox.
    pub fn outbox(&self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        type ListedOutbox = ([u8; 16], i64, String, i64, Vec<u8>);
        let rows: Vec<ListedOutbox> = self
            .read_one(|c| {
                if group_row(c, id)?.is_none() {
                    return Ok(None);
                }
                let mut s = c.prepare(
                    "SELECT msg_id,state,error,created,envelope FROM app_outbox \
                     WHERE group_id=?1 ORDER BY created,msg_id",
                )?;
                let it = s.query_map([id.as_slice()], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?;
                it.collect::<Result<_, _>>().map(Some).map_err(Into::into)
            })?
            .ok_or_else(not_found)?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for (msg, state, error, created, env) in rows {
            let env = Envelope::decode(&env)
                .map_err(|_| ClientError::new(E_CORE_STORAGE, "outbox envelope does not decode"))?;
            e.array(8)
                .bytes(&msg)
                .uint(state as u64)
                .text(&error)
                .uint(created as u64)
                .text(&env.body)
                .uint(u64::from(env.kind.as_u8()))
                .opt_bytes(env.reply_to.as_ref().map(|m| &m.0[..]))
                .array(env.attachments.len());
            for a in &env.attachments {
                e.array(4)
                    .bytes(&a.blob_id)
                    .uint(a.size)
                    .text(&a.mime)
                    .text(&a.name);
            }
        }
        Ok(e.into_vec())
    }
    /// Phase 2. The attachment element (L-CORE-30, nine elements, key and nonce included) at
    /// `index` of the envelope of the status-0 type-0 row at (group_id, seq). E_CORE_NOT_FOUND
    /// "no such attachment" for any other row or an index past the list (L-CORE-38).
    pub fn attachment_get(
        &self,
        group_id: &[u8; 16],
        seq: u64,
        index: u32,
    ) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let seq = checked("seq", seq)?;
        let bytes: Option<Option<Vec<u8>>> = self.read_one(|c| {
            c.query_row(
                "SELECT envelope FROM app_messages \
                 WHERE group_id = ?1 AND seq = ?2 AND status = 0 AND type = 0",
                params![group_id.as_slice(), seq],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
        })?;
        let env = Envelope::decode(&bytes.flatten().ok_or_else(no_attachment)?).map_err(|_| {
            ClientError::new(E_CORE_STORAGE, "app_messages envelope does not decode")
        })?;
        let a = env
            .attachments
            .get(index as usize)
            .ok_or_else(no_attachment)?;
        Ok(wire::encode_attachment(a))
    }

    /// Phase 2. [[group_id b16, seq uint, channel_id b16, blob_ids [b32]]] ordered by group_id,
    /// seq (L-CORE-38).
    pub fn purges(&self) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        type RawPurge = (Vec<u8>, i64, Vec<u8>, Vec<u8>);
        let rows: Vec<RawPurge> = self.read_one(|c| {
            let mut s = c.prepare(
                "SELECT group_id, seq, channel_id, blob_ids FROM app_purges ORDER BY group_id, seq",
            )?;
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()
                .map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for (group_id, seq, channel_id, blob_ids) in rows {
            let ids = wire::decode_blob_ids(&blob_ids)?;
            e.array(4)
                .bytes(&group_id)
                .uint(seq as u64)
                .bytes(&channel_id)
                .array(ids.len());
            for id in ids {
                e.bytes(&id);
            }
        }
        Ok(e.into_vec())
    }

    /// Phase 2. Deletes the app_purges row in one unit; no error when it is absent (L-CORE-38).
    pub fn purge_done(&mut self, group_id: &[u8; 16], seq: u64) -> Result<(), ClientError> {
        self.own()?;
        let seq = checked("seq", seq)?;
        self.write_dyn(&mut |c| {
            c.execute(
                "DELETE FROM app_purges WHERE group_id = ?1 AND seq = ?2",
                params![group_id.as_slice(), seq],
            )?;
            Ok(())
        })
    }
    pub fn timeline(
        &self,
        id: &[u8; 16],
        before_seq: u64,
        limit: u32,
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        if !(1..=200).contains(&limit) {
            return Err(ClientError::new(E_CORE_INPUT, "limit out of range"));
        }
        // A value above SQLite's signed range is later than every stored sequence.
        let before = if before_seq > i64::MAX as u64 {
            0
        } else {
            before_seq as i64
        };
        self.read(|c| group_row(c, id))?.ok_or_else(not_found)?;
        struct Raw {
            seq: i64,
            epoch: i64,
            recv_ts: i64,
            status: i64,
            reason: String,
            sender_user: Option<Vec<u8>>,
            sender_device: Vec<u8>,
            sender_kind: Option<i64>,
            sender_tier: Option<i64>,
            msg_id: Option<[u8; 16]>,
            ty: Option<i64>,
            body: String,
            edit_body: Option<String>,
            edit_seq: i64,
            reply_to: Option<[u8; 16]>,
            envelope: Option<Vec<u8>>,
            mention: i64,
            is_target: bool,
        }
        let rows = self.read(|c| {
            let mut s = c.prepare(TIMELINE_SQL)?;
            let it = s.query_map(params![id.as_slice(), before, i64::from(limit)], |r| {
                Ok(Raw { seq: r.get(0)?, epoch: r.get(1)?, recv_ts: r.get(2)?, status: r.get(3)?,
                    reason: r.get(4)?, sender_user: r.get(5)?, sender_device: r.get(6)?,
                    sender_kind: r.get(7)?, sender_tier: r.get(8)?, msg_id: r.get(9)?, ty: r.get(10)?,
                    body: r.get(11)?, edit_body: r.get(12)?, edit_seq: r.get(13)?, reply_to: r.get(14)?,
                    envelope: r.get(15)?, mention: r.get(16)?, is_target: r.get::<_, i64>(17)? != 0 })
            })?;
            let mut raw: Vec<Raw> = it.collect::<Result<_, _>>()?;
            raw.reverse();
            let mut views = Vec::with_capacity(raw.len());
            for r in raw {
                let body = if r.status == STATUS_OK { r.edit_body.unwrap_or(r.body) } else { String::new() };
                let reply = if r.status == STATUS_OK {
                    r.reply_to.map(|reply_to| {
                        let target = fold::resolve(c, id, &reply_to)?;
                        Ok::<_, StorageError>(wire::ReplyView {
                            reply_to, target_seq: target.as_ref().map(|t| t.seq), target_user: target.as_ref().and_then(|t| t.sender_user),
                            excerpt: target.as_ref().filter(|t| t.status == STATUS_OK).map_or_else(String::new, |t| fold::excerpt(&t.shown_body)),
                            state: target.as_ref().map_or(1, |t| if t.status == STATUS_OK { 0 } else { 2 }),
                        })
                    }).transpose()?
                } else { None };
                let mut reactions = Vec::new();
                let mut pinned = false;
                if r.status == STATUS_OK && r.ty == Some(0) && r.is_target && let Some(msg) = r.msg_id {
                    let mut q = c.prepare("SELECT emoji, n, mine FROM (SELECT emoji, COUNT(*) AS n, MAX(user_id = ?3) AS mine, MIN(seq) AS first FROM app_reactions WHERE group_id = ?1 AND target = ?2 GROUP BY emoji ORDER BY n DESC, first, emoji LIMIT 20) ORDER BY first, emoji")?;
                    reactions = q.query_map(params![id.as_slice(), msg.as_slice(), own.user_id.as_slice()], |x| Ok((x.get(0)?, x.get::<_, i64>(1)? as u64, x.get::<_, i64>(2)? != 0)))?.collect::<Result<_, _>>()?;
                    pinned = c.query_row("SELECT 1 FROM app_pins WHERE group_id = ?1 AND target = ?2", params![id.as_slice(), msg.as_slice()], |_| Ok(())).optional()?.is_some();
                }
                let attachments = if r.status == STATUS_OK && r.ty == Some(0) {
                    r.envelope.as_deref().and_then(|bytes| Envelope::decode(bytes).ok()).map_or_else(Vec::new, |env| env.attachments.into_iter().map(|a| wire::AttachmentView {
                        size: a.size, mime: a.mime, w: a.w, h: a.h, has_thumb: a.thumb.is_some(), name: a.name,
                    }).collect())
                } else { Vec::new() };
                views.push(wire::TimelineView {
                    seq: r.seq as u64, epoch: r.epoch as u64, recv_ts: r.recv_ts as u64, status: r.status as u64,
                    reason: r.reason, sender_user: r.sender_user, sender_device: r.sender_device,
                    sender_kind: r.sender_kind.map(|v| v as u64), sender_tier: r.sender_tier.map(|v| v as u64),
                    msg_id: r.msg_id.map(|m| m.to_vec()), ty: r.ty.map(|v| v as u64), body,
                    edited_seq: r.edit_seq as u64, reply, reactions, pinned, attachments, mention: r.mention != 0,
                });
            }
            Ok(views)
        })?;
        Ok(wire::encode_timeline(&rows))
    }

    pub fn pins(&self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let rows = self
            .read_one(|c| {
                if group_row(c, id)?.is_none() {
                    return Ok(None);
                }
                let mut q = c.prepare(
                "SELECT target, seq, by_user FROM app_pins WHERE group_id = ?1 ORDER BY seq DESC",
            )?;
                let pins: Vec<([u8; 16], i64, [u8; 16])> = q
                    .query_map([id.as_slice()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
                let mut views = Vec::new();
                for (msg_id, seq, by_user) in pins {
                    if let Some(t) = fold::resolve(c, id, &msg_id)? {
                        let ts: i64 = c.query_row(
                            "SELECT recv_ts FROM app_messages WHERE group_id = ?1 AND seq = ?2",
                            params![id.as_slice(), t.seq as i64],
                            |r| r.get(0),
                        )?;
                        views.push(wire::PinView {
                            target_seq: t.seq,
                            msg_id,
                            pinned_seq: seq as u64,
                            by_user,
                            author: t.sender_user,
                            excerpt: fold::excerpt(&t.shown_body),
                            target_ts: ts as u64,
                        });
                    }
                }
                Ok(Some(views))
            })?
            .ok_or_else(not_found)?;
        Ok(wire::encode_pins(&rows))
    }

    pub fn own_roles_set(
        &mut self,
        community_id: &[u8; 16],
        role_ids: &[u8],
    ) -> Result<(), ClientError> {
        self.own()?;
        if !role_ids.len().is_multiple_of(16) || role_ids.len() > 1024 {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "role_ids must be 0..=64 ids of 16 bytes",
            ));
        }
        self.write_dyn(&mut |c| {
            c.execute(
                "DELETE FROM app_roles WHERE community_id = ?1",
                [community_id.as_slice()],
            )?;
            for id in role_ids.as_chunks::<16>().0 {
                c.execute(
                    "INSERT OR IGNORE INTO app_roles (community_id, role_id) VALUES (?1, ?2)",
                    params![community_id.as_slice(), id],
                )?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod mention_tests {
    use super::mentions_me;

    const ME: [u8; 16] = [0xa1; 16];

    #[test]
    fn the_readable_mention_syntax_is_matched_literally() {
        let me = "a1".repeat(16);
        for (body, want) in [
            (format!("hi <@{me}>"), true),
            (format!("<@{me}>"), true),
            ("<@everyone> standup".to_owned(), true),
            ("x<@here>y".to_owned(), true),
            (format!("hi <@{}>", "A1".repeat(16)), false),
            (format!("hi <@{}>", "b2".repeat(16)), false),
            (format!("hi <@{me}"), false),
            (format!("hi @{me}"), false),
            ("<@Everyone>".to_owned(), false),
            ("<@everyone >".to_owned(), false),
            (String::new(), false),
        ] {
            assert_eq!(mentions_me(&body, &ME), want, "{body:?}");
        }
    }
}
