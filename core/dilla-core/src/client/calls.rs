//! Call groups in the browser core (L-CORE-50): create and join a call group, read each epoch's
//! media key only through the call gate, leave, rotate and forget.
//!
//! The gate is the core's answer to "may this device's audio reach every leaf of this tree": a
//! stored failed or changed-key verdict of a leaf (the send block), a leaf that does not validate
//! against its cached signed list now (pending included: ruling RV-1), and for a DM's call group
//! the send block of the DM's text group (decision 4). It runs in the core, on the core's own live
//! tree, so neither the worker nor the instance can skip it, and before any key byte is derived.

use super::error::E_DEVICE_LIST_STALE;
use super::error::{E_CORE_INPUT, E_CORE_NO_IDENTITY, E_CORE_NOT_FOUND, E_CORE_STATE};
use super::groups::{
    GroupRow, STATE_ACTIVE, STATE_GONE, STATE_JOINING, group_row, holder, row_kind,
};
use super::{ClientCore, ClientError, Own, trust, wire};
use crate::cbor::Encoder;
use crate::identity::{DISPLAY_GROUP, group_digits, sas};
use crate::mls::{DillaGroup, DillaProvider, GroupKind, StorageError, UnitScope};
use openmls::prelude::GroupId;
use rusqlite::params;

#[cfg(feature = "test-hooks")]
thread_local! {
    static DERIVED: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
}

/// Test builds only: how many media keys `call_media_epoch` derived on this thread.
#[cfg(feature = "test-hooks")]
pub fn test_media_key_derivations() -> u64 {
    DERIVED.with(core::cell::Cell::get)
}

/// The DM text group a call group's gate reads in step 3, with its MLS state when it loads.
type TextGroup<'a> = Option<([u8; 16], Option<&'a DillaGroup>)>;

/// The id of the text group of a DM's call group: held for the same target, when the call group's
/// binding names no community (a DM or group DM). None for a voice channel's call group.
fn dm_text_id(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    id: &[u8; 16],
) -> Result<Option<[u8; 16]>, StorageError> {
    let binding = group.binding();
    if binding.community_id.is_some() {
        return Ok(None);
    }
    holder(c, &binding.target_id, 0, id)
}

/// The call gate, in the ledger's order; the answer is the refusal code. With `stale_ok` (the join
/// before its commit is posted) a pending leaf alone passes step 2: `call_join_check` settles it.
fn gate_verdict(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    id: &[u8; 16],
    own: &Own,
    text: TextGroup<'_>,
    stale_ok: bool,
) -> Result<Result<(), &'static str>, StorageError> {
    // 1. The send block: a stored failed or changed-key verdict of a leaf of this tree.
    if let Some(code) = trust::send_block(c, group, id)? {
        return Ok(Err(code));
    }
    // 2. Every other leaf validates against its cached signed list now; pending refuses.
    match trust::call_leaves_verdict(c, group, id, &own.user_id, &own.device_id)? {
        Ok(()) => {}
        Err(E_DEVICE_LIST_STALE) if stale_ok => {}
        Err(code) => return Ok(Err(code)),
    }
    // 3. A DM's call group refuses while the DM's text group is send-blocked (decision 4).
    if let Some((text_id, text_group)) = text {
        let block = match text_group {
            Some(g) => trust::send_block(c, g, &text_id)?,
            None => trust::stored_block(c, &text_id)?,
        };
        if let Some(code) = block {
            return Ok(Err(code));
        }
    }
    Ok(Ok(()))
}

/// The call gate of a join, inside the join's unit right after the audit of the joined tree
/// (`group_join_kind`): an `Err` rolls the whole unit back, so no row, verdict or MLS state of the
/// refused join survives and no external commit leaves the core.
pub(super) fn join_gate(
    provider: &DillaProvider,
    u: &UnitScope<'_>,
    group: &DillaGroup,
    id: &[u8; 16],
    own: &Own,
) -> Result<(), ClientError> {
    let text_id = u.with_conn(|c| dm_text_id(c, group, id))?;
    // A text group whose state does not load answers from its stored verdicts (fail closed).
    let loaded = match text_id {
        Some(t) => DillaGroup::load(provider, &GroupId::from_slice(&t)).unwrap_or(None),
        None => None,
    };
    let text = text_id.map(|t| (t, loaded.as_ref()));
    u.with_conn(|c| gate_verdict(c, group, id, own, text, true))?
        .map_err(refused)
}

