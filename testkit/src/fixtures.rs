//! Generates the committed benchmark fixture: a 1,500-leaf group's public state plus ten
//! alternative commits valid at its base epoch (R10).

use crate::{TestClient, TestkitError};
use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{
    DillaBinding, DillaGroup, GroupKind, MAX_ADDS_PER_COMMIT, build_key_package,
};
use dilla_core::public_group::DillaPublicGroup;
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
    let mut group = DillaGroup::create(
        creator.provider(),
        creator.signer(),
        creator.credential(),
        group_id.clone(),
        binding,
        None,
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
    let manifest = FixtureManifest {
        leaves: spec.leaves,
        epoch: base_epoch,
        group_id_hex: hex(group_id.as_slice()),
        tree_hash_hex: hex(&tree_hash),
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
