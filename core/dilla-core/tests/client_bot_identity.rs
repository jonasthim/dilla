#![cfg(not(target_arch = "wasm32"))]

use dilla_core::cbor::{Decoder, Encoder};
use dilla_core::client::ClientCore;
use dilla_core::identity::{CredentialIdentity, DeviceList};
use dilla_core::mls::ConnHandle;
use dilla_core::public_group::validate_key_package;
use openmls::prelude::*;
use openmls_rust_crypto::RustCrypto;
use std::sync::{Arc, Mutex};
use tls_codec::Deserialize as _;

const INSTANCE: [u8; 16] = [0x11; 16];
const COMMUNITY: [u8; 16] = [0x22; 16];
const INSTALLATION: [u8; 16] = [0x33; 16];
const USER: [u8; 16] = [0x44; 16];

#[test]
fn bot_binding_validation_requires_ready_native_identity_and_exact_store_binding() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    assert!(
        core.bot_validate_binding(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .is_err()
    );
    core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("pending");
    assert!(
        core.bot_validate_binding(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .is_err()
    );
    core.bot_bootstrap_complete(&USER, "native-bot", 1_800_000_000)
        .expect("ready");
    assert!(
        core.bot_validate_binding(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .is_ok()
    );
    assert_eq!(
        core.bot_validate_binding(&INSTANCE, &[0x55; 16], &INSTALLATION)
            .unwrap_err()
            .code,
        "E_CORE_STATE"
    );
    assert_eq!(
        core.bot_validate_binding(&INSTANCE, &COMMUNITY, &[0x66; 16])
            .unwrap_err()
            .code,
        "E_CORE_STATE"
    );

    let human_connection = conn();
    let mut human = ClientCore::open(human_connection).expect("open human core");
    human.signup_begin(&INSTANCE).expect("human signup");
    human
        .signup_complete(&[0x45; 16], "ordinary-user", 1_800_000_000)
        .expect("human enrollment");
    assert!(
        human
            .bot_validate_binding(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .is_err()
    );
}

fn conn() -> ConnHandle {
    Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ))
}

fn decode_final(body: &[u8]) -> (Vec<u8>, Vec<u8>) {
    dilla_core::cbor::decode_strict(body, |d| {
        d.array(2)?;
        Ok((d.bytes()?.to_vec(), d.bytes()?.to_vec()))
    })
    .expect("final bot material")
}

fn key_package_identity(bytes: &[u8]) -> CredentialIdentity {
    let input = match MlsMessageIn::tls_deserialize_exact(bytes)
        .expect("MLS message")
        .extract()
    {
        MlsMessageBodyIn::KeyPackage(kp) => kp,
        other => panic!("expected KeyPackage, got {other:?}"),
    };
    let kp = validate_key_package(&RustCrypto::default(), input).expect("validated key package");
    let basic =
        BasicCredential::try_from(kp.leaf_node().credential().clone()).expect("basic credential");
    CredentialIdentity::decode(basic.identity()).expect("bot credential in key package")
}

#[test]
fn bot_bootstrap_is_bound_idempotent_and_completes_as_native_bot() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    let first = core
        .bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("begin");
    let mut device_decoder = Decoder::new(&first);
    device_decoder.array(4).expect("bot registration");
    let umk: [u8; 32] = device_decoder.bytes_exact().expect("umk");
    let ssk: [u8; 32] = device_decoder.bytes_exact().expect("ssk");
    let sig: [u8; 64] = device_decoder.bytes_exact().expect("umk signature");
    device_decoder.array(5).expect("device");
    let device_id: [u8; 16] = device_decoder.bytes_exact().expect("device id");
    let dsk: [u8; 32] = device_decoder.bytes_exact().expect("device key");
    assert_eq!(device_decoder.uint().expect("tier"), 0);
    assert_eq!(device_decoder.uint().expect("signer tier"), 0);
    let placeholder = CredentialIdentity::decode(device_decoder.bytes().expect("credential"))
        .expect("placeholder credential");
    assert_eq!(placeholder.user_id.as_bytes(), &[0; 16]);
    assert_eq!(placeholder.umk_pub, umk);
    assert_eq!(placeholder.ssk_pub, ssk);
    assert_eq!(placeholder.sig_umk_ssk, sig);
    assert_eq!(placeholder.kind.as_u8(), 1);
    assert_eq!(placeholder.tier.as_u8(), 0);
    assert_eq!(placeholder.signer_tier.as_u8(), 0);
    placeholder
        .verify_signatures(&dsk)
        .expect("credential signatures");
    device_decoder.finish().expect("registration end");

    drop(core);
    let mut core = ClientCore::open(connection.clone()).expect("reopen pending");
    assert_eq!(
        core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .expect("repeat begin"),
        first
    );
    let final_body = core
        .bot_bootstrap_complete(&USER, "music-bot", 1_800_000_000)
        .expect("complete");
    let (credential, list_body) = decode_final(&final_body);
    let credential = CredentialIdentity::decode(&credential).expect("final credential");
    assert_eq!(credential.user_id.as_bytes(), &USER);
    assert_eq!(credential.kind.as_u8(), 1);
    assert_eq!(credential.tier.as_u8(), 0);
    assert_eq!(credential.signer_tier.as_u8(), 0);
    credential
        .verify_signatures(&dsk)
        .expect("final signatures");
    let list_blob = dilla_core::cbor::decode_strict(&list_body, |d| {
        d.array(4)?;
        let _version = d.uint()?;
        let blob = d.bytes()?.to_vec();
        let _signature: [u8; 64] = d.bytes_exact()?;
        let _prev_hash: [u8; 32] = d.bytes_exact()?;
        Ok(blob)
    })
    .expect("device list body");
    let list = DeviceList::decode(&list_blob).expect("device list");
    assert_eq!(list.unsigned.user_id.as_bytes(), &USER);
    assert_eq!(list.unsigned.entries.len(), 1);
    assert_eq!(list.unsigned.entries[0].device_id.as_bytes(), &device_id);
    assert_eq!(list.unsigned.entries[0].tier.as_u8(), 0);
    list.verify(&ssk).expect("device list signature");

    assert_eq!(
        core.bot_bootstrap_complete(&USER, "ignored-retry-name", 1_800_000_001)
            .expect("repeat complete"),
        final_body
    );
    let packages = core.key_packages(1, false).expect("bot key package");
    let package = dilla_core::cbor::decode_strict(&packages, |d| {
        d.array(2)?;
        d.array(1)?;
        let package = d.bytes()?.to_vec();
        assert!(d.opt_bytes()?.is_none());
        Ok(package)
    })
    .expect("one key package");
    let package_identity = key_package_identity(&package);
    assert_eq!(package_identity.user_id.as_bytes(), &USER);
    assert_eq!(package_identity.kind.as_u8(), 1);
    assert_eq!(package_identity.tier.as_u8(), 0);
    assert_eq!(package_identity.signer_tier.as_u8(), 0);
    drop(core);
    let mut core = ClientCore::open(connection).expect("reopen ready bot");
    assert!(!core.identity().expect("identity").is_empty());
    assert_eq!(
        core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .expect("ready begin is stable"),
        first
    );
    let after_reopen = core
        .key_packages(1, false)
        .expect("reopened bot key package");
    let package = dilla_core::cbor::decode_strict(&after_reopen, |d| {
        d.array(2)?;
        d.array(1)?;
        let package = d.bytes()?.to_vec();
        assert!(d.opt_bytes()?.is_none());
        Ok(package)
    })
    .expect("one key package after reopen");
    let package_identity = key_package_identity(&package);
    assert_eq!(package_identity.user_id.as_bytes(), &USER);
    assert_eq!(package_identity.kind.as_u8(), 1);
    assert_eq!(package_identity.tier.as_u8(), 0);
    assert_eq!(package_identity.signer_tier.as_u8(), 0);
}

