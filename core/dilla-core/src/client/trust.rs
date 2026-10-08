//! Authenticated leaf trust and device-list history.

use super::error::{
    E_CORE_LIMIT, E_CORE_NOT_FOUND, E_CORE_STORAGE, E_CREDENTIAL, E_DEVICE_LIST_STALE,
    E_DEVICE_UNLISTED, E_TIER_MISMATCH, E_UMK_CHANGED,
};
use super::{ClientCore, ClientError, schema, wire};
use crate::cbor::Encoder;
use crate::identity::{CredentialIdentity, DISPLAY_GROUP, DeviceList, group_digits, safety_number};
use crate::mls::{DillaGroup, StorageError};
use crate::mls::{DillaProcessed, ReceivedApplication};
use openmls::prelude::{BasicCredential, GroupId, KeyPackage, Member};
use rusqlite::{OptionalExtension, params};

#[derive(Clone)]
pub(crate) struct LeafEvidence {
    group_id: [u8; 16],
    epoch: u64,
    tree_hash: [u8; 32],
    leaf_index: u32,
    credential: CredentialIdentity,
    dsk_pub: [u8; 32],
}

#[derive(Debug)]
pub(crate) struct ValidatedLeaf {
    user_id: [u8; 16],
    device_id: [u8; 16],
    umk_pub: [u8; 32],
    ssk_pub: [u8; 32],
    version: u64,
}

type CachedList = (i64, Vec<u8>, [u8; 32], [u8; 32]);
type TrustRow = ([u8; 16], [u8; 32], i64, i64, Option<[u8; 32]>);
type RetractedRow = (i64, Option<[u8; 16]>, Option<[u8; 16]>);

fn failure(code: &'static str) -> ClientError {
    ClientError::new(code, "")
}

/// Verify every signed link against the authenticated leaf and the exact candidate head.
#[allow(dead_code)] // L-CORE-44 direct-verifier test seam.
pub(crate) fn validate_history(
    leaf: &LeafEvidence,
    requested_user: &[u8; 16],
    history: &[DeviceList],
    head: &DeviceList,
) -> Result<ValidatedLeaf, ClientError> {
    validate_history_from(leaf, requested_user, history, head, None)
}

fn validate_history_from(
    leaf: &LeafEvidence,
    requested_user: &[u8; 16],
    history: &[DeviceList],
    head: &DeviceList,
    cached_anchor: Option<&DeviceList>,
) -> Result<ValidatedLeaf, ClientError> {
    let cred = &leaf.credential;
    if cred.user_id.as_bytes() != requested_user {
        return Err(failure(E_CREDENTIAL));
    }
    cred.verify_signatures(&leaf.dsk_pub)
        .map_err(|_| failure(E_CREDENTIAL))?;
    if history.is_empty() {
        return Err(failure(E_DEVICE_LIST_STALE));
    }
    if history.len() > 1024
        || history.iter().map(|l| l.encode().len()).sum::<usize>() > 4 * 1024 * 1024
    {
        return Err(failure(E_CORE_LIMIT));
    }
    let mut previous = cached_anchor;
    for list in history.iter().skip(usize::from(cached_anchor.is_some())) {
        if list.unsigned.user_id.as_bytes() != requested_user {
            return Err(failure(E_CREDENTIAL));
        }
        let expected = previous.map_or(1, |p| p.unsigned.version + 1);
        if list.unsigned.version != expected {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        list.accept(previous, &cred.ssk_pub)
            .map_err(ClientError::from)?;
        previous = Some(list);
    }
    let current = previous.expect("history is nonempty");
    if current.encode() != head.encode() || current.hash() != head.hash() {
        return Err(failure(E_DEVICE_LIST_STALE));
    }
    let entry = current
        .lookup(&cred.device_id)
        .ok_or_else(|| failure(E_DEVICE_UNLISTED))?;
    if entry.dsk_pub != leaf.dsk_pub {
        return Err(failure(E_CREDENTIAL));
    }
    if entry.tier != cred.tier {
        return Err(failure(E_TIER_MISMATCH));
    }
    current
        .check_leaf(&cred.device_id, &leaf.dsk_pub, cred.tier)
        .map_err(ClientError::from)?;
    Ok(ValidatedLeaf {
        user_id: *requested_user,
        device_id: *cred.device_id.as_bytes(),
        umk_pub: cred.umk_pub,
        ssk_pub: cred.ssk_pub,
        version: current.unsigned.version,
    })
}

/// Neutralize already accepted rows from a quarantined leaf in the caller's write unit.
pub(super) fn retract_device(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    device_id: &[u8; 16],
    code: &str,
) -> Result<(), StorageError> {
    let mut stmt = c.prepare(
        "SELECT seq,msg_id,reply_to FROM app_messages WHERE group_id=?1 AND sender_device=?2 AND status=0",
    )?;
    let rows: Vec<RetractedRow> = stmt
        .query_map(params![group_id.as_slice(), device_id.as_slice()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (seq, own_id, reply_to) in rows {
        c.execute("UPDATE app_messages SET status=1,reason=?3,body='',envelope=NULL,edit_body=NULL,mention=0 WHERE group_id=?1 AND seq=?2", params![group_id.as_slice(),seq,code])?;
        c.execute(
            "DELETE FROM app_search_rows WHERE group_id=?1 AND seq=?2",
            params![group_id.as_slice(), seq],
        )?;
        for target in [own_id, reply_to].into_iter().flatten() {
            super::fold::refold(
                c,
                group_id,
                &target,
                &super::fold::FoldScope::Full,
                None,
                None,
            )?;
            if let Some(row) = super::fold::resolve(c, group_id, &target)? {
                super::search::index_fold(c, group_id, row.seq)?;
            }
        }
    }
    Ok(())
}

/// Persist a failed authenticated-leaf verdict with its historical retraction.
/// The caller owns the same write unit as the unreadable incoming row.
pub(super) fn quarantine_device(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    device_id: &[u8; 16],
    code: &str,
) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_quarantine(group_id,device_id,code) VALUES(?1,?2,?3) \
         ON CONFLICT(group_id,device_id) DO UPDATE SET code=excluded.code",
        params![group_id.as_slice(), device_id.as_slice(), code],
    )?;
    retract_device(c, group_id, device_id, code)?;
    bump_generation(c)?;
    Ok(())
}

pub(super) fn bump_generation(c: &rusqlite::Connection) -> Result<(), StorageError> {
    let generation = schema::meta_get(c, "trust_generation")?
        .and_then(|v| crate::cbor::decode_strict(&v, |d| d.uint()).ok())
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| StorageError::Codec("trust generation overflow".into()))?;
    let mut encoded = Encoder::new();
    encoded.uint(generation);
    schema::meta_put(c, "trust_generation", &encoded.into_vec())
}

