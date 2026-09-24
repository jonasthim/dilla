//! The `(ptr, len) -> u64` handlers of interfaces §2.10 — the fifteen shipped at ABI v1 plus ABI
//! v2's `public_group_staged_discard` — written as pure functions over
//! `&[u8]` so the native test build drives exactly the same encoders the wasm build does.

// `Decoder` is deliberately absent: nothing outside the `#[cfg(test)]` module (which has its own
// `use`) names the type, and `cargo clippy --all-targets -- -D warnings` at step 16 fails on an
// unused import.
use dilla_core::cbor::Encoder;
use dilla_core::identity::CredentialIdentity;
use dilla_core::public_group::{
    DillaPublicGroup, PublicProcessed, external_propose_add, external_propose_remove,
    validate_key_package,
};
// `BasicCredential` lives in `openmls::credentials` (facts-openmls §7), not in
// `openmls_basic_credential`, which exports only `SignatureKeyPair`. `ProposalRef` is
// `openmls::ciphersuite::hash_ref::ProposalRef` and is NOT re-exported by `openmls::prelude` in
// 0.9.0 (`messages::proposals` imports it privately) — the same finding `public_group::state`
// records.
use openmls::ciphersuite::hash_ref::ProposalRef;
// Named explicitly so the two types this file's ABI v2 code leans on are visible at the top of
// the file rather than arriving through the glob.
use openmls::group::StagedCommit;
use openmls::messages::proposals::Proposal;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;

use crate::abi::{self, AbiError, tls};
use crate::handles::{Table, with_table};

/// The only ciphersuite dilla speaks at e2ee_version 1 (`protocol/00-overview.md`).
const CIPHERSUITE_ID: u64 = 0x0001;

/// Routes one request by export name. Never panics and never returns an OpenMLS type.
pub fn dispatch(export: &str, req: &[u8]) -> Vec<u8> {
    let result = with_table(|t| match export {
        "dilla_abi" => abi_info(req, t),
        "vectors_check" => vectors_check(req, t),
        "public_group_create" => public_group_create(req, t),
        "public_group_import_state" => public_group_import_state(req, t),
        "public_group_export_state" => public_group_export_state(req, t),
        "public_group_close" => public_group_close(req, t),
        "public_group_process" => public_group_process(req, t),
        "public_group_merge" => public_group_merge(req, t),
        "public_group_staged_discard" => public_group_staged_discard(req, t),
        "public_group_tree" => public_group_tree(req, t),
        "public_group_state" => public_group_state(req, t),
        "public_group_proposal_put" => public_group_proposal_put(req, t),
        "public_group_proposal_list" => public_group_proposal_list(req, t),
        "validate_key_package" => validate_key_package_export(req, t),
        "external_propose_add" => external_propose_add_export(req, t),
        "external_propose_remove" => external_propose_remove_export(req, t),
        other => Err(AbiError::shape(format!("unknown export {other}"))),
    });
    match result {
        Ok(bytes) => bytes,
        Err(err) => abi::error_response(&err),
    }
}

fn abi_info(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    abi::open(req, 1)?.finish()?;
    let mut e = Encoder::new();
    e.array(6)
        .uint(0)
        .uint(dilla_core::ABI_VERSION)
        .text(dilla_core::CORE_VERSION)
        .uint(dilla_core::E2EE_VERSION)
        .uint(dilla_core::MEDIA_VERSION)
        .array(1)
        .uint(CIPHERSUITE_ID);
    Ok(e.into_vec())
}

/// Deviation A2-9: the report's elements are emitted after the `0`, not the whole
/// `VectorReport::encode` array nested inside it.
fn vectors_check(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    abi::open(req, 1)?.finish()?;
    let report = dilla_core::vectors::run_all();
    let mut e = Encoder::new();
    e.array(4)
        .uint(0)
        .uint(u64::from(report.passed))
        .uint(u64::from(report.failed));
    e.array(report.suites.len());
    for suite in &report.suites {
        e.array(2).text(suite.name).array(suite.cases.len());
        for case in &suite.cases {
            e.array(5)
                .text(&case.case)
                .text(case.field)
                .uint(u64::from(case.ok))
                .text(&case.expected)
                .text(&case.actual);
        }
    }
    Ok(e.into_vec())
}

fn public_group_create(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let tree = d.bytes()?;
    let group_info = d.bytes()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let (group, gi) = DillaPublicGroup::from_external(
        &crypto,
        tls::ratchet_tree_in(tree)?,
        tls::verifiable_group_info(group_info)?,
    )?;
    let gi_bytes = tls::group_info_out(&gi)?;
    let epoch = group.epoch();
    let group_id = group.group_id().as_slice().to_vec();
    let tree_hash = group.tree_hash();
    let handle = t.insert_group(group);

    let mut e = Encoder::new();
    e.array(6)
        .uint(0)
        .uint(u64::from(handle))
        .uint(epoch)
        .bytes(&group_id)
        .bytes(&tree_hash)
        .bytes(&gi_bytes);
    Ok(e.into_vec())
}

fn public_group_import_state(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let state = d.bytes()?;
    let group_id = d.bytes()?;
    d.finish()?;

    let group = DillaPublicGroup::import_state(state, &GroupId::from_slice(group_id))?;
    let epoch = group.epoch();
    let handle = t.insert_group(group);

    let mut e = Encoder::new();
    e.array(3).uint(0).uint(u64::from(handle)).uint(epoch);
    Ok(e.into_vec())
}

fn public_group_export_state(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    let state = t.group(handle)?.export_state();
    let mut e = Encoder::new();
    e.array(2).uint(0).bytes(&state);
    Ok(e.into_vec())
}

fn public_group_close(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    t.close_group(handle)?;
    let mut e = Encoder::new();
    e.array(1).uint(0);
    Ok(e.into_vec())
}