#[test]
fn failed_bot_completion_rolls_back_and_other_account_cannot_adopt_identity() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("begin");
    {
        let guard = connection.lock().expect("connection lock");
        guard
            .execute_batch(
                "CREATE TRIGGER fail_bot_identity BEFORE INSERT ON app_meta \
             WHEN NEW.k = 'identity' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
            )
            .expect("trigger");
    }
    assert_eq!(
        core.bot_bootstrap_complete(&USER, "music-bot", 1)
            .expect_err("injected failure")
            .code,
        "E_CORE_STORAGE"
    );
    {
        let guard = connection.lock().expect("connection lock");
        let pending: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM app_meta WHERE k='bot_pending'",
                [],
                |r| r.get(0),
            )
            .expect("pending row");
        let identity: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM app_meta WHERE k='identity'",
                [],
                |r| r.get(0),
            )
            .expect("identity row");
        assert_eq!(pending, 1);
        assert_eq!(identity, 0);
        guard
            .execute_batch("DROP TRIGGER fail_bot_identity")
            .expect("drop trigger");
    }
    core.bot_bootstrap_complete(&USER, "music-bot", 1)
        .expect("completion after rollback");
    assert_eq!(
        core.bot_bootstrap_complete(&[0x55; 16], "other", 2)
            .expect_err("another user refused")
            .code,
        "E_CORE_STATE"
    );
}