/// A verified Remove releases only the affected group's changed-key send block.
pub(super) fn clear_group_block(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    device_id: &[u8; 16],
) -> Result<(), StorageError> {
    let changed = c.execute(
        "DELETE FROM app_quarantine WHERE group_id=?1 AND device_id=?2 AND code='E_UMK_CHANGED'",
        params![group_id.as_slice(), device_id.as_slice()],
    )?;
    if changed > 0 {
        bump_generation(c)?;
    }
    Ok(())
}

pub(super) fn member_devices(group: &DillaGroup) -> Vec<[u8; 16]> {
    group
        .members()
        .into_iter()
        .filter_map(|member| {
            let basic = BasicCredential::try_from(member.credential).ok()?;
            let identity = CredentialIdentity::decode(basic.identity()).ok()?;
            Some(*identity.device_id.as_bytes())
        })
        .collect()
}

fn extract_leaf(
    group_id: &[u8; 16],
    group: &DillaGroup,
    tree_hash: [u8; 32],
    member: Member,
) -> Result<LeafEvidence, ClientError> {
    let basic = BasicCredential::try_from(member.credential).map_err(|_| failure(E_CREDENTIAL))?;
    let credential =
        CredentialIdentity::decode(basic.identity()).map_err(|_| failure(E_CREDENTIAL))?;
    let dsk_pub: [u8; 32] = member
        .signature_key
        .as_slice()
        .try_into()
        .map_err(|_| failure(E_CREDENTIAL))?;
    Ok(LeafEvidence {
        group_id: *group_id,
        epoch: group.epoch(),
        tree_hash,
        leaf_index: member.index.u32(),
        credential,
        dsk_pub,
    })
}

/// Recheck the authenticated application sender and the current signed-list cache before display.
pub(super) fn validate_cached_sender(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
    received: &ReceivedApplication,
) -> Result<(), ClientError> {
    let member = group
        .member_at(received.sender_leaf)
        .ok_or_else(|| failure(E_CREDENTIAL))?;
    let leaf = extract_leaf(group_id, group, [0; 32], member)?;
    if leaf.credential != received.sender {
        return Err(failure(E_CREDENTIAL));
    }
    validate_cached_leaf(c, &leaf)
}

