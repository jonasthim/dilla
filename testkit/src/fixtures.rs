//! Generates the committed benchmark fixture: a 1,500-leaf group's public state plus ten
//! alternative commits valid at its base epoch (R10).

use crate::{TestClient, TestkitError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, MsgId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, DILLA_BINDING, DillaBinding, DillaGroup, GroupKind, MAX_ADDS_PER_COMMIT,
    PADDING_SIZE, build_key_package, external_senders, group_context_extensions, leaf_capabilities,
    past_epoch_policy,
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
    // The last alternative, the creator's self-update, is the one commit the fixture ALSO merges:
    // its handle is kept pending here and merged only after the creator's in-memory base-epoch
    // handle has sent `application_message.mls` below, and the GroupInfo of the epoch it produces
    // is exported as `commits/09.group_info.mls`. That GroupInfo is what lets a delivery service
    // ACCEPT a commit of this fixture at all (invariant 4 wants a GroupInfo at epoch n+1, signed
    // by the committer), and what a heal whose tail merges uploads (invariant 11). The
    // self-update adds nobody, so accepting it needs no device list and no ACL.
    let mut self_update = DillaGroup::load(creator.provider(), &group_id)?
        .ok_or_else(|| TestkitError::Scenario("the creator's group vanished".into()))?;
    {
        let bundle = self_update.self_update(creator.provider(), creator.signer())?;
        commits.push(serialize(&bundle.commit)?);
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
    // of the ten alternative commits above was staged on a fresh `load`, and none is merged before
    // this line (the self-update is merged at the very end, on its own handle).
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

    // Now, and only now, the self-update is merged: nothing above reads the creator's storage
    // again, so moving it to epoch n+1 cannot disturb a base-epoch file.
    self_update.merge_pending_commit(creator.provider())?;
    let merged_group_info =
        serialize(&self_update.export_group_info(creator.provider(), creator.signer())?)?;
    write_file(
        spec,
        "commits/09.group_info.mls",
        &merged_group_info,
        &mut files,
    )?;

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

/// The directory KeyPackage fixture: `count` KeyPackages, each built by its own device of its own
/// user with the device's own signing key, exactly as an honest client publishes one.
///
/// The delivery service binds a KeyPackage to the device it is published for (its credential
/// names that device and user, and its leaf key is the device's registered key), so a Go test that
/// needs several devices with a KeyPackage each needs one real package per device: Go builds no
/// MLS object, and `key_package.mls` of the 1,500-leaf fixture is a single device's.
pub struct KeyPackageSetSpec {
    pub count: usize,
    pub out: PathBuf,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyPackageSetEntry {
    /// `NN.mls`: an `MLSMessage` framing a bare KeyPackage, the form `POST /v1/keypackages` takes.
    pub path: String,
    pub device_id_hex: String,
    pub user_id_hex: String,
    /// The device's DSK public key: the KeyPackage leaf's signature key, which the device
    /// registers as `dsk_pub`.
    pub dsk_pub_hex: String,
    pub key_package_ref_hex: String,
    pub sha256_hex: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyPackageSetManifest {
    /// Seconds since the Unix epoch; every package's lifetime ends here or later.
    pub not_after: u64,
    pub openmls_version: String,
    pub key_packages: Vec<KeyPackageSetEntry>,
}

pub fn gen_key_packages(spec: &KeyPackageSetSpec) -> Result<KeyPackageSetManifest, TestkitError> {
    let crypto = openmls_rust_crypto::RustCrypto::default();
    std::fs::create_dir_all(&spec.out).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?
        .as_secs();
    let mut entries = Vec::with_capacity(spec.count);
    for i in 0..spec.count {
        // One user per device, so a test can give each its own ACL verdict and device list. Not a
        // uniform byte array: the 1,500-leaf fixture's users are `[k; 16]` for every k in 1..=250
        // (`gen_public_group` above), and a user id equal to one of them would already be a member
        // of that group.
        let mut user_bytes = [0xfd; 16];
        user_bytes[1] = i as u8;
        let user = UserId::from_bytes(user_bytes);
        let client = TestClient::new(
            &format!("kp{i}"),
            user,
            Tier::Native,
            Kind::User,
            spec.seed.wrapping_add(i as u64),
        )?;
        let kp = build_key_package(
            client.provider(),
            client.signer(),
            client.credential(),
            false,
        )?;
        let bytes = serialize(&MlsMessageOut::from(kp.key_package().clone()))?;
        let path = format!("{i:02}.mls");
        std::fs::write(spec.out.join(&path), &bytes)
            .map_err(|e| TestkitError::Scenario(e.to_string()))?;
        entries.push(KeyPackageSetEntry {
            path,
            device_id_hex: hex(client.device_id().as_bytes()),
            user_id_hex: hex(client.user_id().as_bytes()),
            dsk_pub_hex: hex(client.signer().public()),
            key_package_ref_hex: hex(kp
                .key_package()
                .hash_ref(&crypto)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
                .as_slice()),
            sha256_hex: hex(&Sha256::digest(&bytes)),
        });
    }
    let manifest = KeyPackageSetManifest {
        not_after: now + dilla_core::mls::KEY_PACKAGE_LIFETIME_DAYS * 24 * 60 * 60,
        openmls_version: "0.9.0".to_owned(),
        key_packages: entries,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    std::fs::write(spec.out.join("manifest.json"), format!("{json}\n"))
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    Ok(manifest)
}

/// The committed registration fixture: what an honest device uploads to `POST /v1/groups`.
///
/// The delivery service registers a group only when its tree holds exactly one leaf, the
/// registering device's own (hardening G), and Go builds no MLS object, so a Go test that drives
/// the registration route needs real one-leaf groups. Every group here is created by the 1,500-leaf
/// fixture's creator (same seed, so the same user, device and signature key as that fixture's
/// leaf 0), bound to this instance (`0x11…`) with the instance's external sender, on one channel
/// target, so a test can register a group, a second group for the same target, and a re-creation.
/// `hidden` is the one negative shape the 1,500-leaf fixture cannot supply: two leaves, the second
/// carrying a credential that is not a dilla identity, so its member list names one leaf while its
/// tree holds two. `pairing` and `pairing-sender` are one-leaf `pairing` groups on their own target
/// (`0x68…`), without and with an external sender (DS-MEMBERSHIP-01: a `pairing` group carries
/// none). `self-update` and `gce-swap` are honest one-leaf text groups that each also carry one
/// commit by the creator at the creation epoch, with the GroupInfo after it: an honest self-update,
/// and a GroupContextExtensions commit that swaps `external_senders` to the creator's own key.
///
/// Everything is written as hex inside one JSON file, so the fixture travels in a text diff.
pub struct RegistrationSpec {
    pub out: PathBuf,
    pub seed: u64,
    /// How many one-leaf groups to generate.
    pub groups: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegistrationGroup {
    pub name: String,
    pub group_id_hex: String,
    /// The `dilla_binding` CBOR, exactly as the group context carries it.
    pub binding_hex: String,
    pub group_info_hex: String,
    pub ratchet_tree_hex: String,
    /// Occupied leaves of the tree.
    pub leaves: usize,
    /// A commit by the creator at the group's creation epoch (`self-update` and `gce-swap` only),
    /// and the creator-signed GroupInfo after it, without the tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_group_info_hex: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegistrationManifest {
    pub user_id_hex: String,
    pub device_id_hex: String,
    /// The creator's signature key: the key its leaf carries and its device registers.
    pub dsk_pub_hex: String,
    pub target_id_hex: String,
    /// Seconds since the Unix epoch; every leaf's lifetime ends here or later.
    pub not_after: u64,
    pub openmls_version: String,
    pub groups: Vec<RegistrationGroup>,
}

pub fn gen_registration_groups(
    spec: &RegistrationSpec,
) -> Result<RegistrationManifest, TestkitError> {
    std::fs::create_dir_all(&spec.out).map_err(|e| TestkitError::Scenario(e.to_string()))?;
    let creator = TestClient::new(
        "creator",
        UserId::from_bytes([0x01; 16]),
        Tier::Native,
        Kind::User,
        spec.seed,
    )?;
    // The instance's external-sender keypair, derived exactly as `gen_public_group` derives it.
    let instance = TestClient::new(
        "instance",
        UserId::from_bytes([0x11; 16]),
        Tier::Native,
        Kind::User,
        spec.seed ^ 0x0d15_0d15,
    )?;
    let target = [0x67; 16];
    let binding = DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes([0x11; 16]),
        community_id: None,
        target_id: target,
        kind: GroupKind::Text,
        policy_version: 1,
        e2ee_version: 1,
        media_version: 0,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?
        .as_secs();
    let mut groups = Vec::with_capacity(spec.groups + 1);
    for i in 0..=spec.groups {
        let hidden = i == spec.groups;
        let mut id = [0x67; 16];
        id[15] = if hidden { 0xff } else { i as u8 };
        let group_id = GroupId::from_slice(&id);
        let mut group = DillaGroup::create(
            creator.provider(),
            creator.signer(),
            creator.credential(),
            group_id.clone(),
            binding.clone(),
            Some(external_senders(
                SignaturePublicKey::from(instance.signer().public()),
                &binding.instance_id,
            )),
        )?;
        if hidden {
            // A leaf nobody can name: its credential is not a dilla identity.
            let nameless = TestClient::new(
                "nameless",
                UserId::from_bytes([0x69; 16]),
                Tier::Native,
                Kind::User,
                spec.seed.wrapping_add(7_000_000),
            )?;
            let with_key = CredentialWithKey {
                credential: BasicCredential::new(b"not a dilla identity".to_vec()).into(),
                signature_key: nameless.signer().public().into(),
            };
            let kp = build_key_package(nameless.provider(), nameless.signer(), with_key, false)?;
            // `DillaGroup::add_members` names every device it adds, so the nameless leaf goes in
            // through the raw OpenMLS group, as a patched client would add it.
            let mut raw = MlsGroup::load(creator.provider().storage(), &group_id)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
                .ok_or_else(|| TestkitError::Scenario("the created group is not stored".into()))?;
            raw.add_members(
                creator.provider(),
                creator.signer(),
                &[kp.key_package().clone()],
            )
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            raw.merge_pending_commit(creator.provider())
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            group = DillaGroup::load(creator.provider(), &group_id)?
                .ok_or_else(|| TestkitError::Scenario("the created group is not stored".into()))?;
        }
        let group_info =
            serialize(&group.export_group_info(creator.provider(), creator.signer())?)?;
        let tree = group.export_ratchet_tree();
        groups.push(RegistrationGroup {
            name: if hidden {
                "hidden".to_owned()
            } else {
                format!("one-leaf-{i}")
            },
            group_id_hex: hex(group_id.as_slice()),
            binding_hex: hex(&binding.encode()),
            group_info_hex: hex(&group_info),
            ratchet_tree_hex: hex(&serialize(&tree)?),
            leaves: group.member_count(),
            commit_hex: None,
            commit_group_info_hex: None,
        });
    }
    // Two honest one-leaf text groups that each carry one commit by the creator at their creation
    // epoch (fix wave C): `self-update`, an honest self-update, and `gce-swap`, a
    // GroupContextExtensions commit that keeps `required_capabilities` and `dilla_binding` and
    // swaps `external_senders` to the creator's own key - what a patched client sends to make an
    // honestly registered group one the instance cannot propose into. The group is registered as
    // created; the commit and the GroupInfo after it are what the member then uploads.
    for (name, last, swap) in [("self-update", 0xfdu8, false), ("gce-swap", 0xfe, true)] {
        let mut id = [0x67; 16];
        id[15] = last;
        let group_id = GroupId::from_slice(&id);
        let mut group = DillaGroup::create(
            creator.provider(),
            creator.signer(),
            creator.credential(),
            group_id.clone(),
            binding.clone(),
            Some(external_senders(
                SignaturePublicKey::from(instance.signer().public()),
                &binding.instance_id,
            )),
        )?;
        let group_info =
            serialize(&group.export_group_info(creator.provider(), creator.signer())?)?;
        let tree = serialize(&group.export_ratchet_tree())?;
        let commit = if swap {
            let swapped = group_context_extensions(
                &binding,
                Some(external_senders(
                    SignaturePublicKey::from(creator.signer().public()),
                    &binding.instance_id,
                )),
            )?;
            let mut raw = MlsGroup::load(creator.provider().storage(), &group_id)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
                .ok_or_else(|| TestkitError::Scenario("the created group is not stored".into()))?;
            let commit = raw
                .update_group_context_extensions(creator.provider(), swapped, creator.signer())
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
                .0;
            raw.merge_pending_commit(creator.provider())
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            group = DillaGroup::load(creator.provider(), &group_id)?
                .ok_or_else(|| TestkitError::Scenario("the created group is not stored".into()))?;
            commit
        } else {
            let bundle = group.self_update(creator.provider(), creator.signer())?;
            group.merge_pending_commit(creator.provider())?;
            bundle.commit
        };
        let commit_group_info =
            serialize(&group.export_group_info(creator.provider(), creator.signer())?)?;
        groups.push(RegistrationGroup {
            name: name.to_owned(),
            group_id_hex: hex(group_id.as_slice()),
            binding_hex: hex(&binding.encode()),
            group_info_hex: hex(&group_info),
            ratchet_tree_hex: hex(&tree),
            leaves: 1,
            commit_hex: Some(hex(&serialize(&commit)?)),
            commit_group_info_hex: Some(hex(&commit_group_info)),
        });
    }
    // Two one-leaf `pairing` groups for DS-MEMBERSHIP-01, by the same creator on their own target:
    // `pairing`, as an honest client creates one (no external sender - `create_config` refuses one
    // for this kind), and `pairing-sender`, the same shape with the instance's external sender in
    // its group context, which only a patched client builds: through OpenMLS's own builder, with
    // the three extensions `group_context_extensions` would write for a text group.
    let pairing = DillaBinding {
        target_id: [0x68; 16],
        kind: GroupKind::Pairing,
        media_version: GroupKind::Pairing.media_version(),
        ..binding.clone()
    };
    for (name, last, with_sender) in [("pairing", 0x00u8, false), ("pairing-sender", 0x01, true)] {
        let mut id = [0x68; 16];
        id[15] = last;
        let group_id = GroupId::from_slice(&id);
        let group = if with_sender {
            let extensions = Extensions::try_from(vec![
                Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
                    &[DILLA_BINDING],
                    &[],
                    &[CredentialType::Basic],
                )),
                Extension::ExternalSenders(external_senders(
                    SignaturePublicKey::from(instance.signer().public()),
                    &pairing.instance_id,
                )),
                pairing.to_extension(),
            ])
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            let config = MlsGroupCreateConfig::builder()
                .ciphersuite(CIPHERSUITE)
                .use_ratchet_tree_extension(false)
                .padding_size(PADDING_SIZE)
                .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
                .set_past_epoch_deletion_policy(past_epoch_policy(GroupKind::Pairing))
                .with_group_context_extensions(extensions)
                .capabilities(leaf_capabilities())
                .build();
            MlsGroup::new_with_group_id(
                creator.provider(),
                creator.signer(),
                &config,
                group_id.clone(),
                creator.credential(),
            )
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            DillaGroup::load(creator.provider(), &group_id)?
                .ok_or_else(|| TestkitError::Scenario("the created group is not stored".into()))?
        } else {
            DillaGroup::create(
                creator.provider(),
                creator.signer(),
                creator.credential(),
                group_id.clone(),
                pairing.clone(),
                None,
            )?
        };
        let group_info =
            serialize(&group.export_group_info(creator.provider(), creator.signer())?)?;
        let tree = group.export_ratchet_tree();
        groups.push(RegistrationGroup {
            name: name.to_owned(),
            group_id_hex: hex(group_id.as_slice()),
            binding_hex: hex(&pairing.encode()),
            group_info_hex: hex(&group_info),
            ratchet_tree_hex: hex(&serialize(&tree)?),
            leaves: group.member_count(),
            commit_hex: None,
            commit_group_info_hex: None,
        });
    }
    // The creator's own leaf takes OpenMLS's default leaf lifetime (84 days: 28 * 3, openmls-0.9.0
    // key_packages/lifetime.rs), shorter than the 90 days `build_key_package` gives the nameless
    // leaf, and `from_external` validates every leaf's lifetime, so the shorter one is the
    // fixture's expiry.
    let not_after = now + 60 * 60 * 24 * 28 * 3;
    let manifest = RegistrationManifest {
        user_id_hex: hex(creator.user_id().as_bytes()),
        device_id_hex: hex(creator.device_id().as_bytes()),
        dsk_pub_hex: hex(creator.signer().public()),
        target_id_hex: hex(&target),
        not_after,
        openmls_version: "0.9.0".to_owned(),
        groups,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    std::fs::write(spec.out.join("manifest.json"), format!("{json}\n"))
        .map_err(|e| TestkitError::Scenario(e.to_string()))?;
    Ok(manifest)
}
