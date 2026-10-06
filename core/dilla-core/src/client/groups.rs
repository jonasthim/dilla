//! Local group lifecycle and Welcome acceptance.

use super::error::{E_CORE_INPUT, E_CORE_NOT_FOUND, E_CORE_STATE};
use super::{ClientCore, ClientError, Own, wire};
use crate::cbor::Encoder;
use crate::ids::{CommunityId, InstanceId};
use crate::mls::{
    DillaBinding, DillaGroup, GroupKind, StorageError, UnitScope, WelcomeLabel, external_senders,
};
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::*;
use rusqlite::{OptionalExtension, params};
use tls_codec::Deserialize as _;

pub(crate) const STATE_REGISTERING: i64 = 0;
pub(crate) const STATE_JOINING: i64 = 1;
pub(crate) const STATE_ACTIVE: i64 = 2;
pub(crate) const STATE_NEEDS_RESYNC: i64 = 3;
#[allow(dead_code)] // Task 6 consumes the gone state.
pub(crate) const STATE_GONE: i64 = 4;

#[allow(dead_code)] // The full persisted row is shared with task 6.
#[derive(Clone)]
pub(super) struct GroupRow {
    pub kind: i64,
    pub community_id: Option<Vec<u8>>,
    pub target_id: Vec<u8>,
    pub state: i64,
    pub next_seq: i64,
    pub resync: i64,
    pub was_gone: i64,
    pub max_epoch: i64,
}
impl GroupRow {
    /// Whether the row is the text group of `channel` in `community`: a join never changes this.
    fn bound_to(&self, community: &[u8; 16], channel: &[u8; 16]) -> bool {
        self.kind == 0
            && self.community_id.as_deref() == Some(community.as_slice())
            && self.target_id.as_slice() == channel.as_slice()
    }
}
fn rebound() -> ClientError {
    ClientError::new(E_CORE_STATE, "group is bound to another channel")
}
/// The lowest epoch a rejoin may land in: the highest this device has held for the group (the
/// row's `max_epoch`, and the stale group's epoch while it is still stored).
fn epoch_floor(row: Option<&GroupRow>, prior: Option<&DillaGroup>) -> u64 {
    let stored = row.map_or(0, |r| u64::try_from(r.max_epoch).unwrap_or(0));
    stored.max(prior.map_or(0, DillaGroup::epoch))
}
fn below_floor(what: &str) -> ClientError {
    ClientError::new(
        E_CORE_INPUT,
        format!("{what} would rejoin at or below an epoch this device has held"),
    )
}
pub(super) fn group_row(
    c: &rusqlite::Connection,
    id: &[u8; 16],
) -> Result<Option<GroupRow>, StorageError> {
    c.query_row(
        "SELECT kind, community_id, target_id, state, next_seq, resync, was_gone, max_epoch \
         FROM app_groups WHERE group_id = ?1",
        [id.as_slice()],
        |r| {
            Ok(GroupRow {
                kind: r.get(0)?,
                community_id: r.get(1)?,
                target_id: r.get(2)?,
                state: r.get(3)?,
                next_seq: r.get(4)?,
                resync: r.get(5)?,
                was_gone: r.get(6)?,
                max_epoch: r.get(7)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}
fn holder(
    c: &rusqlite::Connection,
    channel: &[u8; 16],
    except: &[u8; 16],
) -> Result<Option<Vec<u8>>, StorageError> {
    c.query_row(
        "SELECT group_id FROM app_groups \
         WHERE target_id = ?1 AND kind = 0 AND state <> 4 AND group_id <> ?2",
        params![channel.as_slice(), except.as_slice()],
        |r| r.get(0),
    )
    .optional()
    .map_err(Into::into)
}
fn binding(own: &Own, community: &[u8; 16], channel: &[u8; 16], policy: u64) -> DillaBinding {
    DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes(own.instance_id),
        community_id: Some(CommunityId::from_bytes(*community)),
        target_id: *channel,
        kind: GroupKind::Text,
        policy_version: policy,
        e2ee_version: 1,
        media_version: 0,
    }
}
fn credential(own: &Own) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(own.credential.clone()).into(),
        signature_key: own.dsk_pub.to_vec().into(),
    }
}
pub(super) fn checked(name: &str, v: u64) -> Result<i64, ClientError> {
    i64::try_from(v).map_err(|_| ClientError::new(E_CORE_INPUT, format!("{name} out of range")))
}
fn missing() -> ClientError {
    ClientError::new(E_CORE_NOT_FOUND, "")
}
fn state(n: i64) -> ClientError {
    ClientError::new(E_CORE_STATE, format!("group state {n}"))
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, ClientError> {
    let m = MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| ClientError::new(E_CORE_INPUT, "group_info is not an MLS GroupInfo"))?;
    match m.extract() {
        MlsMessageBodyIn::GroupInfo(v) => Ok(v),
        _ => Err(ClientError::new(
            E_CORE_INPUT,
            "group_info is not an MLS GroupInfo",
        )),
    }
}
fn tree(bytes: &[u8]) -> Result<RatchetTreeIn, ClientError> {
    RatchetTreeIn::tls_deserialize_exact(bytes)
        .map_err(|_| ClientError::new(E_CORE_INPUT, "ratchet_tree is not a TLS RatchetTree"))
}
fn welcome(bytes: &[u8]) -> Result<Welcome, ClientError> {
    let m = MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| ClientError::new(E_CORE_INPUT, "blob is not an MLS Welcome"))?;
    match m.extract() {
        MlsMessageBodyIn::Welcome(v) => Ok(v),
        _ => Err(ClientError::new(E_CORE_INPUT, "blob is not an MLS Welcome")),
    }
}
fn in_unit<T>(
    u: &UnitScope<'_>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
) -> Result<T, ClientError> {
    u.with_conn(f).map_err(Into::into)
}