fn refused(code: &'static str) -> ClientError {
    ClientError::new(code, "")
}

fn not_call() -> ClientError {
    ClientError::new(E_CORE_INPUT, "not a call group")
}

fn state(n: i64) -> ClientError {
    ClientError::new(E_CORE_STATE, format!("group state {n}"))
}

impl ClientCore {
    /// `group_create` for a call group: kind call, media version 1, the row written with kind 1.
    pub fn call_group_create(
        &mut self,
        id: &[u8; 16],
        community: Option<&[u8; 16]>,
        channel: &[u8; 16],
        policy: u64,
        external_sender_pub: &[u8; 32],
    ) -> Result<Vec<u8>, ClientError> {
        self.group_create_kind(
            id,
            community,
            channel,
            policy,
            external_sender_pub,
            GroupKind::Call,
        )
    }

    /// `group_join_external` for a call group, gated in the join's unit (`join_gate`): a pending
    /// leaf is tolerated (the group is staged, the commit returned unposted for `call_join_check`),
    /// every other refusal rolls the join back.
    pub fn call_group_join_external(
        &mut self,
        id: &[u8; 16],
        community: Option<&[u8; 16]>,
        channel: &[u8; 16],
        policy: u64,
        info_body: &[u8],
        tree_body: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        self.group_join_kind(
            id,
            community,
            channel,
            policy,
            info_body,
            tree_body,
            GroupKind::Call,
        )
    }

    /// The row of a call group: `E_CORE_NOT_FOUND` for an unknown id, `E_CORE_INPUT` for a group
    /// that is not a call group.
    fn call_row(&self, id: &[u8; 16]) -> Result<GroupRow, ClientError> {
        let row = self
            .read(|c| group_row(c, id))?
            .ok_or_else(|| ClientError::new(E_CORE_NOT_FOUND, ""))?;
        if row.kind != row_kind(GroupKind::Call) {
            return Err(not_call());
        }
        Ok(row)
    }

