// Native only: every test opens a real SQLite connection through rusqlite.
#![cfg(not(target_arch = "wasm32"))]

//! web-1 task 4: `DillaStorage::unit` with savepoint nesting, the app schema v1, and the identity
//! surface of `dilla_core::client::ClientCore`: browser-rooted signup, the sealed root and state
//! objects, the session signature, the session record and KeyPackages.
//!
//! `TxError`, `StorageError` and `MlsError` are `#[non_exhaustive]` (`tx.rs:13`, `mod.rs:60`,
//! `group.rs:26`); every `match` on them in this file has a wildcard arm (`matches!` has its own).

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use dilla_core::ProtocolError;
use dilla_core::cbor::{Encoder, decode_strict};
use dilla_core::client::{ClientCore, ClientError, HANDSHAKE_TAIL, migrate_app, session_preimage};
use dilla_core::identity::{
    CredentialIdentity, DeviceList, Kind, SignerTier, SskSigner, Tier, UmkSigner, k_backup,
    k_header, recovery_key_from_base32,
};
use dilla_core::ids::{DeviceId, InstanceId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, ConnHandle, DillaBinding, DillaGroup, DillaProvider, DillaStorage, GroupKind,
    MlsError, StorageError, TxError, UnitScope,
};
use dilla_core::public_group::validate_key_package;
use ed25519_dalek::{Signature, VerifyingKey};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use rusqlite::OptionalExtension;
use std::sync::{Arc, Mutex};

const INSTANCE: [u8; 16] = [0x11; 16];
const USER: [u8; 16] = [0x42; 16];
const GROUP: [u8; 16] = [0x77; 16];
const NOW: u64 = 1_790_000_000;
const IDENTITY_JSON: &str = include_str!("../../../protocol/vectors/identity.json");

// ---------------------------------------------------------------------------------------------
// fixtures

fn conn() -> ConnHandle {
    Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ))
}

/// A core over a fresh in-memory database. The second value is another `Arc` on the same
/// connection; the tests read through it only while no core call is running.
fn core() -> (ClientCore, ConnHandle) {
    let c = conn();
    let core = ClientCore::open(c.clone()).expect("open");
    (core, c)
}

