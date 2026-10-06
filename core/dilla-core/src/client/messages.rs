//! Prepared sends, delivery confirmation, outbox and timeline reads.

use super::error::{E_CORE_INPUT, E_CORE_MLS, E_CORE_NOT_FOUND, E_CORE_STATE, E_CORE_STORAGE};
use super::groups::{STATE_ACTIVE, checked, group_row};
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
    pub body: &'a str,
    pub envelope: Option<&'a [u8]>,
    pub franking_tag: &'a [u8; 32],
}
pub(super) fn insert_message(
    c: &rusqlite::Connection,
    m: &StoredMessage<'_>,
) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_messages \
         (group_id,seq,epoch,recv_ts,status,reason,sender_user,sender_device, \
          sender_leaf,sender_kind,sender_tier,msg_id,type,body,envelope,franking_tag) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
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
        ],
    )?;
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
        body: &env.body,
        envelope: Some(bytes),
        franking_tag: tag,
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
    pub fn send_prepare(
        &mut self,
        id: &[u8; 16],
        body: &str,
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let now = checked("now", now)?;
        if body.trim().is_empty() {
            return Err(ClientError::new(E_CORE_INPUT, "body is empty"));
        }
        let row = self.read(|c| group_row(c, id))?.ok_or_else(not_found)?;
        if row.state != STATE_ACTIVE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", row.state),
            ));
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
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: body.into(),
            attachments: vec![],
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

    pub fn outbox(&self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.read(|c| group_row(c, id))?.ok_or_else(not_found)?;
        type ListedOutbox = ([u8; 16], i64, String, i64, Vec<u8>);
        let rows: Vec<ListedOutbox> = self.read(|c| {
            let mut s = c.prepare(
                "SELECT msg_id,state,error,created,envelope FROM app_outbox \
                 WHERE group_id=?1 ORDER BY created,msg_id",
            )?;
            let it = s.query_map([id.as_slice()], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            it.collect::<Result<_, _>>().map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for (msg, state, error, created, env) in rows {
            let env = Envelope::decode(&env)
                .map_err(|_| ClientError::new(E_CORE_STORAGE, "outbox envelope does not decode"))?;
            e.array(5)
                .bytes(&msg)
                .uint(state as u64)
                .text(&error)
                .uint(created as u64)
                .text(&env.body);
        }
        Ok(e.into_vec())
    }
    pub fn timeline(
        &self,
        id: &[u8; 16],
        before_seq: u64,
        limit: u32,
    ) -> Result<Vec<u8>, ClientError> {
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
        type Row = (
            i64,
            i64,
            i64,
            i64,
            String,
            Option<Vec<u8>>,
            Vec<u8>,
            Option<i64>,
            Option<i64>,
            Option<Vec<u8>>,
            Option<i64>,
            String,
        );
        let mut rows: Vec<Row> = self.read(|c| {
            let mut s = c.prepare(
                "SELECT seq,epoch,recv_ts,status,reason,sender_user,sender_device, \
                 sender_kind,sender_tier,msg_id,type,body FROM app_messages \
                 WHERE group_id=?1 AND (?2=0 OR seq<?2) ORDER BY seq DESC LIMIT ?3",
            )?;
            let it = s.query_map(params![id.as_slice(), before, i64::from(limit)], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                ))
            })?;
            it.collect::<Result<_, _>>().map_err(Into::into)
        })?;
        rows.reverse();
        let mut e = Encoder::new();
        e.array(rows.len());
        for (seq, epoch, recv, status, reason, user, device, kind, tier, msg, ty, body) in rows {
            e.array(12)
                .uint(seq as u64)
                .uint(epoch as u64)
                .uint(recv as u64)
                .uint(status as u64)
                .text(&reason)
                .opt_bytes(user.as_deref())
                .bytes(&device)
                .opt_uint(kind.map(|v| v as u64))
                .opt_uint(tier.map(|v| v as u64))
                .opt_bytes(msg.as_deref())
                .opt_uint(ty.map(|v| v as u64))
                .text(&body);
        }
        Ok(e.into_vec())
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