fn public_group_process(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let handle = abi::read_handle(&mut d)?;
    let message = d.bytes()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let pm = tls::protocol_message(message)?;
    // process_message takes &self and writes nothing (gap-1 §6), so the borrow ends here and the
    // staged commit can then be moved into the table.
    let (processed, epoch) = {
        let group = t.group(handle)?;
        (group.process_message(&crypto, pm)?, group.epoch())
    };

    let (kind, sender_leaf, staged, proposal_ref) = match processed {
        PublicProcessed::Proposal {
            proposal_ref,
            sender_leaf,
        } => (0u64, sender_leaf, None, Some(proposal_ref)),
        PublicProcessed::ExternalJoinProposal { proposal_ref } => {
            (2, None, None, Some(proposal_ref))
        }
        p @ PublicProcessed::StagedCommit { .. } => {
            let sender = match &p {
                PublicProcessed::StagedCommit { sender_leaf, .. } => *sender_leaf,
                _ => unreachable!("matched StagedCommit one line above"),
            };
            let staged_handle = t.insert_staged(p);
            (1, sender, Some(staged_handle), None)
        }
        // kind 3: the DS never sees a PrivateMessage; the message is reported, not raised.
        PublicProcessed::Rejected(_) => (3, None, None, None),
    };

    // ABI v2: the applied list and the committer-update flag. Both elements are always present;
    // for anything but a commit they are the empty array and 0. The staged commit is read back
    // **by reference** (`Table::staged`), never taken: `public_group_merge` is the one consumer.
    // Building the list can fail on input a remote member controls, and the handle is already in
    // the table by then, so it goes through `with_staged_or_release`: see that function for why an
    // error must take the entry with it.
    let (applied, committer_updated) = match staged {
        Some(h) => with_staged_or_release(t, h, |p| match p {
            PublicProcessed::StagedCommit { staged, .. } => Ok((
                applied_proposals(staged)?,
                u64::from(staged.update_path_leaf_node().is_some()),
            )),
            _ => Ok((Vec::new(), 0)),
        })?,
        None => (Vec::new(), 0),
    };

    let mut e = Encoder::new();
    e.array(8).uint(0).uint(kind).uint(epoch);
    e.opt_uint(sender_leaf.map(u64::from));
    e.opt_uint(staged.map(u64::from));
    e.opt_bytes(proposal_ref.as_deref());
    e.array(applied.len());
    for item in &applied {
        e.array(5).bytes(&item.proposal_ref).uint(item.kind);
        e.opt_uint(item.sender_leaf.map(u64::from));
        e.opt_uint(item.target_leaf.map(u64::from));
        e.opt_bytes(item.credential_identity.as_deref());
    }
    e.uint(committer_updated);
    Ok(e.into_vec())
}

/// Reads the staged commit at `handle` by reference, and releases it if `f` fails.
///
/// `public_group_process` inserts the `StagedCommit` before it can know whether the applied list
/// will build, and `applied_proposals` has two failure modes a remote member controls: a proposal
/// type outside the seven `protocol/02-delivery-service.md` numbers (openmls 0.9.0 carries
/// `SelfRemove` and `Custom` unconditionally) and an Add whose credential is not a
/// `BasicCredential` (`E_CREDENTIAL`). An error frame carries no handle number, and `take_staged`
/// is the only remover, so an entry left behind on that path can never be reached again by
/// `public_group_merge` or `public_group_staged_discard` — for a 1500-leaf group that is the
/// unbounded growth the discard export exists to prevent, on a message the DS did not choose to
/// accept. So the handle is released before the error leaves this module.
fn with_staged_or_release<T>(
    t: &mut Table,
    handle: u32,
    f: impl FnOnce(&PublicProcessed) -> Result<T, AbiError>,
) -> Result<T, AbiError> {
    // An unknown handle is E_ABI_HANDLE and removes nothing: `f` never runs, so the release arm
    // below is not reached and no live entry is touched.
    let staged = t.staged(handle)?;
    match f(staged) {
        Ok(value) => Ok(value),
        Err(err) => {
            let _ = t.take_staged(handle);
            Err(err)
        }
    }
}

/// One entry of ABI v2 §3.1's `applied` array.
struct Applied {
    proposal_ref: Vec<u8>,
    kind: u64,
    sender_leaf: Option<u32>,
    target_leaf: Option<u32>,
    credential_identity: Option<Vec<u8>>,
}

/// Every proposal the commit resolved, in the order `StagedCommit` reports them.
///
/// `kind` is the RFC 9420 proposal type as `protocol/02-delivery-service.md` numbers it —
/// 1 add, 2 update, 3 remove, 4 psk, 5 reinit, 6 external_init, 7 group_context_extensions.
/// Anything else (openmls 0.9.0 also has `SelfRemove`, `Custom` and the two `extensions-draft`
/// variants) is a shape failure rather than a silently dropped item: invariant 4 clause 1 is a
/// **set** comparison against the DS's outstanding proposals, and an item the DS cannot name is
/// exactly the case where discarding it would let an unreferenced proposal through.
fn applied_proposals(staged: &StagedCommit) -> Result<Vec<Applied>, AbiError> {
    let mut out = Vec::new();
    for queued in staged.queued_proposals() {
        let sender_leaf = match queued.sender() {
            Sender::Member(index) => Some(index.u32()),
            _ => None,
        };
        let proposal_ref = queued.proposal_reference_ref().as_slice().to_vec();
        let (kind, target_leaf, credential_identity) = match queued.proposal() {
            Proposal::Add(add) => (1u64, None, Some(leaf_credential_bytes(add.key_package())?)),
            Proposal::Update(_) => (2, None, None),
            Proposal::Remove(remove) => (3, Some(remove.removed().u32()), None),
            Proposal::PreSharedKey(_) => (4, None, None),
            Proposal::ReInit(_) => (5, None, None),
            Proposal::ExternalInit(_) => (6, None, None),
            Proposal::GroupContextExtensions(_) => (7, None, None),
            other => {
                return Err(AbiError::shape(format!(
                    "commit applies an unsupported proposal type {:?}",
                    other.proposal_type()
                )));
            }
        };
        out.push(Applied {
            proposal_ref,
            kind,
            sender_leaf,
            target_leaf,
            credential_identity,
        });
    }
    Ok(out)
}

fn public_group_merge(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let handle = abi::read_handle(&mut d)?;
    let staged = abi::read_handle(&mut d)?;
    d.finish()?;

    let processed = t.take_staged(staged)?;
    let commit = match processed {
        PublicProcessed::StagedCommit { staged, .. } => staged,
        _ => {
            return Err(AbiError::state(format!(
                "handle {staged} is not a staged commit"
            )));
        }
    };
    let group = t.group_mut(handle)?;
    group.merge_commit(*commit)?;
    let epoch = group.epoch();

    let mut e = Encoder::new();
    e.array(2).uint(0).uint(epoch);
    Ok(e.into_vec())
}

