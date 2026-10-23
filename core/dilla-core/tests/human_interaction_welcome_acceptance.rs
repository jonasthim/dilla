#![cfg(not(target_arch = "wasm32"))]

//! End-to-end acceptance of a real kind-3 Welcome by an enrolled human core. The Bot creates and
//! signs the MLS group, its current-context proof is server-key signed, and both leaves have
//! locally pinned UMKs and signed device lists before the client applies the Welcome.

#[path = "client_support/mod.rs"]
mod client_support;

use client_support::{Core, GROUP, INSTANCE, NOW};
use dilla_core::{
    cbor::{Encoder, decode_strict},
    client::ClientCore,
    identity::{
        CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier,
        SskSigner, Tier, UmkSigner,
    },
    ids::{CommunityId, DeviceId, InstanceId, UserId},
    mls::{CIPHERSUITE, DILLA_BINDING_ID, DillaInteractionBinding},
};
use ed25519_dalek::{Signer, SigningKey};
use openmls::{extensions::UnknownExtension, prelude::*};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tls_codec::{Deserialize as _, Serialize as _};

const BOT_USER: [u8; 16] = [0x91; 16];
const BOT_DEVICE: [u8; 16] = [0x92; 16];
const INSTALLATION: [u8; 16] = [0x93; 16];
const OPERATION: [u8; 16] = [0x94; 16];
const GROUP_ID: [u8; 16] = GROUP;
const COMMUNITY: [u8; 16] = [0x22; 16];
const POLICY: u64 = 3;
const SERVER_CONTEXT_DOMAIN: &[u8] = b"dilla bot current interaction context v1\0";

struct BotIdentity {
    credential: CredentialWithKey,
    signer: SignatureKeyPair,
    identity: CredentialIdentity,
    list: DeviceList,
}

fn bot_identity() -> BotIdentity {
    let umk = UmkSigner::from_bytes(&[0xb1; 32]);
    let ssk = SskSigner::from_bytes(&[0xb2; 32]);
    let dsk_seed = [0xb3; 32];
    let dsk = SskSigner::from_bytes(&dsk_seed).public();
    let signer =
        SignatureKeyPair::from_raw(SignatureScheme::ED25519, dsk_seed.to_vec(), dsk.to_vec());
    let identity = CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes(BOT_USER),
        device_id: DeviceId::from_bytes(BOT_DEVICE),
        kind: Kind::Bot,
        tier: Tier::Native,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
        sig_ssk_dev: ssk.sign_device(
            &DeviceId::from_bytes(BOT_DEVICE),
            &dsk,
            Kind::Bot,
            Tier::Native,
            SignerTier::Native,
        ),
    };
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: UserId::from_bytes(BOT_USER),
        version: 1,
        prev_hash: [0; 32],
        entries: vec![DeviceEntry {
            device_id: DeviceId::from_bytes(BOT_DEVICE),
            dsk_pub: dsk,
            tier: Tier::Native,
            added_at: NOW,
            revoked_at: None,
        }],
    };
    let list = DeviceList {
        sig_ssk: ssk.sign_device_list(&unsigned),
        unsigned,
    };
    let credential = CredentialWithKey {
        credential: BasicCredential::new(identity.encode()).into(),
        signature_key: signer.public().into(),
    };
    BotIdentity {
        credential,
        signer,
        identity,
        list,
    }
}

fn enrolled_human(instance_signer: &[u8; 32]) -> Core {
    let connection = client_support::memory();
    let probe = std::sync::Arc::clone(&connection);
    let mut core = ClientCore::open(connection).expect("open human core");
    core.signup_begin(&INSTANCE)
        .expect("begin human enrollment");
    core.signup_complete(&[0xa1; 16], "human participant", NOW, instance_signer)
        .expect("enroll and pin instance signer");
    let device = decode_strict(&core.identity().expect("human identity"), |d| {
        d.array(6)?;
        d.uint()?;
        d.opt_bytes_exact::<16>()?;
        d.opt_bytes_exact::<16>()?;
        let device = d.opt_bytes_exact::<16>()?;
        d.text()?;
        d.uint()?;
        Ok(device)
    })
    .expect("human identity shape")
    .expect("enrolled human device");
    Core {
        core,
        probe,
        user: [0xa1; 16],
        device,
    }
}

