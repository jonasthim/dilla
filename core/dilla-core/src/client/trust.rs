//! Authenticated leaf trust and device-list history.
//!
//! Each trust table has one writer, so every path reaches the same decision:
//! - `write_pin` alone writes `app_trust_pins`: one row per user with the pinned UMK, whether it
//!   was verified, and at most one pending changed key taken from a validated signed list.
//! - `record_quarantine` alone writes leaf verdicts to `app_quarantine`, keyed by the
//!   authenticated leaf (group, user, device, signature key). A changed-key send block is never
//!   replaced by a later verdict about the same leaf; it ends only when the leaf leaves the group
//!   (a validated Remove) or its exact key is verified.
//! - `leaf_verdict` is the one judgement of a leaf against the pin and the cached signed list, and
//!   `apply_verdict` the one way a verdict reaches storage (quarantine row and retraction).
//! - `send_block` derives the send gate from the live tree: a member leaf with a failed or
//!   changed-key verdict blocks sending to that group until it leaves the group (controller ruling
//!   2, fail closed for confidentiality); a leaf that later validates clears its failed verdict.

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
use std::collections::BTreeSet;

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
    #[allow(dead_code)] // L-CORE-44 shape; ingest judges every current leaf of the user instead.
    device_id: [u8; 16],
    umk_pub: [u8; 32],
    ssk_pub: [u8; 32],
    version: u64,
}

type CachedList = (i64, Vec<u8>, [u8; 32], [u8; 32]);
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
    // The newest list must be signed under this leaf's SSK also when it is the cached anchor (a
    // history of the unchanged head only), or a leaf under another key would rebind the cached
    // list to a key that never signed it (protocol/03 rule 2).
    current
        .verify(&cred.ssk_pub)
        .map_err(|_| failure(E_CREDENTIAL))?;
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

// ---------------------------------------------------------------------------------------------
// The pin: one row per user.

/// A user's pin. `umk` is the key first seen (or last verified); `changed` is a different key a
/// validated signed list later presented, pending exact-key verification.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Pin {
    umk: [u8; 32],
    first_seen: i64,
    verified: bool,
    changed: Option<[u8; 32]>,
}

