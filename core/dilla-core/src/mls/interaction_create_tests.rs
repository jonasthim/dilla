use super::*;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use std::sync::{Arc, Mutex};
use tls_codec::{Deserialize as _, Serialize as _};

fn provider() -> DillaProvider {
    let connection = rusqlite::Connection::open_in_memory().expect("sqlite");
    let provider = DillaProvider::new(Arc::new(Mutex::new(connection)));
    provider.storage().migrate().expect("storage schema");
    provider
}

fn credential(user: u8, device: u8, signer: &SignatureKeyPair) -> CredentialWithKey {
    use crate::identity::{CredentialIdentity, Kind, SignerTier, SskSigner, Tier, UmkSigner};
    use crate::ids::{DeviceId, UserId};

    let umk = UmkSigner::from_bytes(&[user; 32]);
    let ssk = SskSigner::from_bytes(&[user.wrapping_add(0x40); 32]);
    let device_id = DeviceId::from_bytes([device; 16]);
    let dsk_pub: [u8; 32] = signer.public().try_into().expect("signature key");
    let identity = CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes([user; 16]),
        device_id,
        kind: Kind::User,
        tier: Tier::Native,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
        sig_ssk_dev: ssk.sign_device(
            &device_id,
            &dsk_pub,
            Kind::User,
            Tier::Native,
            SignerTier::Native,
        ),
    };
    CredentialWithKey {
        credential: BasicCredential::new(identity.encode()).into(),
        signature_key: signer.public().into(),
    }
}

#[test]
fn rejected_transient_interaction_candidate_rolls_back_openmls_group_state() {
    let bot_provider = provider();
    let bot_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("Bot DSK");
    let participant_signer =
        SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("participant DSK");
    let bot_credential = credential(0x21, 0x22, &bot_signer);
    let participant_credential = credential(0x31, 0x32, &participant_signer);
    // The joiner's private KeyPackage state belongs to another device and is not part of the
    // creator's transaction; only the creator's provider state is expected to roll back here.
    let participant_provider = provider();
    let package = build_key_package(
        &participant_provider,
        &participant_signer,
        participant_credential,
        false,
    )
    .expect("participant KeyPackage");
    let binding = DillaInteractionBinding {
        instance_id: crate::ids::InstanceId::from_bytes([0x11; 16]),
        bot_user_id: [0x21; 16],
        installation_id: [0x33; 16],
        community_id: crate::ids::CommunityId::from_bytes([0x44; 16]),
        participant_user_id: [0x55; 16],
        participant_device_id: crate::ids::DeviceId::from_bytes([0x56; 16]),
        policy_version: 1,
        e2ee_version: 1,
        media_version: 0,
    };

    let rejected: Result<(), TxError<MlsError>> = bot_provider.storage().unit(|_| {
        let mut group = DillaGroup::create_interaction(
            &bot_provider,
            &bot_signer,
            bot_credential,
            GroupId::from_slice(&[0x61; 16]),
            binding,
        )?;
        group.add_members(&bot_provider, &bot_signer, &[package.key_package().clone()])?;
        group.merge_pending_commit(&bot_provider)?;
        assert_eq!(group.epoch(), 1);
        assert_eq!(group.members().len(), 2);

        // Model the signed-snapshot roster check rejecting this candidate after OpenMLS has
        // created, staged, and merged it. The enclosing unit must undo every provider write.
        Err(MlsError::OpenMls(
            "candidate roster did not match signed snapshot".into(),
        ))
    });
    assert!(matches!(rejected, Err(TxError::RolledBack(_))));
    let persisted: i64 = bot_provider
        .storage()
        .unit(|unit| {
            unit.with_conn(|connection| {
                let mut statement = connection.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'openmls_%'",
                )?;
                let tables = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                tables.into_iter().try_fold(0_i64, |total, table| {
                    let quoted = table.replace('"', "\"\"");
                    let count = connection.query_row(
                        &format!("SELECT count(*) FROM \"{quoted}\""),
                        [],
                        |row| row.get::<_, i64>(0),
                    )?;
                    Ok::<_, StorageError>(total + count)
                })
            })
        })
        .expect("read after rollback");
    assert_eq!(
        persisted, 0,
        "rejected candidate leaves no OpenMLS provider state"
    );
}