fn snapshot(identity: &CredentialIdentity, list: &DeviceList) -> Vec<u8> {
    let blob = list.encode();
    let hash: [u8; 32] = Sha256::digest(&blob).into();
    let mut e = Encoder::new();
    e.array(9)
        .bytes(identity.user_id.as_bytes())
        .bytes(&identity.umk_pub)
        .bytes(&identity.ssk_pub)
        .bytes(&identity.sig_umk_ssk)
        .uint(list.unsigned.version)
        .bytes(&blob)
        .bytes(&list.sig_ssk)
        .bytes(&list.unsigned.prev_hash)
        .bytes(&hash);
    e.into_vec()
}

fn credential_from_key_package(
    bytes: &[u8],
    provider: &OpenMlsRustCrypto,
) -> (KeyPackage, CredentialIdentity, [u8; 32]) {
    let message = MlsMessageIn::tls_deserialize_exact(bytes).expect("human KeyPackage message");
    let MlsMessageBodyIn::KeyPackage(package) = message.extract() else {
        panic!("human package is not a KeyPackage");
    };
    let unverified = package.unverified_credential();
    let basic =
        BasicCredential::try_from(unverified.credential.clone()).expect("human BasicCredential");
    let identity = CredentialIdentity::decode(basic.identity()).expect("human identity");
    let dsk = unverified
        .signature_key
        .as_slice()
        .try_into()
        .expect("human DSK length");
    let package = package
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .expect("valid human KeyPackage");
    (package, identity, dsk)
}

fn welcomes_body(welcome: &[u8], tree: &[u8], tree_hash: &[u8; 32]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(1)
        .array(7)
        .uint(1)
        .bytes(&GROUP_ID)
        .uint(1)
        .uint(1)
        .bytes(welcome)
        .bytes(tree)
        .bytes(tree_hash);
    e.into_vec()
}

fn mutate_welcome_body(body: &[u8]) -> Vec<u8> {
    let (welcome_id, group, epoch, commit_seq, mut blob, tree, hash) = decode_strict(body, |d| {
        d.array(1)?;
        d.array(7)?;
        Ok((
            d.uint()?,
            d.bytes_exact::<16>()?,
            d.uint()?,
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes()?.to_vec(),
            d.bytes_exact::<32>()?,
        ))
    })
    .expect("Welcome body");
    blob[0] ^= 1;
    let mut e = Encoder::new();
    e.array(1)
        .array(7)
        .uint(welcome_id)
        .bytes(&group)
        .uint(epoch)
        .uint(commit_seq)
        .bytes(&blob)
        .bytes(&tree)
        .bytes(&hash);
    e.into_vec()
}

fn current_context_proof(
    server_key: &SigningKey,
    human: &Core,
    bot: &BotIdentity,
    human_identity: &CredentialIdentity,
    human_list: &DeviceList,
    human_dsk: &[u8; 32],
    tree_hash: &[u8; 32],
    issued_at: u64,
    accepted_at: u64,
    registration_group: [u8; 16],
) -> Vec<u8> {
    let bot_snapshot = snapshot(&bot.identity, &bot.list);
    let human_snapshot = snapshot(human_identity, human_list);
    let key = server_key.verifying_key().to_bytes();
    let not_after = issued_at + 30;
    let binding = DillaInteractionBinding {
        instance_id: InstanceId::from_bytes(INSTANCE),
        installation_id: INSTALLATION,
        community_id: CommunityId::from_bytes(COMMUNITY),
        bot_user_id: BOT_USER,
        participant_user_id: human.user,
        participant_device_id: DeviceId::from_bytes(human.device),
        policy_version: POLICY,
        e2ee_version: 1,
        media_version: 0,
    };
    let mut payload = Encoder::new();
    payload
        .array(18)
        .uint(1)
        .bytes(&INSTANCE)
        .bytes(&[0x95; 16])
        .bytes(&key)
        .uint(issued_at)
        .uint(not_after)
        .array(11)
        .bytes(&INSTALLATION)
        .bytes(&OPERATION)
        .bytes(&BOT_USER)
        .bytes(&BOT_DEVICE)
        .bytes(&COMMUNITY)
        .bytes(&registration_group)
        .bytes(&[0x96; 32])
        .uint(1)
        .uint(1)
        .uint(2)
        .uint(accepted_at)
        .array(9)
        .bytes(binding.instance_id.as_bytes())
        .bytes(&binding.installation_id)
        .bytes(binding.community_id.as_bytes())
        .bytes(&binding.bot_user_id)
        .bytes(&binding.participant_user_id)
        .bytes(binding.participant_device_id.as_bytes())
        .uint(binding.policy_version)
        .uint(binding.e2ee_version)
        .uint(binding.media_version)
        .uint(1)
        .uint(2)
        .bytes(tree_hash)
        .array(2)
        .array(4)
        .uint(0)
        .bytes(&BOT_USER)
        .bytes(&BOT_DEVICE)
        .bytes(bot.signer.public())
        .array(4)
        .uint(1)
        .bytes(&human.user)
        .bytes(&human.device)
        .bytes(human_dsk)
        .uint(1)
        .uint(POLICY)
        .uint(1)
        .uint(0)
        .raw(&bot_snapshot)
        .raw(&human_snapshot);
    let payload = payload.into_vec();
    let mut preimage = SERVER_CONTEXT_DOMAIN.to_vec();
    preimage.extend_from_slice(&payload);
    let signature = server_key.sign(&preimage).to_bytes();
    let mut wire = Encoder::new();
    wire.array(2).bytes(&payload).bytes(&signature);
    wire.into_vec()
}