fn validate_cached_leaf(c: &rusqlite::Connection, leaf: &LeafEvidence) -> Result<(), ClientError> {
    leaf.credential
        .verify_signatures(&leaf.dsk_pub)
        .map_err(|_| failure(E_CREDENTIAL))?;
    let user = leaf.credential.user_id.as_bytes();
    let cached: Option<(Vec<u8>, [u8; 32], [u8; 32])> = c
        .query_row(
            "SELECT list,umk_pub,ssk_pub FROM app_device_lists WHERE user_id=?1",
            [user.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| ClientError::from(StorageError::from(e)))?;
    let (bytes, umk, ssk) = cached.ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
    if umk != leaf.credential.umk_pub || ssk != leaf.credential.ssk_pub {
        return Err(failure(E_CREDENTIAL));
    }
    let list = DeviceList::decode(&bytes).map_err(|_| failure(E_CREDENTIAL))?;
    if list.unsigned.user_id != leaf.credential.user_id {
        return Err(failure(E_CREDENTIAL));
    }
    list.verify(&ssk).map_err(|_| failure(E_CREDENTIAL))?;
    list.check_leaf(
        &leaf.credential.device_id,
        &leaf.dsk_pub,
        leaf.credential.tier,
    )
    .map_err(ClientError::from)?;
    let pin: Option<([u8; 32], Option<[u8; 32]>)> = c
        .query_row(
            "SELECT umk_pub,changed_umk FROM app_trust_pins WHERE user_id=?1",
            [user.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| ClientError::from(StorageError::from(e)))?;
    let (pinned, changed) = pin.ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
    if changed.is_some() || pinned != umk {
        return Err(failure(E_UMK_CHANGED));
    }
    Ok(())
}

/// Rebind locally retained, MLS-authenticated evidence to the current tree before release.
pub(super) fn validate_pending_sender(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
    sender_leaf: u32,
    sender_credential: &[u8],
) -> Result<(), ClientError> {
    let member = group
        .member_at(sender_leaf)
        .ok_or_else(|| failure(E_CREDENTIAL))?;
    let leaf = extract_leaf(group_id, group, [0; 32], member)?;
    if leaf.credential.encode() != sender_credential {
        return Err(failure(E_CREDENTIAL));
    }
    validate_cached_leaf(c, &leaf)
}

/// Check each current authenticated tree member at an MLS state transition.
/// Missing history remains pending; failed leaves and the commit author are neutralized.
pub(super) fn audit_tree(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
    own_device: &[u8; 16],
    author_device: Option<&[u8; 16]>,
) -> Result<(), StorageError> {
    for member in group.members() {
        let leaf = extract_leaf(group_id, group, [0; 32], member);
        let (device, verdict) = match leaf {
            Ok(leaf) => {
                let device = *leaf.credential.device_id.as_bytes();
                let verdict = validate_cached_leaf(c, &leaf);
                (device, verdict)
            }
            Err(error) => {
                if let Some(author) = author_device.filter(|author| *author != own_device) {
                    quarantine_device(c, group_id, author, error.code)?;
                }
                continue; // Malformed identity has no trustworthy device ID.
            }
        };
        if &device == own_device {
            continue;
        }
        if let Err(error) = verdict {
            if error.code == E_DEVICE_LIST_STALE {
                continue;
            }
            quarantine_device(c, group_id, &device, error.code)?;
            if let Some(author) =
                author_device.filter(|author| **author != device && *author != own_device)
            {
                quarantine_device(c, group_id, author, error.code)?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate_proposed_add(
    c: &rusqlite::Connection,
    kp: &KeyPackage,
) -> Result<(), ClientError> {
    let leaf = leaf_from_key_package(kp)?;
    validate_cached_leaf(c, &leaf)
}

fn leaf_from_key_package(kp: &KeyPackage) -> Result<LeafEvidence, ClientError> {
    let node = kp.leaf_node();
    let basic =
        BasicCredential::try_from(node.credential().clone()).map_err(|_| failure(E_CREDENTIAL))?;
    let credential =
        CredentialIdentity::decode(basic.identity()).map_err(|_| failure(E_CREDENTIAL))?;
    let dsk_pub: [u8; 32] = node
        .signature_key()
        .as_slice()
        .try_into()
        .map_err(|_| failure(E_CREDENTIAL))?;
    let leaf = LeafEvidence {
        group_id: [0; 16],
        epoch: 0,
        tree_hash: [0; 32],
        leaf_index: 0,
        credential,
        dsk_pub,
    };
    Ok(leaf)
}

impl ClientCore {
    pub fn trust_generation(&self) -> Result<u64, ClientError> {
        self.read(|c| {
            Ok(schema::meta_get(c, "trust_generation")?
                .and_then(|v| crate::cbor::decode_strict(&v, |d| d.uint()).ok())
                .unwrap_or(0))
        })
    }
    fn candidate_leaves(
        &mut self,
        group_id: &[u8; 16],
        proposals_body: &[u8],
    ) -> Result<Vec<(u64, LeafEvidence)>, ClientError> {
        let proposals = wire::decode_proposals_body(proposals_body)?;
        if proposals.len() > 1024 {
            return Err(failure(E_CORE_LIMIT));
        }
        let mut group = self
            .take_group(group_id)?
            .ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
        let result = (|| {
            let mut out = Vec::new();
            for (index, item) in proposals.iter().enumerate() {
                if item.void {
                    continue;
                }
                let Ok(message) = wire::protocol_message(&item.blob) else {
                    continue;
                };
                if message.epoch().as_u64() != group.epoch() {
                    continue;
                }
                let Ok(DillaProcessed::Proposal(proposal)) =
                    group.process_message(&self.provider, message)
                else {
                    continue;
                };
                if let openmls::prelude::Proposal::Add(add) = proposal.proposal() {
                    let mut leaf = leaf_from_key_package(add.key_package())?;
                    leaf.group_id = *group_id;
                    leaf.epoch = group.epoch();
                    leaf.tree_hash = group.tree_hash(&self.provider, self.signer()?)?;
                    out.push((index as u64, leaf));
                }
            }
            Ok(out)
        })();
        self.keep_group(*group_id, group);
        result
    }

    /// Authenticated Add candidates from the exact proposal body a commit will consume.
    pub fn proposed_adds(
        &mut self,
        group_id: &[u8; 16],
        proposals_body: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        let leaves = self.candidate_leaves(group_id, proposals_body)?;
        let mut e = Encoder::new();
        e.array(leaves.len());
        for (index, leaf) in leaves {
            let user = leaf.credential.user_id.as_bytes();
            let cached: Option<i64> = self.read(|c| {
                c.query_row(
                    "SELECT version FROM app_device_lists WHERE user_id=?1",
                    [user.as_slice()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(Into::into)
            })?;
            e.array(3)
                .uint(index)
                .bytes(user)
                .uint(cached.unwrap_or(0).max(0) as u64);
        }
        Ok(e.into_vec())
    }

    #[allow(clippy::too_many_arguments)] // Mirrors the bounded signed-history ABI with proposal evidence.
    pub fn device_list_ingest_add(
        &mut self,
        group_id: &[u8; 16],
        proposals_body: &[u8],
        index: u64,
        requested_user: &[u8; 16],
        history_body: &[u8],
        head_list: &[u8],
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        let leaf = self
            .candidate_leaves(group_id, proposals_body)?
            .into_iter()
            .find(|(i, _)| *i == index)
            .map(|(_, leaf)| leaf)
            .ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
        self.ingest_leaf(leaf, requested_user, history_body, head_list, now, false)
    }

    fn groups_holding_device(
        &self,
        user: &[u8; 16],
        device: &[u8; 16],
    ) -> Result<Vec<[u8; 16]>, ClientError> {
        let ids: Vec<[u8; 16]> = self.read(|c| {
            let mut stmt = c.prepare("SELECT group_id FROM app_groups WHERE state=2")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()
                .map_err(Into::into)
        })?;
        let mut out = Vec::new();
        for id in ids {
            let cached = self.groups.get(&id);
            let loaded = if cached.is_none() {
                DillaGroup::load(&self.provider, &GroupId::from_slice(&id))?
            } else {
                None
            };
            let group = cached
                .or(loaded.as_ref())
                .ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
            for member in group.members() {
                let Ok(basic) = BasicCredential::try_from(member.credential) else {
                    continue;
                };
                let Ok(identity) = CredentialIdentity::decode(basic.identity()) else {
                    continue;
                };
                if identity.user_id.as_bytes() == user && identity.device_id.as_bytes() == device {
                    out.push(id);
                    break;
                }
            }
        }
        Ok(out)
    }

    fn current_leaf(
        &self,
        group_id: &[u8; 16],
        leaf_index: u32,
    ) -> Result<LeafEvidence, ClientError> {
        let group = self.groups.get(group_id);
        let loaded = if group.is_none() {
            DillaGroup::load(&self.provider, &GroupId::from_slice(group_id))?
        } else {
            None
        };
        let group = group
            .or(loaded.as_ref())
            .ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
        let member = group
            .member_at(leaf_index)
            .ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
        let tree_hash = group.tree_hash(&self.provider, self.signer()?)?;
        extract_leaf(group_id, group, tree_hash, member)
    }

    /// Current tree leaves that need a signed-list refresh, without exporting credentials or keys.
    pub fn pending_leaves(&self) -> Result<Vec<u8>, ClientError> {
        let ids: Vec<[u8; 16]> = self.read(|c| {
            let mut stmt =
                c.prepare("SELECT group_id FROM app_groups WHERE state=2 ORDER BY group_id")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()
                .map_err(Into::into)
        })?;
        let mut rows = Vec::new();
        for id in ids {
            let group = self.groups.get(&id);
            let loaded = if group.is_none() {
                DillaGroup::load(&self.provider, &GroupId::from_slice(&id))?
            } else {
                None
            };
            let group = group
                .or(loaded.as_ref())
                .ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
            let tree_hash = group.tree_hash(&self.provider, self.signer()?)?;
            for member in group.members() {
                if rows.len() == 4096 {
                    return Err(failure(E_CORE_LIMIT));
                }
                let leaf = extract_leaf(&id, group, tree_hash, member)?;
                let user: [u8; 16] = *leaf.credential.user_id.as_bytes();
                let (cached, changed): (u64, bool) = self.read(|c| {
                    let version: Option<i64> = c
                        .query_row(
                            "SELECT version FROM app_device_lists WHERE user_id=?1",
                            [user.as_slice()],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let changed: Option<Vec<u8>> = c
                        .query_row(
                            "SELECT changed_umk FROM app_trust_pins WHERE user_id=?1",
                            [user.as_slice()],
                            |r| r.get(0),
                        )
                        .optional()?
                        .flatten();
                    Ok((version.unwrap_or(0).max(0) as u64, changed.is_some()))
                })?;
                rows.push((
                    id,
                    leaf.leaf_index,
                    user,
                    cached,
                    if changed {
                        "changed"
                    } else if cached == 0 {
                        "unknown"
                    } else {
                        "ready-refresh"
                    },
                ));
            }
        }
        let mut e = Encoder::new();
        e.array(rows.len());
        for (group, leaf, user, version, reason) in rows {
            e.array(5)
                .bytes(&group)
                .uint(u64::from(leaf))
                .bytes(&user)
                .uint(version)
                .text(reason);
        }
        Ok(e.into_vec())
    }

    /// Validate a paged signed history against an authenticated current MLS leaf and pin it atomically.
    pub fn device_list_ingest(
        &mut self,
        group_id: &[u8; 16],
        leaf_index: u32,
        requested_user: &[u8; 16],
        history_body: &[u8],
        head_list: &[u8],
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        // An unknown group is refused before parsing the untrusted history.
        let first = self.current_leaf(group_id, leaf_index)?;
        self.ingest_leaf(first, requested_user, history_body, head_list, now, true)
    }

    fn ingest_leaf(
        &mut self,
        first: LeafEvidence,
        requested_user: &[u8; 16],
        history_body: &[u8],
        head_list: &[u8],
        now: u64,
        current: bool,
    ) -> Result<Vec<u8>, ClientError> {
        if first.credential.user_id.as_bytes() != requested_user {
            return Err(failure(E_CREDENTIAL));
        }
        if history_body.len() > 4 * 1024 * 1024 {
            return Err(failure(E_CORE_LIMIT));
        }
        let served =
            wire::decode_history_body(history_body).map_err(|_| failure(E_DEVICE_LIST_STALE))?;
        if served.is_empty() {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        let mut history = Vec::new();
        for row in served {
            let list = DeviceList::decode(&row.blob).map_err(|_| failure(E_CREDENTIAL))?;
            if list.unsigned.version != row.version
                || list.sig_ssk != row.ssk_signature
                || list.unsigned.prev_hash != row.prev_hash
            {
                return Err(failure(E_DEVICE_LIST_STALE));
            }
            history.push(list);
        }
        let head = DeviceList::decode(head_list).map_err(|_| failure(E_DEVICE_LIST_STALE))?;
        let cached: Option<CachedList> = self.read(|c| {
            c.query_row(
                "SELECT version,list,umk_pub,ssk_pub FROM app_device_lists WHERE user_id=?1",
                [requested_user.as_slice()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(Into::into)
        })?;
        let mut anchor = None;
        if let Some((version, blob, old_umk, old_ssk)) = &cached {
            let first_list = history
                .first()
                .ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
            if *version < 1
                || first_list.unsigned.version != *version as u64
                || first_list.encode() != *blob
                || head.unsigned.version < *version as u64
            {
                return Err(failure(E_DEVICE_LIST_STALE));
            }
            if first_list.unsigned.user_id.as_bytes() != requested_user
                || first_list.verify(old_ssk).is_err()
            {
                return Err(failure(E_CREDENTIAL));
            }
            if *old_umk == first.credential.umk_pub && *old_ssk != first.credential.ssk_pub {
                return Err(failure(E_CREDENTIAL));
            }
            anchor = Some(first_list);
        }
        let validated = validate_history_from(&first, requested_user, &history, &head, anchor)?;
        if current {
            let second = self.current_leaf(&first.group_id, first.leaf_index)?;
            if first.group_id != second.group_id
                || first.epoch != second.epoch
                || first.tree_hash != second.tree_hash
                || first.leaf_index != second.leaf_index
                || first.credential != second.credential
                || first.dsk_pub != second.dsk_pub
            {
                return Err(failure(E_DEVICE_LIST_STALE));
            }
        }
        let affected_groups = self.groups_holding_device(requested_user, &validated.device_id)?;
        let now = i64::try_from(now).map_err(|_| failure(super::error::E_CORE_INPUT))?;
        let (changed,quarantined)=self.write(|_,u| {
            u.with_conn(|c| {
                let pinned: Option<[u8;32]> = c.query_row("SELECT umk_pub FROM app_trust_pins WHERE user_id=?1",[requested_user.as_slice()],|r| r.get(0)).optional()?;
                let changed=pinned.is_some_and(|p| p!=validated.umk_pub);
                c.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,list=excluded.list,umk_pub=excluded.umk_pub,ssk_pub=excluded.ssk_pub",params![validated.user_id.as_slice(),validated.version as i64,head_list,validated.umk_pub.as_slice(),validated.ssk_pub.as_slice()])?;
                if changed {
                    c.execute("UPDATE app_trust_pins SET changed_umk=?2,verified=0 WHERE user_id=?1",params![validated.user_id.as_slice(),validated.umk_pub.as_slice()])?;
                    for affected in &affected_groups {
                        c.execute("INSERT INTO app_quarantine(group_id,device_id,code) VALUES(?1,?2,?3) ON CONFLICT(group_id,device_id) DO UPDATE SET code=excluded.code",params![affected.as_slice(),validated.device_id.as_slice(),E_UMK_CHANGED])?;
                        retract_device(c,affected,&validated.device_id,E_UMK_CHANGED)?;
                    }
                    bump_generation(c)?;
                } else if pinned.is_none() {
                    c.execute("INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,0,NULL)",params![validated.user_id.as_slice(),validated.umk_pub.as_slice(),now])?;
                }
                Ok((changed,if changed { affected_groups.len() } else { 0 }))
            }).map_err(ClientError::from)
        })?;
        let mut e = Encoder::new();
        e.array(3)
            .uint(validated.version)
            .uint(u64::from(changed))
            .uint(quarantined as u64);
        Ok(e.into_vec())
    }

    /// Bounded public-key-only local trust state.
    pub fn trust_state(&self) -> Result<Vec<u8>, ClientError> {
        let rows: Vec<TrustRow> = self.read(|c| {
            let mut stmt=c.prepare("SELECT user_id,umk_pub,first_seen,verified,changed_umk FROM app_trust_pins ORDER BY user_id LIMIT 4097")?;
            stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?.collect::<Result<_,_>>().map_err(Into::into)
        })?;
        if rows.len() > 4096 {
            return Err(failure(E_CORE_LIMIT));
        }
        let mut e = Encoder::new();
        e.array(rows.len());
        for (user, umk, first, verified, changed) in rows {
            e.array(5)
                .bytes(&user)
                .bytes(&umk)
                .uint(first.max(0) as u64)
                .uint(verified as u64)
                .opt_bytes(changed.as_ref().map(|v| v.as_slice()));
        }
        Ok(e.into_vec())
    }

    /// Approve only the exact key validated from the cached signed list.
    pub fn trust_verify(
        &mut self,
        user_id: &[u8; 16],
        expected_umk: &[u8; 32],
    ) -> Result<(), ClientError> {
        let cached: Option<([u8; 32], [u8; 32], Vec<u8>)> = self.read(|c| {
            c.query_row(
                "SELECT umk_pub,ssk_pub,list FROM app_device_lists WHERE user_id=?1",
                [user_id.as_slice()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(Into::into)
        })?;
        let (umk, ssk, blob) = cached.ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
        if umk != *expected_umk {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        let list = DeviceList::decode(&blob).map_err(|_| failure(E_DEVICE_LIST_STALE))?;
        list.verify(&ssk).map_err(|_| failure(E_CREDENTIAL))?;
        if list.unsigned.user_id.as_bytes() != user_id {
            return Err(failure(E_CREDENTIAL));
        }
        let mut live = false;
        for entry in &list.unsigned.entries {
            let device = entry.device_id.as_bytes();
            for group_id in self.groups_holding_device(user_id, device)? {
                let group = self.groups.get(&group_id);
                let loaded = if group.is_none() {
                    DillaGroup::load(&self.provider, &GroupId::from_slice(&group_id))?
                } else {
                    None
                };
                let group = group
                    .or(loaded.as_ref())
                    .ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
                for member in group.members() {
                    let leaf = extract_leaf(&group_id, group, [0; 32], member)?;
                    if leaf.credential.user_id.as_bytes() != user_id
                        || leaf.credential.device_id.as_bytes() != device
                    {
                        continue;
                    }
                    if leaf.credential.umk_pub == *expected_umk
                        && leaf.credential.ssk_pub == ssk
                        && leaf.dsk_pub == entry.dsk_pub
                        && leaf.credential.verify_signatures(&leaf.dsk_pub).is_ok()
                        && list
                            .check_leaf(
                                &leaf.credential.device_id,
                                &leaf.dsk_pub,
                                leaf.credential.tier,
                            )
                            .is_ok()
                    {
                        live = true;
                    }
                }
            }
        }
        if !live {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        self.write(|_,u|u.with_conn(|c| {
            let changed: Option<[u8;32]>=c.query_row("SELECT changed_umk FROM app_trust_pins WHERE user_id=?1",[user_id.as_slice()],|r|r.get(0)).optional()?.flatten();
            if changed!=Some(*expected_umk) {return Err(StorageError::Codec("pending validated key differs".into()));}
            let cached: Option<([u8;32],[u8;32],Vec<u8>)>=c.query_row("SELECT umk_pub,ssk_pub,list FROM app_device_lists WHERE user_id=?1",[user_id.as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (umk,ssk,blob)=cached.ok_or_else(||StorageError::Codec("cached validated list missing".into()))?;
            if umk!=*expected_umk {return Err(StorageError::Codec("cached validated list differs".into()));}
            let list=DeviceList::decode(&blob).map_err(|_|StorageError::Codec("cached list malformed".into()))?;
            list.verify(&ssk).map_err(|_|StorageError::Codec("cached list signature invalid".into()))?;
            if list.unsigned.user_id.as_bytes()!=user_id {return Err(StorageError::Codec("cached list user differs".into()));}
            c.execute("UPDATE app_trust_pins SET umk_pub=?2,changed_umk=NULL,verified=1 WHERE user_id=?1",params![user_id.as_slice(),expected_umk.as_slice()])?;
            for entry in &list.unsigned.entries {
                c.execute("DELETE FROM app_quarantine WHERE device_id=?1 AND code='E_UMK_CHANGED'",[entry.device_id.as_bytes().as_slice()])?;
            }
            bump_generation(c)?;
            Ok(())
        }).map_err(ClientError::from))
    }

    /// Pairwise comparison digits for a contact in a current shared MLS group.
    pub fn safety_number_for(&self, user_id: &[u8; 16]) -> Result<String, ClientError> {
        let pin: Option<[u8; 32]> = self.read(|c| {
            c.query_row(
                "SELECT umk_pub FROM app_trust_pins WHERE user_id=?1",
                [user_id.as_slice()],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
        })?;
        let pin = pin.ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
        let own = self.own()?;
        let own_cred =
            CredentialIdentity::decode(&own.credential).map_err(|_| failure(E_CORE_STORAGE))?;
        let pending = self.pending_leaves()?;
        let shared = crate::cbor::decode_strict(&pending, |d| {
            let n = d.array_len()?;
            let mut found = false;
            for _ in 0..n {
                d.array(5)?;
                d.skip()?;
                d.skip()?;
                if d.bytes_exact::<16>()? == *user_id {
                    found = true;
                }
                d.skip()?;
                d.skip()?;
            }
            Ok(found)
        })
        .unwrap_or(false);
        if !shared {
            return Err(failure(E_CORE_NOT_FOUND));
        }
        Ok(group_digits(
            &safety_number(&own_cred.umk_pub, &pin),
            DISPLAY_GROUP,
        ))
    }
}

#[cfg(test)]
#[allow(clippy::useless_conversion, clippy::cloned_ref_to_slice_refs)]
mod tests {
    use super::*;
    use crate::identity::{
        CredentialIdentity, DeviceEntry, DeviceListUnsigned, Kind, SignerTier, SskSigner, Tier,
        UmkSigner,
    };
    use crate::ids::{DeviceId, UserId};

    fn fixture() -> (LeafEvidence, DeviceList) {
        let umk = UmkSigner::from_bytes(&[0x41; 32]);
        let ssk = SskSigner::from_bytes(&[0x42; 32]);
        let user_id = UserId::from_bytes([0x43; 16]);
        let device_id = DeviceId::from_bytes([0x44; 16]);
        let dsk_pub = [0x45; 32];
        let credential = CredentialIdentity {
            v: 1,
            umk_pub: umk.public(),
            user_id,
            device_id,
            kind: Kind::User,
            tier: Tier::Native,
            signer_tier: SignerTier::Native,
            ssk_pub: ssk.public(),
            sig_umk_ssk: umk.sign_ssk(&ssk.public()),
            sig_ssk_dev: ssk.sign_device(
                &device_id,
                &dsk_pub,
                Kind::User,
                Tier::Native,
                SignerTier::Native,
            ),
        };
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id,
            version: 1,
            prev_hash: [0; 32],
            entries: vec![DeviceEntry {
                device_id,
                dsk_pub,
                tier: Tier::Native,
                added_at: 1,
                revoked_at: None,
            }],
        };
        let list = DeviceList {
            sig_ssk: ssk.sign_device_list(&unsigned),
            unsigned,
        };
        let leaf = LeafEvidence {
            group_id: [0x46; 16],
            epoch: 1,
            tree_hash: [0x47; 32],
            leaf_index: 1,
            credential,
            dsk_pub,
        };
        (leaf, list)
    }

    #[test]
    fn signed_v1_and_exact_head_pass() {
        let (leaf, list) = fixture();
        let out = validate_history(
            &leaf,
            leaf.credential.user_id.as_bytes().try_into().unwrap(),
            &[list.clone()],
            &list,
        )
        .expect("valid");
        assert_eq!(out.version, 1);
        assert_eq!(out.umk_pub, leaf.credential.umk_pub);
    }

    #[test]
    fn gap_rollback_wrong_signer_cross_user_and_substitute_are_refused() {
        let (leaf, first) = fixture();
        let requested: [u8; 16] = *leaf.credential.user_id.as_bytes();
        let ssk = SskSigner::from_bytes(&[0x42; 32]);
        let mut second = first.clone();
        second.unsigned.version = 2;
        second.unsigned.prev_hash = first.hash();
        second.sig_ssk = ssk.sign_device_list(&second.unsigned);
        let mut gap = second.clone();
        gap.unsigned.version = 3;
        gap.sig_ssk = ssk.sign_device_list(&gap.unsigned);
        assert_eq!(
            validate_history(&leaf, &requested, &[first.clone(), gap.clone()], &gap)
                .unwrap_err()
                .code,
            "E_DEVICE_LIST_STALE"
        );
        assert_eq!(
            validate_history(&leaf, &requested, &[first.clone(), first.clone()], &first)
                .unwrap_err()
                .code,
            "E_DEVICE_LIST_STALE"
        );
        let mut wrong_signer = second.clone();
        wrong_signer.sig_ssk = [0; 64];
        assert_eq!(
            validate_history(
                &leaf,
                &requested,
                &[first.clone(), wrong_signer.clone()],
                &wrong_signer
            )
            .unwrap_err()
            .code,
            "E_CREDENTIAL"
        );
        let mut cross_user = second.clone();
        cross_user.unsigned.user_id = UserId::from_bytes([0x99; 16]);
        cross_user.sig_ssk = ssk.sign_device_list(&cross_user.unsigned);
        assert_eq!(
            validate_history(
                &leaf,
                &requested,
                &[first.clone(), cross_user.clone()],
                &cross_user
            )
            .unwrap_err()
            .code,
            "E_CREDENTIAL"
        );
        let mut substitute = leaf.clone();
        substitute.dsk_pub = [0x98; 32];
        assert_eq!(
            validate_history(&substitute, &requested, &[first.clone()], &first)
                .unwrap_err()
                .code,
            "E_CREDENTIAL"
        );
        substitute.credential.sig_ssk_dev = ssk.sign_device(
            &substitute.credential.device_id,
            &substitute.dsk_pub,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        assert_eq!(
            validate_history(
                &substitute,
                &requested,
                std::slice::from_ref(&first),
                &first
            )
            .unwrap_err()
            .code,
            "E_CREDENTIAL"
        );
        let mut wrong_ssk = leaf.clone();
        wrong_ssk.credential.ssk_pub = [0x97; 32];
        assert_eq!(
            validate_history(&wrong_ssk, &requested, &[first.clone()], &first)
                .unwrap_err()
                .code,
            "E_CREDENTIAL"
        );
        let mut bad_credential = leaf.clone();
        bad_credential.credential.sig_umk_ssk = [0; 64];
        assert_eq!(
            validate_history(
                &bad_credential,
                &requested,
                std::slice::from_ref(&first),
                &first
            )
            .unwrap_err()
            .code,
            "E_CREDENTIAL"
        );
    }

    #[test]
    fn history_limit_and_revoked_device_are_refused() {
        let (leaf, first) = fixture();
        let requested: [u8; 16] = *leaf.credential.user_id.as_bytes();
        let too_many = vec![first.clone(); 1025];
        assert_eq!(
            validate_history(&leaf, &requested, &too_many, &first)
                .unwrap_err()
                .code,
            "E_CORE_LIMIT"
        );
        let ssk = SskSigner::from_bytes(&[0x42; 32]);
        let mut revoked = first.clone();
        revoked.unsigned.entries[0].revoked_at = Some(2);
        revoked.sig_ssk = ssk.sign_device_list(&revoked.unsigned);
        assert_eq!(
            validate_history(&leaf, &requested, &[revoked.clone()], &revoked)
                .unwrap_err()
                .code,
            "E_DEVICE_UNLISTED"
        );
    }

    #[test]
    fn quarantine_retracts_already_displayed_and_indexed_text() {
        let db = rusqlite::Connection::open_in_memory().expect("db");
        super::super::schema::migrate_conn(&db).expect("v4 schema");
        let group = [0x51; 16];
        let device = [0x52; 16];
        db.execute(
            "INSERT INTO app_groups(group_id,kind,target_id,state) VALUES(?1,0,?2,2)",
            rusqlite::params![group.as_slice(), [0x53u8; 16].as_slice()],
        )
        .expect("group");
        db.execute(
            "INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,reason,sender_user,sender_device,type,body,envelope,franking_tag,edit_body) \
             VALUES(?1,1,1,1,0,'',?2,?3,0,'naïve lantern',x'80',?4,'edited lantern')",
            rusqlite::params![group.as_slice(), [0x54u8; 16].as_slice(), device.as_slice(), [0x55u8; 32].as_slice()],
        ).expect("accepted message");
        db.execute(
            "INSERT INTO app_search_rows(group_id,seq,body,terms) VALUES(?1,1,'naïve lantern',' naive lantern')",
            [group.as_slice()],
        ).expect("indexed message");
        retract_device(&db, &group, &device, "E_UMK_CHANGED").expect("retract");
        let (status, reason, body, envelope, edit): (i64, String, String, Option<Vec<u8>>, Option<String>) = db.query_row(
            "SELECT status,reason,body,envelope,edit_body FROM app_messages WHERE group_id=?1 AND seq=1",
            [group.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).expect("message");
        assert_eq!(
            (status, reason.as_str(), body.as_str()),
            (1, "E_UMK_CHANGED", "")
        );
        assert_eq!(envelope, None);
        assert_eq!(edit, None);
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM app_search_rows WHERE group_id=?1",
                [group.as_slice()],
                |r| r.get(0),
            )
            .expect("index");
        assert_eq!(count, 0);
    }

    #[test]
    fn retracting_a_remote_edit_refolds_its_honest_target() {
        let db = rusqlite::Connection::open_in_memory().expect("db");
        super::super::schema::migrate_conn(&db).expect("v4 schema");
        let group = [0x71u8; 16];
        let author = [0x72u8; 16];
        let honest_device = [0x73u8; 16];
        let bad_device = [0x74u8; 16];
        let target = [0x75u8; 16];
        db.execute(
            "INSERT INTO app_groups(group_id,kind,target_id,state) VALUES(?1,0,?2,2)",
            rusqlite::params![group.as_slice(), [0x76u8; 16].as_slice()],
        )
        .expect("group");
        db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,sender_user,sender_device,msg_id,type,body,franking_tag) VALUES(?1,1,1,1,0,?2,?3,?4,0,'original lantern',?5)", rusqlite::params![group.as_slice(),author.as_slice(),honest_device.as_slice(),target.as_slice(),[0x77u8;32].as_slice()]).expect("target");
        db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,sender_user,sender_device,msg_id,type,body,franking_tag,reply_to) VALUES(?1,2,1,2,0,?2,?3,?4,1,'tampered lantern',?5,?6)", rusqlite::params![group.as_slice(),author.as_slice(),bad_device.as_slice(),[0x78u8;16].as_slice(),[0x79u8;32].as_slice(),target.as_slice()]).expect("edit");
        super::super::fold::refold(
            &db,
            &group,
            &target,
            &super::super::fold::FoldScope::Full,
            None,
            None,
        )
        .expect("initial fold");
        let before: Option<String> = db
            .query_row(
                "SELECT edit_body FROM app_messages WHERE group_id=?1 AND seq=1",
                [group.as_slice()],
                |r| r.get(0),
            )
            .expect("edit body");
        assert_eq!(before.as_deref(), Some("tampered lantern"));
        retract_device(&db, &group, &bad_device, "E_CREDENTIAL").expect("retract edit");
        let after: Option<String> = db
            .query_row(
                "SELECT edit_body FROM app_messages WHERE group_id=?1 AND seq=1",
                [group.as_slice()],
                |r| r.get(0),
            )
            .expect("refolded body");
        assert_eq!(after, None);
    }

    #[test]
    fn validated_remove_clears_one_group_block_without_verifying_key() {
        let db = rusqlite::Connection::open_in_memory().expect("db");
        super::super::schema::migrate_conn(&db).expect("v4 schema");
        let first = [0x61; 16];
        let second = [0x62; 16];
        let device = [0x63; 16];
        for group in [first, second] {
            db.execute(
                "INSERT INTO app_quarantine(group_id,device_id,code) VALUES(?1,?2,'E_UMK_CHANGED')",
                rusqlite::params![group.as_slice(), device.as_slice()],
            )
            .expect("block");
        }
        db.execute(
            "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,1,0,?3)",
            rusqlite::params![[0x64u8; 16].as_slice(), [0x65u8; 32].as_slice(), [0x66u8; 32].as_slice()],
        ).expect("changed pin");
        clear_group_block(&db, &first, &device).expect("validated remove");
        let count = |group: &[u8; 16]| -> i64 {
            db.query_row(
                "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
                rusqlite::params![group.as_slice(), device.as_slice()],
                |r| r.get(0),
            )
            .expect("block count")
        };
        assert_eq!((count(&first), count(&second)), (0, 1));
        let verified: i64 = db
            .query_row(
                "SELECT verified FROM app_trust_pins WHERE user_id=?1",
                [[0x64u8; 16].as_slice()],
                |r| r.get(0),
            )
            .expect("pin");
        assert_eq!(verified, 0);
    }
}