fn err<T>(r: Result<T, ClientError>) -> ClientError {
    match r {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

fn meta(c: &ConnHandle, k: &str) -> Option<Vec<u8>> {
    let guard = c.lock().expect("lock");
    guard
        .query_row("SELECT v FROM app_meta WHERE k = ?1", [k], |r| {
            r.get::<_, Vec<u8>>(0)
        })
        .optional()
        .expect("app_meta read")
}

fn meta_rows(c: &ConnHandle) -> Vec<(String, Vec<u8>)> {
    let guard = c.lock().expect("lock");
    let mut stmt = guard.prepare("SELECT k, v FROM app_meta").expect("prepare");
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// Every BLOB and TEXT cell of every table, with its table name.
fn cells(c: &ConnHandle) -> Vec<(String, Vec<u8>)> {
    let guard = c.lock().expect("lock");
    let tables: Vec<String> = guard
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .expect("prepare")
        .query_map([], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("names");
    let mut out = Vec::new();
    for table in tables {
        let mut stmt = guard
            .prepare(&format!("SELECT * FROM \"{table}\""))
            .expect("prepare");
        let n = stmt.column_count();
        let mut rows = stmt.query([]).expect("query");
        while let Some(row) = rows.next().expect("row") {
            for i in 0..n {
                match row.get_ref(i).expect("cell") {
                    rusqlite::types::ValueRef::Blob(b) | rusqlite::types::ValueRef::Text(b) => {
                        out.push((table.clone(), b.to_vec()));
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

struct Info {
    phase: u64,
    instance: Option<[u8; 16]>,
    user: Option<[u8; 16]>,
    device: Option<[u8; 16]>,
    username: String,
    published: u64,
}

fn info(core: &ClientCore) -> Info {
    let bytes = core.identity().expect("identity");
    decode_strict(&bytes, |d| {
        d.array(6)?;
        Ok(Info {
            phase: d.uint()?,
            instance: d.opt_bytes_exact::<16>()?,
            user: d.opt_bytes_exact::<16>()?,
            device: d.opt_bytes_exact::<16>()?,
            username: d.text()?.to_owned(),
            published: d.uint()?,
        })
    })
    .expect("[phase, instance|null, user|null, device|null, username, published]")
}

struct Registration {
    invite: String,
    username: String,
    display: String,
    umk_pub: [u8; 32],
    ssk_pub: [u8; 32],
    sig_umk_ssk: [u8; 64],
    password: Option<String>,
    device_id: [u8; 16],
    dsk_pub: [u8; 32],
    tier: u64,
    signer_tier: u64,
    credential: Vec<u8>,
}

fn registration(body: &[u8]) -> Registration {
    decode_strict(body, |d| {
        d.array(8)?;
        let invite = d.text()?.to_owned();
        let username = d.text()?.to_owned();
        let display = d.text()?.to_owned();
        let umk_pub = d.bytes_exact::<32>()?;
        let ssk_pub = d.bytes_exact::<32>()?;
        let sig_umk_ssk = d.bytes_exact::<64>()?;
        let password = if d.try_null()? {
            None
        } else {
            Some(d.text()?.to_owned())
        };
        d.array(5)?;
        let device_id = d.bytes_exact::<16>()?;
        let dsk_pub = d.bytes_exact::<32>()?;
        let tier = d.uint()?;
        let signer_tier = d.uint()?;
        let credential = d.bytes()?.to_vec();
        Ok(Registration {
            invite,
            username,
            display,
            umk_pub,
            ssk_pub,
            sig_umk_ssk,
            password,
            device_id,
            dsk_pub,
            tier,
            signer_tier,
            credential,
        })
    })
    .expect("POST /v1/accounts body")
}

/// `signup_begin` then one `signup_request`: (core, connection, RK bytes, the registration).
fn begun() -> (ClientCore, ConnHandle, [u8; 32], Registration) {
    let (mut core, c) = core();
    let rk_text = core.signup_begin(&INSTANCE).expect("signup_begin");
    let rk = recovery_key_from_base32(&rk_text).expect("52 Crockford characters");
    let reg = registration(
        &core
            .signup_request("INV-1", "alice", "Alice", None)
            .expect("signup_request"),
    );
    (core, c, rk, reg)
}

/// The three elements of a stored object `[v, nonce, ciphertext]`.
fn stored_parts(stored: &[u8]) -> (u64, [u8; 12], Vec<u8>) {
    decode_strict(stored, |d| {
        d.array(3)?;
        Ok((d.uint()?, d.bytes_exact::<12>()?, d.bytes()?.to_vec()))
    })
    .expect("[1, nonce, ciphertext]")
}

fn open_sealed(key: &[u8; 32], aad: &[u8], stored: &[u8]) -> Vec<u8> {
    let (v, nonce, ct) = stored_parts(stored);
    assert_eq!(v, 1);
    Aes256Gcm::new_from_slice(key)
        .expect("key")
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .expect("the stored object opens")
}

/// (UMK_priv, SSK_priv) from the root object.
fn root_keys(root: &[u8], rk: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let plain = open_sealed(&k_header(rk), b"dilla root v1", root);
    decode_strict(&plain, |d| {
        d.array(3)?;
        assert_eq!(d.uint()?, 1);
        Ok((d.bytes_exact::<32>()?, d.bytes_exact::<32>()?))
    })
    .expect("[1, umk_priv, ssk_priv]")
}

/// (instance_id, device_id, dsk_pub, ssk_priv, k_backup) from the `signup` record.
#[allow(clippy::type_complexity)] // The fixture keeps the five wire fields visible at call sites.
fn signup_record(bytes: &[u8]) -> ([u8; 16], [u8; 16], [u8; 32], [u8; 32], [u8; 32]) {
    decode_strict(bytes, |d| {
        d.array(10)?;
        assert_eq!(d.uint()?, 1);
        let instance = d.bytes_exact::<16>()?;
        let device = d.bytes_exact::<16>()?;
        let dsk = d.bytes_exact::<32>()?;
        d.bytes_exact::<32>()?;
        d.bytes_exact::<32>()?;
        d.bytes_exact::<64>()?;
        d.bytes_exact::<64>()?;
        let ssk = d.bytes_exact::<32>()?;
        let kb = d.bytes_exact::<32>()?;
        Ok((instance, device, dsk, ssk, kb))
    })
    .expect("the ten-element signup record")
}

fn sealed(root: Option<&[u8]>, state: Option<&[u8]>) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).opt_bytes(root).opt_bytes(state);
    e.into_vec()
}

fn session_of(core: &ClientCore) -> Option<(String, u64, u64)> {
    let bytes = core.session().expect("session");
    decode_strict(&bytes, |d| {
        if d.try_null()? {
            return Ok(None);
        }
        d.array(3)?;
        Ok(Some((d.text()?.to_owned(), d.uint()?, d.uint()?)))
    })
    .expect("null | [token, expires, idle_expires]")
}

fn scratch(c: &ConnHandle) {
    c.lock()
        .expect("lock")
        .execute_batch("CREATE TABLE scratch (n INTEGER NOT NULL)")
        .expect("scratch table");
}

fn scratch_rows(c: &ConnHandle) -> i64 {
    c.lock()
        .expect("lock")
        .query_row("SELECT count(*) FROM scratch", [], |r| r.get(0))
        .expect("count")
}

fn insert_scratch(u: &UnitScope<'_>, n: i64) -> Result<(), StorageError> {
    u.with_conn(|conn| {
        conn.execute("INSERT INTO scratch (n) VALUES (?1)", [n])?;
        Ok(())
    })
}

fn mls_fixture(p: &DillaProvider) -> (SignatureKeyPair, CredentialWithKey) {
    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    signer.store(p.storage()).expect("store signer");
    let umk = UmkSigner::from_bytes(&[0x0a; 32]);
    let ssk = SskSigner::from_bytes(&[0x4a; 32]);
    let identity = CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes([0x0a; 16]),
        device_id: DeviceId::from_bytes([0x01; 16]),
        kind: Kind::User,
        tier: Tier::Native,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
        sig_ssk_dev: [0u8; 64],
    };
    let credential = CredentialWithKey {
        credential: BasicCredential::new(identity.encode()).into(),
        signature_key: signer.public().into(),
    };
    (signer, credential)
}

fn text_binding() -> DillaBinding {
    DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes(INSTANCE),
        community_id: None,
        target_id: [0x33; 16],
        kind: GroupKind::Text,
        policy_version: 1,
        e2ee_version: 1,
        media_version: GroupKind::Text.media_version(),
    }
}

fn validated(bytes: &[u8]) -> KeyPackage {
    use tls_codec::Deserialize as _;
    let kp_in = match MlsMessageIn::tls_deserialize_exact(bytes)
        .expect("an MLSMessage")
        .extract()
    {
        MlsMessageBodyIn::KeyPackage(kp) => kp,
        other => panic!("expected a KeyPackage message, got {other:?}"),
    };
    validate_key_package(&openmls_rust_crypto::RustCrypto::default(), kp_in)
        .expect("the instance's validation accepts it")
}

// ---------------------------------------------------------------------------------------------
// DillaStorage::unit (L-CORE-03)

#[test]
fn a_unit_rollback_undoes_the_mls_write_made_inside_it() {
    let c = conn();
    scratch(&c);
    let p = DillaProvider::new(c.clone());
    p.storage().migrate().expect("migrate");
    let (signer, credential) = mls_fixture(&p);
    let out: Result<(), TxError<StorageError>> = p.storage().unit(|u: &UnitScope<'_>| {
        let group = DillaGroup::create(
            &p,
            &signer,
            credential.clone(),
            GroupId::from_slice(&GROUP),
            text_binding(),
            None,
        )
        .map_err(|e| StorageError::Codec(format!("create inside the unit: {e}")))?;
        assert_eq!(group.epoch(), 0);
        insert_scratch(u, 1)?;
        Err(StorageError::Codec("deliberate".into()))
    });
    assert!(
        matches!(out, Err(TxError::RolledBack(StorageError::Codec(ref m))) if m == "deliberate"),
        "{out:?}"
    );
    assert!(
        DillaGroup::load(&p, &GroupId::from_slice(&GROUP))
            .expect("load")
            .is_none(),
        "the group written inside the unit must be gone"
    );
    assert_eq!(scratch_rows(&c), 0);
}

#[test]
fn a_committed_unit_keeps_the_mls_write_and_the_app_row() {
    let c = conn();
    scratch(&c);
    let p = DillaProvider::new(c.clone());
    p.storage().migrate().expect("migrate");
    let (signer, credential) = mls_fixture(&p);
    let out: Result<u8, TxError<StorageError>> = p.storage().unit(|u| {
        DillaGroup::create(
            &p,
            &signer,
            credential.clone(),
            GroupId::from_slice(&GROUP),
            text_binding(),
            None,
        )
        .map_err(|e| StorageError::Codec(format!("create inside the unit: {e}")))?;
        insert_scratch(u, 1)?;
        Ok(7)
    });
    assert_eq!(out.expect("the unit commits"), 7);
    let group = DillaGroup::load(&p, &GroupId::from_slice(&GROUP))
        .expect("load")
        .expect("the group survives the commit");
    assert_eq!(group.epoch(), 0);
    assert_eq!(scratch_rows(&c), 1);
}

#[test]
fn a_failed_nested_transaction_rolls_back_to_its_savepoint_and_the_unit_goes_on() {
    let c = conn();
    scratch(&c);
    let s = DillaStorage::new(c.clone());
    s.migrate().expect("migrate");
    let doomed = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let out: Result<(), TxError<StorageError>> = s.unit(|u| {
        insert_scratch(u, 1)?;
        let inner: Result<(), TxError<StorageError>> = s.transaction(|| {
            doomed.store(&s)?;
            Err(StorageError::Codec("inner".into()))
        });
        assert!(
            matches!(inner, Err(TxError::RolledBack(StorageError::Codec(ref m))) if m == "inner"),
            "{inner:?}"
        );
        insert_scratch(u, 2)?;
        Ok(())
    });
    out.expect("the unit commits after the inner rollback");
    assert_eq!(scratch_rows(&c), 2);
    assert!(
        SignatureKeyPair::read(&s, doomed.public(), CIPHERSUITE.signature_algorithm()).is_none(),
        "the write of the failed savepoint must be gone"
    );
}

#[test]
fn units_and_transactions_nest_exactly_one_level() {
    let s = DillaStorage::new(conn());
    s.migrate().expect("migrate");
    let out: Result<(), TxError<StorageError>> = s.unit(|u| {
        let second: Result<(), TxError<StorageError>> = s.unit(|_| Ok(()));
        assert!(matches!(second, Err(TxError::AlreadyOpen)), "{second:?}");
        let nested: Result<(), TxError<StorageError>> = s.transaction(|| {
            let third: Result<(), TxError<StorageError>> = s.transaction(|| Ok(()));
            assert!(matches!(third, Err(TxError::AlreadyOpen)), "{third:?}");
            Ok(())
        });
        nested.expect("one transaction nests in a unit");
        let inside: Result<Result<(), StorageError>, TxError<StorageError>> =
            s.transaction(|| Ok(u.with_conn(|_| Ok(()))));
        assert!(
            matches!(
                inside,
                Ok(Err(StorageError::Sqlite(ref m)))
                    if m == "the unit connection is not usable inside a nested transaction"
            ),
            "{inside:?}"
        );
        Ok(())
    });
    out.expect("unit");
    let plain: Result<u8, TxError<StorageError>> = s.transaction(|| Ok(5));
    assert_eq!(plain.expect("a plain transaction after the unit"), 5);
    let again: Result<u8, TxError<StorageError>> = s.unit(|_| Ok(6));
    assert_eq!(again.expect("a second unit after the first closed"), 6);
}

#[test]
fn another_thread_cannot_enter_an_open_unit() {
    let s = DillaStorage::new(conn());
    s.migrate().expect("migrate");
    let out: Result<(), TxError<StorageError>> = s.unit(|_| {
        std::thread::scope(|scope| {
            let t = scope.spawn(|| {
                let r: Result<(), TxError<StorageError>> = s.transaction(|| Ok(()));
                r
            });
            assert!(matches!(t.join().expect("join"), Err(TxError::AlreadyOpen)));
            let t = scope.spawn(|| {
                let r: Result<(), TxError<StorageError>> = s.unit(|_| Ok(()));
                r
            });
            assert!(matches!(t.join().expect("join"), Err(TxError::AlreadyOpen)));
        });
        Ok(())
    });
    out.expect("unit");
}

#[test]
fn a_panic_inside_a_unit_rolls_back_and_the_storage_takes_units_again() {
    let c = conn();
    scratch(&c);
    let s = DillaStorage::new(c.clone());
    s.migrate().expect("migrate");
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), TxError<StorageError>> = s.unit(|u| {
            insert_scratch(u, 1)?;
            let _: Result<(), TxError<StorageError>> =
                s.transaction(|| panic!("exploded inside the savepoint"));
            Ok(())
        });
    }));
    assert!(unwound.is_err(), "the panic must reach the caller");
    assert_eq!(scratch_rows(&c), 0);
    let again: Result<u8, TxError<StorageError>> = s.unit(|u| {
        insert_scratch(u, 2)?;
        Ok(9)
    });
    assert_eq!(again.expect("usable after the unwind"), 9);
    assert_eq!(scratch_rows(&c), 1);
    let plain: Result<u8, TxError<StorageError>> = s.transaction(|| Ok(1));
    assert_eq!(plain.expect("plain transaction after the unwind"), 1);
}

// ---------------------------------------------------------------------------------------------
// ClientError (L-CORE-02)

#[test]
fn client_errors_render_and_convert_as_the_code_table_says() {
    let bare = ClientError {
        code: "E_CORE_INPUT",
        detail: String::new(),
    };
    assert_eq!(bare.to_string(), "E_CORE_INPUT");
    let with = ClientError {
        code: "E_CORE_STATE",
        detail: "a signup is pending".into(),
    };
    assert_eq!(with.to_string(), "E_CORE_STATE: a signup is pending");
    assert_eq!(
        ClientError::from(ProtocolError::Credential),
        ClientError {
            code: "E_CREDENTIAL",
            detail: String::new()
        }
    );
    assert_eq!(
        ClientError::from(MlsError::Protocol(ProtocolError::EnvelopeLimit)),
        ClientError {
            code: "E_ENVELOPE_LIMIT",
            detail: String::new()
        }
    );
    assert_eq!(
        ClientError::from(MlsError::OpenMls("boom".into())),
        ClientError {
            code: "E_CORE_MLS",
            detail: "boom".into()
        }
    );
    assert_eq!(
        ClientError::from(MlsError::NeedsReload),
        ClientError {
            code: "E_CORE_RELOAD",
            detail: String::new()
        }
    );
    assert_eq!(
        ClientError::from(MlsError::NotFound),
        ClientError {
            code: "E_CORE_NOT_FOUND",
            detail: String::new()
        }
    );
    assert_eq!(
        ClientError::from(MlsError::Tx("x".into())),
        ClientError {
            code: "E_CORE_STORAGE",
            detail: "x".into()
        }
    );
    assert_eq!(
        ClientError::from(MlsError::Storage(StorageError::Poisoned)),
        ClientError {
            code: "E_CORE_STORAGE",
            detail: "lock poisoned".into()
        }
    );
    assert_eq!(
        ClientError::from(StorageError::Sqlite("disk".into())),
        ClientError {
            code: "E_CORE_STORAGE",
            detail: "sqlite: disk".into()
        }
    );
    assert_eq!(
        ClientError::from(TxError::<ClientError>::AlreadyOpen),
        ClientError {
            code: "E_CORE_STORAGE",
            detail: "a transaction is already open on this storage".into()
        }
    );
    assert_eq!(ClientError::from(TxError::RolledBack(with.clone())), with);
}

// ---------------------------------------------------------------------------------------------
// app schema v2 (L-SQL-20) and ClientCore::open (L-CORE-05)

#[test]
fn open_creates_app_schema_v2_and_reopens_idempotently() {
    let c = conn();
    drop(ClientCore::open(c.clone()).expect("first open"));
    drop(ClientCore::open(c.clone()).expect("second open over the same database"));
    assert_eq!(
        migrate_app(&DillaStorage::new(c.clone())).expect("migrate_app is idempotent on its own"),
        2
    );
    let guard = c.lock().expect("lock");
    let names: Vec<String> = guard
        .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') \
             AND name LIKE 'app%' ORDER BY name",
        )
        .expect("prepare")
        .query_map([], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("names");
    assert_eq!(
        names,
        [
            "app_groups",
            "app_groups_by_target",
            "app_handshake_tail",
            "app_messages",
            "app_messages_by_msg",
            "app_meta",
            "app_outbox",
            "app_outbox_by_group",
            "app_proposals",
            "app_read_state",
            "app_settings",
        ]
    );
    let schema: Vec<u8> = guard
        .query_row("SELECT v FROM app_meta WHERE k = 'schema'", [], |r| {
            r.get(0)
        })
        .expect("schema row");
    assert_eq!(schema, [0x02]);
    let resync: i64 = guard
        .query_row(
            "SELECT count(*) FROM pragma_table_info('app_groups') WHERE name = 'resync'",
            [],
            |r| r.get(0),
        )
        .expect("pragma_table_info app_groups");
    assert_eq!(resync, 1, "app_groups.resync exists (task 5 reads it)");
    let epoch: i64 = guard
        .query_row(
            "SELECT count(*) FROM pragma_table_info('app_outbox') WHERE name = 'epoch'",
            [],
            |r| r.get(0),
        )
        .expect("pragma_table_info app_outbox");
    assert_eq!(epoch, 1, "app_outbox.epoch exists (task 5 reads it)");
    for (table, column) in [
        ("app_groups", "epoch"),
        ("app_groups", "pending_commit"),
        ("app_messages", "mention"),
    ] {
        let n: i64 = guard
            .query_row(
                "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column],
                |r| r.get(0),
            )
            .expect("pragma_table_info");
        assert_eq!(n, 1, "{table}.{column} exists at schema 2");
    }
    let secure: i64 = guard
        .query_row("PRAGMA secure_delete", [], |r| r.get(0))
        .expect("pragma");
    assert_eq!(secure, 1, "open turns secure_delete on");
    assert_eq!(HANDSHAKE_TAIL, 64);
}

#[test]
fn app_schema_checks_lengths_and_keeps_one_live_group_per_target() {
    let (_core, c) = core();
    let g = c.lock().expect("lock");
    assert!(
        g.execute(
            "INSERT INTO app_groups (group_id, kind, target_id, state) VALUES (zeroblob(15), 0, zeroblob(16), 2)",
            [],
        )
        .is_err(),
        "a 15-byte group id is refused"
    );
    g.execute(
        "INSERT INTO app_groups (group_id, kind, target_id, state) VALUES (x'01010101010101010101010101010101', 0, zeroblob(16), 2)",
        [],
    )
    .expect("a 16-byte group id");
    assert!(
        g.execute(
            "INSERT INTO app_groups (group_id, kind, target_id, state) VALUES (x'02020202020202020202020202020202', 0, zeroblob(16), 2)",
            [],
        )
        .is_err(),
        "two live groups for one (target, kind) are refused"
    );
    g.execute(
        "INSERT INTO app_groups (group_id, kind, target_id, state) VALUES (x'03030303030303030303030303030303', 0, zeroblob(16), 4)",
        [],
    )
    .expect("a gone group does not count against the target");
    let defaults: (i64, i64, i64, i64) = g
        .query_row(
            "SELECT next_seq, acked_seq, acked_epoch, resync FROM app_groups WHERE group_id = x'01010101010101010101010101010101'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("row");
    assert_eq!(defaults, (1, 0, 0, 0));
    assert!(
        g.execute(
            "UPDATE app_groups SET resync = 2 WHERE group_id = x'01010101010101010101010101010101'",
            [],
        )
        .is_err(),
        "resync is 0 or 1"
    );
    assert!(
        g.execute(
            "INSERT INTO app_groups (group_id, kind, community_id, target_id, state) VALUES (x'04040404040404040404040404040404', 0, zeroblob(15), x'05050505050505050505050505050505', 2)",
            [],
        )
        .is_err(),
        "a 15-byte community id is refused"
    );
    assert!(
        g.execute(
            "INSERT INTO app_outbox (msg_id, group_id, envelope, created, state) VALUES (zeroblob(17), zeroblob(16), x'00', 1, 0)",
            [],
        )
        .is_err(),
        "a 17-byte msg id is refused"
    );
    g.execute(
        "INSERT INTO app_outbox (msg_id, group_id, envelope, created, state) VALUES (zeroblob(16), zeroblob(16), x'00', 1, 0)",
        [],
    )
    .expect("a 16-byte msg id");
    let outbox: (String, i64) = g
        .query_row(
            "SELECT error, epoch FROM app_outbox WHERE msg_id = zeroblob(16)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("outbox row");
    assert_eq!(outbox, (String::new(), 0));
}

#[test]
fn open_refuses_an_app_schema_newer_than_this_build() {
    let c = conn();
    c.lock()
        .expect("lock")
        .execute_batch(
            "CREATE TABLE app_meta (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
             INSERT INTO app_meta (k, v) VALUES ('schema', x'03');",
        )
        .expect("seed");
    let e = match ClientCore::open(c) {
        Ok(_) => panic!("a newer schema must be refused"),
        Err(e) => e,
    };
    assert_eq!(
        e,
        ClientError {
            code: "E_CORE_STATE",
            detail: "app schema 3 is newer than this build".into()
        }
    );
}

// ---------------------------------------------------------------------------------------------
// identity and signup (L-CORE-06)

#[test]
fn a_fresh_store_is_phase_0_and_refuses_every_identity_bound_call() {
    let (mut core, _c) = core();
    let i = info(&core);
    assert_eq!(
        (
            i.phase,
            i.instance,
            i.user,
            i.device,
            i.username.as_str(),
            i.published
        ),
        (0, None, None, None, "", 0)
    );
    assert_eq!(
        err(core.signup_request("i", "u", "d", None)),
        ClientError {
            code: "E_CORE_STATE",
            detail: "no signup is pending".into()
        }
    );
    assert_eq!(
        err(core.signup_complete(&USER, "alice", NOW)).code,
        "E_CORE_STATE"
    );
    assert_eq!(err(core.signup_reset()).code, "E_CORE_STATE");
    assert_eq!(
        err(core.device_list_body()),
        ClientError {
            code: "E_CORE_NO_IDENTITY",
            detail: String::new()
        }
    );
    assert_eq!(err(core.device_list_published()).code, "E_CORE_NO_IDENTITY");
    assert_eq!(err(core.key_packages(1, false)).code, "E_CORE_NO_IDENTITY");
    assert_eq!(
        err(core.session_sign(&[0xab; 32], 0)).code,
        "E_CORE_NO_IDENTITY"
    );
    assert_eq!(
        err(core.session_store("t", 1, 1)).code,
        "E_CORE_NO_IDENTITY"
    );
    assert_eq!(core.session().expect("session"), [0xf6]);
    core.session_clear().expect("a no-op without a record");
    assert_eq!(
        core.sealed_objects().expect("sealed_objects"),
        [0x82, 0xf6, 0xf6]
    );
    core.unload();
    assert_eq!(info(&core).phase, 0);
}

#[test]
fn signup_begin_seals_the_root_object_under_the_returned_recovery_key() {
    let (mut core, c) = core();
    let rk_text = core.signup_begin(&INSTANCE).expect("signup_begin");
    assert_eq!(rk_text.len(), 52);
    assert!(
        rk_text
            .bytes()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b)),
        "{rk_text}"
    );
    let rk = recovery_key_from_base32(&rk_text).expect("decodes");
    let i = info(&core);
    assert_eq!(
        (
            i.phase,
            i.instance,
            i.user,
            i.username.as_str(),
            i.published
        ),
        (1, Some(INSTANCE), None, "", 0)
    );
    let root = meta(&c, "root_sealed").expect("root_sealed written");
    assert_eq!(root.len(), 103);
    let (umk, ssk) = root_keys(&root, &rk);
    let reg = registration(
        &core
            .signup_request("CODE", "alice", "Alice", None)
            .expect("request"),
    );
    assert_eq!(UmkSigner::from_bytes(&umk).public(), reg.umk_pub);
    assert_eq!(SskSigner::from_bytes(&ssk).public(), reg.ssk_pub);
    assert_eq!(i.device, Some(reg.device_id));
    let (_, nonce, ct) = stored_parts(&root);
    assert!(
        Aes256Gcm::new_from_slice(&k_header(&rk))
            .expect("key")
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: b"dilla state v1"
                }
            )
            .is_err(),
        "the root object is bound to its own aad"
    );
    assert!(
        Aes256Gcm::new_from_slice(&k_backup(&rk))
            .expect("key")
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: b"dilla root v1"
                }
            )
            .is_err(),
        "the root object is sealed under K_header, not K_backup"
    );
    let (instance, device, dsk, ssk_rec, kb_rec) =
        signup_record(&meta(&c, "signup").expect("signup record"));
    assert_eq!(
        (instance, device, dsk),
        (INSTANCE, reg.device_id, reg.dsk_pub)
    );
    assert_eq!(ssk_rec, ssk);
    assert_eq!(kb_rec, k_backup(&rk));
    assert!(meta(&c, "identity").is_none());
    assert!(meta(&c, "state_sealed").is_none());
    assert_eq!(
        core.sealed_objects().expect("sealed"),
        sealed(Some(&root), None)
    );
    assert_eq!(
        err(core.signup_begin(&INSTANCE)),
        ClientError {
            code: "E_CORE_STATE",
            detail: "a signup is pending".into()
        }
    );
}