fn read_pin(c: &rusqlite::Connection, user: &[u8; 16]) -> Result<Option<Pin>, StorageError> {
    c.query_row(
        "SELECT umk_pub,first_seen,verified,changed_umk FROM app_trust_pins WHERE user_id=?1",
        [user.as_slice()],
        |r| {
            Ok(Pin {
                umk: r.get(0)?,
                first_seen: r.get(1)?,
                verified: r.get::<_, i64>(2)? == 1,
                changed: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// The only writer of `app_trust_pins`.
fn write_pin(c: &rusqlite::Connection, user: &[u8; 16], pin: &Pin) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,?4,?5) \
         ON CONFLICT(user_id) DO UPDATE SET umk_pub=excluded.umk_pub,first_seen=excluded.first_seen,\
         verified=excluded.verified,changed_umk=excluded.changed_umk",
        params![
            user.as_slice(),
            pin.umk.as_slice(),
            pin.first_seen,
            i64::from(pin.verified),
            pin.changed.as_ref().map(|k| k.as_slice())
        ],
    )?;
    Ok(())
}

/// The own account's pin: this device's own credential's UMK, verified, with no pending change.
/// The client holds the ground truth for itself, so the own key is never taken on first use
/// from what the instance serves. Written at signup, at enrolment and at every open.
pub(super) fn pin_own(
    c: &rusqlite::Connection,
    user: &[u8; 16],
    umk: &[u8; 32],
    now: i64,
) -> Result<(), StorageError> {
    let prior = read_pin(c, user)?;
    let pin = Pin {
        umk: *umk,
        first_seen: prior
            .filter(|p| p.umk == *umk)
            .map_or(now, |p| p.first_seen),
        verified: true,
        changed: None,
    };
    if prior != Some(pin) {
        write_pin(c, user, &pin)?;
        // The first pin changes nothing displayed; a repaired one does.
        if prior.is_some() {
            bump_generation(c)?;
        }
    }
    Ok(())
}

/// `pin_own` from the stored identity record, when there is one (the open-time repair).
pub(super) fn seed_own_pin(c: &rusqlite::Connection) -> Result<(), StorageError> {
    let Some((user, umk)) = own_user_key(c)? else {
        return Ok(());
    };
    pin_own(c, &user, &umk, 0)
}

/// A visitor of each active group (one non-generic body for the three walkers: wasm size).
type GroupVisitor<'a> = dyn FnMut(&[u8; 16], &DillaGroup) -> Result<(), ClientError> + 'a;

/// This device's user id and its own credential's UMK.
type OwnUserKey = ([u8; 16], [u8; 32]);

/// This device's user id and own credential UMK, from the stored identity record.
fn own_user_key(c: &rusqlite::Connection) -> Result<Option<OwnUserKey>, StorageError> {
    let Some(bytes) = schema::meta_get(c, schema::IDENTITY)? else {
        return Ok(None);
    };
    Ok(super::identity::IdentityRecord::decode(&bytes)
        .ok()
        .and_then(|record| {
            let credential = CredentialIdentity::decode(&record.credential).ok()?;
            Some((record.user_id, credential.umk_pub))
        }))
}

/// The pin after a validated signed list under `key`. First sight pins it unverified; the pinned
/// key keeps the pin (and ends a pending change: its newest list is the pinned key's again); any
/// other key becomes the one pending change and withdraws an earlier verification.
fn next_pin(prior: Option<Pin>, key: &[u8; 32], now: i64) -> Pin {
    match prior {
        None => Pin {
            umk: *key,
            first_seen: now,
            verified: false,
            changed: None,
        },
        Some(pin) if pin.umk == *key => Pin {
            changed: None,
            ..pin
        },
        Some(pin) => Pin {
            verified: false,
            changed: Some(*key),
            ..pin
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Retraction, bounded by a page.

/// Accepted rows retracted per page, and the number of distinct dependent targets collected
/// before they are refolded. Neither is sized by the history a sender made this device store.
const RETRACT_PAGE: i64 = 256;
const REFOLD_FLUSH: usize = 1024;

/// Neutralize already accepted rows from a quarantined leaf in the caller's write unit.
/// L-CORE-45: the legacy pair form, for rows stored before the authenticated key was kept.
pub(super) fn retract_device(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    user_id: &[u8; 16],
    device_id: &[u8; 16],
    code: &str,
) -> Result<usize, StorageError> {
    retract_matching(c, group_id, RetractBy::LegacyPair(user_id, device_id), code)
}

fn retract_signature(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    signature_key: &[u8],
    code: &str,
) -> Result<usize, StorageError> {
    retract_matching(c, group_id, RetractBy::Leaf(signature_key), code)
}

enum RetractBy<'a> {
    /// Rows stored without an authenticated leaf key, by their sender pair.
    LegacyPair(&'a [u8; 16], &'a [u8; 16]),
    /// Rows authenticated by this leaf signature key.
    Leaf(&'a [u8]),
}

/// Walks the matching accepted rows in pages by seq, inside the caller's write unit: each page is
/// neutralized and unindexed, and the dependent edits, reactions and replies are refolded once per
/// distinct target. Memory is bounded by a page and the refold set, not by the history.
#[inline(never)]
fn retract_matching(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    by: RetractBy<'_>,
    code: &str,
) -> Result<usize, StorageError> {
    let (sql, a, b): (&str, &[u8], &[u8]) = match by {
        RetractBy::LegacyPair(user, device) => (
            "SELECT seq,msg_id,reply_to FROM app_messages WHERE sender_user=?2 AND group_id=?1 \
             AND sender_device=?3 AND sender_sig_key IS NULL AND status=0 AND seq>?4 ORDER BY seq LIMIT ?5",
            user.as_slice(),
            device.as_slice(),
        ),
        RetractBy::Leaf(key) => (
            "SELECT seq,msg_id,reply_to FROM app_messages WHERE group_id=?1 AND sender_sig_key=?2 \
             AND status=0 AND seq>?4 ORDER BY seq LIMIT ?5",
            key,
            &[],
        ),
    };
    let mut retracted = 0usize;
    let mut targets: BTreeSet<[u8; 16]> = BTreeSet::new();
    let mut cursor = i64::MIN;
    loop {
        let rows: Vec<RetractedRow> = {
            let mut stmt = c.prepare_cached(sql)?;
            stmt.query_map(
                params![group_id.as_slice(), a, b, cursor, RETRACT_PAGE],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?
            .collect::<Result<_, _>>()?
        };
        let Some(last) = rows.last() else { break };
        cursor = last.0;
        let full = rows.len() as i64 == RETRACT_PAGE;
        for (seq, own_id, reply_to) in rows {
            c.execute("UPDATE app_messages SET status=1,reason=?3,body='',envelope=NULL,edit_body=NULL,mention=0 WHERE group_id=?1 AND seq=?2", params![group_id.as_slice(),seq,code])?;
            c.execute(
                "DELETE FROM app_search_rows WHERE group_id=?1 AND seq=?2",
                params![group_id.as_slice(), seq],
            )?;
            retracted += 1;
            targets.extend([own_id, reply_to].into_iter().flatten());
        }
        if targets.len() >= REFOLD_FLUSH {
            refold_targets(c, group_id, &mut targets)?;
        }
        if !full {
            break;
        }
    }
    refold_targets(c, group_id, &mut targets)?;
    Ok(retracted)
}

fn refold_targets(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    targets: &mut BTreeSet<[u8; 16]>,
) -> Result<(), StorageError> {
    for target in std::mem::take(targets) {
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
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Leaf verdicts and the send gate.

/// Persist a failed authenticated-leaf verdict with its historical retraction.
/// The caller owns the same write unit as the unreadable incoming row.
#[cfg(test)]
pub(super) fn quarantine_device(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    user_id: &[u8; 16],
    device_id: &[u8; 16],
    code: &str,
) -> Result<(), StorageError> {
    record_quarantine(c, group_id, user_id, device_id, &[], code)?;
    retract_device(c, group_id, user_id, device_id, code)?;
    bump_generation(c)
}

/// The only writer of leaf verdicts. A changed-key send block is kept when a later verdict about
/// the same leaf arrives (a revocation must not release it); the answer is whether a row changed.
fn record_quarantine(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    user_id: &[u8; 16],
    device_id: &[u8; 16],
    signature_key: &[u8],
    code: &str,
) -> Result<bool, StorageError> {
    let changed = c.execute(
        "INSERT INTO app_quarantine(group_id,user_id,device_id,signature_key,code) VALUES(?1,?2,?3,?4,?5) \
         ON CONFLICT(group_id,user_id,device_id,signature_key) DO UPDATE SET code=excluded.code \
         WHERE app_quarantine.code<>excluded.code AND app_quarantine.code<>'E_UMK_CHANGED'",
        params![
            group_id.as_slice(),
            user_id.as_slice(),
            device_id.as_slice(),
            signature_key,
            code
        ],
    )?;
    Ok(changed > 0)
}

/// The one way a leaf verdict reaches storage. A pending verdict (`E_DEVICE_LIST_STALE`) writes
/// nothing and retracts nothing. A valid leaf ends its own earlier failed verdict (a device that
/// joined before the list naming it was ingested), never a changed-key block. Any other failure
/// quarantines the leaf by its authenticated key and retracts that key's accepted rows. Answers
/// whether stored state changed.
fn apply_verdict(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    user: &[u8; 16],
    device: &[u8; 16],
    signature_key: &[u8],
    verdict: Result<(), &str>,
) -> Result<bool, StorageError> {
    let code = match verdict {
        Ok(()) => {
            let cleared = c.execute(
                "DELETE FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3 \
                 AND signature_key=?4 AND code<>'E_UMK_CHANGED'",
                params![
                    group_id.as_slice(),
                    user.as_slice(),
                    device.as_slice(),
                    signature_key
                ],
            )?;
            return Ok(cleared > 0);
        }
        Err(code) if code == E_DEVICE_LIST_STALE => return Ok(false),
        Err(code) => code,
    };
    let recorded = record_quarantine(c, group_id, user, device, signature_key, code)?;
    let retracted = retract_signature(c, group_id, signature_key, code)?;
    Ok(recorded || retracted > 0)
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
    signature_key: &[u8],
) -> Result<(), StorageError> {
    let changed = c.execute(
        "DELETE FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3 AND signature_key=?4 AND code='E_UMK_CHANGED'",
        params![group_id.as_slice(), user_id.as_slice(), device_id.as_slice(), signature_key],
    )?;
    if changed > 0 {
        bump_generation(c)?;
    }
    Ok(())
}

/// The verdict that blocks sending to `group`, if any (controller ruling 2: fail closed for
/// confidentiality). Every member leaf is looked up by its authenticated signature key, decodable
/// or not; a changed-key block wins over other failures. A row of a leaf that left the group (any
/// validated Remove, also one this device committed) does not count, so a Remove releases that
/// group only. A legacy row without a leaf key matches its user and device (or, if its owner was
/// ambiguous, its device) so a migrated block is not lost.
pub(super) fn send_block(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
) -> Result<Option<&'static str>, StorageError> {
    let mut found = None;
    for (_, code) in member_blocks(c, group, group_id)? {
        if code == E_UMK_CHANGED {
            return Ok(Some(code));
        }
        found.get_or_insert(code);
    }
    Ok(found)
}

/// A member leaf's stored verdict, with the leaf's user when its credential decodes.
type MemberBlock = (Option<[u8; 16]>, &'static str);

/// The stored verdict of each member leaf of `group` that has one, with the leaf's user when its
/// credential decodes. The one lookup of a live leaf's verdict, for the send gate and trust_state.
fn member_blocks(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
) -> Result<Vec<MemberBlock>, StorageError> {
    let mut stmt = c.prepare_cached(
        "SELECT code FROM app_quarantine WHERE group_id=?1 AND (signature_key=?2 \
         OR (signature_key=x'' AND device_id=?4 AND user_id IN (?3,zeroblob(16)))) \
         ORDER BY code='E_UMK_CHANGED' DESC LIMIT 1",
    )?;
    let mut out = Vec::new();
    for member in group.members() {
        let pair = BasicCredential::try_from(member.credential)
            .ok()
            .and_then(|basic| CredentialIdentity::decode(basic.identity()).ok())
            .map(|identity| (*identity.user_id.as_bytes(), *identity.device_id.as_bytes()));
        let code: Option<String> = stmt
            .query_row(
                params![
                    group_id.as_slice(),
                    member.signature_key.as_slice(),
                    pair.map(|p| p.0.to_vec()),
                    pair.map(|p| p.1.to_vec())
                ],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(code) = code {
            out.push((pair.map(|p| p.0), block_code(&code)));
        }
    }
    Ok(out)
}

/// The stored verdict as the refusal `send_prepare` and `send_encrypt` answer with.
fn block_code(code: &str) -> &'static str {
    [E_UMK_CHANGED, E_DEVICE_UNLISTED, E_TIER_MISMATCH]
        .into_iter()
        .find(|known| *known == code)
        .unwrap_or(E_CREDENTIAL)
}

pub(super) fn member_devices(group: &DillaGroup) -> Vec<([u8; 16], [u8; 16], [u8; 32])> {
    group
        .members()
        .into_iter()
        .filter_map(|member| {
            let basic = BasicCredential::try_from(member.credential).ok()?;
            let identity = CredentialIdentity::decode(basic.identity()).ok()?;
            let signature_key = member.signature_key.as_slice().try_into().ok()?;
            Some((
                *identity.user_id.as_bytes(),
                *identity.device_id.as_bytes(),
                signature_key,
            ))
        })
        .collect()
}

pub(super) fn clear_removed_blocks(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    before: &[([u8; 16], [u8; 16], [u8; 32])],
    after: &[([u8; 16], [u8; 16], [u8; 32])],
) -> Result<(), StorageError> {
    for (user, device, sig) in before.iter().filter(|leaf| !after.contains(leaf)) {
        clear_group_block(c, group_id, user, device, sig)?;
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
    // One row per leaf and verdict: a failed leaf left in the tree does not add a row per epoch.
    c.execute(
        "INSERT INTO app_trust_audit \
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE NOT EXISTS(SELECT 1 FROM app_trust_audit \
         WHERE group_id=?1 AND user_id=?2 AND device_id=?3 AND signature_key=?6 AND code=?7) \
         ON CONFLICT DO UPDATE SET code=excluded.code,added_by_user=COALESCE(excluded.added_by_user,app_trust_audit.added_by_user),added_by_device=COALESCE(excluded.added_by_device,app_trust_audit.added_by_device)",
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
    leaf_verdict(c, leaf)
        .map_err(ClientError::from)?
        .map_err(failure)
}

/// The one judgement of an authenticated leaf against its user's pin and cached signed list.
/// The outer error is storage; the inner one the verdict code. Rule 2 (the pinned UMK) is
/// decided before rule 3 (the newest signed list), as `protocol/03-identity.md` orders them:
/// - a leaf of the pending changed key is `E_UMK_CHANGED` (it blocks the groups holding it);
/// - while a change is pending, a leaf of the pinned key is pending (`E_DEVICE_LIST_STALE`): a
///   list signed under an unverified key neither revokes it nor vouches for it;
/// - any other key is `E_CREDENTIAL` (D1-prime: a leaf not backed by its user's verified signed
///   list only ever fails itself);
/// - otherwise the newest signed list decides (`E_DEVICE_UNLISTED`, `E_TIER_MISMATCH`).
#[inline(never)]
fn leaf_verdict(
    c: &rusqlite::Connection,
    leaf: &LeafEvidence,
) -> Result<Result<(), &'static str>, StorageError> {
    if leaf.credential.verify_signatures(&leaf.dsk_pub).is_err() {
        return Ok(Err(E_CREDENTIAL));
    }
    let user = leaf.credential.user_id.as_bytes();
    // The pin is judged first: the own account's pin exists before any of its lists is cached.
    let pin = read_pin(c, user)?;
    let key = leaf.credential.umk_pub;
    match pin.map(|pin| (pin.umk, pin.changed)) {
        Some((_, Some(pending))) if pending == key => return Ok(Err(E_UMK_CHANGED)),
        Some((pinned, Some(_))) if pinned == key => return Ok(Err(E_DEVICE_LIST_STALE)),
        Some((_, Some(_))) => return Ok(Err(E_CREDENTIAL)),
        // A leaf of the own user under another key than this device's own (F3 ruling).
        Some((pinned, None)) if pinned != key => {
            let own = own_user_key(c)?.is_some_and(|(own, _)| own == *user);
            return Ok(Err(if own { E_UMK_CHANGED } else { E_CREDENTIAL }));
        }
        Some((_, None)) | None => {}
    }
    let cached: Option<(Vec<u8>, [u8; 32], [u8; 32])> = c
        .query_row(
            "SELECT list,umk_pub,ssk_pub FROM app_device_lists WHERE user_id=?1",
            [user.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((bytes, umk, ssk)) = cached else {
        return Ok(Err(E_DEVICE_LIST_STALE));
    };
    if umk != key || ssk != leaf.credential.ssk_pub {
        return Ok(Err(E_CREDENTIAL));
    }
    let Ok(list) = DeviceList::decode(&bytes) else {
        return Ok(Err(E_CREDENTIAL));
    };
    if list.unsigned.user_id != leaf.credential.user_id || list.verify(&ssk).is_err() {
        return Ok(Err(E_CREDENTIAL));
    }
    if let Err(e) = list.check_leaf(
        &leaf.credential.device_id,
        &leaf.dsk_pub,
        leaf.credential.tier,
    ) {
        return Ok(Err(ClientError::from(e).code));
    }
    // A cached list without its pin (never written apart by ingest) vouches for nobody.
    Ok(if pin.is_some() {
        Ok(())
    } else {
        Err(E_DEVICE_LIST_STALE)
    })
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
/// Missing history remains pending; a failed leaf is neutralized by its own leaf identity.
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
        audit_member(
            c, group, group_id, own_user, own_device, member, author, previous,
        )?;
    }
    Ok(())
}

/// A failed application sender is charged to its own leaf: one verdict, not a re-verification
/// of every member's signed list per refused message.
pub(super) fn audit_sender(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
    own_user: &[u8; 16],
    own_device: &[u8; 16],
    sender_leaf: u32,
) -> Result<(), StorageError> {
    match group.member_at(sender_leaf) {
        Some(member) => audit_member(c, group, group_id, own_user, own_device, member, None, None),
        None => Ok(()),
    }
}

#[allow(clippy::too_many_arguments)] // The tree transition's evidence, as audit_tree receives it.
fn audit_member(
    c: &rusqlite::Connection,
    group: &DillaGroup,
    group_id: &[u8; 16],
    own_user: &[u8; 16],
    own_device: &[u8; 16],
    member: Member,
    author: Option<(&[u8; 16], &[u8; 16])>,
    previous: Option<&[LeafFingerprint]>,
) -> Result<(), StorageError> {
    let fingerprint = (member.index.u32(), member.signature_key.as_slice().to_vec());
    let (user, device, code) = match extract_leaf(group_id, group, [0; 32], member) {
        Ok(leaf) => {
            let user = *leaf.credential.user_id.as_bytes();
            let device = *leaf.credential.device_id.as_bytes();
            if &user == own_user
                && &device == own_device
                && fingerprint.0 == group.own_leaf_index().u32()
            {
                return Ok(());
            }
            match leaf_verdict(c, &leaf)? {
                Ok(()) => {
                    if apply_verdict(c, group_id, &user, &device, &fingerprint.1, Ok(()))? {
                        bump_generation(c)?;
                    }
                    return Ok(());
                }
                Err(code) => (user, device, code),
            }
        }
        Err(_) => {
            // A credential without a decodable identity has no authenticated user/device
            // pair. Reserve the zero user and derive a stable opaque device key from the
            // authenticated tree position and signature key. It is never treated as a
            // verified device-list entry, but its own leaf gets a failed verdict.
            let mut hash = Sha256::new();
            hash.update(b"dilla undecodable leaf v1");
            hash.update(group_id);
            hash.update(fingerprint.0.to_be_bytes());
            hash.update(&fingerprint.1);
            let digest = hash.finalize();
            let mut opaque_device = [0u8; 16];
            opaque_device.copy_from_slice(&digest[..16]);
            ([0; 16], opaque_device, E_CREDENTIAL)
        }
    };
    if code == E_DEVICE_LIST_STALE {
        return Ok(());
    }
    if apply_verdict(c, group_id, &user, &device, &fingerprint.1, Err(code))? {
        bump_generation(c)?;
    }
    audit_failed_leaf(
        c,
        group_id,
        group.epoch(),
        &fingerprint,
        &user,
        &device,
        code,
        author,
        previous,
    )
}

/// A proposed Add's verdict. A leaf whose signed history was fetched and failed
/// (`device_list_ingest_add` recorded the verdict) answers that failure rather than looking
/// unfetched, so it is left out of the commit instead of refusing every commit (ruling 3).
pub(super) fn validate_proposed_add(
    c: &rusqlite::Connection,
    kp: &KeyPackage,
) -> Result<(), ClientError> {
    let leaf = leaf_from_key_package(kp)?;
    match leaf_verdict(c, &leaf)? {
        Err(E_DEVICE_LIST_STALE) => {
            let failed: Option<String> = c
                .query_row(
                    "SELECT code FROM app_quarantine WHERE user_id=?1 AND device_id=?2 AND signature_key=?3 LIMIT 1",
                    params![
                        leaf.credential.user_id.as_bytes().as_slice(),
                        leaf.credential.device_id.as_bytes().as_slice(),
                        leaf.dsk_pub.as_slice()
                    ],
                    |r| r.get(0),
                )
                .optional()
                .map_err(StorageError::from)?;
            Err(failure(
                failed.map_or(E_DEVICE_LIST_STALE, |code| block_code(&code)),
            ))
        }
        verdict => verdict.map_err(failure),
    }
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

/// This device's own exact leaf identity, which no trust verdict is applied to.
type OwnLeaf = Option<([u8; 16], [u8; 16], [u8; 32])>;

fn is_own(own: &OwnLeaf, leaf: &LeafEvidence) -> bool {
    own.is_some_and(|(user, device, dsk)| {
        leaf.credential.user_id.as_bytes() == &user
            && leaf.credential.device_id.as_bytes() == &device
            && leaf.dsk_pub == dsk
    })
}

impl ClientCore {
    pub fn trust_generation(&self) -> Result<u64, ClientError> {
        self.read(|c| {
            Ok(schema::meta_get(c, "trust_generation")?
                .and_then(|v| crate::cbor::decode_strict(&v, |d| d.uint()).ok())
                .unwrap_or(0))
        })
    }

    fn own_leaf(&self) -> OwnLeaf {
        self.own()
            .ok()
            .map(|own| (own.user_id, own.device_id, own.dsk_pub))
    }

    /// The send gate of `send_prepare`: the live tree when the group can be loaded, otherwise
    /// any verdict row of the group (fail closed). Public so the page can pause its composer on
    /// the same verdict the core refuses a send with.
    pub fn send_block_code(
        &self,
        group_id: &[u8; 16],
    ) -> Result<Option<&'static str>, ClientError> {
        let cached = self.groups.get(group_id);
        let loaded = if cached.is_none() {
            DillaGroup::load(&self.provider, &GroupId::from_slice(group_id))?
        } else {
            None
        };
        match cached.or(loaded.as_ref()) {
            Some(group) => self.read(|c| send_block(c, group, group_id)),
            None => self.read(|c| {
                let code: Option<String> = c
                    .query_row(
                        "SELECT code FROM app_quarantine WHERE group_id=?1 ORDER BY code='E_UMK_CHANGED' DESC LIMIT 1",
                        [group_id.as_slice()],
                        |r| r.get(0),
                    )
                    .optional()?;
                Ok(code.map(|code| block_code(&code)))
            }),
        }
    }

    fn candidate_leaves(
        &mut self,
        group_id: &[u8; 16],
        proposals_body: &[u8],
    ) -> Result<Vec<(u64, LeafEvidence)>, ClientError> {
        let proposals = wire::decode_proposals_body(proposals_body)?;
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
        let evidence = leaf.clone();
        let result = self.ingest_leaf(leaf, requested_user, history_body, head_list, now, false);
        // A fetched history that fails this candidate is its verdict: kept by its leaf identity
        // so the commit leaves the Add out instead of asking for a fetch again (ruling 3). An
        // incomplete or substituted history (`E_DEVICE_LIST_STALE`) stays a refusal to retry.
        if let Err(e) = &result {
            let verdict = [
                E_CREDENTIAL,
                E_DEVICE_UNLISTED,
                E_TIER_MISMATCH,
                E_UMK_CHANGED,
            ]
            .into_iter()
            .find(|code| *code == e.code);
            if let Some(code) =
                verdict.filter(|_| evidence.credential.user_id.as_bytes() == requested_user)
            {
                self.write(|_, u| {
                    u.with_conn(|c| {
                        record_quarantine(
                            c,
                            &evidence.group_id,
                            requested_user,
                            evidence.credential.device_id.as_bytes(),
                            &evidence.dsk_pub,
                            code,
                        )
                        .map(drop)
                    })
                    .map_err(ClientError::from)
                })?;
            }
        }
        result
    }

    /// Calls `f` with each active group (state 2), from the cache or loaded from the store; at
    /// most 4,096 groups, ids bounded before any group state is loaded.
    fn each_active_group(&self, f: &mut GroupVisitor<'_>) -> Result<(), ClientError> {
        let ids: Vec<[u8; 16]> = self.read(|c| {
            let mut stmt = c.prepare(
                "SELECT group_id FROM app_groups WHERE state=2 ORDER BY group_id LIMIT 4097",
            )?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()
                .map_err(Into::into)
        })?;
        if ids.len() > 4096 {
            return Err(failure(E_CORE_LIMIT));
        }
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
            f(&id, group)?;
        }
        Ok(())
    }

    fn current_user_leaves(&self, user: &[u8; 16]) -> Result<Vec<LeafEvidence>, ClientError> {
        let mut out = Vec::new();
        self.each_active_group(&mut |id, group| {
            for member in group.members() {
                let Ok(leaf) = extract_leaf(id, group, [0; 32], member) else {
                    continue;
                };
                if leaf.credential.user_id.as_bytes() == user {
                    if out.len() == 4096 {
                        return Err(failure(E_CORE_LIMIT));
                    }
                    out.push(leaf);
                }
            }
            Ok(())
        })?;
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
        let mut rows = Vec::new();
        self.each_active_group(&mut |id, group| {
            let id = *id;
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
                    let changed = read_pin(c, &user)?.is_some_and(|pin| pin.changed.is_some());
                    Ok((version.unwrap_or(0).max(0) as u64, changed))
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
            Ok(())
        })?;
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
        let count = Decoder::new(history_body)
            .array_len()
            .map_err(|_| failure(E_DEVICE_LIST_STALE))?;
        if count > 1024 {
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
        // The own account's key is this device's own credential's; no served list changes it.
        if self
            .read(own_user_key)?
            .is_some_and(|(user, umk)| user == *requested_user && umk != validated.umk_pub)
        {
            return Err(failure(E_UMK_CHANGED));
        }
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
        let now = i64::try_from(now).map_err(|_| failure(super::error::E_CORE_INPUT))?;
        // Every current leaf of this user is judged again, in the same unit, by the same verdict
        // the transition audit uses, against the pin and list this ingest writes.
        let user_leaves = self.current_user_leaves(requested_user)?;
        let own = self.own_leaf();
        // Rows stored before the authenticated leaf key was kept: candidates for retraction when
        // the newest list under the pinned key drops their device.
        let revoked_legacy_devices: Vec<[u8; 16]> = cached
            .as_ref()
            .and_then(|(_, blob, _, _)| DeviceList::decode(blob).ok())
            .map(|previous| {
                previous
                    .unsigned
                    .entries
                    .iter()
                    .filter(|entry| {
                        head.check_leaf(&entry.device_id, &entry.dsk_pub, entry.tier)
                            .is_err()
                    })
                    .map(|entry| *entry.device_id.as_bytes())
                    .collect()
            })
            .unwrap_or_default();
        let legacy_rows: Vec<([u8; 16], [u8; 16])> = if revoked_legacy_devices.is_empty() {
            Vec::new()
        } else {
            self.read(|c| {
            let mut stmt=c.prepare("SELECT DISTINCT group_id,sender_device FROM app_messages WHERE sender_user=?1 AND sender_sig_key IS NULL AND status=0 LIMIT 4097")?;
            stmt.query_map([requested_user.as_slice()],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>().map_err(Into::into)
        })?
        };
        if legacy_rows.len() > 4096 {
            return Err(failure(E_CORE_LIMIT));
        }
        let (changed, quarantined) = self.write(|_, u| {
            u.with_conn(|c| {
                let prior = read_pin(c, requested_user)?;
                let pin = next_pin(prior, &validated.umk_pub, now);
                write_pin(c, requested_user, &pin)?;
                c.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,list=excluded.list,umk_pub=excluded.umk_pub,ssk_pub=excluded.ssk_pub",params![validated.user_id.as_slice(),validated.version as i64,head_list,validated.umk_pub.as_slice(),validated.ssk_pub.as_slice()])?;
                // First sight pins without changing anything displayed; a key change or its end does.
                let mut touched = prior.is_some() && prior != Some(pin);
                let mut quarantined = 0u64;
                for leaf in user_leaves.iter().filter(|leaf| !is_own(&own, leaf)) {
                    let verdict = leaf_verdict(c, leaf)?;
                    let device = leaf.credential.device_id.as_bytes();
                    touched |= apply_verdict(c, &leaf.group_id, requested_user, device, &leaf.dsk_pub, verdict)?;
                    quarantined += u64::from(verdict.is_err_and(|code| code != E_DEVICE_LIST_STALE));
                }
                // Only a list under the pinned key is the user's own word on its devices; a list
                // under a pending, unverified key revokes nothing that was accepted before.
                if pin.changed.is_none() && pin.umk == validated.umk_pub {
                    for (group, device) in legacy_rows.iter().filter(|(_, device)| revoked_legacy_devices.contains(device)) {
                        touched |= retract_device(c, group, requested_user, device, E_DEVICE_UNLISTED)? > 0;
                    }
                }
                if touched {
                    bump_generation(c)?;
                }
                let newly_changed = pin.changed.is_some() && pin.changed != prior.and_then(|p| p.changed);
                Ok((newly_changed, quarantined))
            })
            .map_err(ClientError::from)
        })?;
        let mut e = Encoder::new();
        e.array(3)
            .uint(validated.version)
            .uint(u64::from(changed))
            .uint(quarantined);
        Ok(e.into_vec())
    }

    /// Bounded public-key-only local trust state.
    pub fn trust_state(&self) -> Result<Vec<u8>, ClientError> {
        type TrustRow = ([u8; 16], [u8; 32], i64, i64, Option<[u8; 32]>);
        let rows: Vec<TrustRow> = self.read(|c| {
            let mut stmt=c.prepare("SELECT user_id,umk_pub,first_seen,verified,changed_umk FROM app_trust_pins ORDER BY user_id LIMIT 4097")?;
            stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?.collect::<Result<_,_>>().map_err(Into::into)
        })?;
        if rows.len() > 4096 {
            return Err(failure(E_CORE_LIMIT));
        }
        // The stored verdict of each user's leaves still in an active group; a changed-key block
        // wins. Read from the store, so a reload never shows a blocked contact as clean.
        let mut blocks: Vec<MemberBlock> = Vec::new();
        self.each_active_group(&mut |id, group| {
            blocks.extend(self.read(|c| member_blocks(c, group, id))?);
            Ok(())
        })?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for (user, umk, first, verified, changed) in rows {
            e.array(6)
                .bytes(&user)
                .bytes(&umk)
                .uint(first.max(0) as u64)
                .uint(u64::from(verified == 1))
                .opt_bytes(changed.as_ref().map(|v| v.as_slice()));
            let mut blocked = None;
            for (_, code) in blocks.iter().filter(|(owner, _)| *owner == Some(user)) {
                if blocked != Some(E_UMK_CHANGED) {
                    blocked = Some(*code);
                }
            }
            match blocked {
                Some(code) => e.text(code),
                None => e.null(),
            };
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
        let pin = self
            .read(|c| read_pin(c, user_id))?
            .ok_or_else(|| failure(E_DEVICE_LIST_STALE))?;
        // The key shown for comparison: the pending changed key, or the pinned one.
        if pin.changed.unwrap_or(pin.umk) != *expected_umk {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        let leaves = self.current_user_leaves(user_id)?;
        let endorsed: Vec<&LeafEvidence> = leaves
            .iter()
            .filter(|leaf| {
                leaf.credential.umk_pub == *expected_umk
                    && leaf.credential.verify_signatures(&leaf.dsk_pub).is_ok()
            })
            .collect();
        // The verified key must still hold a current leaf that its signed list names.
        if !endorsed.iter().any(|leaf| {
            leaf.credential.ssk_pub == ssk
                && list
                    .check_leaf(
                        &leaf.credential.device_id,
                        &leaf.dsk_pub,
                        leaf.credential.tier,
                    )
                    .is_ok()
        }) {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
        // Blocks this verification ends: every leaf of the verified key, current or named by its
        // list. Blocks of any other key stay until their leaf is removed.
        let mut released: BTreeSet<[u8; 32]> = endorsed.iter().map(|leaf| leaf.dsk_pub).collect();
        released.extend(
            list.unsigned
                .entries
                .iter()
                .filter(|entry| entry.revoked_at.is_none())
                .map(|entry| entry.dsk_pub),
        );
        let own = self.own_leaf();
        self.write(|_, u| {
            u.with_conn(|c| {
                write_pin(
                    c,
                    user_id,
                    &Pin {
                        umk: *expected_umk,
                        first_seen: pin.first_seen,
                        verified: true,
                        changed: None,
                    },
                )?;
                for key in &released {
                    c.execute("DELETE FROM app_quarantine WHERE user_id=?1 AND signature_key=?2 AND code='E_UMK_CHANGED'",params![user_id.as_slice(),key.as_slice()])?;
                }
                for leaf in leaves.iter().filter(|leaf| !is_own(&own, leaf)) {
                    let verdict = leaf_verdict(c, leaf)?;
                    let device = leaf.credential.device_id.as_bytes();
                    apply_verdict(c, &leaf.group_id, user_id, device, &leaf.dsk_pub, verdict)?;
                }
                bump_generation(c)
            })
            .map_err(ClientError::from)
        })?;
        // Messages the user's current leaves sent while unverified waited as retained evidence;
        // each is released only if its exact leaf now validates (revalidate_pending checks it).
        // A core with no identity has received nothing. Each (group, leaf index) is listed once.
        if own.is_some() {
            for leaf in leaves.iter().filter(|leaf| !is_own(&own, leaf)) {
                self.revalidate_pending(&leaf.group_id, leaf.leaf_index, 256)?;
            }
        }
        Ok(())
    }

    /// Pairwise comparison digits for a contact in a current shared MLS group, for exactly the key
    /// the caller will approve with `trust_verify`: `expected_umk` must be the comparison key (the
    /// pending changed key, or the pinned one), else `E_DEVICE_LIST_STALE`.
    pub fn safety_number_for(
        &self,
        user_id: &[u8; 16],
        expected_umk: &[u8; 32],
    ) -> Result<String, ClientError> {
        let comparison_key: Option<[u8; 32]> = self.read(|c| {
            c.query_row(
                "SELECT l.umk_pub FROM app_device_lists l JOIN app_trust_pins p ON p.user_id=l.user_id WHERE l.user_id=?1 AND COALESCE(p.changed_umk,p.umk_pub)=l.umk_pub",
                [user_id.as_slice()],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
        })?;
        let comparison_key = comparison_key.ok_or_else(|| failure(E_CORE_NOT_FOUND))?;
        if comparison_key != *expected_umk {
            return Err(failure(E_DEVICE_LIST_STALE));
        }
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
            &safety_number(&own_cred.umk_pub, &comparison_key),
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
        clear_group_block(&db, &group, &changed, &device, &[]).unwrap();
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
        // The UMK pin belongs to the user (protocol/03 rule 2): two users colliding on a device
        // id keep two independent pins, and one user cannot hold two disagreeing pins.
        for owner in [user, other_user] {
            db.execute(
                "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified) VALUES(?1,?2,1,0)",
                params![owner.as_slice(), [0x34u8; 32].as_slice()],
            )
            .unwrap();
        }
        let pins: i64 = db
            .query_row(
                "SELECT count(*) FROM app_trust_pins WHERE user_id IN (?1,?2)",
                params![user.as_slice(), other_user.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pins, 2);
        assert!(
            db.execute(
                "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified) VALUES(?1,?2,1,1)",
                params![user.as_slice(), [0x36u8; 32].as_slice()],
            )
            .is_err(),
            "a second, disagreeing pin for one user is unrepresentable"
        );
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
        let (mut owner, mut owner_list) = fixture();
        let owner_key: [u8; 32] = owner_signer.public().try_into().unwrap();
        owner_list.unsigned.entries[0].dsk_pub = owner_key;
        owner_list.sig_ssk =
            SskSigner::from_bytes(&[0x42; 32]).sign_device_list(&owner_list.unsigned);
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
        db.execute(
            "INSERT INTO app_groups(group_id,kind,target_id,state) VALUES(?1,0,?2,2)",
            params![group_id.as_slice(), [0x33u8; 16].as_slice()],
        )
        .unwrap();
        db.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub) VALUES(?1,1,?2,?3,?4)",params![owner.credential.user_id.as_bytes(),owner_list.encode(),owner.credential.umk_pub.as_slice(),owner.credential.ssk_pub.as_slice()]).unwrap();
        db.execute(
            "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified) VALUES(?1,?2,1,0)",
            params![
                owner.credential.user_id.as_bytes(),
                owner.credential.umk_pub.as_slice()
            ],
        )
        .unwrap();
        let malformed_key: [u8; 32] = malformed_signer.public().try_into().unwrap();
        db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,sender_user,sender_device,sender_sig_key,type,body,franking_tag) VALUES(?1,1,0,1,0,?2,?3,?4,0,'malformed historical comet',?5)",params![group_id.as_slice(),[0x66u8;16].as_slice(),[0x67u8;16].as_slice(),malformed_key.as_slice(),[0x68u8;32].as_slice()]).unwrap();
        db.execute("INSERT INTO app_search_rows(group_id,seq,user_id,device_id,body,terms) VALUES(?1,1,?2,?3,'malformed historical comet',' malformed historical comet')",params![group_id.as_slice(),[0x66u8;16].as_slice(),[0x67u8;16].as_slice()]).unwrap();
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
        let old: (i64, String) = db
            .query_row(
                "SELECT status,body FROM app_messages WHERE group_id=?1 AND seq=1",
                [group_id.as_slice()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            old,
            (1, String::new()),
            "a failed nameless leaf retracts rows bearing its signature key"
        );
        let hits: i64 = db
            .query_row(
                "SELECT count(*) FROM app_search_rows WHERE group_id=?1",
                [group_id.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0);
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
        drop(db);
        let mut core = ClientCore {
            provider,
            signer: None,
            groups: Default::default(),
        };
        core.trust_verify(
            owner.credential.user_id.as_bytes().try_into().unwrap(),
            &owner.credential.umk_pub,
        )
        .expect("unrelated malformed leaf cannot prevent exact-key verification");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn forged_local_pair_quarantines_only_its_authenticated_leaf() {
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
        let (mut owner, mut list) = fixture();
        let owner_key: [u8; 32] = owner_signer.public().try_into().unwrap();
        let ssk = SskSigner::from_bytes(&[0x42; 32]);
        owner.credential.sig_ssk_dev = ssk.sign_device(
            &DeviceId::from_bytes([0x44; 16]),
            &owner_key,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        list.unsigned.entries[0].dsk_pub = owner_key;
        list.sig_ssk = ssk.sign_device_list(&list.unsigned);
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
        let forged_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).unwrap();
        forged_signer.store(provider.storage()).unwrap();
        let forged_key: [u8; 32] = forged_signer.public().try_into().unwrap();
        let mut forged = owner.credential.clone();
        forged.sig_ssk_dev = ssk.sign_device(
            &forged.device_id,
            &forged_key,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        );
        let forged_cred = CredentialWithKey {
            credential: BasicCredential::new(forged.encode()).into(),
            signature_key: forged_signer.public().into(),
        };
        let kp = build_key_package(&provider, &forged_signer, forged_cred, false).unwrap();
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
        db.execute(
            "INSERT INTO app_groups(group_id,kind,target_id,state) VALUES(?1,0,?2,2)",
            params![group_id.as_slice(), [0x33u8; 16].as_slice()],
        )
        .unwrap();
        db.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub) VALUES(?1,1,?2,?3,?4)",params![owner.credential.user_id.as_bytes(),list.encode(),owner.credential.umk_pub.as_slice(),owner.credential.ssk_pub.as_slice()]).unwrap();
        for (seq, leaf, body, key) in [
            (1, 0, "honest comet", owner_key),
            (2, 1, "forged comet", forged_key),
        ] {
            db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,sender_user,sender_device,sender_leaf,sender_sig_key,type,body,franking_tag) VALUES(?1,?2,0,1,0,?3,?4,?5,?6,0,?7,?8)",params![group_id.as_slice(),seq,owner.credential.user_id.as_bytes(),owner.credential.device_id.as_bytes(),leaf,key.as_slice(),body,[0x77u8;32].as_slice()]).unwrap();
            db.execute("INSERT INTO app_search_rows(group_id,seq,user_id,device_id,body,terms) VALUES(?1,?2,?3,?4,?5,?6)",params![group_id.as_slice(),seq,owner.credential.user_id.as_bytes(),owner.credential.device_id.as_bytes(),body,format!(" {body}")]).unwrap();
        }
        audit_tree(
            &db,
            &group,
            &group_id,
            owner.credential.user_id.as_bytes().try_into().unwrap(),
            owner.credential.device_id.as_bytes().try_into().unwrap(),
            None,
            Some(&[]),
        )
        .unwrap();
        let rows: Vec<(i64, String)> = db
            .prepare("SELECT status,body FROM app_messages WHERE group_id=?1 ORDER BY seq")
            .unwrap()
            .query_map([group_id.as_slice()], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec![(0, "honest comet".into()), (1, String::new())]);
        let indexed: Vec<i64> = db
            .prepare("SELECT seq FROM app_search_rows WHERE group_id=?1 ORDER BY seq")
            .unwrap()
            .query_map([group_id.as_slice()], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(indexed, vec![1]);
        let bad: i64 = db.query_row("SELECT count(*) FROM app_trust_audit WHERE group_id=?1 AND signature_key=?2 AND code IN ('E_CREDENTIAL','E_DEVICE_UNLISTED')",params![group_id.as_slice(),forged_key.as_slice()],|r|r.get(0)).unwrap();
        assert_eq!(bad, 1);
        let pair_block: i64 = db.query_row("SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3 AND signature_key=?4",params![group_id.as_slice(),owner.credential.user_id.as_bytes(),owner.credential.device_id.as_bytes(),owner_key.as_slice()],|r|r.get(0)).unwrap();
        assert_eq!(
            pair_block, 0,
            "the valid local leaf cannot inherit its forgery's verdict"
        );
        let forged_block: i64 = db.query_row("SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3 AND signature_key=?4",params![group_id.as_slice(),owner.credential.user_id.as_bytes(),owner.credential.device_id.as_bytes(),forged_key.as_slice()],|r|r.get(0)).unwrap();
        assert_eq!(
            forged_block, 1,
            "the forged leaf keeps its own failed verdict"
        );
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
            before.iter().map(|(u, d, _)| (*u, *d)).collect::<Vec<_>>(),
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
        assert_eq!(
            after.iter().map(|(u, d, _)| (*u, *d)).collect::<Vec<_>>(),
            vec![([0x43; 16], [0x44; 16])]
        );
        let db = db.lock().unwrap();
        super::super::schema::migrate_conn(&db).unwrap();
        db.execute("INSERT INTO app_quarantine(group_id,user_id,device_id,signature_key,code) VALUES(?1,?2,?3,?4,'E_UMK_CHANGED')",
            params![group_id.as_slice(),[0x55u8;16].as_slice(),[0x44u8;16].as_slice(),before[1].2.as_slice()]).unwrap();
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
            "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,1,0,?3)",
            rusqlite::params![[0x64u8; 16].as_slice(), [0x65u8; 32].as_slice(), [0x66u8; 32].as_slice()],
        ).expect("changed pin");
        clear_group_block(&db, &first, &[0x64u8; 16], &device, &[]).expect("validated remove");
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

    #[test]
    fn failed_same_pair_leaf_cannot_replace_a_changed_key_send_block() {
        for forged_first in [false, true] {
            let db = rusqlite::Connection::open_in_memory().unwrap();
            super::super::schema::migrate_conn(&db).unwrap();
            let group = [0x91; 16];
            let user = [0x92; 16];
            let device = [0x93; 16];
            let changed = || {
                record_quarantine(&db, &group, &user, &device, &[0x94; 32], E_UMK_CHANGED).unwrap()
            };
            let forged = || {
                record_quarantine(&db, &group, &user, &device, &[0x95; 32], E_CREDENTIAL).unwrap()
            };
            if forged_first {
                forged();
                changed();
            } else {
                changed();
                forged();
            }
            let blocked: i64 = db.query_row(
                "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND code='E_UMK_CHANGED'",
                [group.as_slice()],
                |r| r.get(0),
            ).unwrap();
            assert_eq!(
                blocked, 1,
                "a forged leaf must not clear the changed user's send block"
            );
            clear_group_block(&db, &group, &user, &device, &[0x95; 32]).unwrap();
            let still_blocked: i64 = db.query_row("SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND code='E_UMK_CHANGED'",[group.as_slice()],|r|r.get(0)).unwrap();
            assert_eq!(
                still_blocked, 1,
                "removing the forged leaf cannot release the changed leaf's block"
            );
        }
    }
}