pub(super) fn set_mls(
    c: &rusqlite::Connection,
    id: &[u8; 16],
    epoch: i64,
    pending: bool,
) -> Result<(), StorageError> {
    c.execute(
        "UPDATE app_groups SET epoch = ?2, pending_commit = ?3 WHERE group_id = ?1",
        params![id.as_slice(), epoch, i64::from(pending)],
    )?;
    Ok(())
}
pub(super) fn set_pending(
    c: &rusqlite::Connection,
    id: &[u8; 16],
    pending: bool,
) -> Result<(), StorageError> {
    c.execute(
        "UPDATE app_groups SET pending_commit = ?2 WHERE group_id = ?1",
        params![id.as_slice(), i64::from(pending)],
    )?;
    Ok(())
}

/// The select of one `groups()` row, as a macro so each query is one literal (`concat!`), not a
/// `format!` at run time.
macro_rules! listed {
    ($tail:literal) => {
        concat!(
            "SELECT group_id, kind, community_id, target_id, state, epoch, next_seq, \
             (SELECT COUNT(*) FROM app_proposals WHERE app_proposals.group_id = app_groups.group_id), \
             pending_commit FROM app_groups ",
            $tail
        )
    };
}
type ListedGroup = (
    [u8; 16],
    i64,
    Option<Vec<u8>>,
    Vec<u8>,
    i64,
    i64,
    i64,
    i64,
    i64,
);
fn listed_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ListedGroup> {
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
    ))
}
fn encode_listed(e: &mut Encoder, row: &ListedGroup) {
    let (id, kind, community, target, state, epoch, next, proposals, pending) = row;
    e.array(9)
        .bytes(id)
        .uint(*kind as u64)
        .opt_bytes(community.as_deref())
        .bytes(target)
        .uint(*state as u64)
        .uint(*epoch as u64)
        .uint(*next as u64)
        .uint(*proposals as u64)
        .uint(*pending as u64);
}