#[test]
fn signup_request_is_the_registration_body_with_a_zero_user_id_credential() {
    let (mut core, c) = core();
    core.signup_begin(&INSTANCE).expect("begin");
    let a = registration(
        &core
            .signup_request("ABCD-EFGH", "alice", "Alice A.", Some("correct horse"))
            .expect("request"),
    );
    assert_eq!(
        (
            a.invite.as_str(),
            a.username.as_str(),
            a.display.as_str(),
            a.password.as_deref()
        ),
        ("ABCD-EFGH", "alice", "Alice A.", Some("correct horse"))
    );
    assert_eq!((a.tier, a.signer_tier), (1, 1));
    let (_, device, dsk, _, _) = signup_record(&meta(&c, "signup").expect("signup"));
    assert_eq!((a.device_id, a.dsk_pub), (device, dsk));
    let cred = CredentialIdentity::decode(&a.credential).expect("the ten-element credential");
    assert_eq!(cred.v, 1);
    assert_eq!(cred.user_id, UserId::from_bytes([0; 16]));
    assert_eq!(cred.device_id, DeviceId::from_bytes(a.device_id));
    assert_eq!(
        (cred.kind, cred.tier, cred.signer_tier),
        (Kind::User, Tier::Browser, SignerTier::Browser)
    );
    assert_eq!(
        (cred.umk_pub, cred.ssk_pub, cred.sig_umk_ssk),
        (a.umk_pub, a.ssk_pub, a.sig_umk_ssk)
    );
    cred.verify_signatures(&a.dsk_pub)
        .expect("both credential signatures verify against the DSK");
    let b = registration(
        &core
            .signup_request("", "bob", "Bob", None)
            .expect("request"),
    );
    assert_eq!(
        (b.invite.as_str(), b.username.as_str(), b.password),
        ("", "bob", None)
    );
    assert_eq!(
        (b.umk_pub, b.ssk_pub, b.device_id, b.dsk_pub, b.credential),
        (a.umk_pub, a.ssk_pub, a.device_id, a.dsk_pub, a.credential),
        "signup_request is pure: the keys do not change between calls"
    );
}