#[test]
fn bot_bootstrap_rejects_zero_and_mismatched_binding_without_replacing_pending() {
    let mut core = ClientCore::open(conn()).expect("open");
    let err = core
        .bot_bootstrap_begin(&[0; 16], &COMMUNITY, &INSTALLATION)
        .expect_err("zero instance");
    assert_eq!(err.code, "E_CORE_INPUT");
    let first = core
        .bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("begin");
    assert_eq!(
        core.bot_bootstrap_begin(&INSTANCE, &[0x55; 16], &INSTALLATION)
            .expect_err("different community")
            .code,
        "E_CORE_STATE"
    );
    assert_eq!(
        core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &[0x66; 16])
            .expect_err("different installation")
            .code,
        "E_CORE_STATE"
    );
    assert_eq!(
        core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
            .expect("original pending remains"),
        first
    );
    assert_eq!(
        core.bot_bootstrap_complete(&[0; 16], "music-bot", 1)
            .expect_err("zero user")
            .code,
        "E_CORE_INPUT"
    );
    assert_eq!(
        core.bot_bootstrap_complete(&USER, "music-bot", 1)
            .expect("pending untouched"),
        core.bot_bootstrap_complete(&USER, "music-bot", 2)
            .expect("complete retry")
    );
}

#[test]
fn human_signup_cannot_adopt_bot_pending_material() {
    let mut core = ClientCore::open(conn()).expect("open");
    core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("bot pending");
    assert_eq!(
        core.signup_begin(&INSTANCE)
            .expect_err("human signup blocked")
            .code,
        "E_CORE_STATE"
    );
    assert_eq!(
        core.signup_complete(&USER, "human", 1)
            .expect_err("human cannot finish bot pending")
            .code,
        "E_CORE_STATE"
    );
    assert_eq!(
        core.enrol_begin(&INSTANCE)
            .expect_err("human recovery cannot adopt bot pending")
            .code,
        "E_CORE_STATE"
    );
    core.bot_bootstrap_complete(&USER, "music-bot", 1)
        .expect("bot pending remains intact");
}

#[test]
fn bot_completion_cannot_finish_a_human_signup() {
    let mut core = ClientCore::open(conn()).expect("open");
    core.signup_begin(&INSTANCE).expect("human signup");
    assert_eq!(
        core.bot_bootstrap_complete(&USER, "bot", 1)
            .expect_err("bot completion cannot adopt human pending keys")
            .code,
        "E_CORE_STATE"
    );
    assert!(
        core.signup_request("invite", "human", "Human", None)
            .is_ok()
    );
}

