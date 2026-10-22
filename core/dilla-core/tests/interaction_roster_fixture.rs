#![cfg(not(target_arch = "wasm32"))]

//! Writer for the public kind-3 two-member roster fixture consumed by Go DS tests.
//!
//! Regenerate with:
//! `cargo test -p dilla-core --test interaction_roster_fixture -- --ignored --nocapture`
//! The writer creates real OpenMLS credentials, a v2 DillaInteractionBinding, signed identity
//! credentials and SSK-signed device lists. It writes public material only; private signing keys
//! remain in memory and are discarded when the test exits.

use dilla_core::{
    identity::{
        CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier,
        SskSigner, Tier, UmkSigner,
    },
    ids::{CommunityId, DeviceId, InstanceId, UserId},
    mls::{DILLA_BINDING_ID, DillaInteractionBinding},
};
use openmls::{extensions::UnknownExtension, prelude::*};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::{fs, path::PathBuf};
use tls_codec::Serialize as _;

const INSTANCE: [u8; 16] = [0x11; 16];
const BOT_USER: [u8; 16] = [0x22; 16];
const INSTALLATION: [u8; 16] = [0x33; 16];
const COMMUNITY: [u8; 16] = [0x44; 16];
const PARTICIPANT_USER: [u8; 16] = [0x55; 16];
const BOT_DEVICE: [u8; 16] = [0x66; 16];
const PARTICIPANT_DEVICE: [u8; 16] = [0x77; 16];
const GROUP_ID: [u8; 16] = [0x88; 16];

struct Member {
    credential: CredentialWithKey,
    signer: SignatureKeyPair,
    identity: Vec<u8>,
    signed_device_list: Vec<u8>,
    dsk: [u8; 32],
    ssk: [u8; 32],
}

fn member(user: [u8; 16], device: [u8; 16], kind: Kind, seed: u8) -> Member {
    let umk = UmkSigner::from_bytes(&[seed; 32]);
    let ssk_signer = SskSigner::from_bytes(&[seed.wrapping_add(1); 32]);
    let dsk_seed = [seed.wrapping_add(2); 32];
    let dsk = SskSigner::from_bytes(&dsk_seed).public();
    let signer =
        SignatureKeyPair::from_raw(SignatureScheme::ED25519, dsk_seed.to_vec(), dsk.to_vec());
    let tier = Tier::Native;
    let identity = CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes(user),
        device_id: DeviceId::from_bytes(device),
        kind,
        tier,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk_signer.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk_signer.public()),
        sig_ssk_dev: ssk_signer.sign_device(
            &DeviceId::from_bytes(device),
            &dsk,
            kind,
            tier,
            SignerTier::Native,
        ),
    }
    .encode();
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: UserId::from_bytes(user),
        version: 1,
        prev_hash: [0; 32],
        entries: vec![DeviceEntry {
            device_id: DeviceId::from_bytes(device),
            dsk_pub: dsk,
            tier,
            added_at: 1_790_000_000,
            revoked_at: None,
        }],
    };
    let signed_device_list = DeviceList {
        sig_ssk: ssk_signer.sign_device_list(&unsigned),
        unsigned,
    }
    .encode();
    let credential = CredentialWithKey {
        credential: BasicCredential::new(identity.clone()).into(),
        signature_key: signer.public().into(),
    };
    Member {
        credential,
        signer,
        identity,
        signed_device_list,
        dsk,
        ssk: ssk_signer.public(),
    }
}

fn write(path: &PathBuf, bytes: &[u8]) {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).expect("write temp fixture");
    fs::rename(tmp, path).expect("publish fixture");
}