#[test]
fn signup_complete_signs_device_list_v1_and_seals_the_state_object() {
    let (mut core, c, rk, reg) = begun();
    assert_eq!(
        err(core.signup_complete(&[0u8; 16], "alice", NOW)),
        ClientError {
            code: "E_CORE_INPUT",
            detail: "user_id is all zero".into()
        }
    );
    let body = core
        .signup_complete(&USER, "alice", NOW)
        .expect("signup_complete");
    let (version, blob, sig, prev) = decode_strict(&body, |d| {
        d.array(4)?;
        Ok((
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes_exact::<64>()?,
            d.bytes_exact::<32>()?,
        ))
    })
    .expect("[version, blob, ssk_signature, prev_hash]");
    assert_eq!((version, prev), (1, [0u8; 32]));
    let list = DeviceList::decode(&blob).expect("the six-element signed list");
    assert_eq!(list.sig_ssk, sig);
    assert_eq!(list.unsigned.user_id, UserId::from_bytes(USER));
    assert_eq!(list.unsigned.version, 1);
    assert_eq!(list.unsigned.entries.len(), 1);
    let e = &list.unsigned.entries[0];
    assert_eq!(
        (e.device_id, e.dsk_pub, e.tier, e.added_at, e.revoked_at),
        (
            DeviceId::from_bytes(reg.device_id),
            reg.dsk_pub,
            Tier::Browser,
            NOW,
            None
        )
    );
    list.accept(None, &reg.ssk_pub)
        .expect("list v1 verifies under the SSK");
    let i = info(&core);
    assert_eq!(
        (
            i.phase,
            i.instance,
            i.user,
            i.device,
            i.username.as_str(),
            i.published
        ),
        (
            2,
            Some(INSTANCE),
            Some(USER),
            Some(reg.device_id),
            "alice",
            0
        )
    );
    assert!(
        meta(&c, "signup").is_none(),
        "the pending signup record is gone"
    );
    let state = meta(&c, "state_sealed").expect("state object");
    let plain = open_sealed(&k_backup(&rk), b"dilla state v1", &state);
    let (v, inner, pins) = decode_strict(&plain, |d| {
        d.array(3)?;
        Ok((d.uint()?, d.bytes()?.to_vec(), d.array_len()?))
    })
    .expect("[1, device_list, pins]");
    assert_eq!((v, inner, pins), (1, blob.clone(), 0));
    let record = meta(&c, "identity").expect("identity record");
    let (v, cred_bytes, list, uploaded) = decode_strict(&record, |d| {
        d.array(13)?;
        let v = d.uint()?;
        for _ in 0..7 {
            d.skip()?;
        }
        let cred = d.bytes()?.to_vec();
        d.skip()?;
        d.skip()?;
        Ok((v, cred, d.bytes()?.to_vec(), d.uint()?))
    })
    .expect("the thirteen-element identity record");
    assert_eq!((v, uploaded), (2, 0));
    assert_eq!(list, blob, "device_list is list v1 from signup on");
    let cred = CredentialIdentity::decode(&cred_bytes).expect("credential");
    let placeholder = CredentialIdentity::decode(&reg.credential).expect("placeholder");
    assert_eq!(cred.user_id, UserId::from_bytes(USER));
    assert_eq!(
        CredentialIdentity {
            user_id: placeholder.user_id,
            ..cred.clone()
        },
        placeholder,
        "only user_id changed"
    );
    cred.verify_signatures(&reg.dsk_pub)
        .expect("still verifies");
    assert_eq!(core.device_list_body().expect("phase 2"), body);
    let root = meta(&c, "root_sealed").expect("root kept");
    assert_eq!(
        core.sealed_objects().expect("sealed"),
        sealed(Some(&root), Some(&state))
    );
    core.device_list_published().expect("mark published");
    core.device_list_published().expect("idempotent");
    assert_eq!(info(&core).published, 1);
    assert_eq!(
        err(core.signup_complete(&USER, "alice", NOW)),
        ClientError {
            code: "E_CORE_STATE",
            detail: "the identity is complete".into()
        }
    );
    assert_eq!(
        err(core.signup_request("i", "u", "d", None)).code,
        "E_CORE_STATE"
    );
    assert_eq!(err(core.signup_reset()).code, "E_CORE_STATE");
    assert_eq!(
        err(core.signup_begin(&INSTANCE)),
        ClientError {
            code: "E_CORE_STATE",
            detail: "an identity exists".into()
        }
    );
}

