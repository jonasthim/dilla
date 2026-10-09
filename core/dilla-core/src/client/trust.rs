//! Authenticated leaf trust and device-list history.

use super::error::{
    E_CORE_LIMIT, E_CORE_NOT_FOUND, E_CORE_STORAGE, E_CREDENTIAL, E_DEVICE_LIST_STALE,
    E_DEVICE_UNLISTED, E_TIER_MISMATCH, E_UMK_CHANGED,
};
use super::{ClientCore, ClientError, schema, wire};
use crate::cbor::{Decoder, Encoder};
use crate::identity::{CredentialIdentity, DISPLAY_GROUP, DeviceList, group_digits, safety_number};
use crate::mls::{DillaGroup, StorageError};
use crate::mls::{DillaProcessed, ReceivedApplication};
use openmls::prelude::{BasicCredential, GroupId, KeyPackage, Member};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

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

const MAX_LIST_BYTES: usize = 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 10_000;

fn bounded_list(bytes: &[u8]) -> Result<DeviceList, ClientError> {
    if bytes.len() > MAX_LIST_BYTES {
        return Err(failure(E_CORE_LIMIT));
    }
    let mut decoder = Decoder::new(bytes);
    decoder.array(6).map_err(|_| failure(E_DEVICE_LIST_STALE))?;
    decoder.uint().map_err(|_| failure(E_DEVICE_LIST_STALE))?;
    decoder
        .bytes_exact::<16>()
        .map_err(|_| failure(E_DEVICE_LIST_STALE))?;
    decoder.uint().map_err(|_| failure(E_DEVICE_LIST_STALE))?;
    decoder
        .bytes_exact::<32>()
        .map_err(|_| failure(E_DEVICE_LIST_STALE))?;
    if decoder
        .array_len()
        .map_err(|_| failure(E_DEVICE_LIST_STALE))?
        > MAX_LIST_ENTRIES
    {
        return Err(failure(E_CORE_LIMIT));
    }
    DeviceList::decode(bytes).map_err(|_| failure(E_DEVICE_LIST_STALE))
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
    user_id: &[u8; 16],
    device_id: &[u8; 16],
    code: &str,
) -> Result<(), StorageError> {
    let mut stmt = c.prepare(
        "SELECT seq,msg_id,reply_to FROM app_messages WHERE group_id=?1 AND sender_user=?2 AND sender_device=?3 AND status=0",
    )?;
    let rows: Vec<RetractedRow> = stmt
        .query_map(
            params![
                group_id.as_slice(),
                user_id.as_slice(),
                device_id.as_slice()
            ],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?
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
    user_id: &[u8; 16],
    device_id: &[u8; 16],
    code: &str,
) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_quarantine(group_id,user_id,device_id,code) VALUES(?1,?2,?3,?4) \
         ON CONFLICT(group_id,user_id,device_id) DO UPDATE SET code=excluded.code",
        params![
            group_id.as_slice(),
            user_id.as_slice(),
            device_id.as_slice(),
            code
        ],
    )?;
    retract_device(c, group_id, user_id, device_id, code)?;
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
    user_id: &[u8; 16],
    device_id: &[u8; 16],
) -> Result<(), StorageError> {
    let changed = c.execute(
        "DELETE FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3 AND code='E_UMK_CHANGED'",
        params![group_id.as_slice(), user_id.as_slice(), device_id.as_slice()],
    )?;
    if changed > 0 {
        bump_generation(c)?;
    }
    Ok(())
}

pub(super) fn member_devices(group: &DillaGroup) -> Vec<([u8; 16], [u8; 16])> {
    group
        .members()
        .into_iter()
        .filter_map(|member| {
            let basic = BasicCredential::try_from(member.credential).ok()?;
            let identity = CredentialIdentity::decode(basic.identity()).ok()?;
            Some((*identity.user_id.as_bytes(), *identity.device_id.as_bytes()))
        })
        .collect()
}

pub(super) fn clear_removed_blocks(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    before: &[([u8; 16], [u8; 16])],
    after: &[([u8; 16], [u8; 16])],
) -> Result<(), StorageError> {
    for (user, device) in before.iter().filter(|pair| !after.contains(pair)) {
        clear_group_block(c, group_id, user, device)?;
    }
    Ok(())
}

