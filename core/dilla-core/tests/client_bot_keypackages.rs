#![cfg(not(target_arch = "wasm32"))]

mod client_support;

use client_support::{
    CHANNEL, COMMUNITY, Core, GROUP, Instance, POLICY, Relay, expected_body, ingest_add_candidate,
    ready_core,
};
use dilla_core::bot::keypackage::{Intent, IntentResult, Resolution};
use dilla_core::client::ClientCore;
use dilla_core::ids::MsgId;
use dilla_core::mls::ConnHandle;
use dilla_core::public_group::validate_key_package;
use openmls::prelude::*;
use openmls_rust_crypto::RustCrypto;
use std::sync::{Arc, Mutex};
use tls_codec::Deserialize as _;

const INSTANCE_ID: [u8; 16] = [0x11; 16];
const INSTALLATION: [u8; 16] = [0x33; 16];
const USER: [u8; 16] = [0x84; 16];

#[test]
fn native_keypackage_intent_is_crypto_backed_durable_and_resolves_semantically() {
    let conn = conn();
    let mut bot = ready_bot(conn.clone());
    let encoded = intent(1, 1, 1, 0).encode().expect("intent");
    let first = bot
        .core
        .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &encoded)
        .expect("generate");
    let decoded = IntentResult::decode(&first).expect("typed result");
    assert_eq!(decoded.package_refs.len(), 2);
    assert_eq!(actual_refs(&decoded.upload_body), decoded.package_refs);

    drop(bot);
    let mut bot = reopen_bot(conn.clone());
    assert_eq!(
        bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &encoded)
            .expect("exact retry"),
        first,
        "pending retries return the exact original bytes after reopen"
    );
    assert_eq!(
        bot.core
            .bot_keypackage_intent(
                &INSTANCE_ID,
                &COMMUNITY,
                &INSTALLATION,
                &intent(1, 2, 0, 0).encode().expect("changed input"),
            )
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "reusing an operation id with changed intent fields is rejected"
    );
    assert_eq!(
        bot.core
            .bot_keypackage_intent(
                &INSTANCE_ID,
                &COMMUNITY,
                &INSTALLATION,
                &intent(2, 1, 0, 0).encode().expect("different op")
            )
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "one unresolved batch owns the identity scope"
    );
    assert_eq!(
        conn.lock()
            .expect("db")
            .query_row("SELECT count(*) FROM openmls_key_packages", [], |r| r
                .get::<_, i64>(0))
            .expect("no extra MLS packages generated on retry conflict"),
        2
    );

    let premature = resolution(1, decoded.package_refs.clone(), 1, 0, 0)
        .encode()
        .expect("resolution");
    assert_eq!(
        bot.core
            .bot_keypackage_resolve(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &premature)
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "obsolete needs generation or expiry evidence"
    );
    let mut reordered_refs = decoded.package_refs.clone();
    reordered_refs.reverse();
    if reordered_refs != decoded.package_refs {
        assert_eq!(
            bot.core
                .bot_keypackage_resolve(
                    &INSTANCE_ID,
                    &COMMUNITY,
                    &INSTALLATION,
                    &resolution(1, reordered_refs, 0, 0, 0)
                        .encode()
                        .expect("reordered refs")
                )
                .unwrap_err()
                .code,
            "E_CORE_STATE",
            "resolution refs must match the complete stored order"
        );
    }
    assert_eq!(
        bot.core
            .bot_keypackage_resolve(
                &INSTANCE_ID,
                &COMMUNITY,
                &INSTALLATION,
                &resolution(1, decoded.package_refs[..1].to_vec(), 0, 0, 0)
                    .encode()
                    .expect("incomplete refs"),
            )
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "resolution must name every stored package ref"
    );
    let accepted = resolution(1, decoded.package_refs.clone(), 0, 0, 0)
        .encode()
        .expect("accepted");
    bot.core
        .bot_keypackage_resolve(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &accepted)
        .expect("accepted receipt resolution");
    assert_eq!(
        bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &encoded)
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "resolved creation retries cannot mint replacement private keys"
    );
    bot.core
        .bot_keypackage_resolve(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &accepted)
        .expect("same semantic resolution repeats");
    bot.core
        .bot_keypackage_resolve(
            &INSTANCE_ID,
            &COMMUNITY,
            &INSTALLATION,
            &resolution(1, decoded.package_refs.clone(), 0, 123, 9)
                .encode()
                .expect("newer evidence for same accepted result"),
        )
        .expect("accepted retry ignores newer evidence values");
    assert_eq!(
        bot.core
            .bot_keypackage_resolve(
                &INSTANCE_ID,
                &COMMUNITY,
                &INSTALLATION,
                &resolution(1, decoded.package_refs.clone(), 1, 0, 0)
                    .encode()
                    .expect("opposite")
            )
            .unwrap_err()
            .code,
        "E_CORE_STATE"
    );

    let next = intent(2, 1, 0, 0).encode().expect("next intent");
    bot.core
        .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &next)
        .expect("new batch after resolution");
}