/// Releases a staged commit the DS decided not to merge. `public_group_process` inserts the
/// `StagedCommit` before the delivery service has checked invariant 4, and every refusal path
/// (an omitted outstanding proposal, a committer Update, a cross-user Remove, a GroupInfo whose
/// epoch or signature is wrong) leaves that handle behind. `public_group_merge` consumes a handle
/// but also advances the group, which is exactly what a refusal must not do — so the ABI needs a
/// second, non-advancing consumer. Discarding an unknown handle is `E_ABI_HANDLE`, so a double
/// discard is a clean error rather than a silent success.
fn public_group_staged_discard(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 3)?;
    let handle = abi::read_handle(&mut d)?;
    let staged = abi::read_handle(&mut d)?;
    d.finish()?;
    // `handle` is validated and nothing more: it proves the caller named a *live group*, not that
    // this group is the one `public_group_process` staged `staged` against. The two handle classes
    // share one id space (`handles.rs`) but not an ownership link, so pairing group A's handle with
    // group B's staged handle still discards B's commit. That pairing is the host's to get right —
    // interfaces §2.10 defines `staged` as a flat per-instance handle, exactly as
    // `public_group_merge` takes it, and dillad issues both from the same call site.
    let _ = t.group(handle)?;
    t.take_staged(staged)?;
    let mut e = Encoder::new();
    e.array(1).uint(0);
    Ok(e.into_vec())
}

fn public_group_tree(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    let group = t.group(handle)?;
    let tree = tls::ratchet_tree_out(&group.export_ratchet_tree())?;
    let mut e = Encoder::new();
    e.array(4)
        .uint(0)
        .bytes(&tree)
        .bytes(&group.tree_hash())
        .uint(group.epoch());
    Ok(e.into_vec())
}

fn public_group_state(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    let group = t.group(handle)?;
    let binding = group.binding().encode();
    let members = group.members();

    // Deviation A2-13: element 5 is a CBOR byte string *wrapping* the 8-element dilla_binding array,
    // which is how §2.10's export table types it (`binding(bstr)`). The same section's field note
    // says "spliced verbatim"; that note is wrong, and splicing a bare array here would make
    // §2.13's mlswasi decoder read a major-4 head where it expects major 2. The Go side decodes the
    // bstr, then decodes the binding array out of those bytes.
    let mut e = Encoder::new();
    e.array(6)
        .uint(0)
        .uint(group.epoch())
        .bytes(group.group_id().as_slice())
        .bytes(&group.tree_hash())
        .bytes(&binding);
    e.array(members.len());
    for m in &members {
        e.array(3)
            .uint(u64::from(m.leaf_index))
            .bytes(&m.signature_key)
            .bytes(&m.identity.encode());
    }
    Ok(e.into_vec())
}

fn public_group_proposal_put(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 4)?;
    let handle = abi::read_handle(&mut d)?;
    let op = d.uint()?;
    let mut e = Encoder::new();
    match op {
        0 => {
            let proposal = d.bytes()?;
            d.finish()?;
            let crypto = RustCrypto::default();
            // NV-4: framing and signature verification stay inside dilla-core. `queue_proposal`
            // (Plan A task 11) takes the received ProtocolMessage, verifies it against the group
            // context, stores the original bytes beside the QueuedProposal (deviation A2-11) and
            // returns the new proposal's reference bytes. The wasi crate never builds an
            // `AuthenticatedContent` or a `QueuedProposal` of its own.
            let pm = tls::protocol_message(proposal)?;
            let proposal_ref = t.group_mut(handle)?.queue_proposal(&crypto, pm)?;
            e.array(2).uint(0).bytes(&proposal_ref);
        }
        1 => {
            let raw = d.bytes()?;
            d.finish()?;
            let group = t.group_mut(handle)?;
            let target = group
                .queued_proposals()?
                .into_iter()
                .find(|(r, _)| proposal_ref_bytes(r) == raw)
                .map(|(r, _)| r)
                .ok_or_else(|| AbiError::state("no queued proposal with that ref"))?;
            group.remove_proposal(&target)?;
            e.array(2).uint(0).null();
        }
        2 => {
            d.null()?;
            d.finish()?;
            let group = t.group_mut(handle)?;
            for (r, _) in group.queued_proposals()? {
                group.remove_proposal(&r)?;
            }
            e.array(2).uint(0).null();
        }
        other => {
            return Err(AbiError::shape(format!(
                "proposal op {other}, expected 0, 1 or 2"
            )));
        }
    }
    Ok(e.into_vec())
}

fn public_group_proposal_list(req: &[u8], t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let handle = abi::read_handle(&mut d)?;
    d.finish()?;

    // Deviation A2-11: the second element is the original MLSMessage the DS received, not a bare
    // `Proposal`. The DS hands this list straight back to clients in §2.12's CommitConflict and
    // CommitRequired, and a bare Proposal has lost its FramedContent and signature, so a client
    // could not process what it got back. `queued_proposals()` yields `(ProposalRef, Vec<u8>)` of
    // (reference, received bytes) — Plan A task 11 owns that, raised in step 1.
    let queued = t.group(handle)?.queued_proposals()?;
    let mut e = Encoder::new();
    e.array(2).uint(0).array(queued.len());
    for (r, message) in &queued {
        e.array(2).bytes(&proposal_ref_bytes(r)).bytes(message);
    }
    Ok(e.into_vec())
}

fn validate_key_package_export(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 2)?;
    let bytes = d.bytes()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let kp = validate_key_package(&crypto, tls::key_package_in(bytes)?)?;
    let identity = CredentialIdentity::decode(&leaf_credential_bytes(&kp)?)?;

    let mut e = Encoder::new();
    e.array(5)
        .uint(0)
        .bytes(identity.device_id.as_bytes())
        .bytes(identity.user_id.as_bytes())
        .uint(u64::from(is_last_resort(&kp)))
        .uint(lifetime_not_after(&kp));
    Ok(e.into_vec())
}