#[test]
#[ignore = "explicit writer for the committed public Go DS/WASI kind-3 fixture"]
fn write_interaction_roster_fixture() {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../internal/ds/dstest/testdata/kind3-interaction");
    fs::create_dir_all(&output).expect("fixture directory");
    let provider = OpenMlsRustCrypto::default();
    let bot = member(BOT_USER, BOT_DEVICE, Kind::Bot, 0x21);
    let participant = member(PARTICIPANT_USER, PARTICIPANT_DEVICE, Kind::User, 0x31);
    let binding = DillaInteractionBinding {
        instance_id: InstanceId::from_bytes(INSTANCE),
        bot_user_id: BOT_USER,
        installation_id: INSTALLATION,
        community_id: CommunityId::from_bytes(COMMUNITY),
        participant_user_id: PARTICIPANT_USER,
        participant_device_id: DeviceId::from_bytes(PARTICIPANT_DEVICE),
        policy_version: 3,
        e2ee_version: 1,
        media_version: 0,
    };
    let extensions = Extensions::<GroupContext>::try_from(vec![
        Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
            &[ExtensionType::Unknown(DILLA_BINDING_ID)],
            &[],
            &[CredentialType::Basic],
        )),
        Extension::Unknown(DILLA_BINDING_ID, UnknownExtension(binding.encode())),
    ])
    .expect("valid group-context extensions");
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519)
        .use_ratchet_tree_extension(false)
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .with_group_context_extensions(extensions)
        .capabilities(Capabilities::new(
            None,
            None,
            Some(&[ExtensionType::Unknown(DILLA_BINDING_ID)]),
            None,
            Some(&[CredentialType::Basic]),
        ))
        .build();
    let mut group = MlsGroup::new_with_group_id(
        &provider,
        &bot.signer,
        &config,
        GroupId::from_slice(&GROUP_ID),
        bot.credential.clone(),
    )
    .expect("create Bot interaction group");

    let kp = KeyPackage::builder()
        .leaf_node_capabilities(Capabilities::new(
            None,
            None,
            Some(&[ExtensionType::Unknown(DILLA_BINDING_ID)]),
            None,
            Some(&[CredentialType::Basic]),
        ))
        .build(
            Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
            &provider,
            &participant.signer,
            participant.credential.clone(),
        )
        .expect("participant KeyPackage");
    let bundle = group
        .add_members(&provider, &bot.signer, &[kp.key_package().clone()])
        .expect("add participant");
    group
        .merge_pending_commit(&provider)
        .expect("merge participant Add");
    let _ = bundle;
    let group_info = group
        .export_group_info(provider.crypto(), &bot.signer, false)
        .expect("export authenticated GroupInfo")
        .tls_serialize_detached()
        .expect("serialize GroupInfo");
    let tree = group
        .export_ratchet_tree()
        .tls_serialize_detached()
        .expect("serialize ratchet tree");

    let extra = member([0x99; 16], [0xaa; 16], Kind::User, 0x41);
    let mut extra_group = MlsGroup::new_with_group_id(
        &provider,
        &bot.signer,
        &config,
        GroupId::from_slice(&[0x89; 16]),
        bot.credential.clone(),
    )
    .expect("create extra-leaf Bot interaction group");
    let kp_extra = KeyPackage::builder()
        .leaf_node_capabilities(Capabilities::new(
            None,
            None,
            Some(&[ExtensionType::Unknown(DILLA_BINDING_ID)]),
            None,
            Some(&[CredentialType::Basic]),
        ))
        .build(
            Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
            &provider,
            &extra.signer,
            extra.credential.clone(),
        )
        .expect("extra human KeyPackage");
    let _extra_bundle = extra_group
        .add_members(
            &provider,
            &bot.signer,
            &[kp.key_package().clone(), kp_extra.key_package().clone()],
        )
        .expect("add participant and extra leaf");
    extra_group
        .merge_pending_commit(&provider)
        .expect("merge extra-leaf Add");
    let extra_group_info = extra_group
        .export_group_info(provider.crypto(), &bot.signer, false)
        .expect("export extra-leaf GroupInfo")
        .tls_serialize_detached()
        .expect("serialize extra-leaf GroupInfo");
    let extra_tree = extra_group
        .export_ratchet_tree()
        .tls_serialize_detached()
        .expect("serialize extra-leaf tree");

    write(&output.join("group_info.mls"), &group_info);
    write(&output.join("ratchet_tree.mls"), &tree);
    write(&output.join("bot_credential.cbor"), &bot.identity);
    write(
        &output.join("participant_credential.cbor"),
        &participant.identity,
    );
    write(
        &output.join("bot_device_list.cbor"),
        &bot.signed_device_list,
    );
    write(
        &output.join("participant_device_list.cbor"),
        &participant.signed_device_list,
    );
    write(&output.join("extra.group_info.mls"), &extra_group_info);
    write(&output.join("extra.ratchet_tree.mls"), &extra_tree);
    let metadata = serde_json::json!({
        "fixture": "kind3-interaction",
        "abi": 9,
        "binding_version": 2,
        "binding_cbor_hex": hex::encode(binding.encode()),
        "group_id_hex": hex::encode(GROUP_ID),
        "instance_id_hex": hex::encode(INSTANCE),
        "bot_user_id_hex": hex::encode(BOT_USER),
        "bot_device_id_hex": hex::encode(BOT_DEVICE),
        "bot_dsk_public_hex": hex::encode(bot.dsk),
        "bot_ssk_public_hex": hex::encode(bot.ssk),
        "installation_id_hex": hex::encode(INSTALLATION),
        "community_id_hex": hex::encode(COMMUNITY),
        "participant_user_id_hex": hex::encode(PARTICIPANT_USER),
        "participant_device_id_hex": hex::encode(PARTICIPANT_DEVICE),
        "participant_dsk_public_hex": hex::encode(participant.dsk),
        "participant_ssk_public_hex": hex::encode(participant.ssk),
        "extra_user_id_hex": hex::encode([0x99; 16]),
        "extra_device_id_hex": hex::encode([0xaa; 16]),
        "policy_version": 3,
        "e2ee_version": 1,
        "media_version": 0,
        "expected_roster_leaves": 2,
        "credential_kind": {"bot": 1, "participant": 0},
        "tier": {"bot": 0, "participant": 0},
        "generated_by": "cargo test -p dilla-core --test interaction_roster_fixture -- --ignored --nocapture"
    });
    write(
        &output.join("metadata.json"),
        serde_json::to_string_pretty(&metadata).unwrap().as_bytes(),
    );
}