type LeafFingerprint = (u32, Vec<u8>);

pub(super) fn member_fingerprints(group: &DillaGroup) -> Vec<LeafFingerprint> {
    group
        .members()
        .into_iter()
        .map(|member| (member.index.u32(), member.signature_key.as_slice().to_vec()))
        .collect()
}

#[allow(clippy::too_many_arguments)] // Carries the complete authenticated tree transition into one audit write.
fn audit_failed_leaf(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    epoch: u64,
    fingerprint: &LeafFingerprint,
    user: &[u8; 16],
    device: &[u8; 16],
    code: &str,
    author: Option<(&[u8; 16], &[u8; 16])>,
    previous: Option<&[LeafFingerprint]>,
) -> Result<(), StorageError> {
    // A failed Add is charged to the new leaf alone. Quarantining its committer
    // lets an attacker put a bad leaf in an honest member's commit to block that member.
    let added_by = author.filter(|_| previous.is_some_and(|old| !old.contains(fingerprint)));
    c.execute(
        "INSERT INTO app_trust_audit(group_id,user_id,device_id,epoch,leaf_index,signature_key,code,added_by_user,added_by_device) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) \
         ON CONFLICT(group_id,user_id,device_id,epoch,leaf_index) DO UPDATE SET code=excluded.code,added_by_user=COALESCE(excluded.added_by_user,app_trust_audit.added_by_user),added_by_device=COALESCE(excluded.added_by_device,app_trust_audit.added_by_device)",
        params![group_id.as_slice(),user.as_slice(),device.as_slice(),epoch as i64,
            fingerprint.0 as i64,&fingerprint.1,code,added_by.map(|a|a.0.as_slice()),added_by.map(|a|a.1.as_slice())],
    )?;
    Ok(())
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
            "SELECT umk_pub,changed_umk FROM app_trust_pins WHERE user_id=?1 AND device_id=?2",
            params![user.as_slice(), leaf.credential.device_id.as_bytes()],
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
/// Missing history remains pending; a failed leaf is neutralized by its own device identity.
pub(super) fn audit_tree(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
    own_user: &[u8; 16],
    own_device: &[u8; 16],
    author: Option<(&[u8; 16], &[u8; 16])>,
    previous: Option<&[LeafFingerprint]>,
) -> Result<(), StorageError> {
    for member in group.members() {
        let malformed_leaf = (member.index.u32(), member.signature_key.as_slice().to_vec());
        let leaf = extract_leaf(group_id, group, [0; 32], member);
        let (user, device, verdict) = match leaf {
            Ok(leaf) => {
                let user = *leaf.credential.user_id.as_bytes();
                let device = *leaf.credential.device_id.as_bytes();
                let verdict = validate_cached_leaf(c, &leaf);
                (user, device, verdict)
            }
            Err(_) => {
                // A credential without a decodable identity has no authenticated user/device
                // pair. Reserve the zero user and derive a stable opaque device key from the
                // authenticated tree position and signature key. It is never treated as a
                // verified device-list entry, but its own leaf gets a failed verdict.
                let mut hash = Sha256::new();
                hash.update(b"dilla undecodable leaf v1");
                hash.update(group_id);
                hash.update(malformed_leaf.0.to_be_bytes());
                hash.update(&malformed_leaf.1);
                let digest = hash.finalize();
                let mut opaque_device = [0u8; 16];
                opaque_device.copy_from_slice(&digest[..16]);
                quarantine_device(c, group_id, &[0; 16], &opaque_device, E_CREDENTIAL)?;
                audit_failed_leaf(
                    c,
                    group_id,
                    group.epoch(),
                    &malformed_leaf,
                    &[0; 16],
                    &opaque_device,
                    E_CREDENTIAL,
                    author,
                    previous,
                )?;
                continue;
            }
        };
        if &user == own_user && &device == own_device {
            continue;
        }
        if let Err(error) = verdict {
            if error.code == E_DEVICE_LIST_STALE {
                continue;
            }
            quarantine_device(c, group_id, &user, &device, error.code)?;
            audit_failed_leaf(
                c,
                group_id,
                group.epoch(),
                &malformed_leaf,
                &user,
                &device,
                error.code,
                author,
                previous,
            )?;
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

    fn matching_current_devices(
        &self,
        group_id: &[u8; 16],
        user: &[u8; 16],
        list: &DeviceList,
        umk: &[u8; 32],
        ssk: &[u8; 32],
    ) -> Result<Vec<[u8; 16]>, ClientError> {
        let group = self.groups.get(group_id);
        let loaded = if group.is_none() {
            DillaGroup::load(&self.provider, &GroupId::from_slice(group_id))?
        } else {
            None
        };
        let group = group
            .or(loaded.as_ref())
            .ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
        let mut out = Vec::new();
        for member in group.members() {
            let Ok(leaf) = extract_leaf(group_id, group, [0; 32], member) else {
                continue;
            };
            if leaf.credential.user_id.as_bytes() != user
                || &leaf.credential.umk_pub != umk
                || &leaf.credential.ssk_pub != ssk
                || leaf.credential.verify_signatures(&leaf.dsk_pub).is_err()
                || list
                    .check_leaf(
                        &leaf.credential.device_id,
                        &leaf.dsk_pub,
                        leaf.credential.tier,
                    )
                    .is_err()
            {
                continue;
            }
            let device = *leaf.credential.device_id.as_bytes();
            if !out.contains(&device) {
                out.push(device);
            }
        }
        Ok(out)
    }

    pub(super) fn current_leaf(
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

    pub(super) fn current_leaf_pair(
        &self,
        group_id: &[u8; 16],
        leaf_index: u32,
    ) -> Result<([u8; 16], [u8; 16]), ClientError> {
        let leaf = self.current_leaf(group_id, leaf_index)?;
        Ok((
            *leaf.credential.user_id.as_bytes(),
            *leaf.credential.device_id.as_bytes(),
        ))
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
                // The transition audit already marks an undecodable credential failed.
                // It cannot be a pending signed-list candidate, and must not prevent
                // refresh of the other decodable leaves in this group.
                let Ok(leaf) = extract_leaf(&id, group, tree_hash, member) else {
                    continue;
                };
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
                            "SELECT changed_umk FROM app_trust_pins WHERE user_id=?1 AND device_id=?2",
                            params![user.as_slice(),leaf.credential.device_id.as_bytes()],
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
            let list = bounded_list(&row.blob)?;
            if list.unsigned.version != row.version
                || list.sig_ssk != row.ssk_signature
                || list.unsigned.prev_hash != row.prev_hash
            {
                return Err(failure(E_DEVICE_LIST_STALE));
            }
            history.push(list);
        }
        let head = bounded_list(head_list)?;
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
        let mut devices = self.matching_current_devices(
            &first.group_id,
            requested_user,
            &head,
            &validated.umk_pub,
            &validated.ssk_pub,
        )?;
        if !devices.contains(&validated.device_id) {
            devices.push(validated.device_id);
        }
        let mut affected = Vec::new();
        for device in &devices {
            for group in self.groups_holding_device(requested_user, device)? {
                if !affected.contains(&(group, *device)) {
                    affected.push((group, *device));
                }
            }
        }
        let now = i64::try_from(now).map_err(|_| failure(super::error::E_CORE_INPUT))?;
        let (changed,quarantined)=self.write(|_,u| {
            u.with_conn(|c| {
                let pinned: Option<[u8;32]> = c.query_row("SELECT umk_pub FROM app_trust_pins WHERE user_id=?1 AND device_id=?2",params![requested_user.as_slice(),validated.device_id.as_slice()],|r| r.get(0)).optional()?;
                let prior_key = pinned.or_else(|| cached.as_ref().map(|row| row.2));
                let changed=prior_key.is_some_and(|p| p!=validated.umk_pub);
                c.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,list=excluded.list,umk_pub=excluded.umk_pub,ssk_pub=excluded.ssk_pub",params![validated.user_id.as_slice(),validated.version as i64,head_list,validated.umk_pub.as_slice(),validated.ssk_pub.as_slice()])?;
                if changed {
                    for device in &devices {
                        c.execute("INSERT INTO app_trust_pins(user_id,device_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,?4,0,?5) ON CONFLICT(user_id,device_id) DO UPDATE SET changed_umk=excluded.changed_umk,verified=0",params![validated.user_id.as_slice(),device.as_slice(),prior_key.expect("changed has a prior key").as_slice(),now,validated.umk_pub.as_slice()])?;
                    }
                    for (group,device) in &affected {
                        c.execute("INSERT INTO app_quarantine(group_id,user_id,device_id,code) VALUES(?1,?2,?3,?4) ON CONFLICT(group_id,user_id,device_id) DO UPDATE SET code=excluded.code",params![group.as_slice(),validated.user_id.as_slice(),device.as_slice(),E_UMK_CHANGED])?;
                        retract_device(c,group,requested_user,device,E_UMK_CHANGED)?;
                    }
                    bump_generation(c)?;
                } else {
                    for device in &devices {
                        c.execute("INSERT OR IGNORE INTO app_trust_pins(user_id,device_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,?4,0,NULL)",params![validated.user_id.as_slice(),device.as_slice(),validated.umk_pub.as_slice(),now])?;
                    }
                }
                Ok((changed,if changed { affected.len() } else { 0 }))
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
            let mut stmt=c.prepare("SELECT user_id,MIN(umk_pub),MIN(first_seen),MIN(verified),MAX(changed_umk) FROM app_trust_pins GROUP BY user_id ORDER BY user_id LIMIT 4097")?;
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
        let mut owned_blocks = Vec::new();
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
                        owned_blocks.push((group_id, *device));
                    }
                }
            }
        }
        if owned_blocks.is_empty() {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        self.write(|_,u|u.with_conn(|c| {
            let pin: Option<([u8;32],Option<[u8;32]>)>=c.query_row("SELECT umk_pub,changed_umk FROM app_trust_pins WHERE user_id=?1 AND device_id=?2",params![user_id.as_slice(),owned_blocks[0].1.as_slice()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let matches = pin.is_some_and(|(pinned,changed)| changed.map_or(pinned==*expected_umk,|pending|pending==*expected_umk));
            if !matches {return Err(StorageError::Codec("pending validated key differs".into()));}
            let cached: Option<([u8;32],[u8;32],Vec<u8>)>=c.query_row("SELECT umk_pub,ssk_pub,list FROM app_device_lists WHERE user_id=?1",[user_id.as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (umk,ssk,blob)=cached.ok_or_else(||StorageError::Codec("cached validated list missing".into()))?;
            if umk!=*expected_umk {return Err(StorageError::Codec("cached validated list differs".into()));}
            let list=DeviceList::decode(&blob).map_err(|_|StorageError::Codec("cached list malformed".into()))?;
            list.verify(&ssk).map_err(|_|StorageError::Codec("cached list signature invalid".into()))?;
            if list.unsigned.user_id.as_bytes()!=user_id {return Err(StorageError::Codec("cached list user differs".into()));}
            let pinned_devices: Vec<[u8;16]> = {
                let mut stmt=c.prepare("SELECT device_id FROM app_trust_pins WHERE user_id=?1")?;
                stmt.query_map([user_id.as_slice()],|r|r.get(0))?.collect::<Result<_,_>>()?
            };
            for device in &pinned_devices {
                c.execute("UPDATE app_trust_pins SET umk_pub=?3,changed_umk=NULL,verified=1 WHERE user_id=?1 AND device_id=?2",params![user_id.as_slice(),device.as_slice(),expected_umk.as_slice()])?;
            }
            for (group, device) in &owned_blocks {
                c.execute("DELETE FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3 AND code='E_UMK_CHANGED'",params![group.as_slice(),user_id.as_slice(),device.as_slice()])?;
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
            "INSERT INTO app_search_rows(group_id,seq,user_id,device_id,body,terms) VALUES(?1,1,?2,?3,'naïve lantern',' naive lantern')",
            rusqlite::params![group.as_slice(),[0x54u8;16].as_slice(),device.as_slice()],
        ).expect("indexed message");
        retract_device(&db, &group, &[0x54u8; 16], &device, "E_UMK_CHANGED").expect("retract");
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
    fn retract_device_scopes_a_colliding_id_to_the_authenticated_user() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        super::super::schema::migrate_conn(&db).unwrap();
        let group = [0x91u8; 16];
        let device = [0x92u8; 16];
        let victim = [0x93u8; 16];
        let offender = [0x94u8; 16];
        db.execute(
            "INSERT INTO app_groups(group_id,kind,target_id,state) VALUES(?1,0,?2,2)",
            rusqlite::params![group.as_slice(), [0x95u8; 16].as_slice()],
        )
        .unwrap();
        for (seq, user, body) in [(1, victim, "honest comet"), (2, offender, "bad comet")] {
            db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,sender_user,sender_device,type,body,franking_tag) VALUES(?1,?2,1,1,0,?3,?4,0,?5,?6)",
                rusqlite::params![group.as_slice(), seq, user.as_slice(), device.as_slice(), body, [0x96u8;32].as_slice()]).unwrap();
            db.execute(
                "INSERT INTO app_search_rows(group_id,seq,user_id,device_id,body,terms) VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![group.as_slice(), seq,user.as_slice(),device.as_slice(), body, format!(" {body}")],
            )
            .unwrap();
        }
        retract_device(&db, &group, &offender, &device, "E_CREDENTIAL").unwrap();
        let status: Vec<(i64, String)> = db
            .prepare("SELECT status,body FROM app_messages WHERE group_id=?1 ORDER BY seq")
            .unwrap()
            .query_map([group.as_slice()], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(status, vec![(0, "honest comet".into()), (1, String::new())]);
        let indexed: Vec<i64> = db
            .prepare("SELECT seq FROM app_search_rows WHERE group_id=?1 ORDER BY seq")
            .unwrap()
            .query_map([group.as_slice()], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(indexed, vec![1]);
    }

    #[test]
    fn colliding_device_ids_keep_independent_quarantine_and_remove_blocks() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        super::super::schema::migrate_conn(&db).unwrap();
        let group = [0x81; 16];
        let device = [0x82; 16];
        let honest = [0x83; 16];
        let changed = [0x84; 16];
        for user in [honest, changed] {
            quarantine_device(&db, &group, &user, &device, E_UMK_CHANGED).unwrap();
        }
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
                params![group.as_slice(), device.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2, "each user's changed-key block has its own row");
        clear_group_block(&db, &group, &changed, &device).unwrap();
        let remaining: [u8; 16] = db
            .query_row(
                "SELECT user_id FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
                params![group.as_slice(), device.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            remaining, honest,
            "removing one leaf must leave the other user's block"
        );
    }

    #[test]
    fn trust_pins_and_visibility_rows_store_the_authenticated_pair() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        super::super::schema::migrate_conn(&db).unwrap();
        let user = [0x31; 16];
        let other_user = [0x32; 16];
        let device = [0x33; 16];
        for owner in [user, other_user] {
            db.execute(
                "INSERT INTO app_trust_pins(user_id,device_id,umk_pub,first_seen,verified) VALUES(?1,?2,?3,1,0)",
                params![owner.as_slice(),device.as_slice(),[0x34u8;32].as_slice()],
            ).unwrap();
        }
        let pairs: i64 = db
            .query_row(
                "SELECT count(*) FROM app_trust_pins WHERE device_id=?1",
                [device.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pairs, 2);
        db.execute(
            "INSERT INTO app_search_rows(group_id,seq,user_id,device_id,body,terms) VALUES(?1,1,?2,?3,'honest comet',' honest comet')",
            params![[0x35u8;16].as_slice(),user.as_slice(),device.as_slice()],
        ).unwrap();
        let pair: ([u8; 16], [u8; 16]) = db
            .query_row(
                "SELECT user_id,device_id FROM app_search_rows WHERE seq=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(pair, (user, device));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn an_undecodable_merged_leaf_is_a_failed_leaf() {
        use crate::ids::DeviceId;
        use crate::mls::{CIPHERSUITE, DillaBinding, DillaProvider, GroupKind, build_key_package};
        use openmls::prelude::{BasicCredential, CredentialWithKey, GroupId, MlsGroup};
        use openmls_basic_credential::SignatureKeyPair;
        use std::sync::{Arc, Mutex};

        let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        let provider = DillaProvider::new(Arc::clone(&db));
        provider.storage().migrate().unwrap();
        let owner_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        owner_signer.store(provider.storage()).unwrap();
        let (mut owner, _) = fixture();
        let owner_key: [u8; 32] = owner_signer.public().try_into().unwrap();
        owner.credential.sig_ssk_dev = SskSigner::from_bytes(&[0x42; 32]).sign_device(
            &DeviceId::from_bytes([0x44; 16]),
            &owner_key,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        let owner_cred = CredentialWithKey {
            credential: BasicCredential::new(owner.credential.encode()).into(),
            signature_key: owner_signer.public().into(),
        };
        let group_id = [0x46; 16];
        let binding = DillaBinding {
            v: 1,
            instance_id: crate::ids::InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: [0x33; 16],
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: GroupKind::Text.media_version(),
        };
        DillaGroup::create(
            &provider,
            &owner_signer,
            owner_cred,
            GroupId::from_slice(&group_id),
            binding,
            None,
        )
        .unwrap();
        let malformed_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        malformed_signer.store(provider.storage()).unwrap();
        let malformed = CredentialWithKey {
            credential: BasicCredential::new(b"not a dilla identity".to_vec()).into(),
            signature_key: malformed_signer.public().into(),
        };
        let kp = build_key_package(&provider, &malformed_signer, malformed, false).unwrap();
        let mut raw = MlsGroup::load(provider.storage(), &GroupId::from_slice(&group_id))
            .unwrap()
            .unwrap();
        raw.add_members(&provider, &owner_signer, &[kp.key_package().clone()])
            .unwrap();
        raw.merge_pending_commit(&provider).unwrap();
        let group = DillaGroup::load(&provider, &GroupId::from_slice(&group_id))
            .unwrap()
            .unwrap();
        let db = db.lock().unwrap();
        super::super::schema::migrate_conn(&db).unwrap();
        audit_tree(
            &db,
            &group,
            &group_id,
            &[0x43; 16],
            &[0x44; 16],
            Some((&[0x43; 16], &[0x44; 16])),
            Some(&[]),
        )
        .unwrap();
        let failed: i64 = db
            .query_row(
                "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND code='E_CREDENTIAL'",
                [group_id.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(failed, 1, "the nameless leaf must be quarantined");
        let credited: i64 = db.query_row(
            "SELECT count(*) FROM app_trust_audit WHERE group_id=?1 AND added_by_user=?2 AND added_by_device=?3 AND code='E_CREDENTIAL'",
            params![group_id.as_slice(), [0x43u8;16].as_slice(), [0x44u8;16].as_slice()],
            |r| r.get(0),
        ).unwrap_or(0);
        assert_eq!(
            credited, 1,
            "the failed Add must name its authenticated committer"
        );
        let author_blocked: i64 = db.query_row(
            "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3",
            params![group_id.as_slice(), [0x43u8;16].as_slice(), [0x44u8;16].as_slice()],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(author_blocked, 0, "the committer stays usable");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn real_remove_of_colliding_device_id_releases_only_departed_users_block() {
        use crate::ids::{DeviceId, InstanceId, UserId};
        use crate::mls::{CIPHERSUITE, DillaBinding, DillaProvider, GroupKind, build_key_package};
        use openmls::prelude::{
            BasicCredential, CredentialWithKey, GroupId, LeafNodeIndex, MlsGroup,
        };
        use openmls_basic_credential::SignatureKeyPair;
        use std::sync::{Arc, Mutex};

        let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        let provider = DillaProvider::new(Arc::clone(&db));
        provider.storage().migrate().unwrap();
        let owner_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        owner_signer.store(provider.storage()).unwrap();
        let (mut owner, _) = fixture();
        let owner_key: [u8; 32] = owner_signer.public().try_into().unwrap();
        owner.credential.sig_ssk_dev = SskSigner::from_bytes(&[0x42; 32]).sign_device(
            &DeviceId::from_bytes([0x44; 16]),
            &owner_key,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        let owner_cred = CredentialWithKey {
            credential: BasicCredential::new(owner.credential.encode()).into(),
            signature_key: owner_signer.public().into(),
        };
        let group_id = [0x46; 16];
        let binding = DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: [0x33; 16],
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: GroupKind::Text.media_version(),
        };
        DillaGroup::create(
            &provider,
            &owner_signer,
            owner_cred,
            GroupId::from_slice(&group_id),
            binding,
            None,
        )
        .unwrap();

        let departed_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        departed_signer.store(provider.storage()).unwrap();
        let departed_umk = UmkSigner::from_bytes(&[0x55; 32]);
        let departed_ssk = SskSigner::from_bytes(&[0x56; 32]);
        let departed_key: [u8; 32] = departed_signer.public().try_into().unwrap();
        let mut identity = owner.credential;
        identity.user_id = UserId::from_bytes([0x55; 16]);
        identity.umk_pub = departed_umk.public();
        identity.ssk_pub = departed_ssk.public();
        identity.sig_umk_ssk = departed_umk.sign_ssk(&identity.ssk_pub);
        identity.sig_ssk_dev = departed_ssk.sign_device(
            &identity.device_id,
            &departed_key,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        let departed_cred = CredentialWithKey {
            credential: BasicCredential::new(identity.encode()).into(),
            signature_key: departed_signer.public().into(),
        };
        let kp = build_key_package(&provider, &departed_signer, departed_cred, false).unwrap();
        let mut raw = MlsGroup::load(provider.storage(), &GroupId::from_slice(&group_id))
            .unwrap()
            .unwrap();
        raw.add_members(&provider, &owner_signer, &[kp.key_package().clone()])
            .unwrap();
        raw.merge_pending_commit(&provider).unwrap();
        let before_group = DillaGroup::load(&provider, &GroupId::from_slice(&group_id))
            .unwrap()
            .unwrap();
        let before = member_devices(&before_group);
        assert_eq!(
            before,
            vec![([0x43; 16], [0x44; 16]), ([0x55; 16], [0x44; 16])]
        );

        raw = MlsGroup::load(provider.storage(), &GroupId::from_slice(&group_id))
            .unwrap()
            .unwrap();
        raw.remove_members(&provider, &owner_signer, &[LeafNodeIndex::new(1)])
            .unwrap();
        raw.merge_pending_commit(&provider).unwrap();
        let after_group = DillaGroup::load(&provider, &GroupId::from_slice(&group_id))
            .unwrap()
            .unwrap();
        let after = member_devices(&after_group);
        assert_eq!(after, vec![([0x43; 16], [0x44; 16])]);
        let db = db.lock().unwrap();
        super::super::schema::migrate_conn(&db).unwrap();
        db.execute("INSERT INTO app_quarantine(group_id,user_id,device_id,code) VALUES(?1,?2,?3,'E_UMK_CHANGED')",
            params![group_id.as_slice(),[0x55u8;16].as_slice(),[0x44u8;16].as_slice()]).unwrap();
        clear_removed_blocks(&db, &group_id, &before, &after).unwrap();
        let blocked: i64 = db
            .query_row(
                "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND code='E_UMK_CHANGED'",
                [group_id.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            blocked, 0,
            "a validated Remove clears this group's send block"
        );
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
        retract_device(&db, &group, &author, &bad_device, "E_CREDENTIAL").expect("retract edit");
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
                "INSERT INTO app_quarantine(group_id,user_id,device_id,code) VALUES(?1,?2,?3,'E_UMK_CHANGED')",
                rusqlite::params![group.as_slice(), [0x64u8; 16].as_slice(), device.as_slice()],
            )
            .expect("block");
        }
        db.execute(
            "INSERT INTO app_trust_pins(user_id,device_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,1,0,?4)",
            rusqlite::params![[0x64u8; 16].as_slice(), device.as_slice(), [0x65u8; 32].as_slice(), [0x66u8; 32].as_slice()],
        ).expect("changed pin");
        clear_group_block(&db, &first, &[0x64u8; 16], &device).expect("validated remove");
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