    /// The call group's MLS state: the cache, else the store, checked against its row.
    fn call_group<'a>(
        &'a self,
        id: &[u8; 16],
        row: &GroupRow,
        slot: &'a mut Option<DillaGroup>,
    ) -> Result<&'a DillaGroup, ClientError> {
        if let Some(group) = self.groups.get(id) {
            return Ok(group);
        }
        let group = DillaGroup::load(&self.provider, &GroupId::from_slice(id))?
            .ok_or_else(|| ClientError::new(E_CORE_NOT_FOUND, ""))?;
        if !super::matches_row(&group, id, row) {
            return Err(super::mismatched());
        }
        Ok(slot.insert(group))
    }

    /// The call gate over the core's own live tree (`gate_verdict`, nothing tolerated).
    fn call_gate(&self, group: &DillaGroup, id: &[u8; 16]) -> Result<(), ClientError> {
        let own = self.own()?;
        let text_id = self.read(|c| dm_text_id(c, group, id))?;
        let loaded = match text_id {
            Some(t) if !self.groups.contains_key(&t) => {
                DillaGroup::load(&self.provider, &GroupId::from_slice(&t)).unwrap_or(None)
            }
            _ => None,
        };
        let text = text_id.map(|t| (t, self.groups.get(&t).or(loaded.as_ref())));
        self.read(|c| gate_verdict(c, group, id, &own, text, false))?
            .map_err(refused)
    }

    /// CBOR `[epoch, base_key(16), own_leaf, [[leaf, device_id, user_id]], code]` of the active call
    /// group's current epoch, where `code` is the SAS of its `epoch_authenticator` as 6 groups of
    /// 5 digits. Refused by the call gate before any key byte is derived.
    pub fn call_media_epoch(&self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        let row = self.call_row(id)?;
        if row.state != STATE_ACTIVE {
            return Err(state(row.state));
        }
        let mut slot = None;
        let group = self.call_group(id, &row, &mut slot)?;
        self.call_gate(group, id)?;
        #[cfg(feature = "test-hooks")]
        DERIVED.with(|d| d.set(d.get() + 1));
        let media = group.media_epoch(&self.provider)?;
        let code = group_digits(&sas(&group.epoch_authenticator()?), DISPLAY_GROUP);
        // Sized up front so the buffer holding the key never reallocates and leaves a copy behind.
        let mut e = Encoder::with_capacity(96 + 48 * media.roster.len());
        e.array(5)
            .uint(media.epoch)
            .bytes(&media.base_key[..])
            .uint(u64::from(media.own_leaf));
        e.array(media.roster.len());
        for entry in &media.roster {
            e.array(3)
                .uint(u64::from(entry.leaf_index))
                .bytes(entry.device_id.as_bytes())
                .bytes(entry.user_id.as_bytes());
        }
        e.text(&code);
        Ok(e.into_vec())
    }

    /// The full call gate on a staged call group (joined locally, its external commit not yet
    /// posted): the worker posts the commit only when this passes (ruling RV-1). `E_CORE_STATE`
    /// for a call group in any other state.
    pub fn call_join_check(&self, id: &[u8; 16]) -> Result<(), ClientError> {
        let row = self.call_row(id)?;
        if row.state != STATE_JOINING {
            return Err(state(row.state));
        }
        let mut slot = None;
        let group = self.call_group(id, &row, &mut slot)?;
        self.call_gate(group, id)
    }

    /// CBOR `[epoch, proposal]`: a `Remove` of this device's own leaf, for
    /// `POST /v1/groups/{id}/proposal`. Another member commits it.
    pub fn call_leave_proposal(&mut self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.own()?;
        let row = self.call_row(id)?;
        if row.state != STATE_ACTIVE {
            return Err(state(row.state));
        }
        self.signer()?;
        self.retry_reload(id, |this| {
            let mut group = this
                .take_group(id)?
                .ok_or_else(|| ClientError::new(E_CORE_NOT_FOUND, ""))?;
            let result = this.write(|ctx, _| {
                let signer = ctx
                    .signer
                    .ok_or_else(|| ClientError::new(E_CORE_NO_IDENTITY, ""))?;
                let epoch = group.epoch();
                let proposal = wire::tls(&group.leave(ctx.provider, signer)?)?;
                let mut e = Encoder::new();
                e.array(2).uint(epoch).bytes(&proposal);
                Ok(e.into_vec())
            });
            if result.is_ok() {
                this.keep_group(*id, group);
            }
            result
        })
    }

    /// An empty commit with an UpdatePath (a fresh leaf secret), in `commit_build`'s body shape;
    /// confirmed with `commit_confirm` or dropped with `commit_abort`.
    pub fn call_rotate(&mut self, id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        self.call_row(id)?;
        // An empty `[proposals]` body: the rotation commits only what is already queued.
        self.commit_build_inner(id, &[0x80], true)
    }

    /// Deletes the call group's MLS state and sets its row to gone (state 4); its channel's next
    /// call group can then be created or joined. A gone row stays gone.
    pub fn call_group_forget(&mut self, id: &[u8; 16]) -> Result<(), ClientError> {
        self.own()?;
        let row = self.call_row(id)?;
        if row.state == STATE_GONE {
            return Ok(());
        }
        let mut group = self.take_group_unchecked(id)?;
        self.write(|ctx, u| {
            if let Some(g) = group.as_mut() {
                g.delete(ctx.provider)?;
            }
            u.with_conn(|c| {
                c.execute(
                    "DELETE FROM app_proposals WHERE group_id=?1",
                    [id.as_slice()],
                )?;
                c.execute(
                    "DELETE FROM app_handshake_tail WHERE group_id=?1",
                    [id.as_slice()],
                )?;
                c.execute(
                    "UPDATE app_groups SET state=?2,resync=0,was_gone=0,epoch=0,pending_commit=0 \
                     WHERE group_id=?1",
                    params![id.as_slice(), STATE_GONE],
                )?;
                Ok(())
            })?;
            Ok(())
        })
    }
}
