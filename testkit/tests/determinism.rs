//! What the seed fixes: identity material *and* the MLS signature keypair. Anything the OpenMLS
//! provider's RNG draws (HPKE init keys, leaf secrets, nonces) is still random, so a run is
//! structurally reproducible, not byte-for-byte.

use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::UserId;
use dilla_testkit::TestClient;

fn client(seed: u64) -> TestClient {
    TestClient::new(
        "alice",
        UserId::from_bytes([0xa1; 16]),
        Tier::Native,
        Kind::User,
        seed,
    )
    .expect("client")
}

#[test]
fn the_seed_fixes_the_mls_signature_keypair() {
    let first = client(7);
    let second = client(7);
    let other = client(8);

    assert_eq!(
        first.credential().signature_key.as_slice(),
        second.credential().signature_key.as_slice(),
        "the same seed must produce the same MLS signature key"
    );
    assert_eq!(first.device_id(), second.device_id());
    assert_ne!(
        first.credential().signature_key.as_slice(),
        other.credential().signature_key.as_slice(),
        "a different seed must produce a different MLS signature key"
    );
}