#[test]
fn no_private_key_rests_outside_the_signup_record() {
    let (mut core, c, rk, _reg) = begun();
    let (umk, ssk) = root_keys(&meta(&c, "root_sealed").expect("root"), &rk);
    let kh = k_header(&rk);
    let kb = k_backup(&rk);
    for (table, cell) in cells(&c) {
        assert!(!contains(&cell, &umk), "UMK_priv found in {table}");
        assert!(!contains(&cell, &rk), "the recovery key found in {table}");
        assert!(!contains(&cell, &kh), "K_header found in {table}");
    }
    for (k, v) in meta_rows(&c) {
        if k != "signup" {
            assert!(!contains(&v, &ssk), "SSK_priv found in app_meta {k}");
            assert!(!contains(&v, &kb), "K_backup found in app_meta {k}");
        }
    }
    let ssk_cells = cells(&c)
        .iter()
        .filter(|(_, cell)| contains(cell, &ssk))
        .count();
    assert_eq!(
        ssk_cells, 1,
        "SSK_priv rests in exactly one cell: the signup record"
    );
    core.signup_complete(&USER, "alice", NOW).expect("complete");
    for (table, cell) in cells(&c) {
        for (name, secret) in [
            ("UMK_priv", &umk[..]),
            ("SSK_priv", &ssk[..]),
            ("the recovery key", &rk[..]),
            ("K_header", &kh[..]),
            ("K_backup", &kb[..]),
        ] {
            assert!(
                !contains(&cell, secret),
                "{name} found in {table} after signup_complete"
            );
        }
    }
}

