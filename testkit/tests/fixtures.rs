//! The committed 1,500-leaf fixture, and the generator that produces it.

use dilla_testkit::{FixtureSpec, gen_public_group};

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/ds-1500");

fn manifest() -> serde_json::Value {
    let path = std::path::Path::new(FIXTURE_DIR).join("manifest.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; run `dilla-testkit gen-public-group --leaves 1500 --out {FIXTURE_DIR}`",
            path.display()
        )
    });
    serde_json::from_str(&text).expect("manifest.json is JSON")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// "Deterministic for a fixed seed" (interfaces.md line 1733) means **structurally**
/// deterministic, not byte-identical: `TestClient::new`'s seed only fixes identity material (the
/// Ed25519 signer is derived from it directly, bypassing the provider — see `client.rs`'s own
/// "Reproduction is structural" doc comment on `TestClient::new`, written for task 12). Every
/// `KeyPackage`'s HPKE leaf (encryption) keypair is still drawn through
/// `provider.rand()` -> `openmls_rust_crypto::RustCrypto`, and `RustCrypto` has no seeded
/// constructor: `Default` is `ChaCha20Rng::from_entropy()` (verified in
/// openmls_rust_crypto-0.6.0/src/provider.rs:47-53, `rng: RwLock::new(rand_chacha::ChaCha20Rng::
/// from_entropy())`), reseeded from OS entropy every time, once per `TestClient`. So two runs with
/// the same seed produce the same group id, the same epoch and the same set of files (same paths,
/// same count), but never the same file *contents*: the HPKE keys embedded in the ratchet tree —
/// and everything downstream that includes them (tree_hash, the DS's own generic serde encoding of
/// the tree in `public_group_state.bin`) — differ every run. This is a deviation from the brief's
/// literal test body (byte-for-byte `sha256_hex` and `tree_hash_hex` equality, which this task
/// verified is unreachable with the pinned crypto backend), recorded here rather than silently
/// weakened: see the task 13 report for the full deviation note.
#[test]
fn the_generator_is_deterministic_for_a_fixed_seed() {
    let base = std::env::temp_dir().join(format!("dilla-fixture-{}", std::process::id()));
    let a = base.join("a");
    let b = base.join("b");
    let first = gen_public_group(&FixtureSpec {
        leaves: 32,
        out: a.clone(),
        seed: 7,
    })
    .expect("generate");
    let second = gen_public_group(&FixtureSpec {
        leaves: 32,
        out: b.clone(),
        seed: 7,
    })
    .expect("generate");
    assert_eq!(first.group_id_hex, second.group_id_hex);
    assert_eq!(first.epoch, second.epoch);
    assert_eq!(
        first.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
        second.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
        "same seed must yield the same set of files, in the same order",
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn the_committed_manifest_lists_every_file_with_a_matching_digest() {
    let m = manifest();
    assert_eq!(m["leaves"].as_u64(), Some(1500));
    let files = m["files"].as_array().expect("files");
    assert_eq!(
        files.len(),
        16,
        "group_info, ratchet_tree, key_package, remove_leaf0, application_message, state \
         and ten commits"
    );
    // ABI v2's `validate_key_package`, `public_group_proposal_inspect` and `private_message_aad`
    // `include_bytes!` these three by name, so a regeneration that stopped writing one would break
    // the wasi crate's tests at compile time rather than here. Naming them keeps the failure in
    // the fixture's own test.
    for expected in [
        "key_package.mls",
        "remove_leaf0.mls",
        "application_message.mls",
    ] {
        assert!(
            files.iter().any(|f| f["path"].as_str() == Some(expected)),
            "the manifest must list {expected}"
        );
    }
    for file in files {
        let rel = file["path"].as_str().expect("path");
        let path = std::path::Path::new(FIXTURE_DIR).join(rel);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(
            bytes.len() as u64,
            file["bytes"].as_u64().expect("bytes"),
            "{rel}"
        );
        assert_eq!(
            sha256_hex(&bytes),
            file["sha256_hex"].as_str().expect("sha256"),
            "{rel}"
        );
    }
}

#[test]
fn the_fixture_has_not_expired() {
    let m = manifest();
    let not_after = m["not_after"].as_u64().expect("not_after");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    assert!(
        not_after > now,
        "fixture expired, run dilla-testkit gen-public-group --leaves 1500 --out {FIXTURE_DIR}"
    );
}

#[test]
fn the_ds_view_accepts_the_committed_fixture_and_every_alternative_commit() {
    use dilla_core::public_group::{DillaPublicGroup, PublicProcessed};
    let m = manifest();
    let state = std::fs::read(std::path::Path::new(FIXTURE_DIR).join("public_group_state.bin"))
        .expect("state");
    let group_id_bytes: Vec<u8> = {
        let hex = m["group_id_hex"].as_str().expect("group_id_hex");
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"))
            .collect()
    };
    let group_id = openmls::group::GroupId::from_slice(&group_id_bytes);

    let base = DillaPublicGroup::import_state(&state, &group_id).expect("import");
    assert_eq!(
        base.tree_hash()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        m["tree_hash_hex"].as_str().expect("tree_hash")
    );
    assert_eq!(base.epoch(), m["epoch"].as_u64().expect("epoch"));

    let crypto = openmls_rust_crypto::RustCrypto::default();
    for i in 0..10 {
        let path = std::path::Path::new(FIXTURE_DIR).join(format!("commits/{i:02}.mls"));
        let blob = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        // Every commit is an ALTERNATIVE at the base epoch, so each starts from a fresh import.
        let mut ds = DillaPublicGroup::import_state(&state, &group_id).expect("import");
        let message = {
            use tls_codec::Deserialize as _;
            openmls::prelude::MlsMessageIn::tls_deserialize_exact(&blob)
                .expect("commit")
                .try_into_protocol_message()
                .expect("protocol message")
        };
        let staged = match ds.process_message(&crypto, message).expect("process") {
            PublicProcessed::StagedCommit { staged, .. } => *staged,
            other => panic!("commits/{i:02}.mls is not a commit: {other:?}"),
        };
        let before = ds.epoch();
        ds.merge_commit(staged).expect("merge");
        assert_eq!(
            ds.epoch(),
            before + 1,
            "commits/{i:02}.mls must advance the epoch by one"
        );
    }
}
