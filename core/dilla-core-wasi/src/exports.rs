//! The fifteen `(ptr, len) -> u64` handlers of interfaces §2.10, written as pure functions over
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

    let mut e = Encoder::new();
    e.array(6).uint(0).uint(kind).uint(epoch);
    e.opt_uint(sender_leaf.map(u64::from));
    e.opt_uint(staged.map(u64::from));
    e.opt_bytes(proposal_ref.as_deref());
    Ok(e.into_vec())
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
}