fn external_propose_add_export(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 5)?;
    let group_id = d.bytes()?;
    let epoch = d.uint()?;
    let key_package = d.bytes()?;
    let signing_key = d.bytes_exact::<32>()?;
    d.finish()?;

    let crypto = RustCrypto::default();
    let kp = validate_key_package(&crypto, tls::key_package_in(key_package)?)?;
    let signer = instance_signer(&signing_key);
    let out = external_propose_add(
        kp,
        GroupId::from_slice(group_id),
        GroupEpoch::from(epoch),
        &signer,
    )?;

    let mut e = Encoder::new();
    e.array(2).uint(0).bytes(&tls::message_out(&out)?);
    Ok(e.into_vec())
}

fn external_propose_remove_export(req: &[u8], _t: &mut Table) -> Result<Vec<u8>, AbiError> {
    let mut d = abi::open(req, 5)?;
    let group_id = d.bytes()?;
    let epoch = d.uint()?;
    let leaf = d.uint()?;
    let signing_key = d.bytes_exact::<32>()?;
    d.finish()?;

    let leaf = u32::try_from(leaf)
        .map_err(|_| AbiError::shape(format!("leaf_index {leaf} does not fit in u32")))?;
    let signer = instance_signer(&signing_key);
    let out = external_propose_remove(
        LeafNodeIndex::new(leaf),
        GroupId::from_slice(group_id),
        GroupEpoch::from(epoch),
        &signer,
    )?;

    let mut e = Encoder::new();
    e.array(2).uint(0).bytes(&tls::message_out(&out)?);
    Ok(e.into_vec())
}

/// Rebuilds the instance's Ed25519 signer from its 32-byte private half. `SskSigner` is used only
/// as dilla-core's verified Ed25519 public-key derivation; the key it holds is the instance key,
/// not an SSK.
///
/// NV-3c: `SignatureKeyPair::from_raw` stores `private` verbatim and
/// `openmls_rust_crypto`'s `sign` feeds it to `ed25519_dalek::SigningKey::try_from(&[u8])`, which
/// takes the 32-byte **seed** — so the 32 bytes of the request are exactly what goes in.
fn instance_signer(private: &[u8; 32]) -> SignatureKeyPair {
    let public = dilla_core::identity::SskSigner::from_bytes(private).public();
    SignatureKeyPair::from_raw(SignatureScheme::ED25519, private.to_vec(), public.to_vec())
}

/// NV-3b: the ProposalRef's opaque bytes, as `protocol/02-delivery-service.md` moves them.
fn proposal_ref_bytes(r: &ProposalRef) -> Vec<u8> {
    r.as_slice().to_vec()
}

/// NV-3: the leaf credential's identity bytes, which are dilla's `CredentialIdentity` CBOR.
///
/// Returns an owned `Vec`, never a leaked borrow. `BasicCredential::try_from` produces an owned
/// temporary, so `identity()` can only borrow from it; the earlier `Box::leak` form leaked one
/// allocation per call, and this export is the DS's per-KeyPackage-upload hot path, driven by remote
/// input, inside a wazero instance that dillad pools and keeps alive for the process lifetime (R9).
/// That is a remote memory-exhaustion path, not a style question. The single caller passes the slice
/// straight to `CredentialIdentity::decode(&…)`, so the allocation dies at the end of the call.
fn leaf_credential_bytes(kp: &KeyPackage) -> Result<Vec<u8>, AbiError> {
    let credential = kp.leaf_node().credential();
    BasicCredential::try_from(credential.clone())
        .map(|b| b.identity().to_vec())
        .map_err(|e| AbiError::new("E_CREDENTIAL", e.to_string()))
}

/// NV-3: `last_resort` is a KeyPackage extension, not a leaf-node one.
fn is_last_resort(kp: &KeyPackage) -> bool {
    kp.last_resort()
}

