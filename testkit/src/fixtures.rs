//! Generates the committed benchmark fixture: a 1,500-leaf group's public state plus ten
//! alternative commits valid at its base epoch (R10).

use crate::{TestClient, TestkitError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, MsgId, UserId};
use dilla_core::mls::{
    DillaBinding, DillaGroup, GroupKind, MAX_ADDS_PER_COMMIT, build_key_package, external_senders,
};
use dilla_core::public_group::{DillaPublicGroup, external_propose_remove};
use openmls::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub struct FixtureSpec {
    pub leaves: usize,
    pub out: PathBuf,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FixtureFile {
    pub path: String,
    pub sha256_hex: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FixtureManifest {
    pub leaves: usize,
    pub epoch: u64,
    pub group_id_hex: String,
    pub tree_hash_hex: String,
    /// The leaf whose signature key the committed `group_info.mls` is signed under. ABI v2's
    /// `public_group_group_info_validate` takes the signer leaf as an argument, because
    /// `VerifiableGroupInfo::signer()` is `pub(crate)` in openmls 0.9.0 (interfaces §0.1 D17).
    pub group_info_signer_leaf: u32,
    /// `KeyPackage::hash_ref` of `key_package.mls`, computed natively with `RustCrypto`.
    pub key_package_ref_hex: String,
    /// The 32-byte franking commitment openmls framed into `application_message.mls` as the MLS
    /// `authenticated_data`, computed natively from the envelope by `Envelope::commitment`. It is
    /// what `private_message_aad`'s hand-written RFC 9420 §6.3.2 decode must read back.
    pub application_message_commitment_hex: String,
    /// The epoch `application_message.mls` was framed at. Recorded separately from `epoch` above
    /// so the reader need not assume the sender was still at the frozen base epoch.
    pub application_message_epoch: u64,
    /// Seconds since the Unix epoch. Every leaf carries a KeyPackage lifetime and
    /// `PublicGroup::from_external` validates all of them, so the fixture stops working here.
    pub not_after: u64,
    pub openmls_version: String,
    pub files: Vec<FixtureFile>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_file(
    spec: &FixtureSpec,
    rel: &str,
    bytes: &[u8],
    files: &mut Vec<FixtureFile>,
) -> Result<(), TestkitError> {
    let path = spec.out.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    }
    std::fs::write(&path, bytes).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    files.push(FixtureFile {
        path: rel.to_owned(),
        sha256_hex: hex(&Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
    });
    Ok(())
}

fn serialize<T: tls_codec::Serialize>(value: &T) -> Result<Vec<u8>, TestkitError> {
    value
        .tls_serialize_detached()
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

/// Builds the group by adding `leaves - 1` members in batches of `MAX_ADDS_PER_COMMIT`, then
/// freezes the base state and produces ten alternative commits against it.
pub fn gen_public_group(spec: &FixtureSpec) -> Result<FixtureManifest, TestkitError> {
    assert!(spec.leaves >= 2, "a fixture needs at least two leaves");
    let creator = TestClient::new(
        "creator",
        UserId::from_bytes([0x01; 16]),
        Tier::Native,
        Kind::User,
        spec.seed,
    )?;
    let binding = DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes([0x11; 16]),
        community_id: None,
        target_id: [0x66; 16],
        kind: GroupKind::Text,
        policy_version: 1,
        e2ee_version: 1,
        media_version: 0,
    };
    let group_id = GroupId::from_slice(&binding.target_id);
    // The instance's external-sender keypair. `TestClient::new` is the crate's one deterministic
    // signer factory (`testkit/src/client.rs:48-90`: the seed drives a ChaCha20 stream into
    // `ed25519_dalek::SigningKey`), so the instance reuses it rather than duplicating that code.
    // Only `signer()` is used; the client never joins the group.
    let instance = TestClient::new(
        "instance",
        UserId::from_bytes([0x11; 16]),
        Tier::Native,
        Kind::User,
        spec.seed ^ 0x0d15_0d15,
    )?;
    let instance_signer = instance.signer();
    // `GroupKind::Text.has_external_sender()` is true (`core/dilla-core/src/mls/binding.rs:42`),
    // so `create_config` accepts the extension for this binding. Without it the committed
    // `remove_leaf0.mls` below could not be queued against the fixture at all: a
    // `DillaPublicGroup` resolves an external proposal's sender through `external_senders`.
    let ext_senders = external_senders(
        SignaturePublicKey::from(instance_signer.public()),
        &binding.instance_id,
    );
    let mut group = DillaGroup::create(
        creator.provider(),
        creator.signer(),
        creator.credential(),
        group_id.clone(),
        binding.clone(),
        Some(ext_senders),
    )?;

    // Fill the tree.
    let mut members = Vec::with_capacity(spec.leaves - 1);
    for i in 1..spec.leaves {
        members.push(TestClient::new(
            &format!("m{i}"),
            UserId::from_bytes([(i % 251) as u8; 16]),
            Tier::Native,
            Kind::User,
            spec.seed.wrapping_add(i as u64),
        )?);
    }
    for batch in members.chunks(MAX_ADDS_PER_COMMIT) {
        let mut packages = Vec::with_capacity(batch.len());
        for member in batch {
            let kp = build_key_package(
                member.provider(),
                member.signer(),
                member.credential(),
                false,
            )?;
            packages.push(kp.key_package().clone());
        }
        group.add_members(creator.provider(), creator.signer(), &packages)?;
        group.merge_pending_commit(creator.provider())?;
    }

    // Freeze the base state.
    let group_info = serialize(&group.export_group_info(creator.provider(), creator.signer())?)?;
    let ratchet_tree = serialize(&group.export_ratchet_tree())?;
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let verifiable = {
        use tls_codec::Deserialize as _;
        match MlsMessageIn::tls_deserialize_exact(&group_info)
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
            .extract()
        {
            MlsMessageBodyIn::GroupInfo(info) => info,
            other => {
                return Err(TestkitError::Scenario(format!(
                    "expected a GroupInfo, got {other:?}"
                )));
            }
        }
    };
    let tree_in = {
        use tls_codec::Deserialize as _;
        RatchetTreeIn::tls_deserialize_exact(&ratchet_tree)
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
    };
    let (public, _) = DillaPublicGroup::from_external(&crypto, tree_in, verifiable)
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
    let base_state = public.export_state();
    let base_epoch = public.epoch();
    let tree_hash = public.tree_hash();

    // Ten alternative commits, every one valid at the base epoch. The group is reloaded from
    // storage between them so each starts from the same state.
    let mut commits: Vec<Vec<u8>> = Vec::with_capacity(10);
    for batch in 0..8usize {
        let mut fresh = DillaGroup::load(creator.provider(), &group_id)?
            .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
        let mut packages = Vec::with_capacity(MAX_ADDS_PER_COMMIT);
        for i in 0..MAX_ADDS_PER_COMMIT {
            let member = TestClient::new(
                &format!("add-{batch}-{i}"),
                UserId::from_bytes([0x5a; 16]),
                Tier::Native,
                Kind::User,
                spec.seed
                    .wrapping_add(1_000_000)
                    .wrapping_add((batch * MAX_ADDS_PER_COMMIT + i) as u64),
            )?;
            let kp = build_key_package(
                member.provider(),
                member.signer(),
                member.credential(),
                false,
            )?;
            packages.push(kp.key_package().clone());
        }
        let bundle = fresh.add_members(creator.provider(), creator.signer(), &packages)?;
        commits.push(serialize(&bundle.commit)?);
        // Each of the ten is an alternative at the base epoch, so none is merged. Clearing the
        // staged commit is what lets the next iteration stage one at all.
        fresh.clear_pending_commit(creator.provider())?;
    }
    {
        let mut fresh = DillaGroup::load(creator.provider(), &group_id)?
            .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
        let bundle = fresh.remove_members(
            creator.provider(),
            creator.signer(),
            &[LeafNodeIndex::new(1)],
        )?;
        commits.push(serialize(&bundle.commit)?);
        fresh.clear_pending_commit(creator.provider())?;
    }
    {
        let mut fresh = DillaGroup::load(creator.provider(), &group_id)?
            .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
        let bundle = fresh.self_update(creator.provider(), creator.signer())?;
        commits.push(serialize(&bundle.commit)?);
        fresh.clear_pending_commit(creator.provider())?;
    }

    let mut files = Vec::new();
    std::fs::create_dir_all(&spec.out).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    write_file(spec, "group_info.mls", &group_info, &mut files)?;
    write_file(spec, "ratchet_tree.mls", &ratchet_tree, &mut files)?;

    // ABI v2 needs two more committed inputs, both produced by the same real clients that built
    // the tree: a KeyPackage for `validate_key_package` and an external Remove of leaf 0 for
    // `public_group_proposal_inspect`.
    let joiner = TestClient::new(
        "kp-fixture",
        UserId::from_bytes([0x77; 16]),
        Tier::Native,
        Kind::User,
        spec.seed.wrapping_add(9_000_000),
    )?;
    let joiner_kp = build_key_package(
        joiner.provider(),
        joiner.signer(),
        joiner.credential(),
        false,
    )?;
    // Deviation from the brief, forced by the ABI: the brief wrote
    // `serialize(joiner_kp.key_package())`, a **bare** KeyPackage. Every KeyPackage crossing the
    // wasi ABI is read by `abi::tls::key_package_in`, which deserialises an `MLSMessage` and then
    // matches `MlsMessageBodyIn::KeyPackage` — a bare KeyPackage is refused there with
    // `E_ABI_SHAPE`. `impl From<KeyPackage> for MlsMessageOut`
    // (`openmls-0.9.0/src/framing/message_out.rs:94`) is the public route to that framing, and it
    // is the same framing `group_info.mls` already uses. The `KeyPackageRef` below is unaffected:
    // `KeyPackage::hash_ref` hashes the KeyPackage's own TLS encoding, not the envelope.
    let key_package_bytes = serialize(&MlsMessageOut::from(joiner_kp.key_package().clone()))?;
    write_file(spec, "key_package.mls", &key_package_bytes, &mut files)?;

    let remove = external_propose_remove(
        LeafNodeIndex::new(0),
        group_id.clone(),
        GroupEpoch::from(base_epoch),
        instance_signer,
    )
    .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
    write_file(spec, "remove_leaf0.mls", &serialize(&remove)?, &mut files)?;

    // A third ABI v2 input, and the only one openmls frames as a `PrivateMessage`: the wasi
    // crate's `private_message_aad` decodes RFC 9420 §6.3.2 by hand (controller ruling B2), so its
    // tests need one message a real encoder produced rather than only the ones its own
    // `tests_support::message` writes — a framing mistake shared by that encoder and the decoder
    // would otherwise be symmetric and invisible. `DillaGroup::create_message` sets the MLS
    // `authenticated_data` to the envelope's 32-byte franking commitment
    // (`core/dilla-core/src/mls/group.rs`, `group.set_aad(commitment.to_vec())`), which is exactly
    // the field the DS reads and which the manifest records below.
    let application_envelope = Envelope {
        v: 1,
        msg_id: MsgId::from_bytes([0x5c; 16]),
        kind: EnvelopeType::Message,
        thread_id: None,
        reply_to: None,
        body: "fixture application message".to_owned(),
        attachments: Vec::new(),
        previews: Vec::new(),
        k_f: [0x0f; 32],
    };
    let application_message_commitment_hex = hex(&application_envelope
        .commitment()
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?);
    // Sent from the creator's own in-memory handle, which is still at the frozen base epoch: each
    // of the ten alternative commits above was staged on a fresh `load` and cleared, never merged.
    // This is the last thing the creator's handle does, so the application generation it ratchets
    // here cannot disturb anything above.
    let application_message = serialize(&group.create_message(
        creator.provider(),
        creator.signer(),
        &application_envelope,
    )?)?;
    let application_message_epoch = group.epoch();
    write_file(
        spec,
        "application_message.mls",
        &application_message,
        &mut files,
    )?;

    write_file(spec, "public_group_state.bin", &base_state, &mut files)?;
    for (i, commit) in commits.iter().enumerate() {
        write_file(spec, &format!("commits/{i:02}.mls"), commit, &mut files)?;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?
        .as_secs();
    // Every leaf of this fixture carries a KeyPackage built by `build_key_package`, which
    // overrides OpenMLS's 84-day default with `Lifetime::new(KEY_PACKAGE_LIFETIME_DAYS * 24 * 60 *
    // 60)` = 90 days (task 10). Deriving `not_after` from that constant rather than restating
    // gap-18's 84 keeps the manifest honest: an under-reported expiry makes the benchmark cry
    // "fixture expired" six days early.
    let lifetime_secs = dilla_core::mls::KEY_PACKAGE_LIFETIME_DAYS * 24 * 60 * 60;
    // `group_info.mls` is exported with `creator.signer()`, so its signer is the creator's own
    // leaf. Reading it off the group rather than writing `0` keeps the manifest honest if a
    // future generator ever moves the creator.
    let group_info_signer_leaf = group.own_leaf_index().u32();
    let key_package_ref_hex = hex(joiner_kp
        .key_package()
        .hash_ref(&crypto)
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
        .as_slice());
    let manifest = FixtureManifest {
        leaves: spec.leaves,
        epoch: base_epoch,
        group_id_hex: hex(group_id.as_slice()),
        tree_hash_hex: hex(&tree_hash),
        group_info_signer_leaf,
        key_package_ref_hex,
        application_message_commitment_hex,
        application_message_epoch,
        not_after: now + lifetime_secs,
        openmls_version: "0.9.0".to_owned(),
        files,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    std::fs::write(spec.out.join("manifest.json"), format!("{json}\n"))
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    Ok(manifest)
}