impl ClientCore {
    /// [[group_id b16, kind uint, community_id b16|null, target_id b16, state uint, epoch uint,
    ///   next_seq uint, proposals_pending uint, pending_commit uint 0|1]] ordered by group_id —
    /// epoch and pending_commit are app_groups.epoch and app_groups.pending_commit; no MLS state is loaded.
    pub fn groups(&self) -> Result<Vec<u8>, ClientError> {
        let rows: Vec<ListedGroup> = self.read(|c| {
            let mut s = c.prepare(listed!("ORDER BY group_id"))?;
            let it = s.query_map([], listed_row)?;
            it.collect::<Result<_, _>>().map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for row in &rows {
            encode_listed(&mut e, row);
        }
        Ok(e.into_vec())
    }

    /// CBOR null for an unknown id, else the one row of groups() for it (the same 9 elements).
    pub fn group_row(&self, group_id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        let row: Option<ListedGroup> = self.read(|c| {
            c.query_row(
                listed!("WHERE group_id = ?1"),
                [group_id.as_slice()],
                listed_row,
            )
            .optional()
            .map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        match row {
            Some(row) => encode_listed(&mut e, &row),
            None => {
                e.null();
            }
        }
        Ok(e.into_vec())
    }

    pub fn group_create(
        &mut self,
        id: &[u8; 16],
        community: &[u8; 16],
        channel: &[u8; 16],
        policy: u64,
        external: &[u8; 32],
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        let row = self.read(|c| group_row(c, id))?;
        if let Some(r) = row {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("group exists in state {}", r.state),
            ));
        }
        if let Some(h) = self.read(|c| holder(c, channel, id))? {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("channel has group {}", hex(&h)),
            ));
        }
        let bind = binding(&own, community, channel, policy);
        self.signer()?;
        let (g, info, tree) = self.write(|ctx, u| {
            let signer = ctx
                .signer
                .ok_or_else(|| ClientError::new(super::error::E_CORE_NO_IDENTITY, ""))?;
            let g = DillaGroup::create(
                ctx.provider,
                signer,
                credential(&own),
                GroupId::from_slice(id),
                bind.clone(),
                Some(external_senders(
                    SignaturePublicKey::from(&external[..]),
                    &bind.instance_id,
                )),
            )?;
            let info = wire::tls(&g.export_group_info(ctx.provider, signer)?)?;
            let tree = wire::tls(&g.export_ratchet_tree())?;
            in_unit(u, |c| {
                c.execute(
                    "INSERT INTO app_groups(group_id,kind,community_id,target_id,state) \
                     VALUES(?1,0,?2,?3,0)",
                    params![id.as_slice(), community.as_slice(), channel.as_slice()],
                )?;
                Ok(())
            })?;
            Ok::<_, ClientError>((g, info, tree))
        })?;
        self.keep_group(*id, g);
        let mut e = Encoder::new();
        e.array(4)
            .bytes(id)
            .bytes(&bind.encode())
            .bytes(&info)
            .bytes(&tree);
        Ok(e.into_vec())
    }