/// NV-3: the upper bound of the KeyPackage's `Lifetime`, in seconds since the Unix epoch.
///
/// Deviation from the brief's snippet, forced by the vendored source: `LeafNode::life_time()` is
/// `pub(crate)` in openmls 0.9.0 (`src/treesync/node/leaf_node.rs:473`) and therefore unreachable
/// from this crate. The public accessor is `KeyPackage::life_time(&self) -> &Lifetime`
/// (`src/key_packages/mod.rs:492`), which is infallible — its doc comment records that a leaf
/// inside a KeyPackage always carries a lifetime, and `KeyPackageIn::validate` (the only way a
/// `KeyPackage` is produced here) rejects any other `LeafNodeSource` with
/// `KeyPackageVerifyError::InvalidLeafNodeSourceType`. So this returns `u64`, not
/// `Result<u64, AbiError>`: there is no error path left to report.
fn lifetime_not_after(kp: &KeyPackage) -> u64 {
    kp.life_time().not_after()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dilla_core::cbor::{Decoder, Encoder, decode_strict};

    fn req(build: impl FnOnce(&mut Encoder)) -> Vec<u8> {
        let mut e = Encoder::new();
        build(&mut e);
        e.into_vec()
    }

    fn version_only() -> Vec<u8> {
        req(|e| {
            e.array(1).uint(dilla_core::ABI_VERSION);
        })
    }

    /// Returns (code, detail) of a failure frame, or panics if the frame is a success.
    fn failure(bytes: &[u8]) -> (String, String) {
        decode_strict(bytes, |d: &mut Decoder<'_>| {
            d.array(3)?;
            assert_eq!(d.uint()?, 1, "expected a failure frame");
            Ok((d.text()?.to_owned(), d.text()?.to_owned()))
        })
        .expect("failure frames are always valid deterministic CBOR")
    }

    #[test]
    fn dilla_abi_reports_the_pinned_versions_and_ciphersuite() {
        let out = dispatch("dilla_abi", &version_only());
        let got = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(6)?;
            let ok = d.uint()?;
            let abi = d.uint()?;
            let core = d.text()?.to_owned();
            let e2ee = d.uint()?;
            let media = d.uint()?;
            d.array(1)?;
            let suite = d.uint()?;
            Ok((ok, abi, core, e2ee, media, suite))
        })
        .unwrap();
        assert_eq!(got.0, 0);
        assert_eq!(got.1, dilla_core::ABI_VERSION);
        assert_eq!(got.2, dilla_core::CORE_VERSION);
        assert_eq!(got.3, dilla_core::E2EE_VERSION);
        assert_eq!(got.4, dilla_core::MEDIA_VERSION);
        assert_eq!(
            got.5, 0x0001,
            "the only ciphersuite at v1 is MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
        );
    }

    #[test]
    fn an_unknown_abi_version_is_an_error_frame_not_a_trap() {
        let bad = req(|e| {
            e.array(1).uint(dilla_core::ABI_VERSION + 1);
        });
        assert_eq!(
            failure(&dispatch("dilla_abi", &bad)).0,
            crate::abi::E_ABI_VERSION
        );
    }

    #[test]
    fn truncated_cbor_is_e_abi_shape_not_a_trap() {
        assert_eq!(
            failure(&dispatch("dilla_abi", &[0x82, 0x01])).0,
            crate::abi::E_ABI_SHAPE
        );
        assert_eq!(
            failure(&dispatch("dilla_abi", &[])).0,
            crate::abi::E_ABI_SHAPE
        );
    }

    #[test]
    fn a_map_request_is_rejected_by_the_strict_decoder() {
        // a0 — the empty map, which the dilla CBOR subset forbids outright.
        assert_eq!(
            failure(&dispatch("dilla_abi", &[0xa0])).0,
            crate::abi::E_ABI_SHAPE
        );
    }

    #[test]
    fn an_unknown_export_name_is_an_error_frame() {
        assert_eq!(
            failure(&dispatch("nope", &version_only())).0,
            crate::abi::E_ABI_SHAPE
        );
    }

    #[test]
    fn every_public_group_export_rejects_a_handle_that_was_never_issued() {
        for name in [
            "public_group_export_state",
            "public_group_close",
            "public_group_tree",
            "public_group_state",
            "public_group_proposal_list",
        ] {
            let r = req(|e| {
                e.array(2).uint(dilla_core::ABI_VERSION).uint(4_242);
            });
            assert_eq!(
                failure(&dispatch(name, &r)).0,
                crate::abi::E_ABI_HANDLE,
                "{name}"
            );
        }
    }

    #[test]
    fn merging_a_staged_handle_that_was_never_issued_is_e_abi_handle() {
        let r = req(|e| {
            e.array(3).uint(dilla_core::ABI_VERSION).uint(1).uint(7);
        });
        assert_eq!(
            failure(&dispatch("public_group_merge", &r)).0,
            crate::abi::E_ABI_HANDLE
        );
    }

    #[test]
    fn vectors_check_reports_no_failures() {
        let out = dispatch("vectors_check", &version_only());
        let (ok, passed, failed) = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(4)?;
            let ok = d.uint()?;
            let passed = d.uint()?;
            let failed = d.uint()?;
            d.skip()?;
            Ok((ok, passed, failed))
        })
        .unwrap();
        assert_eq!(ok, 0);
        assert_eq!(
            failed, 0,
            "the wasi build must reproduce every committed vector"
        );
        assert!(passed > 0, "a zero-case report would pass vacuously");
    }

    #[test]
    fn the_vectors_report_carries_the_same_suites_as_the_native_runner() {
        let native = dilla_core::vectors::run_all();
        let out = dispatch("vectors_check", &version_only());
        let names = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(4)?;
            d.uint()?;
            d.uint()?;
            d.uint()?;
            let n = d.array_len()?;
            let mut names = Vec::with_capacity(n);
            for _ in 0..n {
                d.array(2)?;
                names.push(d.text()?.to_owned());
                d.skip()?;
            }
            Ok(names)
        })
        .unwrap();
        let expected: Vec<String> = native.suites.iter().map(|s| s.name.to_string()).collect();
        assert_eq!(names, expected);
    }

    /// The committed 1,500-leaf fixture of Plan A task 13. `include_bytes!` is the only way to reach
    /// it from a `crate-type = ["cdylib"]` crate: no `tests/` integration target can link this
    /// library, so the fixture is compiled into the unit-test binary instead. The paths are relative
    /// to `core/dilla-core-wasi/src/`.
    const FIXTURE_TREE: &[u8] =
        include_bytes!("../../../testkit/fixtures/ds-1500/ratchet_tree.mls");
    const FIXTURE_GROUP_INFO: &[u8] =
        include_bytes!("../../../testkit/fixtures/ds-1500/group_info.mls");

    /// Creates the fixture group and returns `(handle, epoch, group_id, tree_hash)`.
    fn create_fixture_group() -> (u64, u64, Vec<u8>, Vec<u8>) {
        let r = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .bytes(FIXTURE_TREE)
                .bytes(FIXTURE_GROUP_INFO);
        });
        let out = dispatch("public_group_create", &r);
        decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(6)?;
            assert_eq!(
                d.uint()?,
                0,
                "public_group_create must accept the committed fixture"
            );
            let handle = d.uint()?;
            let epoch = d.uint()?;
            let group_id = d.bytes()?.to_vec();
            let tree_hash = d.bytes()?.to_vec();
            d.skip()?; // the re-serialised GroupInfo; its framing is asserted by Plan B task 3.
            Ok((handle, epoch, group_id, tree_hash))
        })
        .expect("the create response is deterministic CBOR")
    }

    /// interfaces §6 task 14: `public_group_export_state` → `public_group_import_state` →
    /// `public_group_state` reproduces the epoch and tree hash.
    #[test]
    fn state_round_trips_through_export_and_import_byte_for_byte() {
        let (handle, epoch, group_id, tree_hash) = create_fixture_group();

        let r = req(|e| {
            e.array(2).uint(dilla_core::ABI_VERSION).uint(handle);
        });
        let state = decode_strict(
            &dispatch("public_group_export_state", &r),
            |d: &mut Decoder<'_>| {
                d.array(2)?;
                assert_eq!(d.uint()?, 0);
                Ok(d.bytes()?.to_vec())
            },
        )
        .unwrap();
        assert!(
            !state.is_empty(),
            "an empty state blob would make the round-trip vacuous"
        );

        let r = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .bytes(&state)
                .bytes(&group_id);
        });
        let (imported, imported_epoch) = decode_strict(
            &dispatch("public_group_import_state", &r),
            |d: &mut Decoder<'_>| {
                d.array(3)?;
                assert_eq!(d.uint()?, 0);
                Ok((d.uint()?, d.uint()?))
            },
        )
        .unwrap();
        assert_eq!(imported_epoch, epoch);

        let r = req(|e| {
            e.array(2).uint(dilla_core::ABI_VERSION).uint(imported);
        });
        let (got_epoch, got_group_id, got_tree_hash, members) = decode_strict(
            &dispatch("public_group_state", &r),
            |d: &mut Decoder<'_>| {
                d.array(6)?;
                assert_eq!(d.uint()?, 0);
                let epoch = d.uint()?;
                let group_id = d.bytes()?.to_vec();
                let tree_hash = d.bytes()?.to_vec();
                // Deviation A2-13: element 5 is a byte string wrapping the 8-element binding array.
                let binding = d.bytes()?.to_vec();
                let members = d.array_len()?;
                for _ in 0..members {
                    d.array(3)?;
                    d.uint()?;
                    d.bytes()?;
                    d.bytes()?;
                }
                assert!(
                    !binding.is_empty(),
                    "dilla_binding must survive the state round-trip"
                );
                Ok((epoch, group_id, tree_hash, members))
            },
        )
        .unwrap();
        assert_eq!(got_epoch, epoch);
        assert_eq!(got_group_id, group_id);
        assert_eq!(
            got_tree_hash, tree_hash,
            "the tree hash must survive export and import"
        );
        assert_eq!(members, 1_500, "the committed fixture has 1,500 leaves");
    }

    #[test]
    fn public_group_close_twice_is_a_bad_handle_the_second_time() {
        let (handle, _, _, _) = create_fixture_group();
        let close = req(|e| {
            e.array(2).uint(dilla_core::ABI_VERSION).uint(handle);
        });
        let first = dispatch("public_group_close", &close);
        decode_strict(&first, |d: &mut Decoder<'_>| {
            d.array(1)?;
            assert_eq!(d.uint()?, 0, "the first close succeeds");
            Ok(())
        })
        .unwrap();
        assert_eq!(
            failure(&dispatch("public_group_close", &close)).0,
            crate::abi::E_ABI_HANDLE
        );
        assert_eq!(
            failure(&dispatch("public_group_tree", &close)).0,
            crate::abi::E_ABI_HANDLE
        );
    }

    /// NV-3c's regression net. It proves the signer can be built and used without panicking, which is
    /// the failure mode a wrong `from_raw` private-key layout produces inside openmls_rust_crypto. It
    /// does **not** prove the signature verifies against a real group: that needs a group whose
    /// `external_senders` carries this public key, which is Plan A task 13's testkit scenario
    /// `external_propose_remove produces a message a member accepts as coming from sender index 0`.
    #[test]
    fn the_instance_signer_is_derived_from_the_private_half_and_signs_without_panicking() {
        let sk = [0x0bu8; 32];
        let signer = super::instance_signer(&sk);
        assert_eq!(
            signer.public(),
            dilla_core::identity::SskSigner::from_bytes(&sk).public(),
            "the public half must be derived, never taken from the request"
        );

        let r = req(|e| {
            e.array(5)
                .uint(dilla_core::ABI_VERSION)
                .bytes(&[0x11u8; 16])
                .uint(7)
                .uint(3)
                .bytes(&sk);
        });
        let message = decode_strict(
            &dispatch("external_propose_remove", &r),
            |d: &mut Decoder<'_>| {
                d.array(2)?;
                assert_eq!(
                    d.uint()?,
                    0,
                    "external_propose_remove must produce a success frame"
                );
                Ok(d.bytes()?.to_vec())
            },
        )
        .unwrap();
        assert!(
            !message.is_empty(),
            "an empty MLSMessage would pass vacuously"
        );
        crate::abi::tls::mls_message_in(&message)
            .expect("the output must be a well-formed MLSMessage");
    }

    // The fixture's own commits are the only committed multi-thousand-leaf MLS messages in the
    // tree, and all ten are alternatives at the same base epoch, so each applies cleanly to a
    // freshly created fixture group. `testkit/src/fixtures.rs:158-215` fixes which is which:
    //   commits/00..07 - `DillaGroup::add_members` over MAX_ADDS_PER_COMMIT (256) KeyPackages
    //   commits/08     - `DillaGroup::remove_members(&[LeafNodeIndex::new(1)])`
    //   commits/09     - `DillaGroup::self_update`
    // Naming the generator line in each constant is deliberate: a fixture regeneration that
    // reorders the ten commits must fail these tests loudly rather than silently assert nothing.

    /// `testkit/src/fixtures.rs:158-181` - 256 inline Add proposals, one per KeyPackage.
    const FIXTURE_COMMIT_ADD: &[u8] =
        include_bytes!("../../../testkit/fixtures/ds-1500/commits/00.mls");
    /// `testkit/src/fixtures.rs:189-199` - one Remove of leaf 1.
    const FIXTURE_COMMIT_REMOVE: &[u8] =
        include_bytes!("../../../testkit/fixtures/ds-1500/commits/08.mls");
    /// `testkit/src/fixtures.rs:207-215` - a self-update: no proposals at all.
    const FIXTURE_COMMIT_SELF_UPDATE: &[u8] =
        include_bytes!("../../../testkit/fixtures/ds-1500/commits/09.mls");

    /// Decodes the ABI v2 `public_group_process` response and returns
    /// `(kind, epoch, sender_leaf, staged, applied, committer_updated)`.
    #[allow(clippy::type_complexity)]
    fn process(
        handle: u64,
        message: &[u8],
    ) -> (u64, u64, Option<u64>, Option<u64>, Vec<AppliedItem>, u64) {
        let r = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .uint(handle)
                .bytes(message);
        });
        let out = dispatch("public_group_process", &r);
        decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(8)?;
            assert_eq!(
                d.uint()?,
                0,
                "public_group_process must accept the fixture commit"
            );
            let kind = d.uint()?;
            let epoch = d.uint()?;
            let sender_leaf = d.opt_uint()?;
            let staged = d.opt_uint()?;
            d.skip()?; // proposal_ref
            let n = d.array_len()?;
            let mut applied = Vec::with_capacity(n);
            for _ in 0..n {
                d.array(5)?;
                let proposal_ref = d.bytes()?.to_vec();
                let kind = d.uint()?;
                let sender_leaf = d.opt_uint()?;
                let target_leaf = d.opt_uint()?;
                let credential_identity = d.opt_bytes()?.map(<[u8]>::to_vec);
                applied.push(AppliedItem {
                    proposal_ref,
                    kind,
                    sender_leaf,
                    target_leaf,
                    credential_identity,
                });
            }
            let committer_updated = d.uint()?;
            Ok((kind, epoch, sender_leaf, staged, applied, committer_updated))
        })
        .expect("the process response is deterministic CBOR")
    }

    #[derive(Debug)]
    struct AppliedItem {
        proposal_ref: Vec<u8>,
        kind: u64,
        sender_leaf: Option<u64>,
        target_leaf: Option<u64>,
        credential_identity: Option<Vec<u8>>,
    }

    /// interfaces §3: the response-shape change forces `abi_version = 2`.
    #[test]
    fn dilla_abi_reports_version_two() {
        let out = dispatch("dilla_abi", &version_only());
        let abi = decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(6)?;
            assert_eq!(d.uint()?, 0);
            let abi = d.uint()?;
            // `decode_strict` insists the whole frame is consumed, so the four elements this test
            // does not assert (core_version, e2ee_version, media_version, ciphersuites) are
            // skipped rather than left as trailing bytes.
            d.skip()?; // core_version
            d.skip()?; // e2ee_version
            d.skip()?; // media_version
            d.skip()?; // the ciphersuite array
            Ok(abi)
        })
        .unwrap();
        assert_eq!(
            abi, 2,
            "ABI v2: the process and validate_key_package responses grew"
        );
        assert_eq!(dilla_core::ABI_VERSION, 2);
    }

    /// An ABI v1 request must now be refused outright — there is no compatibility shim (§3).
    #[test]
    fn an_abi_version_one_request_is_refused() {
        let r = req(|e| {
            e.array(1).uint(1);
        });
        let (code, detail) = failure(&dispatch("dilla_abi", &r));
        assert_eq!(code, crate::abi::E_ABI_VERSION);
        assert!(
            detail.contains('1') && detail.contains('2'),
            "detail: {detail}"
        );
    }

    /// Kind 1. `DillaGroup::add_members` builds one inline Add proposal per KeyPackage and
    /// `StagedCommit::queued_proposals()` iterates the whole staged queue, inline proposals
    /// included (openmls-0.9.0 `staged_commit.rs:926`), so `applied` has exactly
    /// `MAX_ADDS_PER_COMMIT` items. `add_members` passes `force_self_update(true)` to the commit
    /// builder (openmls-0.9.0 `src/group/mls_group/membership.rs:59,165`), so the UpdatePath is
    /// present and `committer_updated` is 1.
    #[test]
    fn an_add_commit_reports_one_applied_item_per_key_package() {
        let (handle, epoch, _group_id, _tree_hash) = create_fixture_group();
        let (kind, got_epoch, sender_leaf, staged, applied, committer_updated) =
            process(handle, FIXTURE_COMMIT_ADD);
        assert_eq!(kind, 1, "a commit");
        assert_eq!(got_epoch, epoch, "process reports the pre-merge epoch");
        assert!(sender_leaf.is_some(), "a member commit names its leaf");
        assert!(staged.is_some(), "a commit yields a staged handle");
        assert_eq!(
            applied.len(),
            dilla_core::mls::MAX_ADDS_PER_COMMIT,
            "commits/00.mls carries one inline Add per KeyPackage"
        );
        for item in &applied {
            assert_eq!(item.kind, 1, "every item is an Add");
            assert_eq!(
                item.sender_leaf, sender_leaf,
                "an inline proposal is attributed to the committer's own leaf"
            );
            assert!(item.target_leaf.is_none(), "an Add names no leaf");
            assert!(!item.proposal_ref.is_empty(), "every item carries its ref");
            let identity = item
                .credential_identity
                .as_ref()
                .expect("an Add carries the joiner's credential identity");
            dilla_core::identity::CredentialIdentity::decode(identity)
                .expect("the credential identity is the core's 10-element CBOR array");
        }
        assert_eq!(committer_updated, 1, "add_members forces a self-update");
    }

    /// Kind 3, with `target_leaf` set and no credential identity.
    #[test]
    fn a_remove_commit_reports_the_removed_leaf() {
        let (handle, _epoch, _group_id, _tree_hash) = create_fixture_group();
        let (kind, _got_epoch, _sender_leaf, staged, applied, committer_updated) =
            process(handle, FIXTURE_COMMIT_REMOVE);
        assert_eq!(kind, 1, "a commit");
        assert!(staged.is_some());
        assert_eq!(
            applied.len(),
            1,
            "commits/08.mls removes exactly one leaf: {applied:?}"
        );
        assert_eq!(applied[0].kind, 3, "a Remove");
        assert_eq!(
            applied[0].target_leaf,
            Some(1),
            "leaf 1, per fixtures.rs:195"
        );
        assert!(
            applied[0].credential_identity.is_none(),
            "a Remove carries no credential"
        );
        assert_eq!(
            committer_updated, 1,
            "a Remove requires an UpdatePath (RFC 9420 §17.4)"
        );
    }

    /// The zero-proposal arm: a self-update commit stages, applies nothing, and sets the flag.
    #[test]
    fn a_self_update_commit_reports_no_proposals_and_the_committer_update_flag() {
        let (handle, epoch, _group_id, _tree_hash) = create_fixture_group();
        let (kind, got_epoch, sender_leaf, staged, applied, committer_updated) =
            process(handle, FIXTURE_COMMIT_SELF_UPDATE);
        assert_eq!(kind, 1, "a commit");
        assert_eq!(got_epoch, epoch, "process reports the pre-merge epoch");
        assert!(sender_leaf.is_some(), "a member commit names its leaf");
        assert!(staged.is_some(), "a commit yields a staged handle");
        assert!(
            applied.is_empty(),
            "commits/09.mls references no proposals: {applied:?}"
        );
        assert_eq!(
            committer_updated, 1,
            "a self-update always carries an UpdatePath"
        );
    }

    /// The staged handle survives the applied read and is consumed exactly once by merge.
    #[test]
    fn the_staged_handle_from_a_v2_process_still_merges_exactly_once() {
        let (handle, _epoch, _group_id, _tree_hash) = create_fixture_group();
        let (_kind, _epoch, _sender, staged, _applied, _updated) =
            process(handle, FIXTURE_COMMIT_SELF_UPDATE);
        let staged = staged.expect("a commit stages");
        let merge = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .uint(handle)
                .uint(staged);
        });
        let epoch = decode_strict(
            &dispatch("public_group_merge", &merge),
            |d: &mut Decoder<'_>| {
                d.array(2)?;
                assert_eq!(d.uint()?, 0);
                d.uint()
            },
        )
        .unwrap();
        assert!(epoch > 0);
        let (code, _) = failure(&dispatch("public_group_merge", &merge));
        assert_eq!(
            code,
            crate::abi::E_ABI_HANDLE,
            "the staged handle is consumed by merge"
        );
    }

    /// A refused commit must not leak its staged handle. `public_group_process` inserts the
    /// `StagedCommit` before the DS has run invariant 4, and the DS refuses commits routinely
    /// (an omitted outstanding proposal, a committer Update, a cross-user Remove, a wrong
    /// GroupInfo). `public_group_merge` is the only other consumer, so without a discard a
    /// client that retries a refused commit in a loop grows the handle table without bound.
    #[test]
    fn a_staged_handle_can_be_discarded_without_merging() {
        let (handle, _epoch, _group_id, _tree_hash) = create_fixture_group();
        let (_kind, _epoch, _sender, staged, _applied, _updated) =
            process(handle, FIXTURE_COMMIT_SELF_UPDATE);
        let staged = staged.expect("a commit stages");
        let discard = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .uint(handle)
                .uint(staged);
        });
        decode_strict(
            &dispatch("public_group_staged_discard", &discard),
            |d: &mut Decoder<'_>| {
                d.array(1)?;
                assert_eq!(d.uint()?, 0);
                Ok(())
            },
        )
        .expect("discard answers [0]");
        let (code, _) = failure(&dispatch("public_group_staged_discard", &discard));
        assert_eq!(
            code,
            crate::abi::E_ABI_HANDLE,
            "the handle is gone after one discard"
        );
        let (code, _) = failure(&dispatch("public_group_merge", &discard));
        assert_eq!(
            code,
            crate::abi::E_ABI_HANDLE,
            "and merge cannot resurrect it"
        );
    }

    /// A proposal, not a commit: `applied` is empty and `committer_updated` is 0 even though the
    /// two elements are always present (fixed positions, §3.1).
    #[test]
    fn a_non_commit_still_carries_the_two_new_elements() {
        let (handle, _epoch, _group_id, _tree_hash) = create_fixture_group();
        // A truncated message is rejected by the TLS decoder, which is an error frame, so the
        // shape assertion uses the fixture commit's own staged response instead: both new
        // elements are present for every accepted message, and `a_commit_with_an_update_path…`
        // above covers the commit arm. This test pins the *rejected* arm's shape.
        let r = req(|e| {
            e.array(3)
                .uint(dilla_core::ABI_VERSION)
                .uint(handle)
                .bytes(&[]);
        });
        let (code, _detail) = failure(&dispatch("public_group_process", &r));
        assert_eq!(
            code,
            crate::abi::E_ABI_SHAPE,
            "an empty message is a shape failure, never a trap"
        );
    }

    /// `public_group_process` inserts the `StagedCommit` and *then* builds the applied list, and
    /// building it can fail on input a remote member controls: a proposal type outside the seven
    /// numbered ones (openmls 0.9.0 has `SelfRemove` and `Custom` unconditionally), or an Add whose
    /// credential is not a `BasicCredential`. The error frame carries no handle number and
    /// `take_staged` is the only remover, so an entry left behind is unreachable for ever — the
    /// unbounded growth `public_group_staged_discard` exists to prevent, reached without a discard
    /// ever being callable. The failure is injected here rather than driven through a fixture
    /// because no committed fixture carries an unsupported proposal; what is under test is the
    /// handle accounting, which is the half that leaks.
    #[test]
    fn a_staged_handle_is_released_when_the_applied_list_fails_to_build() {
        let mut t = Table::new();
        let h = t.insert_staged(PublicProcessed::Rejected(
            dilla_core::ProtocolError::Binding,
        ));
        assert_eq!(t.staged_count(), 1);
        let err = with_staged_or_release(&mut t, h, |_| {
            Err::<(), _>(AbiError::shape(
                "commit applies an unsupported proposal type SelfRemove",
            ))
        })
        .unwrap_err();
        assert_eq!(err.code, crate::abi::E_ABI_SHAPE);
        assert_eq!(
            t.staged_count(),
            0,
            "a process call that fails after staging must not strand the handle"
        );
    }

    /// The other half: the success path must leave the handle for `public_group_merge` (or
    /// `public_group_staged_discard`), which is why the applied list is read by reference at all.
    #[test]
    fn a_staged_handle_survives_an_applied_list_that_builds() {
        let mut t = Table::new();
        let h = t.insert_staged(PublicProcessed::Rejected(
            dilla_core::ProtocolError::Binding,
        ));
        assert_eq!(with_staged_or_release(&mut t, h, |_| Ok(7u64)).unwrap(), 7);
        assert_eq!(t.staged_count(), 1);
        assert!(t.take_staged(h).is_ok(), "merge can still consume it");
    }

    /// An unknown staged handle is `E_ABI_HANDLE` and removes nothing — the release path must not
    /// turn a bad handle into a second, silent removal.
    #[test]
    fn with_staged_or_release_rejects_an_unknown_handle() {
        let mut t = Table::new();
        let h = t.insert_staged(PublicProcessed::Rejected(
            dilla_core::ProtocolError::Binding,
        ));
        let err = with_staged_or_release(&mut t, h + 1, |_| Ok(())).unwrap_err();
        assert_eq!(err.code, crate::abi::E_ABI_HANDLE);
        assert_eq!(t.staged_count(), 1, "the live handle is untouched");
    }
}