#[test]
fn opening_refuses_bot_pending_metadata_mixed_with_human_enrolment() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    let begin = core
        .bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("bot begin");
    let mut d = Decoder::new(&begin);
    d.array(4).expect("registration");
    d.bytes_exact::<32>().expect("umk");
    d.bytes_exact::<32>().expect("ssk");
    d.bytes_exact::<64>().expect("signature");
    d.array(5).expect("device");
    let device_id = d.bytes_exact::<16>().expect("device id");
    let dsk = d.bytes_exact::<32>().expect("dsk");
    d.uint().expect("tier");
    d.uint().expect("signer tier");
    d.bytes().expect("credential");
    d.finish().expect("registration end");
    drop(core);
    let mut enrol = Encoder::new();
    enrol
        .array(5)
        .uint(1)
        .bytes(&INSTANCE)
        .bytes(&device_id)
        .bytes(&dsk)
        .null();
    {
        let guard = connection.lock().expect("connection lock");
        guard
            .execute(
                "INSERT INTO app_meta(k,v) VALUES('enrol',?1)",
                [enrol.into_vec()],
            )
            .expect("mixed enrol metadata");
    }
    let error = match ClientCore::open(connection) {
        Ok(_) => panic!("mixed identity phases must refuse open"),
        Err(error) => error,
    };
    assert_eq!(error.code, "E_CORE_STATE");
}

