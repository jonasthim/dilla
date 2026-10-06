//! Apply ordered delivery rows with MLS changes and the cursor in one unit per row.

use super::error::{
    E_CORE_INPUT, E_CORE_MLS, E_CORE_NOT_FOUND, E_CORE_RELOAD, E_CORE_STATE, E_CORE_STORAGE,
};
use super::groups::{
    STATE_ACTIVE, STATE_GONE, STATE_NEEDS_RESYNC, checked, group_row, set_mls, set_pending,
};
use super::messages::{
    REASON_OWN_UNKNOWN, REASON_PRUNED, REASON_SENDER_MISMATCH, STATUS_CANNOT_DECRYPT,
    STATUS_DELETED, STATUS_OK, StoredMessage, insert_message, mentions_me,
};
use super::{ClientCore, ClientError, Own, wire};
use crate::cbor::Encoder;
use crate::envelope::Envelope;
use crate::mls::{DillaGroup, DillaProcessed, StorageError};
use openmls::prelude::{GroupId, MlsMessageOut};
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;

enum Row {
    Handshake(wire::HandshakeRow),
    Message(wire::MessageRow),
}
fn absent() -> ClientError {
    ClientError::new(E_CORE_NOT_FOUND, "")
}
fn empty_message<'a>(
    id: &'a [u8; 16],
    row: &'a wire::MessageRow,
    status: i64,
    reason: &'a str,
) -> StoredMessage<'a> {
    StoredMessage {
        group_id: id,
        seq: row.seq,
        epoch: row.epoch,
        recv_ts: row.recv_ts,
        status,
        reason,
        sender_user: None,
        sender_device: &row.uploader_device,
        sender_leaf: None,
        sender_kind: None,
        sender_tier: None,
        msg_id: None,
        ty: None,
        body: "",
        envelope: None,
        franking_tag: &row.franking_tag,
        mention: false,
    }
}
fn own_message<'a>(
    id: &'a [u8; 16],
    row: &'a wire::MessageRow,
    own: &'a Own,
    env: &'a Envelope,
    bytes: &'a [u8],
    leaf: u32,
) -> StoredMessage<'a> {
    StoredMessage {
        group_id: id,
        seq: row.seq,
        epoch: row.epoch,
        recv_ts: row.recv_ts,
        status: STATUS_OK,
        reason: "",
        sender_user: Some(&own.user_id),
        sender_device: &own.device_id,
        sender_leaf: Some(leaf),
        sender_kind: Some(own.kind),
        sender_tier: Some(own.tier),
        msg_id: Some(env.msg_id.as_bytes()),
        ty: Some(env.kind.as_u8()),
        body: &env.body,
        envelope: Some(bytes),
        franking_tag: &row.franking_tag,
        mention: false,
    }
}
/// Raises `app_groups.max_epoch` (the F6 floor of a rejoin) to `epoch`, a newly held epoch.
fn raise_floor(c: &rusqlite::Connection, id: &[u8; 16], epoch: i64) -> Result<(), StorageError> {
    c.execute(
        "UPDATE app_groups SET max_epoch=MAX(max_epoch,?2) WHERE group_id=?1",
        params![id.as_slice(), epoch],
    )?;
    Ok(())
}
/// Whether a message row is already stored at `(id, seq)`.
fn message_stored(c: &rusqlite::Connection, id: &[u8; 16], seq: u64) -> Result<bool, StorageError> {
    Ok(c.query_row(
        "SELECT 1 FROM app_messages WHERE group_id=?1 AND seq=?2",
        params![id.as_slice(), seq as i64],
        |r| r.get::<_, i64>(0),
    )
    .optional()?
    .is_some())
}
/// An outbox row: its `msg_id`, the stored envelope bytes and the envelope they decode to.
type OutboxEntry = ([u8; 16], Vec<u8>, Envelope);
/// The group's unresolved outbox row (in any state: in flight, failed after a lost answer, or
/// queued again after an echo wait) whose envelope commitment `C` is `served`: the served row is
/// that row's upload, which the server stored. `C` is keyed by the envelope's random `k_f`, so it
/// names one envelope; adopting it is what keeps a stored upload from being sent again.
fn unresolved_with(
    c: &rusqlite::Connection,
    id: &[u8; 16],
    served: &[u8; 32],
) -> Result<Option<OutboxEntry>, StorageError> {
    let mut stmt = c.prepare(
        "SELECT msg_id,envelope FROM app_outbox WHERE group_id=?1 ORDER BY created,msg_id",
    )?;
    let rows = stmt
        .query_map([id.as_slice()], |r| {
            Ok((r.get::<_, [u8; 16]>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (msg_id, bytes) in rows {
        let env = Envelope::decode(&bytes)
            .map_err(|_| StorageError::Sqlite("outbox envelope does not decode".into()))?;
        let commitment = env
            .commitment()
            .map_err(|_| StorageError::Sqlite("outbox envelope has no commitment".into()))?;
        if &commitment == served {
            return Ok(Some((msg_id, bytes, env)));
        }
    }
    Ok(None)
}
fn apply_message(
    c: &rusqlite::Connection,
    id: &[u8; 16],
    row: &wire::MessageRow,
    own: &Own,
    group: &DillaGroup,
) -> Result<(bool, bool), StorageError> {
    if row.deleted {
        let changed = c.execute(
            "UPDATE app_messages SET status=2,body='',envelope=NULL,reason='' \
             WHERE group_id=?1 AND seq=?2",
            params![id.as_slice(), row.seq as i64],
        )?;
        if changed > 0 {
            return Ok((true, false));
        }
        // The deleted upload of an unresolved outbox row (its commitment survives the deletion): the
        // server stored it, so the outbox row is done and never resent.
        if row.uploader_device == own.device_id
            && let Some(served) = row.commitment.as_ref()
            && let Some((msg_id, _, env)) = unresolved_with(c, id, served)?
        {
            let marker = StoredMessage {
                status: STATUS_DELETED,
                sender_user: Some(&own.user_id),
                sender_device: &own.device_id,
                sender_leaf: Some(group.own_leaf_index().u32()),
                sender_kind: Some(own.kind),
                sender_tier: Some(own.tier),
                msg_id: Some(env.msg_id.as_bytes()),
                ty: Some(env.kind.as_u8()),
                ..empty_message(id, row, STATUS_DELETED, "")
            };
            insert_message(c, &marker)?;
            c.execute(
                "DELETE FROM app_outbox WHERE msg_id=?1",
                [msg_id.as_slice()],
            )?;
            return Ok((true, true));
        }
        insert_message(c, &empty_message(id, row, STATUS_DELETED, ""))?;
        return Ok((true, false));
    }
    if row.blob.is_none() {
        insert_message(
            c,
            &empty_message(id, row, STATUS_CANNOT_DECRYPT, REASON_PRUNED),
        )?;
        return Ok((true, false));
    }
    if row.uploader_device == own.device_id {
        if message_stored(c, id, row.seq)? {
            return Ok((false, false));
        }
        // Adopted only as the upload of the outbox row (in flight, failed or queued again) whose
        // envelope commitment the row carries (the served field and the ciphertext's
        // authenticated data, which must agree when both are there). Anything else is an own
        // upload this device cannot place.
        let carried = row.blob.as_deref().and_then(wire::blob_commitment);
        let served = match (row.commitment, carried) {
            (Some(field), Some(blob)) if field != blob => None,
            (field, blob) => field.or(blob),
        };
        let adopt = match served {
            Some(served) => unresolved_with(c, id, &served)?,
            None => None,
        };
        if let Some((msg_id, bytes, env)) = adopt {
            insert_message(
                c,
                &own_message(id, row, own, &env, &bytes, group.own_leaf_index().u32()),
            )?;
            c.execute(
                "DELETE FROM app_outbox WHERE msg_id=?1",
                [msg_id.as_slice()],
            )?;
            return Ok((true, true));
        }
        insert_message(
            c,
            &empty_message(id, row, STATUS_CANNOT_DECRYPT, REASON_OWN_UNKNOWN),
        )?;
        return Ok((true, false));
    }
    Err(StorageError::Sqlite(
        "message branch was not selected".into(),
    ))
}

impl ClientCore {
    pub fn commit_build(
        &mut self,
        id: &[u8; 16],
        proposals_body: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let proposals = wire::decode_proposals_body(proposals_body)?;
        let row = self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        if row.state != STATE_ACTIVE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", row.state),
            ));
        }
        self.signer()?;
        self.retry_reload(id, |this| {
            let mut group = this.take_group(id)?.ok_or_else(absent)?;
            if group.has_pending_commit() {
                this.keep_group(*id, group);
                return Err(ClientError::new(E_CORE_STATE, "a commit is pending"));
            }
            let result = this.write(|ctx, u| {
                for item in &proposals {
                    if item.void { continue; }
                    let _ = (&item.reference, item.kind, item.target_leaf);
                    let Ok(message) = wire::protocol_message(&item.blob) else { continue; };
                    if message.epoch().as_u64() != group.epoch() { continue; }
                    match group.process_message(ctx.provider, message) {
                        Ok(DillaProcessed::Proposal(proposal)) => {
                            let reference = proposal.proposal_reference_ref().as_slice().to_vec();
                            let exists = u.with_conn(|c| Ok(c.query_row("SELECT 1 FROM app_proposals WHERE group_id=?1 AND ref=?2", params![id.as_slice(), &reference], |r| r.get::<_, i64>(0)).optional()?.is_some()))?;
                            if !exists {
                                group.store_pending_proposal(ctx.provider, *proposal)?;
                                u.with_conn(|c| { c.execute("INSERT INTO app_proposals (group_id,ref,epoch) VALUES(?1,?2,?3)", params![id.as_slice(), reference, group.epoch() as i64])?; Ok(()) })?;
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            let e: ClientError = e.into();
                            if e.code == E_CORE_STORAGE || e.code == E_CORE_RELOAD { return Err(e); }
                            group = DillaGroup::load(ctx.provider, &GroupId::from_slice(id))?.ok_or_else(absent)?;
                        }
                    }
                }
                let epoch = group.epoch();
                let bundle = group.self_update(ctx.provider, ctx.signer.ok_or_else(|| ClientError::new(super::error::E_CORE_NO_IDENTITY, ""))?)?;
                u.with_conn(|c| set_pending(c, id, true))?;
                let info = bundle.group_info.ok_or_else(|| ClientError::new(E_CORE_MLS, "the staged commit carries no GroupInfo"))?;
                let mut out = Encoder::new();
                out.array(5).uint(epoch).bytes(&wire::tls(&bundle.commit)?).bytes(&wire::tls(&MlsMessageOut::from(info))?);
                out.array(bundle.welcomes.len());
                for (device, welcome) in &bundle.welcomes { out.array(2).bytes(device.as_bytes()).bytes(&wire::tls(welcome)?); }
                out.null();
                Ok(out.into_vec())
            });
            if result.is_ok() { this.keep_group(*id, group); }
            result
        })
    }

    pub fn commit_confirm(&mut self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let row = self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        if row.state != STATE_ACTIVE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", row.state),
            ));
        }
        self.retry_reload(id, |this| {
            let mut group = this.take_group(id)?.ok_or_else(absent)?;
            let result = this.write(|ctx, u| {
                if group.has_pending_commit() {
                    group.merge_pending_commit(ctx.provider)?;
                }
                let held = checked("epoch", group.epoch())?;
                u.with_conn(|c| {
                    c.execute(
                        "DELETE FROM app_proposals WHERE group_id=?1",
                        [id.as_slice()],
                    )?;
                    raise_floor(c, id, held)?;
                    set_mls(c, id, held, false)
                })?;
                Ok(wire::encode_apply_result(&wire::ApplyResult {
                    state: 2,
                    epoch: group.epoch(),
                    next_seq: row.next_seq as u64,
                    new_seqs: vec![],
                    proposals_pending: 0,
                    flags: 1,
                }))
            });
            if result.is_ok() {
                this.keep_group(*id, group);
            }
            result
        })
    }

    pub fn commit_abort(&mut self, id: &[u8; 16]) -> Result<(), ClientError> {
        self.own()?;
        self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        self.retry_reload(id, |this| {
            let Some(mut group) = this.take_group(id)? else {
                return Ok(());
            };
            if !group.has_pending_commit() {
                this.keep_group(*id, group);
                return Ok(());
            }
            let result = this.write(|ctx, u| {
                group.clear_pending_commit(ctx.provider)?;
                u.with_conn(|c| set_pending(c, id, false))?;
                Ok(())
            });
            if result.is_ok() {
                this.keep_group(*id, group);
            }
            result
        })
    }

    pub fn cursor_body(&self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let (state, next_seq, acked_seq, epoch): (i64, i64, i64, i64) = self
            .read(|c| {
                c.query_row(
                    "SELECT state,next_seq,acked_seq,epoch FROM app_groups WHERE group_id=?1",
                    [id.as_slice()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(Into::into)
            })?
            .ok_or_else(absent)?;
        if state != STATE_ACTIVE && state != STATE_NEEDS_RESYNC {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {state}"),
            ));
        }
        let mut out = Encoder::new();
        if next_seq - 1 <= acked_seq {
            out.null();
        } else {
            out.array(2).uint((next_seq - 1) as u64).uint(epoch as u64);
        }
        Ok(out.into_vec())
    }

    pub fn cursor_acked(
        &mut self,
        id: &[u8; 16],
        last_seq: u64,
        last_epoch: u64,
    ) -> Result<(), ClientError> {
        self.own()?;
        let row = self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        if last_seq > (row.next_seq - 1) as u64 {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "last_seq beyond the applied head",
            ));
        }
        let epoch = checked("last_epoch", last_epoch)?;
        self.write(|_, u| { u.with_conn(|c| { c.execute("UPDATE app_groups SET acked_seq=?2,acked_epoch=?3 WHERE group_id=?1 AND acked_seq<?2", params![id.as_slice(), last_seq as i64, epoch])?; Ok(()) })?; Ok(()) })
    }

    pub fn message_deleted(&mut self, id: &[u8; 16], seq: u64) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let seq_i = checked("seq", seq)?;
        let row = self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        if row.state == STATE_GONE {
            return Err(ClientError::new(E_CORE_STATE, "state 4"));
        }
        let (changed, proposals): (usize, i64) = self.write(|_, u| Ok(u.with_conn(|c| {
            let changed = c.execute("UPDATE app_messages SET status=2,body='',envelope=NULL,reason='' WHERE group_id=?1 AND seq=?2 AND status<>2", params![id.as_slice(), seq_i])?;
            let proposals = c.query_row("SELECT COUNT(*) FROM app_proposals WHERE group_id=?1", [id.as_slice()], |r| r.get(0))?;
            Ok((changed, proposals))
        })?))?;
        let loaded = if self.groups.contains_key(id) {
            None
        } else {
            DillaGroup::load(&self.provider, &GroupId::from_slice(id))?
        };
        let epoch = self
            .groups
            .get(id)
            .or(loaded.as_ref())
            .map_or(0, DillaGroup::epoch);
        Ok(wire::encode_apply_result(&wire::ApplyResult {
            state: row.state as u8,
            epoch,
            next_seq: row.next_seq as u64,
            new_seqs: if changed == 1 { vec![seq] } else { vec![] },
            proposals_pending: proposals as u64,
            flags: 0,
        }))
    }

    pub fn group_apply(
        &mut self,
        id: &[u8; 16],
        handshakes: &[u8],
        messages: &[u8],
        through: u64,
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        let handshakes = wire::decode_handshake_rows(handshakes)?;
        let messages = wire::decode_message_rows(messages)?;
        let mut rows = BTreeMap::new();
        for h in handshakes {
            let seq = h.seq;
            if rows.insert(seq, Row::Handshake(h)).is_some() {
                return Err(ClientError::new(
                    E_CORE_INPUT,
                    format!("seq {seq} appears twice"),
                ));
            }
        }
        for m in messages {
            checked("messages: epoch", m.epoch)?;
            checked("messages: recv_ts", m.recv_ts)?;
            let seq = m.seq;
            if rows.insert(seq, Row::Message(m)).is_some() {
                return Err(ClientError::new(
                    E_CORE_INPUT,
                    format!("seq {seq} appears twice"),
                ));
            }
        }
        if through >= i64::MAX as u64 {
            return Err(ClientError::new(E_CORE_INPUT, "through out of range"));
        }
        let r = self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        if r.state != STATE_ACTIVE {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group state {}", r.state),
            ));
        }
        let mut next = r.next_seq as u64;
        let mut new_seqs = Vec::new();
        let mut flags = 0u8;
        let mut stopped = false;
        for (seq, row) in rows {
            if seq < next || seq > through {
                continue;
            }
            checked("seq", seq)?;
            let (changed, adopted, epoch_changed, stop) = self.retry_reload(id, |this| {
                let mut group = this.take_group(id)?.ok_or_else(absent)?;
                let mut mls_failed = false;
                let result = this.write(|ctx, u| {
                    let mut changed = false;
                    let mut adopted = false;
                    let mut epoch_changed = false;
                    let mut stop = false;
                    match &row {
                        Row::Handshake(h) => {
                            let hs_epoch = checked("handshakes: epoch", h.epoch)?;
                            u.with_conn(|c| {
                                c.execute("INSERT OR REPLACE INTO app_handshake_tail (group_id,seq,epoch,kind,sender,blob) VALUES(?1,?2,?3,?4,?5,?6)",
                                    params![id.as_slice(), seq as i64, hs_epoch, h.kind as i64, h.sender.map(i64::from), &h.blob])?;
                                c.execute("DELETE FROM app_handshake_tail WHERE group_id=?1 AND seq NOT IN (SELECT seq FROM app_handshake_tail WHERE group_id=?1 ORDER BY seq DESC LIMIT ?2)",
                                    params![id.as_slice(), super::schema::HANDSHAKE_TAIL as i64])?;
                                Ok(())
                            })?;
                            let attempt = (|| -> Result<bool, ClientError> {
                                let message = wire::protocol_message(&h.blob)?;
                                if message.epoch().as_u64() < group.epoch() { return Ok(false); }
                                match group.process_message(ctx.provider, message)? {
                                    DillaProcessed::StagedCommit(commit) => {
                                        if commit.self_removed() {
                                            // The epoch this device held last is already the
                                            // floor (F6): it was written when it was reached.
                                            group.delete(ctx.provider)?;
                                            u.with_conn(|c| {
                                                c.execute("DELETE FROM app_proposals WHERE group_id=?1", [id.as_slice()])?;
                                                c.execute(
                                                    "UPDATE app_groups SET state=4,next_seq=?2,epoch=0,pending_commit=0 WHERE group_id=?1",
                                                    params![id.as_slice(), seq as i64 + 1],
                                                )?;
                                                Ok(())
                                            })?;
                                            epoch_changed = true;
                                            return Ok(true);
                                        }
                                        // The clear is persisted with its column at once: a merge
                                        // that then fails is caught below and commits the unit
                                        // (pre-flight ruling (c)).
                                        if group.has_pending_commit() {
                                            group.clear_pending_commit(ctx.provider)?;
                                            u.with_conn(|c| set_pending(c, id, false))?;
                                        }
                                        group.merge_staged_commit(ctx.provider, *commit)?;
                                        let held = checked("epoch", group.epoch())?;
                                        u.with_conn(|c| { c.execute("DELETE FROM app_proposals WHERE group_id=?1", [id.as_slice()])?; raise_floor(c, id, held)?; set_mls(c, id, held, false) })?;
                                        epoch_changed = true;
                                    }
                                    DillaProcessed::OwnPendingCommit => {
                                        group.merge_pending_commit(ctx.provider)?;
                                        let held = checked("epoch", group.epoch())?;
                                        u.with_conn(|c| { c.execute("DELETE FROM app_proposals WHERE group_id=?1", [id.as_slice()])?; raise_floor(c, id, held)?; set_mls(c, id, held, false) })?;
                                        epoch_changed = true;
                                    }
                                    DillaProcessed::Proposal(proposal) => {
                                        let reference = proposal.proposal_reference_ref().as_slice().to_vec();
                                        let exists: bool = u.with_conn(|c| Ok(c.query_row("SELECT 1 FROM app_proposals WHERE group_id=?1 AND ref=?2", params![id.as_slice(), &reference], |r| r.get::<_, i64>(0)).optional()?.is_some()))?;
                                        if !exists {
                                            group.store_pending_proposal(ctx.provider, *proposal)?;
                                            u.with_conn(|c| { c.execute("INSERT INTO app_proposals (group_id,ref,epoch) VALUES(?1,?2,?3)", params![id.as_slice(), reference, group.epoch() as i64])?; Ok(()) })?;
                                        }
                                    }
                                    _ => {}
                                }
                                Ok(false)
                            })();
                            match attempt {
                                Ok(removed) => { stop = removed; }
                                Err(e) if e.code == E_CORE_STORAGE || e.code == E_CORE_RELOAD => return Err(e),
                                Err(_) if h.kind == 1 || h.kind == 2 => {
                                    u.with_conn(|c| { c.execute("UPDATE app_groups SET state=3 WHERE group_id=?1", [id.as_slice()])?; Ok(()) })?;
                                    stop = true;
                                    mls_failed = true;
                                }
                                Err(_) => { mls_failed = true; }
                            }
                        }
                        Row::Message(m) => {
                            // Do not borrow the connection across an OpenMLS call: `with_conn`
                            // releases it before process_message takes the storage handle.
                            // A row already stored at this seq (an own row confirmed ahead of
                            // next_seq, or one the server serves twice) is skipped before any
                            // MLS processing; rule 2 alone updates a stored row.
                            let occupied =
                                !m.deleted && u.with_conn(|c| message_stored(c, id, m.seq))?;
                            if occupied {
                                // Skipped: not listed; next_seq moves past it below.
                            } else if m.deleted
                                || m.blob.is_none()
                                || m.uploader_device == own.device_id
                            {
                                (changed, adopted) =
                                    u.with_conn(|c| apply_message(c, id, m, &own, &group))?;
                            } else {
                                let parsed =
                                    wire::protocol_message(m.blob.as_deref().unwrap_or_default());
                                let processed = parsed.and_then(|message| {
                                    group
                                        .process_message(ctx.provider, message)
                                        .map_err(Into::into)
                                });
                                let (status, reason, application) = match processed {
                                    Ok(DillaProcessed::Application(r))
                                        if r.sender.device_id.as_bytes() == &m.uploader_device =>
                                    {
                                        (STATUS_OK, "", Some(r))
                                    }
                                    Ok(DillaProcessed::Application(_)) => {
                                        (STATUS_CANNOT_DECRYPT, REASON_SENDER_MISMATCH, None)
                                    }
                                    Ok(_) => (STATUS_CANNOT_DECRYPT, E_CORE_MLS, None),
                                    Err(err) => {
                                        if err.code == E_CORE_STORAGE || err.code == E_CORE_RELOAD {
                                            return Err(err);
                                        }
                                        mls_failed = true;
                                        (STATUS_CANNOT_DECRYPT, err.code, None)
                                    }
                                };
                                let bytes = application
                                    .as_ref()
                                    .map(|r| r.envelope.encode())
                                    .transpose()?;
                                u.with_conn(|c| {
                                    if let Some(r) = application.as_ref() {
                                        let msg = StoredMessage {
                                            group_id: id,
                                            seq: m.seq,
                                            epoch: r.epoch,
                                            recv_ts: m.recv_ts,
                                            status,
                                            reason,
                                            sender_user: Some(r.sender.user_id.as_bytes()),
                                            sender_device: r.sender.device_id.as_bytes(),
                                            sender_leaf: Some(r.sender_leaf),
                                            sender_kind: Some(r.sender.kind.as_u8()),
                                            sender_tier: Some(r.sender.tier.as_u8()),
                                            msg_id: Some(r.envelope.msg_id.as_bytes()),
                                            ty: Some(r.envelope.kind.as_u8()),
                                            body: &r.envelope.body,
                                            envelope: bytes.as_deref(),
                                            franking_tag: &m.franking_tag,
                                            mention: r.envelope.kind.as_u8() == 0
                                                && mentions_me(&r.envelope.body, &own.user_id)
                                                && r.sender.user_id.as_bytes() != &own.user_id,
                                        };
                                        insert_message(c, &msg)?;
                                    } else {
                                        insert_message(c, &empty_message(id, m, status, reason))?;
                                    }
                                    Ok(())
                                })?;
                                changed = true;
                            }
                        }
                    }
                    if !stop || matches!(&row, Row::Handshake(_)) && !mls_failed {
                        u.with_conn(|c| { c.execute("UPDATE app_groups SET next_seq=?2 WHERE group_id=?1", params![id.as_slice(), seq as i64 + 1])?; Ok(()) })?;
                    }
                    Ok((changed, adopted, epoch_changed, stop))
                });
                if result.is_ok() && !mls_failed && !matches!(&result, Ok((_,_,_,true))) {
                    this.keep_group(*id, group);
                }
                result
            })?;
            if !stop || !matches!(&row, Row::Handshake(_)) {
                next = seq + 1;
            }
            if changed {
                new_seqs.push(seq);
            }
            if adopted {
                flags |= 2;
            }
            if epoch_changed {
                flags |= 1;
            }
            if stop {
                stopped = true;
                break;
            }
        }
        if !stopped && through + 1 > next {
            self.write(|_, u| {
                u.with_conn(|c| {
                    c.execute(
                        "UPDATE app_groups SET next_seq=?2 WHERE group_id=?1 AND next_seq<?2",
                        params![id.as_slice(), through as i64 + 1],
                    )?;
                    Ok(())
                })?;
                Ok(())
            })?;
        }
        let row = self.read(|c| group_row(c, id))?.ok_or_else(absent)?;
        let group = self.groups.get(id);
        let loaded = if group.is_none() {
            DillaGroup::load(&self.provider, &openmls::prelude::GroupId::from_slice(id))?
        } else {
            None
        };
        let epoch = group.or(loaded.as_ref()).map_or(0, DillaGroup::epoch);
        let proposals: u64 = self.read(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM app_proposals WHERE group_id=?1",
                [id.as_slice()],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v as u64)
            .map_err(Into::into)
        })?;
        Ok(wire::encode_apply_result(&wire::ApplyResult {
            state: row.state as u8,
            epoch,
            next_seq: row.next_seq as u64,
            new_seqs,
            proposals_pending: proposals,
            flags,
        }))
    }
}