fn seed_trust(
    human: &mut Core,
    bot: &BotIdentity,
    human_identity: &CredentialIdentity,
    human_list: &DeviceList,
) {
    let connection = human.probe.lock().expect("human DB");
    connection
        .execute(
            "INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub,credential) VALUES(?1,1,?2,?3,?4,NULL)",
            rusqlite::params![
                BOT_USER.as_slice(),
                bot.list.encode(),
                bot.identity.umk_pub.as_slice(),
                bot.identity.ssk_pub.as_slice()
            ],
        )
        .expect("cache Bot signed device list");
    connection
        .execute(
            "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,1,NULL)",
            rusqlite::params![BOT_USER.as_slice(), bot.identity.umk_pub.as_slice(), NOW as i64],
        )
        .expect("pin Bot UMK");
    connection
        .execute(
            "INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub,credential) VALUES(?1,1,?2,?3,?4,NULL) ON CONFLICT(user_id) DO UPDATE SET list=excluded.list,umk_pub=excluded.umk_pub,ssk_pub=excluded.ssk_pub",
            rusqlite::params![
                human.user.as_slice(),
                human_list.encode(),
                human_identity.umk_pub.as_slice(),
                human_identity.ssk_pub.as_slice()
            ],
        )
        .expect("cache human signed list");
    drop(connection);
}