#[test]
fn corrupted_pending_bot_signature_refuses_retry_and_reopen_without_mutating_state() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("bot begin");

    let original = {
        let guard = connection.lock().expect("connection lock");
        guard
            .query_row("SELECT v FROM app_meta WHERE k='bot_pending'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .expect("pending row")
    };
    let mut d = Decoder::new(&original);
    d.array(12).expect("pending record");
    assert_eq!(d.uint().expect("version"), 1);
    let instance = d.bytes_exact::<16>().expect("instance");
    let community = d.bytes_exact::<16>().expect("community");
    let installation = d.bytes_exact::<16>().expect("installation");
    let device_id = d.bytes_exact::<16>().expect("device id");
    let dsk = d.bytes_exact::<32>().expect("dsk");
    let umk = d.bytes_exact::<32>().expect("umk");
    let ssk = d.bytes_exact::<32>().expect("ssk");
    let umk_signature = d.bytes_exact::<64>().expect("umk signature");
    let mut device_signature = d.bytes_exact::<64>().expect("device signature");
    device_signature[0] ^= 1;
    let ssk_private = d.bytes_exact::<32>().expect("ssk private");
    let backup_key = d.bytes_exact::<32>().expect("backup key");
    d.finish().expect("pending record end");
    let mut e = Encoder::new();
    e.array(12)
        .uint(1)
        .bytes(&instance)
        .bytes(&community)
        .bytes(&installation)
        .bytes(&device_id)
        .bytes(&dsk)
        .bytes(&umk)
        .bytes(&ssk)
        .bytes(&umk_signature)
        .bytes(&device_signature)
        .bytes(&ssk_private)
        .bytes(&backup_key);
    let corrupted = e.into_vec();
    {
        let guard = connection.lock().expect("connection lock");
        guard
            .execute(
                "UPDATE app_meta SET v=?1 WHERE k='bot_pending'",
                [&corrupted],
            )
            .expect("corrupt pending signature");
    }

    let retry_error = match core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION) {
        Err(error) => error,
        Ok(body) => panic!("retry unexpectedly returned {} bytes", body.len()),
    };
    assert_eq!(retry_error.code, "E_CORE_STATE");
    let error = match ClientCore::open(connection.clone()) {
        Ok(_) => panic!("reopen rejects bad signature"),
        Err(error) => error,
    };
    assert_eq!(error.code, "E_CORE_STATE");
    let persisted = {
        let guard = connection.lock().expect("connection lock");
        guard
            .query_row("SELECT v FROM app_meta WHERE k='bot_pending'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .expect("pending row remains")
    };
    assert_eq!(persisted, corrupted);

    let mut d = Decoder::new(&original);
    d.array(12).expect("pending record");
    let mut e = Encoder::new();
    e.array(12).uint(d.uint().expect("version"));
    for _ in 0..9 {
        e.bytes(d.bytes().expect("public pending field"));
    }
    let mut bad_ssk_private = d.bytes_exact::<32>().expect("ssk private");
    bad_ssk_private[0] ^= 1;
    e.bytes(&bad_ssk_private)
        .bytes(d.bytes().expect("backup key"));
    d.finish().expect("pending record end");
    let corrupted_private_key = e.into_vec();
    {
        let guard = connection.lock().expect("connection lock");
        guard
            .execute(
                "UPDATE app_meta SET v=?1 WHERE k='bot_pending'",
                [&corrupted_private_key],
            )
            .expect("corrupt pending private key");
    }
    let error = match ClientCore::open(connection.clone()) {
        Ok(_) => panic!("reopen rejects mismatched SSK key pair"),
        Err(error) => error,
    };
    assert_eq!(error.code, "E_CORE_STATE");
    let persisted = {
        let guard = connection.lock().expect("connection lock");
        guard
            .query_row("SELECT v FROM app_meta WHERE k='bot_pending'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .expect("pending row remains")
    };
    assert_eq!(persisted, corrupted_private_key);
}

#[test]
fn reopening_rejects_ready_bot_umk_mismatch_without_mutating_state() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    core.bot_bootstrap_begin(&INSTANCE, &COMMUNITY, &INSTALLATION)
        .expect("bot begin");
    core.bot_bootstrap_complete(&USER, "music-bot", 1)
        .expect("bot complete");
    drop(core);

    let original = {
        let guard = connection.lock().expect("connection lock");
        guard
            .query_row("SELECT v FROM app_meta WHERE k='identity'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .expect("identity row")
    };
    let mut d = Decoder::new(&original);
    d.array(13).expect("ready identity");
    assert_eq!(d.uint().expect("version"), 2);
    let instance = d.bytes_exact::<16>().expect("instance");
    let user = d.bytes_exact::<16>().expect("user");
    let device = d.bytes_exact::<16>().expect("device");
    let dsk = d.bytes_exact::<32>().expect("dsk");
    let mut umk = d.bytes_exact::<32>().expect("umk");
    umk[0] ^= 1;
    let ssk = d.bytes_exact::<32>().expect("ssk");
    let username = d.text().expect("username").to_owned();
    let credential = d.bytes().expect("credential").to_vec();
    let list_body = d.bytes().expect("list body").to_vec();
    let list_published = d.uint().expect("published flag");
    let device_list = d.bytes().expect("device list").to_vec();
    let state_uploaded = d.uint().expect("uploaded flag");
    d.finish().expect("identity end");
    let mut e = Encoder::new();
    e.array(13)
        .uint(2)
        .bytes(&instance)
        .bytes(&user)
        .bytes(&device)
        .bytes(&dsk)
        .bytes(&umk)
        .bytes(&ssk)
        .text(&username)
        .bytes(&credential)
        .bytes(&list_body)
        .uint(list_published)
        .bytes(&device_list)
        .uint(state_uploaded);
    let corrupted = e.into_vec();
    {
        let guard = connection.lock().expect("connection lock");
        guard
            .execute("UPDATE app_meta SET v=?1 WHERE k='identity'", [&corrupted])
            .expect("corrupt outer UMK");
    }

    let error = match ClientCore::open(connection.clone()) {
        Ok(_) => panic!("reopen rejects mismatched ready UMK"),
        Err(error) => error,
    };
    assert_eq!(error.code, "E_CORE_STORAGE");
    let persisted = {
        let guard = connection.lock().expect("connection lock");
        guard
            .query_row("SELECT v FROM app_meta WHERE k='identity'", [], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .expect("identity row remains")
    };
    assert_eq!(persisted, corrupted);
}