#[test]
fn obsolete_batch_keeps_private_keys_and_joins_a_late_welcome() {
    let (conn, path) = file_conn();
    let mut bot = ready_bot(conn.clone());
    let encoded = intent(3, 1, 1, 0).encode().expect("intent");
    let result = IntentResult::decode(
        &bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &encoded)
            .expect("generate"),
    )
    .expect("result");
    let package = first_package(&result.upload_body);
    let obsolete = resolution(3, result.package_refs.clone(), 1, result.greatest_expiry, 0)
        .encode()
        .expect("obsolete");
    bot.core
        .bot_keypackage_resolve(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &obsolete)
        .expect("expired batch resolves obsolete");

    // Close the SQLite file and Core before the server delivers the late Welcome.
    drop(bot);
    drop(conn);
    let conn = Arc::new(Mutex::new(
        rusqlite::Connection::open(&path).expect("reopen native journal file"),
    ));
    let mut bot = reopen_bot(conn.clone());
    bot.core
        .bot_keypackage_resolve(
            &INSTANCE_ID,
            &COMMUNITY,
            &INSTALLATION,
            &resolution(
                3,
                result.package_refs.clone(),
                1,
                result.greatest_expiry + 10,
                5,
            )
            .encode()
            .expect("newer obsolete evidence"),
        )
        .expect("obsolete retry ignores newer evidence values");

    let stored: i64 = conn
        .lock()
        .expect("db")
        .query_row("SELECT count(*) FROM openmls_key_packages", [], |r| {
            r.get(0)
        })
        .expect("stored private package count");
    assert_eq!(stored, 2, "resolution does not delete MLS private material");

    // A late Welcome can still arrive because obsolete records unknown historical acceptance.
    // Commit an actual Add using this package and prove OpenMLS consumes the retained private key.
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut inviter = ready_core(0xa1, "inviter");
    inviter.create_and_register(&mut relay, &instance);
    instance.propose_add(&mut relay, &package);
    inviter.sync(&relay);
    ingest_add_candidate(&mut inviter, &relay, &bot);
    inviter.commit(&mut relay);
    let first_welcome = relay.welcomes_body(bot.device);
    let joined = bot
        .core
        .bot_welcomes_apply(
            &first_welcome,
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
            0,
        )
        .expect("late Welcome uses retained private KeyPackage material");
    let outcomes = client_support::decode_outcomes(&joined);
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].outcome, 0, "late Welcome joined successfully");
    assert_eq!(outcomes[0].group_id, GROUP);
    assert_eq!(bot.group(&GROUP).expect("joined group").state, 2);
    client_support::ingest_core_list(&mut bot, &relay, &inviter);

    inviter.send(
        &mut relay,
        &GROUP,
        "late welcome recovered the private key",
        1_800_000_001,
    );
    bot.sync(&relay);
    let timeline = bot.timeline(&GROUP);
    assert!(
        timeline
            .iter()
            .any(|row| row.body == "late welcome recovered the private key"),
        "inviter message should decrypt after the late Welcome; rows: {timeline:?}"
    );

    // The Bot is offline for its removal, so its local row still says active.
    // A later server Add Welcome at a newer epoch must re-admit it on the same
    // binding without accepting the earlier Welcome as a replay.
    instance.propose_remove(&mut relay, bot.device);
    inviter.sync(&relay);
    inviter.commit(&mut relay);
    assert_eq!(bot.group(&GROUP).expect("offline local group").state, 2);
    let next = IntentResult::decode(
        &bot.core
            .bot_keypackage_intent(
                &INSTANCE_ID,
                &COMMUNITY,
                &INSTALLATION,
                &intent(4, 1, 0, 0).encode().expect("re-admission intent"),
            )
            .expect("re-admission package"),
    )
    .expect("re-admission result");
    instance.propose_add(&mut relay, &first_package(&next.upload_body));
    inviter.sync(&relay);
    ingest_add_candidate(&mut inviter, &relay, &bot);
    inviter.commit(&mut relay);
    let readmitted = bot
        .core
        .bot_welcomes_apply(
            &relay.welcomes_body(bot.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
            0,
        )
        .expect("newer Welcome re-admits offline Bot");
    assert_eq!(
        client_support::decode_outcomes(&readmitted)
            .last()
            .unwrap()
            .outcome,
        0
    );
    assert_eq!(bot.group(&GROUP).expect("re-admitted group").state, 2);
    let replay = bot
        .core
        .bot_welcomes_apply(
            &first_welcome,
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
            0,
        )
        .expect("old Welcome response");
    assert_eq!(client_support::decode_outcomes(&replay)[0].outcome, 2);

    drop(bot);
    drop(inviter);
    drop(conn);
    remove_db_files(&path);
}