#[test]
fn human_accepts_server_proven_two_leaf_bot_welcome_and_rejects_group_mismatch() {
    let server_key = SigningKey::from_bytes(&[0xa7; 32]);
    let server_public = server_key.verifying_key().to_bytes();
    let mut human = enrolled_human(&server_public);
    let package_body = human.core.key_packages(1, false).expect("human KeyPackage");
    let key_package = decode_strict(&package_body, |d| {
        d.array(2)?;
        d.array(1)?;
        let package = d.bytes()?.to_vec();
        d.null()?;
        Ok(package)
    })
    .expect("human KeyPackage response");
    let provider = OpenMlsRustCrypto::default();
    let (package, human_identity, human_dsk) = credential_from_key_package(&key_package, &provider);
    let bot = bot_identity();
    let human_list = decode_strict(&human.core.device_list_body().expect("own list"), |d| {
        d.array(4)?;
        d.uint()?;
        let blob = d.bytes()?.to_vec();
        d.bytes()?;
        d.bytes()?;
        Ok(blob)
    })
    .map(|blob| DeviceList::decode(&blob).expect("human signed list"))
    .expect("human list");
    seed_trust(&mut human, &bot, &human_identity, &human_list);

    let binding = DillaInteractionBinding {
        instance_id: InstanceId::from_bytes(INSTANCE),
        installation_id: INSTALLATION,
        community_id: CommunityId::from_bytes(COMMUNITY),
        bot_user_id: BOT_USER,
        participant_user_id: human.user,
        participant_device_id: DeviceId::from_bytes(human.device),
        policy_version: POLICY,
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
    .expect("kind-3 group context extensions");
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
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
    let bundle = group
        .add_members(&provider, &bot.signer, &[package])
        .expect("Bot Add commit and Welcome");
    group
        .merge_pending_commit(&provider)
        .expect("merge human Add");
    assert_eq!(group.members().count(), 2);
    let welcome = bundle
        .1
        .tls_serialize_detached()
        .expect("serialize actual MLS Welcome");
    let tree = group
        .export_ratchet_tree()
        .tls_serialize_detached()
        .expect("serialize actual MLS ratchet tree");
    let group_info = group
        .export_group_info(provider.crypto(), &bot.signer, false)
        .expect("authenticated GroupInfo");
    let MlsMessageBodyOut::GroupInfo(group_info) = group_info.body() else {
        panic!("expected GroupInfo");
    };
    let tree_hash: [u8; 32] = group_info
        .group_context()
        .tree_hash()
        .try_into()
        .expect("tree hash length");
    let welcomes = welcomes_body(&welcome, &tree, &tree_hash);
    human
        .core
        .instance_signer_key_matches(&server_public)
        .expect("server key remains pinned after enrollment");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let good_proof = current_context_proof(
        &server_key,
        &human,
        &bot,
        &human_identity,
        &human_list,
        &human_dsk,
        &tree_hash,
        now - 2,
        now - 3,
        GROUP_ID,
    );
    let wrong_group_proof = current_context_proof(
        &server_key,
        &human,
        &bot,
        &human_identity,
        &human_list,
        &human_dsk,
        &tree_hash,
        now - 2,
        now - 3,
        [0x9f; 16],
    );
    let expected_context = dilla_core::bot::human_interaction_context::Expected {
        instance: InstanceId::from_bytes(INSTANCE),
        group: dilla_core::ids::MsgId::from_bytes(GROUP_ID),
        participant_user: UserId::from_bytes(human.user),
        participant_device: DeviceId::from_bytes(human.device),
        now,
    };
    let initial_context = dilla_core::bot::human_interaction_context::verify(
        &good_proof,
        &server_key.verifying_key().to_bytes(),
        &expected_context,
    )
    .expect("locally verify the valid server proof");
    let rejected = human
        .core
        .human_interaction_welcome_apply(&welcomes, &wrong_group_proof)
        .expect_err("a proof for another group is rejected");
    assert_eq!(rejected.code, "E_BINDING");
    assert!(client_support::groups(&human.core).is_empty());

    let accepted = human
        .core
        .human_interaction_welcome_apply(&welcomes, &good_proof)
        .expect("human accepts current Bot interaction Welcome");
    let accepted = decode_strict(&accepted, |d| {
        d.array(1)?;
        d.array(4)?;
        let id = d.uint()?;
        let group = d.bytes_exact::<16>()?;
        let outcome = d.uint()?;
        let reason = d.text()?.to_owned();
        Ok((id, group, outcome, reason))
    })
    .expect("accepted outcome");
    assert_eq!(accepted, (1, GROUP_ID, 0, String::new()));
    assert_eq!(
        client_support::groups(&human.core),
        vec![client_support::GroupRow {
            group_id: GROUP_ID,
            kind: 3,
            community_id: Some(COMMUNITY),
            target_id: BOT_USER,
            state: 2,
            epoch: 1,
            next_seq: 2,
            proposals_pending: 0,
            pending_commit: 0,
        }]
    );
    let provider = dilla_core::mls::DillaProvider::new(std::sync::Arc::clone(&human.probe));
    let stored = dilla_core::mls::DillaGroup::load(&provider, &GroupId::from_slice(&GROUP_ID))
        .expect("load persisted MLS state")
        .expect("persisted interaction group");
    assert_eq!(stored.kind(), dilla_core::mls::GroupKind::Interaction);
    assert_eq!(stored.members().len(), 2);

    let same_proof_replay = human
        .core
        .human_interaction_welcome_apply(&welcomes, &good_proof)
        .expect("same Welcome with same proof");
    let same_proof_replay = decode_strict(&same_proof_replay, |d| {
        d.array(1)?;
        d.array(4)?;
        d.uint()?;
        d.bytes_exact::<16>()?;
        let outcome = d.uint()?;
        d.text()?;
        Ok(outcome)
    })
    .expect("same-proof replay outcome");
    assert_eq!(same_proof_replay, 1);

    let fresh_proof = current_context_proof(
        &server_key,
        &human,
        &bot,
        &human_identity,
        &human_list,
        &human_dsk,
        &tree_hash,
        now - 1,
        now - 3,
        GROUP_ID,
    );
    assert_ne!(fresh_proof, good_proof, "a refreshed proof has new bytes");
    let fresh_context = dilla_core::bot::human_interaction_context::verify(
        &fresh_proof,
        &server_key.verifying_key().to_bytes(),
        &expected_context,
    )
    .expect("refreshed proof verifies");
    assert_eq!(fresh_context.registration, initial_context.registration);
    assert_eq!(fresh_context.binding, initial_context.binding);
    let before_replay = client_support::groups(&human.core);
    let replay = human
        .core
        .human_interaction_welcome_apply(&welcomes, &fresh_proof)
        .expect("same Welcome with refreshed proof");
    let replay = decode_strict(&replay, |d| {
        d.array(1)?;
        d.array(4)?;
        d.uint()?;
        d.bytes_exact::<16>()?;
        let outcome = d.uint()?;
        let reason = d.text()?.to_owned();
        Ok((outcome, reason))
    })
    .expect("replay outcome");
    assert_eq!(replay, (1, String::new()));
    assert_eq!(client_support::groups(&human.core), before_replay);

    let altered = mutate_welcome_body(&welcomes);
    let changed = human
        .core
        .human_interaction_welcome_apply(&altered, &fresh_proof)
        .expect("changed Welcome is returned as a refusal");
    let changed = decode_strict(&changed, |d| {
        d.array(1)?;
        d.array(4)?;
        d.uint()?;
        d.bytes_exact::<16>()?;
        let outcome = d.uint()?;
        let reason = d.text()?.to_owned();
        Ok((outcome, reason))
    })
    .expect("changed-Welcome outcome");
    assert_eq!(changed, (2, "E_BINDING".to_owned()));
    assert_eq!(client_support::groups(&human.core), before_replay);

    // A kind-3 send uses the already-authenticated MLS binding and a stable request id as its
    // outbox message id, so an exact retry returns the same encrypted-send handle.
    let request_id = [0x42; 16];
    let mut bot_request = Encoder::new();
    bot_request
        .array(8)
        .uint(1)
        .bytes(&request_id)
        .bytes(&COMMUNITY)
        .null()
        .uint(0)
        .null()
        .null()
        .array(0);
    let bot_request = bot_request.into_vec();
    let prepared = human
        .core
        .human_interaction_send_prepare(&request_id, &COMMUNITY, &GROUP_ID, &bot_request, now)
        .expect("prepare encrypted human interaction request");
    let encrypted = human
        .core
        .send_encrypt(&request_id)
        .expect("encrypt interaction request");
    let (encrypted_group, upload) = decode_strict(&encrypted, |d| {
        d.array(2)?;
        Ok((d.bytes_exact::<16>()?, d.bytes()?.to_vec()))
    })
    .expect("encrypted upload shape");
    assert_eq!(encrypted_group, GROUP_ID);
    assert!(!upload.is_empty());
    assert_eq!(
        human
            .core
            .human_interaction_send_prepare(&request_id, &COMMUNITY, &GROUP_ID, &bot_request, now,)
            .expect("idempotent request retry"),
        prepared
    );
    human
        .probe
        .lock()
        .expect("connection")
        .execute(
            "DELETE FROM app_outbox WHERE msg_id=?1",
            [request_id.as_slice()],
        )
        .expect("simulate completed upload cleanup");
    assert_eq!(
        human
            .core
            .human_interaction_send_prepare(&request_id, &COMMUNITY, &GROUP_ID, &bot_request, now,)
            .expect("completed interaction request remains idempotent"),
        prepared
    );
    let mut changed_request = Encoder::new();
    changed_request
        .array(8)
        .uint(1)
        .bytes(&request_id)
        .bytes(&COMMUNITY)
        .null()
        .uint(50)
        .null()
        .null()
        .array(1)
        .uint(0);
    assert!(
        human
            .core
            .human_interaction_send_prepare(
                &request_id,
                &COMMUNITY,
                &GROUP_ID,
                &changed_request.into_vec(),
                now,
            )
            .is_err(),
        "request ids cannot be reused for a different operation"
    );
    assert!(
        human
            .core
            .human_interaction_send_prepare(&request_id, &[0x23; 16], &GROUP_ID, &bot_request, now,)
            .is_err()
    );
    let ordinary_group = [0x45; 16];
    human
        .core
        .group_create(
            &ordinary_group,
            Some(&COMMUNITY),
            &[0x46; 16],
            POLICY,
            &[0x47; 32],
        )
        .expect("ordinary group fixture");
    human
        .core
        .group_registered(&ordinary_group, 1)
        .expect("ordinary group registration");
    assert!(
        human
            .core
            .human_interaction_send_prepare(
                &[0x48; 16],
                &COMMUNITY,
                &ordinary_group,
                &bot_request,
                now,
            )
            .is_err(),
        "ordinary text groups cannot use the interaction request API"
    );
    human
        .probe
        .lock()
        .expect("connection")
        .execute(
            "UPDATE app_groups SET max_epoch=epoch+1 WHERE group_id=?1",
            [GROUP_ID.as_slice()],
        )
        .expect("mark interaction group stale");
    assert!(
        human
            .core
            .human_interaction_send_prepare(&[0x43; 16], &COMMUNITY, &GROUP_ID, &bot_request, now,)
            .is_err(),
        "a stale local epoch must not prepare a request"
    );
}