#[test]
fn labelled_interaction_welcome_joins_only_the_v2_group_at_the_served_epoch_and_hash() {
    let bot_provider = provider();
    let participant_provider = provider();
    let bot_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("Bot DSK");
    let participant_signer =
        SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("participant DSK");
    let bot_credential = credential(0x21, 0x22, &bot_signer);
    let participant_credential = credential(0x31, 0x32, &participant_signer);
    let package = build_key_package(
        &participant_provider,
        &participant_signer,
        participant_credential,
        false,
    )
    .expect("participant KeyPackage");
    let binding = DillaInteractionBinding {
        instance_id: crate::ids::InstanceId::from_bytes([0x11; 16]),
        bot_user_id: [0x21; 16],
        installation_id: [0x33; 16],
        community_id: crate::ids::CommunityId::from_bytes([0x44; 16]),
        participant_user_id: [0x31; 16],
        participant_device_id: crate::ids::DeviceId::from_bytes([0x32; 16]),
        policy_version: 1,
        e2ee_version: 1,
        media_version: 0,
    };
    let mut bot = DillaGroup::create_interaction(
        &bot_provider,
        &bot_signer,
        bot_credential,
        GroupId::from_slice(&[0x61; 16]),
        binding.clone(),
    )
    .expect("interaction group");
    let added = bot
        .add_members(&bot_provider, &bot_signer, &[package.key_package().clone()])
        .expect("add participant");
    let welcome = added.welcomes.into_iter().next().expect("Welcome").1;
    bot.merge_pending_commit(&bot_provider)
        .expect("merge add commit");
    let tree = bot.export_ratchet_tree();
    let tree_bytes = tree.tls_serialize_detached().expect("ratchet tree bytes");
    let welcome_bytes = welcome.tls_serialize_detached().expect("Welcome bytes");
    let wrong_hash = [0x99; 32];
    let wrong_input = MlsMessageIn::tls_deserialize_exact(&welcome_bytes).expect("Welcome message");
    let MlsMessageBodyIn::Welcome(welcome) = wrong_input.extract() else {
        panic!("expected Welcome");
    };
    let tree = RatchetTreeIn::tls_deserialize_exact(&tree_bytes).expect("ratchet tree");
    assert!(
        DillaGroup::join_interaction_from_welcome_labelled(
            &participant_provider,
            welcome,
            tree,
            WelcomeLabel {
                group_id: &[0x61; 16],
                epoch: bot.epoch(),
                tree_hash: &wrong_hash,
            },
        )
        .is_err()
    );

    let input = MlsMessageIn::tls_deserialize_exact(&welcome_bytes).expect("Welcome message");
    let MlsMessageBodyIn::Welcome(welcome) = input.extract() else {
        panic!("expected Welcome");
    };
    let tree_hash = bot
        .tree_hash(&bot_provider, &bot_signer)
        .expect("served tree hash");
    let joined = DillaGroup::join_interaction_from_welcome_labelled(
        &participant_provider,
        welcome,
        RatchetTreeIn::tls_deserialize_exact(&tree_bytes).expect("ratchet tree"),
        WelcomeLabel {
            group_id: &[0x61; 16],
            epoch: bot.epoch(),
            tree_hash: &tree_hash,
        },
    )
    .expect("join interaction Welcome");
    assert_eq!(joined.kind(), GroupKind::Interaction);
    assert_eq!(joined.interaction_binding().expect("v2 binding"), binding);
    assert_eq!(joined.epoch(), bot.epoch());
    assert_eq!(joined.member_count(), 2);
}