#[test]
fn failed_journal_insert_or_resolution_rolls_back_its_whole_unit() {
    let conn = conn();
    let mut bot = ready_bot(conn.clone());
    conn.lock()
        .expect("db")
        .execute_batch(
            "CREATE TRIGGER fail_keypackage_intent BEFORE INSERT ON app_bot_keypackage_intents
         BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END;",
        )
        .expect("install insert failure");
    let encoded = intent(4, 2, 0, 0).encode().expect("intent");
    assert!(
        bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &encoded)
            .is_err()
    );
    let c = conn.lock().expect("db");
    assert_eq!(
        c.query_row("SELECT count(*) FROM app_bot_keypackage_intents", [], |r| r
            .get::<_, i64>(0))
            .expect("no intent"),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM openmls_key_packages", [], |r| r
            .get::<_, i64>(0))
            .expect("no private material"),
        0
    );
    drop(c);
    conn.lock()
        .expect("db")
        .execute_batch("DROP TRIGGER fail_keypackage_intent;")
        .expect("remove trigger");

    let result = IntentResult::decode(
        &bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &encoded)
            .expect("generate after rollback"),
    )
    .expect("result");
    let accepted = resolution(4, result.package_refs, 0, 0, 0)
        .encode()
        .expect("accepted");
    conn.lock()
        .expect("db")
        .execute_batch(
            "CREATE TRIGGER fail_keypackage_resolution BEFORE UPDATE ON app_bot_keypackage_intents
         BEGIN SELECT RAISE(ABORT, 'injected resolution failure'); END;",
        )
        .expect("install update failure");
    assert!(
        bot.core
            .bot_keypackage_resolve(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &accepted)
            .is_err()
    );
    let c = conn.lock().expect("db");
    let row: (i64, Option<Vec<u8>>, Option<Vec<u8>>) = c.query_row(
        "SELECT state,upload_body,resolution_hash FROM app_bot_keypackage_intents WHERE operation_id=?1",
        [[4; 16].as_slice()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).expect("pending intent remains");
    assert_eq!(row.0, 0);
    assert!(row.1.is_some());
    assert!(row.2.is_none());
    drop(c);
    conn.lock()
        .expect("db")
        .execute_batch("DROP TRIGGER fail_keypackage_resolution;")
        .expect("remove trigger");
    bot.core
        .bot_keypackage_resolve(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &accepted)
        .expect("resolve after rollback");
}

#[test]
fn generation_alone_proves_obsolete_and_wrong_identity_scopes_are_refused() {
    let pending_conn = conn();
    let mut pending = ClientCore::open(pending_conn).expect("pending core");
    pending
        .bot_bootstrap_begin(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &[0x77; 32])
        .expect("pending bot");
    let payload = intent(5, 1, 0, 4).encode().expect("intent");
    assert_eq!(
        pending
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &payload)
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "pending Bot identity is not enrolled"
    );

    let mut human = ready_core(0xa2, "human");
    assert_eq!(
        human
            .core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &payload)
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "human identity cannot create native Bot intents"
    );

    let mut bot = ready_bot(conn());
    assert_eq!(
        bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &[0x23; 16], &INSTALLATION, &payload)
            .unwrap_err()
            .code,
        "E_CORE_STATE",
        "the supplied community must equal the persisted Bot binding"
    );
    let result = IntentResult::decode(
        &bot.core
            .bot_keypackage_intent(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &payload)
            .expect("generation"),
    )
    .expect("result");
    bot.core
        .bot_keypackage_resolve(
            &INSTANCE_ID,
            &COMMUNITY,
            &INSTALLATION,
            &resolution(5, result.package_refs, 1, 0, 5)
                .encode()
                .expect("generation obsolete"),
        )
        .expect("a strictly newer authenticated generation proves obsolete");
}

