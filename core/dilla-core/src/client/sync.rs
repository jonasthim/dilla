//! Apply ordered delivery rows with MLS changes and the cursor in one unit per row.

use super::error::{
    E_CORE_INPUT, E_CORE_MLS, E_CORE_NOT_FOUND, E_CORE_RELOAD, E_CORE_STATE, E_CORE_STORAGE,
};
use super::groups::{STATE_ACTIVE, checked, group_row};
use super::messages::{
    REASON_OWN_UNKNOWN, REASON_PRUNED, REASON_SENDER_MISMATCH, STATUS_CANNOT_DECRYPT,
    STATUS_DELETED, STATUS_OK, StoredMessage, insert_message,
};
use super::{ClientCore, ClientError, Own, wire};
use crate::envelope::Envelope;
use crate::mls::{DillaGroup, DillaProcessed, StorageError};
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
    }
}
fn apply_message(
    c: &rusqlite::Connection,
    id: &[u8; 16],
    row: &wire::MessageRow,
    own: &Own,
    group: &DillaGroup,
) -> Result<(bool, bool), StorageError> {
    if row.deleted {
        let changed=c.execute("UPDATE app_messages SET status=2,body='',envelope=NULL,reason='' WHERE group_id=?1 AND seq=?2",params![id.as_slice(),row.seq as i64])?;
        if changed == 0 {
            insert_message(c, &empty_message(id, row, STATUS_DELETED, ""))?;
        }
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
        let existing: Option<i64> = c
            .query_row(
                "SELECT 1 FROM app_messages WHERE group_id=?1 AND seq=?2",
                params![id.as_slice(), row.seq as i64],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Ok((false, false));
        }
        let outbox: Option<([u8; 16], Vec<u8>)> = c
            .query_row(
                "SELECT msg_id,envelope FROM app_outbox WHERE group_id=?1 AND state=1",
                [id.as_slice()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((msg_id, bytes)) = outbox {
            let env = Envelope::decode(&bytes)
                .map_err(|_| StorageError::Sqlite("outbox envelope does not decode".into()))?;
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
        for (seq, row) in rows {
            if seq < next || seq > through {
                continue;
            }
            checked("seq", seq)?;
            let (changed,adopted,epoch_changed)=self.retry_reload(id,|this|{
                let mut group=this.take_group(id)?.ok_or_else(absent)?;
                let mut mls_failed=false;
                let result=this.write(|ctx,u|{
                    let mut changed=false;let mut adopted=false;let mut epoch_changed=false;
                    match &row {
                        Row::Handshake(h)=>{
                            let message=wire::protocol_message(&h.blob)?;
                            if message.epoch().as_u64()>=group.epoch(){
                                match group.process_message(ctx.provider,message)? {
                                    DillaProcessed::StagedCommit(commit)=>{
                                        group.merge_staged_commit(ctx.provider,*commit)?;
                                        u.with_conn(|c|{c.execute("DELETE FROM app_proposals WHERE group_id=?1",[id.as_slice()])?;Ok(())})?;
                                        epoch_changed=true;
                                    }
                                    DillaProcessed::Proposal(proposal)=>{
                                        let reference=proposal.proposal_reference_ref().as_slice().to_vec();
                                        group.store_pending_proposal(ctx.provider,*proposal)?;
                                        u.with_conn(|c|{c.execute("INSERT OR IGNORE INTO app_proposals(group_id,ref,epoch) VALUES(?1,?2,?3)",params![id.as_slice(),reference,group.epoch() as i64])?;Ok(())})?;
                                    }
                                    _=>{}
                                }
                            }
                        }
                        Row::Message(m)=>{
                            // Do not borrow the connection across an OpenMLS call: `with_conn`
                            // releases it before process_message takes the storage handle.
                            if m.deleted||m.blob.is_none()||m.uploader_device==own.device_id {
                                (changed,adopted)=u.with_conn(|c|apply_message(c,id,m,&own,&group))?;
                            }else{
                                let parsed=wire::protocol_message(m.blob.as_deref().unwrap_or_default());
                                let processed=parsed.and_then(|message|group.process_message(ctx.provider,message).map_err(Into::into));
                                let (status,reason,application)=match processed {
                                    Ok(DillaProcessed::Application(r)) if r.sender.device_id.as_bytes()==&m.uploader_device=>(STATUS_OK,"",Some(r)),
                                    Ok(DillaProcessed::Application(_))=>(STATUS_CANNOT_DECRYPT,REASON_SENDER_MISMATCH,None),
                                    Ok(_)=>(STATUS_CANNOT_DECRYPT,E_CORE_MLS,None),
                                    Err(err)=>{if err.code==E_CORE_STORAGE||err.code==E_CORE_RELOAD{return Err(err);}mls_failed=true;(STATUS_CANNOT_DECRYPT,err.code,None)}
                                };
                                let bytes=application.as_ref().map(|r|r.envelope.encode()).transpose()?;
                                u.with_conn(|c|{
                                    if let Some(r)=application.as_ref(){let msg=StoredMessage{group_id:id,seq:m.seq,epoch:r.epoch,recv_ts:m.recv_ts,status,reason,sender_user:Some(r.sender.user_id.as_bytes()),sender_device:r.sender.device_id.as_bytes(),sender_leaf:Some(r.sender_leaf),sender_kind:Some(r.sender.kind.as_u8()),sender_tier:Some(r.sender.tier.as_u8()),msg_id:Some(r.envelope.msg_id.as_bytes()),ty:Some(r.envelope.kind.as_u8()),body:&r.envelope.body,envelope:bytes.as_deref(),franking_tag:&m.franking_tag};insert_message(c,&msg)?;}
                                    else{insert_message(c,&empty_message(id,m,status,reason))?;}Ok(())
                                })?;changed=true;
                            }
                        }
                    }
                    u.with_conn(|c|{c.execute("UPDATE app_groups SET next_seq=?2 WHERE group_id=?1",params![id.as_slice(),seq as i64+1])?;Ok(())})?;
                    Ok((changed,adopted,epoch_changed))
                });
                if result.is_ok()&&!mls_failed{this.keep_group(*id,group);}result
            })?;
            next = seq + 1;
            if changed {
                new_seqs.push(seq);
            }
            if adopted {
                flags |= 2;
            }
            if epoch_changed {
                flags |= 1;
            }
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
