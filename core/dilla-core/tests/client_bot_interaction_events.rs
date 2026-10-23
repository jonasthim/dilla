#![cfg(not(target_arch = "wasm32"))]

//! Exercises the Bot event journal against a real, managed kind-3 group and a participant leaf.

mod client_support;

use client_support::{COMMUNITY, INSTANCE, MsgRow, NOW};
use dilla_core::{
    bot::interaction_admission::Expected,
    cbor::{Encoder, decode_strict},
    client::ClientCore,
    envelope::{Envelope, EnvelopeType},
    identity::{
        CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier,
        SskSigner, Tier, UmkSigner,
    },
    ids::{DeviceId, MsgId, UserId},
    mls::{CIPHERSUITE, DillaGroup, DillaProvider, WelcomeLabel, build_key_package},
};
use ed25519_dalek::{Signer, SigningKey};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tls_codec::{Deserialize as _, Serialize as _};

const INSTALLATION: [u8; 16] = [0x33; 16];
const BOT_USER: [u8; 16] = [0x44; 16];
const PARTICIPANT_USER: [u8; 16] = [0x55; 16];
const GROUP: [u8; 16] = [0x88; 16];
const POLICY: u64 = 3;
const CONTEXT_DOMAIN: &[u8] = b"dilla bot interaction context snapshot v1\0";

fn conn() -> dilla_core::mls::ConnHandle {
    Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ))
}

struct SignedIdentity {
    identity: CredentialIdentity,
    list: DeviceList,
    signer: SignatureKeyPair,
    provider: DillaProvider,
}