    pub fn group_registered(&mut self, id: &[u8; 16], next_seq: u64) -> Result<(), ClientError> {
        self.own()?;
        let next = checked("next_seq", next_seq)?;
        if next < 1 {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "next_seq must be at least 1",
            ));
        }
        let r = self.read(|c| group_row(c, id))?.ok_or_else(missing)?;
        if r.state != STATE_REGISTERING {
            return Err(state(r.state));
        }
        self.write(|_, u| {
            in_unit(u, |c| {
                c.execute(
                    "UPDATE app_groups SET state=2,next_seq=?2 WHERE group_id=?1",
                    params![id.as_slice(), next],
                )?;
                Ok(())
            })
        })
    }

    pub fn group_discard(&mut self, id: &[u8; 16]) -> Result<(), ClientError> {
        self.own()?;
        let r = self.read(|c| group_row(c, id))?.ok_or_else(missing)?;
        if r.state != STATE_REGISTERING && r.state != STATE_JOINING {
            return Err(state(r.state));
        }
        let mut group = self.take_group_unchecked(id)?;
        self.write(|ctx, u| {
            if let Some(g) = group.as_mut() {
                g.delete(ctx.provider)?;
            }
            in_unit(u, |c| {
                c.execute(
                    "DELETE FROM app_proposals WHERE group_id=?1",
                    [id.as_slice()],
                )?;
                if r.state == STATE_JOINING && r.resync == 1 {
                    c.execute(
                        "UPDATE app_groups SET state=3,resync=0,epoch=0,pending_commit=0 WHERE group_id=?1",
                        [id.as_slice()],
                    )?;
                } else if r.state == STATE_JOINING && r.was_gone == 1 {
                    // A rejoin of a gone row that did not complete: the row goes back to gone with
                    // its timeline and outbox (history outranks the discard of a fresh join).
                    c.execute(
                        "UPDATE app_groups SET state=4,was_gone=0,epoch=0,pending_commit=0 WHERE group_id=?1",
                        [id.as_slice()],
                    )?;
                } else {
                    for table in ["app_handshake_tail", "app_messages", "app_outbox"] {
                        c.execute(
                            &format!("DELETE FROM {table} WHERE group_id=?1"),
                            [id.as_slice()],
                        )?;
                    }
                    c.execute("DELETE FROM app_groups WHERE group_id=?1", [id.as_slice()])?;
                }
                Ok(())
            })
        })
    }

    pub fn group_join_external(
        &mut self,
        id: &[u8; 16],
        community: &[u8; 16],
        channel: &[u8; 16],
        policy: u64,
        info_body: &[u8],
        tree_body: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        let info = wire::decode_info_body(info_body)?;
        let tree_body = wire::decode_tree_body(tree_body)?;
        if info.epoch != tree_body.epoch || info.tree_hash != tree_body.tree_hash {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "info_body and tree_body disagree",
            ));
        }
        let gi = group_info(&info.group_info)?;
        // The group this GroupInfo describes must be the one the join is for; checked before
        // anything is joined or written (OpenMLS would store the joined state under the
        // GroupInfo's own id).
        if gi.group_id().as_slice() != id {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "GroupInfo group id does not match",
            ));
        }
        let tree = tree(&tree_body.ratchet_tree)?;
        let r = self.read(|c| group_row(c, id))?;
        if let Some(r) = &r
            && (r.state == STATE_REGISTERING || r.state == STATE_JOINING)
        {
            return Err(state(r.state));
        }
        if let Some(r) = &r
            && !r.bound_to(community, channel)
        {
            return Err(rebound());
        }
        if let Some(h) = self.read(|c| holder(c, channel, id))? {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("channel has group {}", hex(&h)),
            ));
        }
        let mut prior = self.take_group_unchecked(id)?;
        // The join lands this device in epoch e + 1 of a GroupInfo at e: refused when e + 1 is
        // not above the highest epoch held, so a GroupInfo at exactly that epoch is accepted.
        let info_epoch = gi.epoch().as_u64();
        if r.is_some() && info_epoch < epoch_floor(r.as_ref(), prior.as_ref()) {
            // Not put back in the cache: it was taken unchecked; the next use reloads it.
            return Err(below_floor("GroupInfo"));
        }
        let bind = binding(&own, community, channel, policy);
        let result = self.write(|ctx, u| {
            let signer = ctx
                .signer
                .ok_or_else(|| ClientError::new(super::error::E_CORE_NO_IDENTITY, ""))?;
            let resync = matches!(
                r.as_ref().map(|r| r.state),
                Some(STATE_ACTIVE | STATE_NEEDS_RESYNC)
            );
            // The stale group's epoch is already the floor (written when it was reached), so it
            // survives this deletion and a discard of the join. The joined epoch is not held
            // until the server accepts the external commit: group_joined records it.
            if resync && let Some(g) = prior.as_mut() {
                g.delete(ctx.provider)?;
            }
            let (g, commit, _) = DillaGroup::join_by_external_commit(
                ctx.provider,
                signer,
                credential(&own),
                gi,
                tree,
                &bind,
            )?;
            let joined = checked("epoch", g.epoch())?;
            let commit = wire::tls(&commit)?;
            let exported = wire::tls(&g.export_group_info(ctx.provider, signer)?)?;
            in_unit(u, |c| {
                c.execute(
                    "DELETE FROM app_proposals WHERE group_id=?1",
                    [id.as_slice()],
                )?;
                if let Some(r) = &r {
                    // The row's binding (kind, community, target) was checked equal above and
                    // is never rewritten by a join.
                    let was_gone = r.state == STATE_GONE;
                    c.execute(
                        "UPDATE app_groups SET state=1,resync=?2,was_gone=?3,epoch=?4,pending_commit=0 WHERE group_id=?1",
                        params![id.as_slice(), i64::from(resync), i64::from(was_gone), joined],
                    )?;
                } else {
                    c.execute(
                        "INSERT INTO app_groups(group_id,kind,community_id,target_id,state,epoch) \
                         VALUES(?1,0,?2,?3,1,?4)",
                        params![id.as_slice(), community.as_slice(), channel.as_slice(), joined],
                    )?;
                }
                Ok(())
            })?;
            Ok::<_, ClientError>((g, commit, exported))
        })?;
        self.keep_group(*id, result.0);
        let mut e = Encoder::new();
        e.array(2).bytes(&result.1).bytes(&result.2);
        Ok(e.into_vec())
    }

    pub fn group_joined(&mut self, id: &[u8; 16], seq: u64) -> Result<(), ClientError> {
        self.own()?;
        let seq = checked("seq", seq)?;
        if seq < 1 || seq == i64::MAX {
            return Err(ClientError::new(E_CORE_INPUT, "seq out of range"));
        }
        let r = self.read(|c| group_row(c, id))?.ok_or_else(missing)?;
        if r.state != STATE_JOINING {
            return Err(state(r.state));
        }
        // The server accepted the external commit: its epoch is now held (F6 floor).
        let loaded;
        let joined = match self.groups.get(id) {
            Some(g) => Some(g),
            None => {
                loaded = DillaGroup::load(&self.provider, &GroupId::from_slice(id))?;
                loaded.as_ref()
            }
        };
        let held = checked("epoch", joined.map_or(0, DillaGroup::epoch))?;
        self.write(|_, u| {
            in_unit(u, |c| {
                // next_seq never moves back: rows below the stored value were applied or skipped.
                c.execute(
                    "UPDATE app_groups SET state=2,next_seq=MAX(next_seq,?2),resync=0, \
                     was_gone=0,max_epoch=MAX(max_epoch,?3),epoch=?3 WHERE group_id=?1",
                    params![id.as_slice(), seq + 1, held],
                )?;
                Ok(())
            })
        })
    }

    pub fn welcomes_apply(
        &mut self,
        welcomes_body: &[u8],
        expected: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        let own = self.own()?;
        let items = wire::decode_welcomes_body(welcomes_body)?;
        let expected = wire::decode_expected(expected)?;
        let mut e = Encoder::new();
        e.array(items.len());
        for item in items {
            let mut outcome = 3;
            let mut reason = "";
            if let Some(want) = expected.iter().find(|v| v.group_id == item.group_id) {
                let id = &item.group_id;
                let row = self.read(|c| group_row(c, id))?;
                if row.as_ref().is_some_and(|r| r.state <= STATE_ACTIVE) {
                    outcome = 1;
                } else if row
                    .as_ref()
                    .is_some_and(|r| !r.bound_to(&want.community_id, &want.channel_id))
                {
                    outcome = 2;
                    reason = rebound().code;
                } else if self.read(|c| holder(c, &want.channel_id, id))?.is_some() {
                    outcome = 2;
                    reason = E_CORE_STATE;
                } else {
                    let parsed =
                        welcome(&item.blob).and_then(|w| tree(&item.ratchet_tree).map(|t| (w, t)));
                    match parsed {
                        Err(err) => {
                            outcome = 2;
                            reason = err.code;
                        }
                        Ok((w, t)) => {
                            let mut prior = self.take_group_unchecked(id)?;
                            let floor = epoch_floor(row.as_ref(), prior.as_ref());
                            let bind = binding(
                                &own,
                                &want.community_id,
                                &want.channel_id,
                                want.policy_version,
                            );
                            let next = checked("commit_seq", item.commit_seq).and_then(|n| {
                                n.checked_add(1).ok_or_else(|| {
                                    ClientError::new(E_CORE_INPUT, "commit_seq out of range")
                                })
                            });
                            let result = next.and_then(|next| {
                                self.write(|ctx, u| {
                                    if let Some(g) = prior.as_mut() {
                                        g.delete(ctx.provider)?;
                                    }
                                    // The Welcome's group id, epoch and tree hash are inside its
                                    // encrypted GroupInfo, so they are compared with the served
                                    // label on the staged welcome (id: E_BINDING; epoch or tree
                                    // hash: E_CORE_INPUT). Any refusal here rolls the whole unit
                                    // back: the KeyPackage and keys OpenMLS consumed while
                                    // staging, the deleted prior, and no floor is raised.
                                    let g = DillaGroup::join_from_welcome_labelled(
                                        ctx.provider,
                                        w,
                                        t,
                                        &bind,
                                        WelcomeLabel {
                                            group_id: id.as_slice(),
                                            epoch: item.epoch,
                                            tree_hash: item.tree_hash.as_slice(),
                                        },
                                    )?;
                                    // With the epoch the server's (checked above): over an
                                    // existing row, a Welcome
                                    // into an epoch at or below one this device has held is a
                                    // replay (a real re-admission is committed after the last
                                    // held epoch), rolled back the same way.
                                    if row.is_some() && g.epoch() <= floor {
                                        return Err(below_floor("Welcome"));
                                    }
                                    let held = checked("epoch", g.epoch())?;
                                    in_unit(u, |c| {
                                        c.execute(
                                            "DELETE FROM app_proposals WHERE group_id=?1",
                                            [id.as_slice()],
                                        )?;
                                        if row.is_some() {
                                            // The binding was checked equal to the row's above.
                                            c.execute(
                                                "UPDATE app_groups SET state=2, \
                                                 next_seq=MAX(next_seq,?2),resync=0, \
                                                 max_epoch=MAX(max_epoch,?3),epoch=?3,pending_commit=0 WHERE group_id=?1",
                                                params![id.as_slice(), next, held],
                                            )?;
                                        } else {
                                            c.execute(
                                                "INSERT INTO app_groups \
                                                 (group_id,kind,community_id,target_id,state, \
                                                 next_seq,max_epoch,epoch) \
                                                 VALUES(?1,0,?2,?3,2,?4,?5,?5)",
                                                params![
                                                    id.as_slice(),
                                                    want.community_id.as_slice(),
                                                    want.channel_id.as_slice(),
                                                    next,
                                                    held,
                                                ],
                                            )?;
                                        }
                                        Ok(())
                                    })?;
                                    Ok::<_, ClientError>(g)
                                })
                            });
                            match result {
                                Ok(g) => {
                                    self.keep_group(*id, g);
                                    outcome = 0;
                                }
                                Err(err) => {
                                    if err.code == super::error::E_CORE_STORAGE
                                        || err.code == super::error::E_CORE_RELOAD
                                    {
                                        return Err(err);
                                    }
                                    outcome = 2;
                                    reason = err.code;
                                }
                            }
                        }
                    }
                }
            }
            e.array(4)
                .uint(item.welcome_id)
                .bytes(&item.group_id)
                .uint(outcome)
                .text(reason);
        }
        Ok(e.into_vec())
    }
}