#[test]
fn the_deleted_signup_record_leaves_no_ssk_in_the_database_file() {
    let dir = std::env::temp_dir().join(format!("dilla-client-identity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let path = dir.join("secure-delete.sqlite");
    let _ = std::fs::remove_file(&path);
    let c: ConnHandle = Arc::new(Mutex::new(
        rusqlite::Connection::open(&path).expect("open file"),
    ));
    let mut core = ClientCore::open(c.clone()).expect("open");
    let rk = recovery_key_from_base32(&core.signup_begin(&INSTANCE).expect("begin")).expect("rk");
    let (_, ssk) = root_keys(&meta(&c, "root_sealed").expect("root"), &rk);
    let kb = k_backup(&rk);
    let before = std::fs::read(&path).expect("read db");
    assert!(
        contains(&before, &ssk),
        "the scan sees the pending record in the file"
    );
    assert!(contains(&before, &kb), "the scan sees K_backup in the file");
    core.signup_complete(&USER, "alice", NOW).expect("complete");
    drop(core);
    drop(c);
    let after = std::fs::read(&path).expect("read db");
    assert!(
        !contains(&after, &ssk),
        "SSK_priv left in the database file"
    );
    assert!(!contains(&after, &kb), "K_backup left in the database file");
    std::fs::remove_file(&path).expect("cleanup");
}

#[test]
fn signup_reset_forgets_the_pending_identity_and_its_device_key() {
    let (mut core, c, _rk, reg) = begun();
    core.signup_reset().expect("reset");
    let i = info(&core);
    assert_eq!((i.phase, i.instance, i.device), (0, None, None));
    for k in ["signup", "root_sealed"] {
        assert!(meta(&c, k).is_none(), "{k} survives the reset");
    }
    let keys: i64 = c
        .lock()
        .expect("lock")
        .query_row("SELECT count(*) FROM openmls_signature_keys", [], |r| {
            r.get(0)
        })
        .expect("count");
    assert_eq!(keys, 0, "the DSK is deleted");
    assert_eq!(
        err(core.session_sign(&[1; 32], 0)).code,
        "E_CORE_NO_IDENTITY"
    );
    core.signup_begin(&INSTANCE)
        .expect("a new signup may start");
    let again = registration(&core.signup_request("i", "u", "d", None).expect("request"));
    assert_ne!(again.device_id, reg.device_id);
    assert_ne!(again.dsk_pub, reg.dsk_pub);
}

#[test]
fn signup_reset_refuses_while_a_session_is_stored() {
    let (mut core, c) = core();
    core.signup_begin(&INSTANCE).expect("signup_begin");
    core.session_store("tok", 10, 10)
        .expect("session_store in phase 1");
    assert_eq!(
        err(core.signup_reset()),
        ClientError {
            code: "E_CORE_STATE",
            detail: "the account is registered".into()
        }
    );
    assert_eq!(
        info(&core).phase,
        1,
        "the pending signup survives the refused reset"
    );
    let pending: i64 = c
        .lock()
        .expect("lock")
        .query_row(
            "SELECT count(*) FROM app_meta WHERE k IN ('signup','root_sealed')",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(pending, 2, "signup and root_sealed are still stored");
    assert_eq!(
        session_of(&core),
        Some(("tok".to_owned(), 10, 10)),
        "the session record is untouched"
    );
    core.session_sign(&[7u8; 32], 0)
        .expect("the DSK is still stored and loaded");
    let keys: i64 = c
        .lock()
        .expect("lock")
        .query_row("SELECT count(*) FROM openmls_signature_keys", [], |r| {
            r.get(0)
        })
        .expect("count");
    assert_eq!(keys, 1, "the DSK row is still stored");
    core.session_clear().expect("session_clear");
    core.signup_reset()
        .expect("reset once no session is stored");
    assert_eq!(info(&core).phase, 0);
}

#[test]
fn reopening_keeps_the_phase_and_reloads_the_device_key() {
    let c = conn();
    let mut core = ClientCore::open(c.clone()).expect("open");
    core.signup_begin(&INSTANCE).expect("begin");
    let reg = registration(
        &core
            .signup_request("i", "alice", "A", None)
            .expect("request"),
    );
    drop(core);
    let mut core = ClientCore::open(c.clone()).expect("reopen in phase 1");
    assert_eq!(info(&core).phase, 1);
    let body = core
        .session_sign(&[7; 32], 0)
        .expect("the DSK was reloaded");
    let sig = decode_strict(&body, |d| {
        d.array(5)?;
        d.skip()?;
        d.skip()?;
        let s = d.bytes_exact::<64>()?;
        d.skip()?;
        d.skip()?;
        Ok(s)
    })
    .expect("session body");
    VerifyingKey::from_bytes(&reg.dsk_pub)
        .expect("key")
        .verify_strict(
            &session_preimage(&INSTANCE, &reg.device_id, &[7; 32], 0),
            &Signature::from_bytes(&sig),
        )
        .expect("signed with the stored DSK");
    core.signup_complete(&USER, "alice", NOW).expect("complete");
    drop(core);
    let mut core = ClientCore::open(c).expect("reopen in phase 2");
    let i = info(&core);
    assert_eq!(
        (i.phase, i.user, i.username.as_str()),
        (2, Some(USER), "alice")
    );
    core.key_packages(1, false).expect("phase 2 after reopen");
}

#[test]
fn open_refuses_a_store_whose_device_key_is_gone() {
    let c = conn();
    let mut core = ClientCore::open(c.clone()).expect("open");
    core.signup_begin(&INSTANCE).expect("begin");
    drop(core);
    c.lock()
        .expect("lock")
        .execute("DELETE FROM openmls_signature_keys", [])
        .expect("delete");
    let e = match ClientCore::open(c) {
        Ok(_) => panic!("a store without its DSK must be refused"),
        Err(e) => e,
    };
    assert_eq!(
        e,
        ClientError {
            code: "E_CORE_STATE",
            detail: "the device key is missing from the store".into()
        }
    );
}

// ---------------------------------------------------------------------------------------------
// session signature and record

#[test]
fn the_session_preimage_reproduces_the_vector() {
    let doc: serde_json::Value = serde_json::from_str(IDENTITY_JSON).expect("identity.json");
    let v = &doc["session_preimage"];
    let field = |k: &str| hex::decode(v[k].as_str().expect("hex string")).expect("hex");
    let instance: [u8; 16] = field("instance_id").try_into().expect("16 bytes");
    let device: [u8; 16] = field("device_id").try_into().expect("16 bytes");
    let nonce: [u8; 32] = field("nonce").try_into().expect("32 bytes");
    let purpose = u8::try_from(v["purpose"].as_u64().expect("purpose")).expect("one byte");
    let pre = session_preimage(&instance, &device, &nonce, purpose);
    assert_eq!(pre.len(), 81);
    assert_eq!(pre, field("preimage"));
}

#[test]
fn session_sign_signs_the_81_byte_preimage_with_the_device_key() {
    let (mut core, _c, _rk, reg) = begun();
    let nonce = [0xab; 32];
    let key = VerifyingKey::from_bytes(&reg.dsk_pub).expect("dsk_pub");
    for purpose in [0u8, 1] {
        let body = core
            .session_sign(&nonce, purpose)
            .expect("phase 1 may sign");
        let (n, p, sig) = decode_strict(&body, |d| {
            d.array(5)?;
            let n = d.bytes_exact::<32>()?;
            let p = d.uint()?;
            let sig = d.bytes_exact::<64>()?;
            d.null()?;
            d.null()?;
            Ok((n, p, sig))
        })
        .expect("[nonce, purpose, sig, null, null]");
        assert_eq!((n, p), (nonce, u64::from(purpose)));
        key.verify_strict(
            &session_preimage(&INSTANCE, &reg.device_id, &nonce, purpose),
            &Signature::from_bytes(&sig),
        )
        .expect("the signature covers the preimage with its purpose byte");
        let other = 1 - purpose;
        assert!(
            key.verify_strict(
                &session_preimage(&INSTANCE, &reg.device_id, &nonce, other),
                &Signature::from_bytes(&sig),
            )
            .is_err(),
            "a purpose-{purpose} signature must not pass as purpose {other}"
        );
    }
    assert_eq!(
        err(core.session_sign(&nonce, 2)),
        ClientError {
            code: "E_CORE_INPUT",
            detail: "purpose must be 0 or 1".into()
        }
    );
    core.signup_complete(&USER, "alice", NOW).expect("complete");
    core.session_sign(&nonce, 0).expect("phase 2 signs too");
}

#[test]
fn the_session_record_is_stored_replaced_and_cleared() {
    let (mut core, c, _rk, _reg) = begun();
    assert_eq!(
        err(core.session_store("", 1, 1)),
        ClientError {
            code: "E_CORE_INPUT",
            detail: "token must be 1..=256 bytes".into()
        }
    );
    assert_eq!(
        err(core.session_store(&"t".repeat(257), 1, 1)).code,
        "E_CORE_INPUT"
    );
    core.session_store("tok-1", 1_790_604_800, 1_790_043_200)
        .expect("store");
    assert_eq!(
        session_of(&core),
        Some(("tok-1".to_owned(), 1_790_604_800, 1_790_043_200))
    );
    core.session_store("tok-2", 20, 10).expect("replace");
    assert_eq!(session_of(&core), Some(("tok-2".to_owned(), 20, 10)));
    core.session_clear().expect("clear");
    assert_eq!(session_of(&core), None);
    assert!(meta(&c, "session").is_none());
}

// ---------------------------------------------------------------------------------------------
// KeyPackages

#[test]
fn key_packages_are_mls_messages_the_instance_validates() {
    let (mut core, _c, _rk, reg) = begun();
    assert_eq!(err(core.key_packages(1, false)).code, "E_CORE_NO_IDENTITY");
    core.signup_complete(&USER, "alice", NOW).expect("complete");
    for bad in [0u32, 33] {
        assert_eq!(
            err(core.key_packages(bad, false)),
            ClientError {
                code: "E_CORE_INPUT",
                detail: "count must be 1..=32".into()
            }
        );
    }
    let body = core.key_packages(3, true).expect("key_packages");
    let (packages, last) = decode_strict(&body, |d| {
        d.array(2)?;
        let n = d.array_len()?;
        let mut packages = Vec::new();
        for _ in 0..n {
            packages.push(d.bytes()?.to_vec());
        }
        let last = d.opt_bytes()?.map(<[u8]>::to_vec);
        Ok((packages, last))
    })
    .expect("[packages, last_resort]");
    assert_eq!(packages.len(), 3);
    let last = last.expect("a last-resort package was asked for");
    for (bytes, last_resort) in packages
        .iter()
        .map(|p| (p.as_slice(), false))
        .chain([(last.as_slice(), true)])
    {
        let kp = validated(bytes);
        assert_eq!(kp.last_resort(), last_resort);
        let basic = BasicCredential::try_from(kp.leaf_node().credential().clone())
            .expect("basic credential");
        let cred = CredentialIdentity::decode(basic.identity()).expect("credential identity");
        assert_eq!(
            (cred.user_id, cred.device_id, cred.tier),
            (
                UserId::from_bytes(USER),
                DeviceId::from_bytes(reg.device_id),
                Tier::Browser
            )
        );
        assert_eq!(kp.leaf_node().signature_key().as_slice(), &reg.dsk_pub[..]);
    }
    let body = core.key_packages(32, false).expect("32 packages");
    let (n, last_is_null) = decode_strict(&body, |d| {
        d.array(2)?;
        let n = d.array_len()?;
        for _ in 0..n {
            d.bytes()?;
        }
        Ok((n, d.try_null()?))
    })
    .expect("[packages, null]");
    assert_eq!((n, last_is_null), (32, true));
}

/// A store holding only an `enrol` record (L-CORE-22), written by hand as task 3's enrol_begin
/// will write it, with its DSK in OpenMLS's signature-key table.
fn enrolling(user: Option<[u8; 16]>) -> (ClientCore, ConnHandle, [u8; 16], [u8; 32]) {
    let c = conn();
    drop(ClientCore::open(c.clone()).expect("open"));
    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    signer
        .store(DillaProvider::new(c.clone()).storage())
        .expect("store the DSK");
    let dsk_pub: [u8; 32] = signer.public().try_into().expect("32 bytes");
    let device = [0x5d; 16];
    let mut e = Encoder::new();
    e.array(5)
        .uint(1)
        .bytes(&INSTANCE)
        .bytes(&device)
        .bytes(&dsk_pub);
    match user {
        Some(u) => {
            e.bytes(&u);
        }
        None => {
            e.null();
        }
    }
    c.lock()
        .expect("lock")
        .execute(
            "INSERT INTO app_meta (k, v) VALUES ('enrol', ?1)",
            [e.into_vec()],
        )
        .expect("enrol record");
    let core = ClientCore::open(c.clone()).expect("open in phase 3");
    (core, c, device, dsk_pub)
}

/// session_sign's phase-3 answer is not asserted here: task 1's forced arm is phase 0's refusal and
/// task 3 replaces it with the enrol record's ids (head L-CORE-22's split), asserting it there.
#[test]
fn an_enrol_record_is_phase_3_stores_sessions_and_refuses_the_identity_calls() {
    let (mut core, _c, device, _dsk_pub) = enrolling(None);
    let i = info(&core);
    assert_eq!(
        (
            i.phase,
            i.instance,
            i.user,
            i.device,
            i.username.as_str(),
            i.published
        ),
        (3, Some(INSTANCE), None, Some(device), "", 0)
    );
    core.session_store("pending-token", NOW + 60, NOW + 30)
        .expect("phase 3 stores a session");
    assert_eq!(
        session_of(&core),
        Some(("pending-token".into(), NOW + 60, NOW + 30))
    );
    assert_eq!(
        err(core.signup_begin(&INSTANCE)),
        ClientError {
            code: "E_CORE_STATE",
            detail: "an enrolment is pending".into(),
        }
    );
    let no_signup = ClientError {
        code: "E_CORE_STATE",
        detail: "no signup is pending".into(),
    };
    assert_eq!(err(core.signup_request("i", "u", "d", None)), no_signup);
    assert_eq!(err(core.signup_complete(&USER, "alice", NOW)), no_signup);
    assert_eq!(err(core.signup_reset()), no_signup);
    for code in [
        err(core.device_list_body()).code,
        err(core.device_list_published()).code,
        err(core.key_packages(1, false)).code,
        err(core.send_prepare(&GROUP, "x", NOW)).code,
    ] {
        assert_eq!(code, "E_CORE_NO_IDENTITY");
    }
    assert_eq!(
        core.sealed_objects().expect("every phase"),
        sealed(None, None)
    );
    core.session_clear().expect("every phase");

    let (core, _c, _, _) = enrolling(Some(USER));
    assert_eq!(info(&core).user, Some(USER), "the recorded user is shown");
}

#[test]
fn an_enrol_record_beside_another_phase_or_without_its_key_is_refused() {
    let beside = ClientError {
        code: "E_CORE_STATE",
        detail: "enrol record beside another phase".into(),
    };
    let enrol = |device: u8| {
        let mut e = Encoder::new();
        e.array(5)
            .uint(1)
            .bytes(&INSTANCE)
            .bytes(&[device; 16])
            .bytes(&[0x09; 32])
            .null();
        e.into_vec()
    };
    // Beside a pending signup.
    let (core, c, _rk, _reg) = begun();
    drop(core);
    c.lock()
        .expect("lock")
        .execute(
            "INSERT INTO app_meta (k, v) VALUES ('enrol', ?1)",
            [enrol(1)],
        )
        .expect("seed");
    assert_eq!(err(ClientCore::open(c.clone())), beside);
    // Beside a complete identity.
    let (mut core, c, _rk, _reg) = begun();
    core.signup_complete(&USER, "alice", NOW).expect("complete");
    drop(core);
    c.lock()
        .expect("lock")
        .execute(
            "INSERT INTO app_meta (k, v) VALUES ('enrol', ?1)",
            [enrol(2)],
        )
        .expect("seed");
    assert_eq!(err(ClientCore::open(c.clone())), beside);
    // Alone, but its DSK is not stored.
    let c = conn();
    drop(ClientCore::open(c.clone()).expect("open"));
    c.lock()
        .expect("lock")
        .execute(
            "INSERT INTO app_meta (k, v) VALUES ('enrol', ?1)",
            [enrol(3)],
        )
        .expect("seed");
    assert_eq!(
        err(ClientCore::open(c.clone())),
        ClientError {
            code: "E_CORE_STATE",
            detail: "the device key is missing from the store".into()
        }
    );
    // Malformed.
    c.lock()
        .expect("lock")
        .execute("UPDATE app_meta SET v = x'8102' WHERE k = 'enrol'", [])
        .expect("corrupt");
    assert_eq!(
        err(ClientCore::open(c)),
        ClientError {
            code: "E_CORE_STORAGE",
            detail: "app_meta enrol is malformed".into()
        }
    );
}