fn participant_identity(connection: dilla_core::mls::ConnHandle) -> SignedIdentity {
    let _schema = ClientCore::open(connection.clone()).expect("initialize participant store");
    let provider = DillaProvider::new(connection);
    let umk = UmkSigner::from_bytes(&[0x51; 32]);
    let ssk = SskSigner::from_bytes(&[0x52; 32]);
    let signer =
        SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("participant signer");
    signer
        .store(provider.storage())
        .expect("store participant signer");
    let device: [u8; 16] = [0x77; 16];
    let dsk: [u8; 32] = signer.public().try_into().expect("DSK length");
    let identity = CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes(PARTICIPANT_USER),
        device_id: DeviceId::from_bytes(device),
        kind: Kind::User,
        tier: Tier::Native,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
        sig_ssk_dev: ssk.sign_device(
            &DeviceId::from_bytes(device),
            &dsk,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        ),
    };
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: UserId::from_bytes(PARTICIPANT_USER),
        version: 1,
        prev_hash: [0; 32],
        entries: vec![DeviceEntry {
            device_id: DeviceId::from_bytes(device),
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
    SignedIdentity {
        identity,
        list,
        signer,
        provider,
    }
}

fn snapshot_list(identity: &CredentialIdentity, list: &DeviceList) -> Vec<u8> {
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

fn signed_context(
    expected: &Expected,
    bot_list: &[u8],
    participant_list: &[u8],
    key: &SigningKey,
    expiry: u64,
) -> Vec<u8> {
    let mut admission = Encoder::new();
    admission
        .array(12)
        .uint(1)
        .bytes(&[0x01; 16])
        .bytes(expected.instance.as_bytes())
        .bytes(expected.installation.as_bytes())
        .bytes(expected.community.as_bytes())
        .bytes(expected.bot_user.as_bytes())
        .bytes(expected.bot_device.as_bytes())
        .bytes(expected.participant_user.as_bytes())
        .bytes(expected.participant_device.as_bytes())
        .bytes(expected.group.as_bytes())
        .uint(expected.minimum_eligibility_revision)
        .uint(expiry);
    let admission = admission.into_vec();
    let admission_sig = key
        .sign(
            &[
                b"dilla bot interaction admission v1\0".as_slice(),
                &admission,
            ]
            .concat(),
        )
        .to_bytes();
    let mut payload = Encoder::new();
    payload
        .array(16)
        .uint(1)
        .bytes(&[0x0a; 16])
        .bytes(&[0x01; 16])
        .bytes(&admission)
        .bytes(&admission_sig)
        .uint(expected.server_now)
        .uint(expected.minimum_eligibility_revision)
        .uint(expected.policy_version)
        .uint(1)
        .uint(0)
        .bytes(expected.instance.as_bytes())
        .bytes(&[0x0b; 16])
        .bytes(&key.verifying_key().to_bytes())
        .array(8)
        .bytes(expected.instance.as_bytes())
        .bytes(expected.installation.as_bytes())
        .bytes(expected.community.as_bytes())
        .bytes(expected.bot_user.as_bytes())
        .bytes(expected.bot_device.as_bytes())
        .bytes(expected.participant_user.as_bytes())
        .bytes(expected.participant_device.as_bytes())
        .bytes(expected.group.as_bytes())
        .raw(bot_list)
        .raw(participant_list);
    let payload = payload.into_vec();
    let signature = key
        .sign(&[CONTEXT_DOMAIN, payload.as_slice()].concat())
        .to_bytes();
    let mut wire = Encoder::new();
    wire.array(2).bytes(&payload).bytes(&signature);
    wire.into_vec()
}

fn encode_message(row: &MsgRow) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(1)
        .array(8)
        .uint(row.seq)
        .uint(row.epoch)
        .bytes(&row.uploader)
        .opt_bytes(row.blob.as_deref())
        .opt_bytes(row.commitment.as_ref().map(|v| v.as_slice()))
        .bytes(&row.franking_tag)
        .uint(row.recv_ts)
        .uint(u64::from(row.deleted));
    e.into_vec()
}

fn event_actor(body: &[u8]) -> (String, [u8; 16], [u8; 16]) {
    decode_strict(body, |d| {
        d.array(3)?;
        d.array(1)?;
        d.array(17)?;
        d.uint()?;
        d.bytes_exact::<16>()?;
        d.bytes_exact::<16>()?;
        d.bytes_exact::<16>()?;
        d.uint()?;
        d.uint()?;
        d.uint()?;
        let user = d.bytes_exact::<16>()?;
        let device = d.bytes_exact::<16>()?;
        d.uint()?;
        d.uint()?;
        d.uint()?;
        d.bytes_exact::<16>()?;
        d.uint()?;
        let text = d.text()?.to_owned();
        d.opt_bytes()?;
        d.opt_bytes()?;
        d.uint()?;
        d.uint()?;
        Ok((text, user, device))
    })
    .expect("decoded event actor")
}

#[test]
fn managed_kind3_participant_message_is_journaled_with_actor_and_revocation_suppresses_drain() {
    let bot_connection = conn();
    let instance_key = SigningKey::from_bytes(&[0xa7; 32]);
    let mut bot = ClientCore::open(bot_connection.clone()).expect("open bot");
    bot.bot_bootstrap_begin(
        &INSTANCE,
        &COMMUNITY,
        &INSTALLATION,
        &instance_key.verifying_key().to_bytes(),
    )
    .expect("begin bot");
    let completion = bot
        .bot_bootstrap_complete(&BOT_USER, "interaction bot", NOW)
        .expect("complete bot");
    let (bot_credential, bot_list_body) = decode_strict(&completion, |d| {
        d.array(2)?;
        Ok((d.bytes()?.to_vec(), d.bytes()?.to_vec()))
    })
    .expect("bot completion");
    let bot_identity = CredentialIdentity::decode(&bot_credential).expect("bot credential");
    let bot_list = decode_strict(&bot_list_body, |d| {
        d.array(4)?;
        d.uint()?;
        let list = d.bytes()?.to_vec();
        d.bytes()?;
        d.bytes()?;
        Ok(list)
    })
    .map(|b| DeviceList::decode(&b).expect("bot list"))
    .expect("bot list body");
    let bot_device = bot_identity.device_id.0;

    let participant_connection = conn();
    let participant = participant_identity(participant_connection.clone());
    let participant_id = participant.identity.device_id.0;
    let participant_list_wire = participant.list.encode();
    {
        let db = bot_connection.lock().expect("bot db");
        db.execute("INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,?3,1,NULL)", params![PARTICIPANT_USER.as_slice(), participant.identity.umk_pub.as_slice(), NOW as i64]).expect("pin participant");
        db.execute("INSERT INTO app_device_lists(user_id,version,list,umk_pub,ssk_pub,credential) VALUES(?1,1,?2,?3,?4,NULL)", params![PARTICIPANT_USER.as_slice(), participant_list_wire, participant.identity.umk_pub.as_slice(), participant.identity.ssk_pub.as_slice()]).expect("cache participant list");
    }
    let bot_snap = snapshot_list(&bot_identity, &bot_list);
    let participant_snap = snapshot_list(&participant.identity, &participant.list);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let expected = Expected {
        instance: MsgId::from_bytes(INSTANCE),
        installation: MsgId::from_bytes(INSTALLATION),
        community: MsgId::from_bytes(COMMUNITY),
        bot_user: MsgId::from_bytes(BOT_USER),
        bot_device: MsgId::from_bytes(bot_device),
        participant_user: MsgId::from_bytes(PARTICIPANT_USER),
        participant_device: MsgId::from_bytes(participant_id),
        group: MsgId::from_bytes(GROUP),
        minimum_eligibility_revision: 1,
        server_now: now,
        policy_version: POLICY,
    };
    let signed = signed_context(
        &expected,
        &bot_snap,
        &participant_snap,
        &instance_key,
        now + 30,
    );
    let kp = build_key_package(
        &participant.provider,
        &participant.signer,
        CredentialWithKey {
            credential: BasicCredential::new(participant.identity.encode()).into(),
            signature_key: participant.signer.public().into(),
        },
        false,
    )
    .expect("participant KeyPackage");
    let kp_wire = MlsMessageOut::from(kp.key_package().clone())
        .tls_serialize_detached()
        .expect("serialize KeyPackage");

    let created = bot
        .bot_interaction_group_create(&[0x98; 16], &GROUP, &signed, &expected, &kp_wire)
        .expect("create real kind-3 group");
    bot.bot_group_registered(&[0x98; 16], &GROUP, 1)
        .expect("register managed group");
    let (group_id, binding_wire, _group_info, tree_wire, welcome_wire) =
        decode_strict(&created, |d| {
            d.array(5)?;
            Ok((
                d.bytes_exact::<16>()?,
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
            ))
        })
        .expect("managed group response");
    assert_eq!(group_id, GROUP);
    let welcome = match MlsMessageIn::tls_deserialize_exact(&welcome_wire)
        .expect("Welcome message")
        .extract()
    {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("expected Welcome"),
    };
    let tree = RatchetTreeIn::tls_deserialize_exact(tree_wire.as_slice()).expect("ratchet tree");
    let group_info = match MlsMessageIn::tls_deserialize_exact(&_group_info)
        .expect("GroupInfo message")
        .extract()
    {
        MlsMessageBodyIn::GroupInfo(info) => info,
        _ => panic!("expected GroupInfo"),
    };
    let tree_hash: [u8; 32] = group_info
        .group_context()
        .tree_hash()
        .try_into()
        .expect("tree hash length");
    let mut participant_group = DillaGroup::join_interaction_from_welcome_labelled(
        &participant.provider,
        welcome,
        tree,
        WelcomeLabel {
            group_id: &GROUP,
            epoch: 1,
            tree_hash: &tree_hash,
        },
    )
    .expect("join actual interaction Welcome");
    assert_eq!(
        participant_group.kind(),
        dilla_core::mls::GroupKind::Interaction
    );
    let binding = dilla_core::mls::DillaInteractionBinding::decode(&binding_wire)
        .expect("interaction binding");
    assert_eq!(binding.participant_device_id.as_bytes(), &participant_id);

    let envelope = Envelope {
        v: 1,
        msg_id: MsgId::from_bytes([0x61; 16]),
        kind: EnvelopeType::Message,
        thread_id: None,
        reply_to: None,
        body: "kind3 participant message".into(),
        attachments: Vec::new(),
        previews: Vec::new(),
        k_f: [0x06; 32],
    };
    let message = participant_group
        .create_message(&participant.provider, &participant.signer, &envelope)
        .expect("encrypt participant message")
        .tls_serialize_detached()
        .expect("serialize encrypted message");
    let source_seq = 1;
    let row = MsgRow {
        seq: source_seq,
        epoch: 1,
        uploader: participant_id,
        blob: Some(message),
        commitment: Some(envelope.commitment().expect("Dilla commitment")),
        franking_tag: [0x21; 32],
        recv_ts: now,
        deleted: false,
        class: None,
    };
    bot.bot_apply_interaction_group(&GROUP, &signed, &expected, &[0x80], &encode_message(&row), source_seq)
        .expect("accept participant sync row");
    let page = bot.bot_events_read(0, 10).expect("drain journal");
    assert_eq!(
        event_actor(&page),
        (
            "kind3 participant message".to_owned(),
            PARTICIPANT_USER,
            participant_id
        )
    );

    // Revoke the same authenticated participant device after another message is journaled. A
    // subsequent drain must re-check the latest signed device list and suppress the event.
    let second = Envelope {
        msg_id: MsgId::from_bytes([0x62; 16]),
        body: "revoked event".into(),
        ..envelope
    };
    let encrypted = participant_group
        .create_message(&participant.provider, &participant.signer, &second)
        .expect("encrypt second message")
        .tls_serialize_detached()
        .expect("serialize second message");
    let second_seq = 2;
    let second_row = MsgRow {
        seq: second_seq,
        epoch: 1,
        uploader: participant_id,
        blob: Some(encrypted),
        commitment: Some(second.commitment().expect("second Dilla commitment")),
        franking_tag: [0x22; 32],
        recv_ts: now + 1,
        deleted: false,
        class: None,
    };
    bot.bot_apply_interaction_group(&GROUP, &signed, &expected, &[0x80], &encode_message(&second_row), second_seq)
        .expect("accept second row");
    let mut revoked = participant.list.clone();
    revoked.unsigned.version = 2;
    revoked.unsigned.prev_hash = participant.list.hash();
    revoked.unsigned.entries[0].revoked_at = Some(now + 1);
    let ssk = SskSigner::from_bytes(&[0x52; 32]);
    revoked.sig_ssk = ssk.sign_device_list(&revoked.unsigned);
    bot_connection
        .lock()
        .expect("bot db")
        .execute(
            "UPDATE app_device_lists SET version=2,list=?2 WHERE user_id=?1",
            params![PARTICIPANT_USER.as_slice(), revoked.encode()],
        )
        .expect("install signed revocation");
    let remaining = decode_strict(
        &bot.bot_events_read(0, 10).expect("drain after revocation"),
        |d| {
            d.array(3)?;
            let count = d.array_len()?;
            d.uint()?;
            d.uint()?;
            Ok(count)
        },
    )
    .expect("empty event page");
    assert_eq!(
        remaining, 0,
        "revoked participant event is suppressed at drain time"
    );
}