fn actual_refs(body: &[u8]) -> Vec<[u8; 32]> {
    let packages = dilla_core::cbor::decode_strict(body, |d| {
        d.array(2)?;
        let n = d.array_len()?;
        let mut packages = Vec::with_capacity(n + 1);
        for _ in 0..n {
            packages.push(d.bytes()?.to_vec());
        }
        if let Some(last) = d.opt_bytes()? {
            packages.push(last.to_vec());
        }
        Ok(packages)
    })
    .expect("upload body");
    let crypto = RustCrypto::default();
    packages
        .into_iter()
        .map(|bytes| {
            let input = match MlsMessageIn::tls_deserialize_exact(&bytes)
                .expect("MLS message")
                .extract()
            {
                MlsMessageBodyIn::KeyPackage(kp) => kp,
                other => panic!("expected KeyPackage, got {other:?}"),
            };
            let kp = validate_key_package(&crypto, input).expect("validated package");
            kp.hash_ref(&crypto)
                .expect("MLS hash reference")
                .as_slice()
                .try_into()
                .expect("32-byte MLS reference")
        })
        .collect()
}

fn first_package(body: &[u8]) -> Vec<u8> {
    dilla_core::cbor::decode_strict(body, |d| {
        d.array(2)?;
        d.array(1)?;
        let package = d.bytes()?.to_vec();
        d.opt_bytes()?;
        Ok(package)
    })
    .expect("first package")
}

fn intent(operation: u8, count: u64, fallback: u64, generation: u64) -> Intent {
    Intent {
        operation_id: MsgId::from_bytes([operation; 16]),
        count,
        last_resort: fallback,
        expected_generation: generation,
    }
}

fn resolution(
    operation: u8,
    refs: Vec<[u8; 32]>,
    outcome: u64,
    now: u64,
    current_generation: u64,
) -> Resolution {
    Resolution {
        operation_id: MsgId::from_bytes([operation; 16]),
        package_refs: refs,
        outcome,
        now,
        current_generation,
    }
}

fn ready_bot(conn: ConnHandle) -> Core {
    let probe = Arc::clone(&conn);
    let mut core = ClientCore::open(conn).expect("open");
    core.bot_bootstrap_begin(&INSTANCE_ID, &COMMUNITY, &INSTALLATION, &[0x77; 32])
        .expect("bootstrap");
    core.bot_bootstrap_complete(&USER, "native-bot", 1_800_000_000)
        .expect("complete");
    core_from_identity(core, probe)
}

fn reopen_bot(conn: ConnHandle) -> Core {
    let probe = Arc::clone(&conn);
    let core = ClientCore::open(conn).expect("reopen");
    core_from_identity(core, probe)
}

fn core_from_identity(core: ClientCore, probe: ConnHandle) -> Core {
    let (user, device) =
        dilla_core::cbor::decode_strict(&core.identity().expect("identity"), |d| {
            d.array(6)?;
            d.uint()?;
            d.opt_bytes_exact::<16>()?;
            let user = d.opt_bytes_exact::<16>()?;
            let device = d.opt_bytes_exact::<16>()?;
            d.text()?;
            d.uint()?;
            Ok((user, device))
        })
        .expect("identity shape");
    Core {
        core,
        probe,
        user: user.expect("ready user"),
        device: device.expect("ready device"),
    }
}

fn conn() -> ConnHandle {
    Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ))
}

fn file_conn() -> (ConnHandle, std::path::PathBuf) {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "dilla-bot-keypackage-{}-{nonce}.db",
        std::process::id()
    ));
    let connection = rusqlite::Connection::open(&path).expect("sqlite file");
    (Arc::new(Mutex::new(connection)), path)
}

fn remove_db_files(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}
