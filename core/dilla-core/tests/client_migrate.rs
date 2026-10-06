// Native only: the fixture is a database file.
#![cfg(not(target_arch = "wasm32"))]

//! web-2a task 1 (L-CORE-20, Q23, lesson g): a store written at app schema v1 opens as v2.
//!
//! `tests/fixtures/app_v1.db` is a real v1 store. `write_the_v1_fixture` (ignored) wrote it: it
//! drives two cores through the web-1 API, then copies Alice's database into a file created from
//! `APP_SCHEMA_V1` — web-1's DDL, kept here verbatim and nowhere in `src/` — taking the openmls
//! tables whole, the app tables by their v1 columns, and the identity record in its v1 form. Run
//! it again only to regenerate the file; it yields a v1 store whatever schema this build writes.

mod client_support;

use client_support::*;
use dilla_core::cbor::{Encoder, decode_strict};
use dilla_core::client::{ClientCore, ClientError, mentions_me, migrate_app};
use dilla_core::mls::{ConnHandle, DillaStorage};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/app_v1.db");
const PENDING_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/app_v1_pending.db"
);

/// web-1's `APP_SCHEMA` (L-SQL-10), verbatim.
const APP_SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_groups (
  group_id     BLOB    PRIMARY KEY CHECK (length(group_id) = 16),
  kind         INTEGER NOT NULL,
  community_id BLOB    CHECK (community_id IS NULL OR length(community_id) = 16),
  target_id    BLOB    NOT NULL CHECK (length(target_id) = 16),
  state        INTEGER NOT NULL,
  next_seq     INTEGER NOT NULL DEFAULT 1,
  acked_seq    INTEGER NOT NULL DEFAULT 0,
  acked_epoch  INTEGER NOT NULL DEFAULT 0,
  resync       INTEGER NOT NULL DEFAULT 0 CHECK (resync IN (0, 1)),
  was_gone     INTEGER NOT NULL DEFAULT 0 CHECK (was_gone IN (0, 1)),
  max_epoch    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS app_groups_by_target ON app_groups (target_id, kind) WHERE state <> 4;
CREATE TABLE IF NOT EXISTS app_handshake_tail (
  group_id BLOB NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, kind INTEGER NOT NULL,
  sender INTEGER, blob BLOB NOT NULL, PRIMARY KEY (group_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_proposals (
  group_id BLOB NOT NULL, ref BLOB NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (group_id, ref)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_messages (
  group_id      BLOB    NOT NULL,
  seq           INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  recv_ts       INTEGER NOT NULL,
  status        INTEGER NOT NULL,
  reason        TEXT    NOT NULL DEFAULT '',
  sender_user   BLOB,
  sender_device BLOB    NOT NULL,
  sender_leaf   INTEGER,
  sender_kind   INTEGER,
  sender_tier   INTEGER,
  msg_id        BLOB,
  type          INTEGER,
  body          TEXT    NOT NULL DEFAULT '',
  envelope      BLOB,
  franking_tag  BLOB    NOT NULL,
  PRIMARY KEY (group_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_messages_by_msg ON app_messages (group_id, msg_id);
CREATE TABLE IF NOT EXISTS app_outbox (
  msg_id   BLOB    PRIMARY KEY CHECK (length(msg_id) = 16),
  group_id BLOB    NOT NULL,
  envelope BLOB    NOT NULL,
  created  INTEGER NOT NULL,
  state    INTEGER NOT NULL,
  error    TEXT    NOT NULL DEFAULT '',
  epoch    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_outbox_by_group ON app_outbox (group_id, created, msg_id);
INSERT OR IGNORE INTO app_meta (k, v) VALUES ('schema', x'01');
";

/// The v1 columns of every app table but `app_meta`, in declaration order.
const V1_COLUMNS: [(&str, &str); 5] = [
    (
        "app_groups",
        "group_id,kind,community_id,target_id,state,next_seq,acked_seq,acked_epoch,resync,was_gone,max_epoch",
    ),
    ("app_handshake_tail", "group_id,seq,epoch,kind,sender,blob"),
    ("app_proposals", "group_id,ref,epoch"),
    (
        "app_messages",
        "group_id,seq,epoch,recv_ts,status,reason,sender_user,sender_device,sender_leaf,sender_kind,sender_tier,msg_id,type,body,envelope,franking_tag",
    ),
    (
        "app_outbox",
        "msg_id,group_id,envelope,created,state,error,epoch",
    ),
];

fn mention_body() -> String {
    format!("ping <@{}>", "a1".repeat(16))
}
fn self_mention_body() -> String {
    format!("note to self <@{}>", "a1".repeat(16))
}
fn shouted_body() -> String {
    format!("shout <@{}>", "A1".repeat(16))
}
/// Sent by Alice's other device (user 0xa1, device 0x5e): the own user, so never a mention.
fn twin_mention_body() -> String {
    format!("from my other browser <@{}>", "a1".repeat(16))
}
const TWIN_DEVICE: [u8; 16] = [0x5e; 16];

fn columns(c: &rusqlite::Connection, table: &str) -> Vec<String> {
    let mut stmt = c
        .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
        .expect("prepare");
    stmt.query_map([table], |r| r.get::<_, String>(0))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("names")
}

fn column_info(
    c: &rusqlite::Connection,
    table: &str,
) -> Vec<(String, String, Option<String>, i64)> {
    let mut stmt = c
        .prepare(
            "SELECT name, type, dflt_value, \"notnull\" FROM pragma_table_info(?1) ORDER BY cid",
        )
        .expect("prepare");
    stmt.query_map([table], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    })
    .expect("query")
    .collect::<Result<_, _>>()
    .expect("column info")
}

fn app_tables(c: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'app%' ORDER BY name")
        .expect("prepare");
    stmt.query_map([], |r| r.get::<_, String>(0))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("names")
}

fn meta_of(c: &rusqlite::Connection, k: &str) -> Option<Vec<u8>> {
    use rusqlite::OptionalExtension;
    c.query_row("SELECT v FROM app_meta WHERE k = ?1", [k], |r| r.get(0))
        .optional()
        .expect("app_meta read")
}

/// The identity record as web-1 wrote it: eleven elements, version 1. A record this build wrote
/// (thirteen elements, version 2) is cut back to its first eleven.
fn identity_v1(record: &[u8]) -> Vec<u8> {
    let fields = decode_strict(record, |d| {
        let n = d.array_len()?;
        assert!(n == 11 || n == 13, "an identity record of {n} elements");
        d.uint()?;
        let fields = (
            d.bytes_exact::<16>()?,
            d.bytes_exact::<16>()?,
            d.bytes_exact::<16>()?,
            d.bytes_exact::<32>()?,
            d.bytes_exact::<32>()?,
            d.bytes_exact::<32>()?,
            d.text()?.to_owned(),
            d.bytes()?.to_vec(),
            d.bytes()?.to_vec(),
            d.uint()?,
        );
        if n == 13 {
            d.skip()?;
            d.skip()?;
        }
        Ok(fields)
    })
    .expect("the identity record");
    let (instance, user, device, dsk, umk, ssk, username, credential, list_body, published) =
        fields;
    let mut e = Encoder::new();
    e.array(11)
        .uint(1)
        .bytes(&instance)
        .bytes(&user)
        .bytes(&device)
        .bytes(&dsk)
        .bytes(&umk)
        .bytes(&ssk)
        .text(&username)
        .bytes(&credential)
        .bytes(&list_body)
        .uint(published);
    e.into_vec()
}

/// Alice and Bob in GROUP at epoch 2 (the external join of Alice's other device, a raw member with
/// user 0xa1 and device 0x5e, moved it from 1 to 2) with six messages (Bob's mention of Alice,
/// Alice's own mention of herself, Bob's upper-case-hex mention, and the other device's mention of
/// Alice among them) and one queued outbox row; Alice alone in OTHER_GROUP at epoch 0 with one
/// message and a commit built and never confirmed: seven messages in all. Alice's store is copied
/// into the fixture as a v1 store.
#[test]
#[ignore = "writes tests/fixtures/app_v1.db; run once with --ignored and commit the file"]
fn write_the_v1_fixture() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    let mut twin = RawPeer::new(0xa1, 0x5e);
    twin.join_external(&mut relay);
    a.sync(&relay);
    b.sync(&relay);
    a.send(&mut relay, &GROUP, "hello from alice", NOW + 1);
    b.send(&mut relay, &GROUP, "hello from bob", NOW + 2);
    b.send(&mut relay, &GROUP, &mention_body(), NOW + 3);
    a.send(&mut relay, &GROUP, &self_mention_body(), NOW + 4);
    b.send(&mut relay, &GROUP, &shouted_body(), NOW + 5);
    twin.send(&mut relay, &twin_mention_body());
    a.sync(&relay);
    a.prepare(&GROUP, "still queued", NOW + 6);

    let mut other = Relay::new(OTHER_GROUP);
    let body = a
        .core
        .group_create(
            &OTHER_GROUP,
            &COMMUNITY,
            &OTHER_CHANNEL,
            POLICY,
            &instance.public(),
        )
        .expect("group_create");
    let created = other.register(&body).expect("register");
    let next_seq = decode_strict(&created, |d| {
        d.array(2)?;
        d.bytes_exact::<16>()?;
        d.uint()
    })
    .expect("201 body");
    a.core
        .group_registered(&OTHER_GROUP, next_seq)
        .expect("group_registered");
    a.send(&mut other, &OTHER_GROUP, "alone here", NOW + 7);
    a.core
        .commit_build(&OTHER_GROUP, &[0x80])
        .expect("commit_build");
    a.core.device_list_published().expect("published");

    let path = Path::new(FIXTURE);
    let _ = std::fs::remove_file(path);
    {
        let file = rusqlite::Connection::open(path).expect("create the fixture");
        file.execute_batch(APP_SCHEMA_V1)
            .expect("the v1 app schema");
        DillaStorage::new(Arc::new(Mutex::new(file)))
            .migrate()
            .expect("the openmls schema");
    }
    {
        let c = a.probe.lock().expect("lock");
        let identity: Vec<u8> = c
            .query_row("SELECT v FROM app_meta WHERE k = 'identity'", [], |r| {
                r.get(0)
            })
            .expect("identity record");
        c.execute("ATTACH DATABASE ?1 AS v1", [FIXTURE])
            .expect("attach");
        let tables: Vec<String> = {
            let mut stmt = c
                .prepare(
                    "SELECT name FROM main.sqlite_master WHERE type = 'table' \
                     AND (name LIKE 'openmls_%' OR name = 'storage_meta') ORDER BY name",
                )
                .expect("prepare");
            stmt.query_map([], |r| r.get(0))
                .expect("query")
                .collect::<Result<Vec<_>, _>>()
                .expect("names")
        };
        for t in &tables {
            c.execute(
                &format!("INSERT OR REPLACE INTO v1.\"{t}\" SELECT * FROM main.\"{t}\""),
                [],
            )
            .expect("copy an openmls table");
        }
        for (t, cols) in V1_COLUMNS {
            c.execute(
                &format!("INSERT INTO v1.{t} ({cols}) SELECT {cols} FROM main.{t}"),
                [],
            )
            .expect("copy an app table");
        }
        c.execute(
            "INSERT INTO v1.app_meta (k, v) SELECT k, v FROM main.app_meta \
             WHERE k NOT IN ('schema', 'identity')",
            [],
        )
        .expect("copy app_meta");
        c.execute(
            "INSERT INTO v1.app_meta (k, v) VALUES ('identity', ?1)",
            [identity_v1(&identity)],
        )
        .expect("the v1 identity record");
        c.execute("DETACH DATABASE v1", []).expect("detach");
    }
    let file = rusqlite::Connection::open(path).expect("reopen the fixture");
    file.execute_batch("VACUUM").expect("vacuum");
    for (t, cols) in V1_COLUMNS {
        assert_eq!(
            columns(&file, t),
            cols.split(',').collect::<Vec<_>>(),
            "{t}"
        );
    }
    assert_eq!(
        app_tables(&file),
        [
            "app_groups",
            "app_handshake_tail",
            "app_messages",
            "app_meta",
            "app_outbox",
            "app_proposals"
        ]
    );
    assert_eq!(meta_of(&file, "schema"), Some(vec![0x01]));
    let total: i64 = file
        .query_row("SELECT count(*) FROM app_messages", [], |r| r.get(0))
        .expect("count");
    assert_eq!(total, 7, "seven messages");
    let twin_row: (Vec<u8>, i64, i64, String) = file
        .query_row(
            "SELECT sender_user, status, type, body FROM app_messages WHERE sender_device = ?1",
            [TWIN_DEVICE.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("the other device's row");
    assert_eq!(
        twin_row,
        (vec![0xa1; 16], 0, 0, twin_mention_body()),
        "a status-0 type-0 row of the own user from another device"
    );
    let record = meta_of(&file, "identity").expect("identity");
    // decode_strict refuses trailing bytes, so every element is read past.
    let len = decode_strict(&record, |d| {
        let n = d.array_len()?;
        for _ in 0..n {
            d.skip()?;
        }
        Ok(n)
    })
    .expect("the identity record decodes");
    assert_eq!(len, 11, "an eleven-element v1 record");
}

/// A private copy of the committed fixture under the temp directory, opened as a file.
fn fixture_copy(name: &str) -> (PathBuf, ConnHandle) {
    let path = std::env::temp_dir().join(format!(
        "dilla-client-migrate-{}-{name}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::copy(FIXTURE, &path).expect("copy the v1 fixture");
    let conn: ConnHandle = Arc::new(Mutex::new(
        rusqlite::Connection::open(&path).expect("open the copy"),
    ));
    (path, conn)
}

#[test]
fn a_v1_store_opens_as_v2_with_every_column_backfilled() {
    let (path, conn) = fixture_copy("open");
    {
        let c = conn.lock().expect("lock");
        assert_eq!(
            meta_of(&c, "schema"),
            Some(vec![0x01]),
            "the committed fixture is v1"
        );
        assert!(!columns(&c, "app_groups").iter().any(|n| n == "epoch"));
    }
    let core = ClientCore::open(Arc::clone(&conn)).expect("open the v1 fixture");
    {
        let c = conn.lock().expect("lock");
        assert_eq!(meta_of(&c, "schema"), Some(vec![0x02]));
        // A migrated store and a fresh one have the same columns, in the same order.
        let fresh = memory();
        drop(ClientCore::open(Arc::clone(&fresh)).expect("a fresh store"));
        let fresh = fresh.lock().expect("lock");
        assert_eq!(app_tables(&c), app_tables(&fresh));
        for t in app_tables(&fresh) {
            assert_eq!(column_info(&c, &t), column_info(&fresh, &t), "{t}");
        }
        let group_columns = columns(&c, "app_groups");
        assert_eq!(
            &group_columns[group_columns.len() - 2..],
            ["epoch", "pending_commit"]
        );
        assert_eq!(
            columns(&c, "app_messages").last().map(String::as_str),
            Some("mention")
        );
        assert_eq!(
            columns(&c, "app_read_state"),
            ["group_id", "last_read_seq", "last_read_at"]
        );
        assert_eq!(columns(&c, "app_settings"), ["k", "v"]);
    }

    // epoch and pending_commit equal the stored MLS groups: GROUP at epoch 2, OTHER_GROUP at 0
    // holding the commit Alice built and never confirmed.
    let rows: Vec<_> = groups(&core)
        .into_iter()
        .map(|r| (r.group_id, r.state, r.epoch, r.pending_commit))
        .collect();
    assert_eq!(rows, vec![(GROUP, 2, 2, 0), (OTHER_GROUP, 2, 0, 1)]);
    assert_mls_columns(&core, &conn, "the migration");

    // mention: Bob's lower-case mention only. Alice's own mention of herself (this device), the
    // mention from Alice's other device (the own user, by user: ruling 29) and the upper-case one
    // keep 0.
    {
        let c = conn.lock().expect("lock");
        let mut stmt = c
            .prepare("SELECT body FROM app_messages WHERE mention = 1 ORDER BY group_id, seq")
            .expect("prepare");
        let flagged = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        assert_eq!(flagged, vec![mention_body()]);
        let mut stmt = c
            .prepare("SELECT body FROM app_messages WHERE mention = 0 ORDER BY group_id, seq")
            .expect("prepare");
        let unflagged = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        assert!(
            unflagged.contains(&twin_mention_body()),
            "the own user's other device is not a mention"
        );
        assert!(unflagged.contains(&self_mention_body()));
        assert!(unflagged.contains(&shouted_body()));
        let twin_mention: i64 = c
            .query_row(
                "SELECT mention FROM app_messages WHERE sender_device = ?1",
                [TWIN_DEVICE.as_slice()],
                |r| r.get(0),
            )
            .expect("the other device's row");
        assert_eq!(twin_mention, 0);
        let total: i64 = c
            .query_row("SELECT count(*) FROM app_messages", [], |r| r.get(0))
            .expect("count");
        assert_eq!(total, 7);
    }

    // The identity record is v2: device_list is the v1 body's signed list, state_uploaded is 0.
    let record = meta_of(&conn.lock().expect("lock"), "identity").expect("identity");
    let (v, list_body, published, list, uploaded) = decode_strict(&record, |d| {
        d.array(13)?;
        let v = d.uint()?;
        for _ in 0..8 {
            d.skip()?;
        }
        Ok((
            v,
            d.bytes()?.to_vec(),
            d.uint()?,
            d.bytes()?.to_vec(),
            d.uint()?,
        ))
    })
    .expect("the thirteen-element identity record");
    let served = decode_strict(&list_body, |d| {
        d.array(4)?;
        d.uint()?;
        let blob = d.bytes()?.to_vec();
        d.skip()?;
        d.skip()?;
        Ok(blob)
    })
    .expect("[version, blob, ssk_signature, prev_hash]");
    assert_eq!((v, published, uploaded), (2, 1, 0));
    assert_eq!(list, served, "device_list is element 1 of device_list_body");
    let (phase, user, username, listed) = decode_strict(&core.identity().expect("identity"), |d| {
        d.array(6)?;
        let phase = d.uint()?;
        d.opt_bytes_exact::<16>()?;
        let user = d.opt_bytes_exact::<16>()?;
        d.opt_bytes_exact::<16>()?;
        Ok((phase, user, d.text()?.to_owned(), d.uint()?))
    })
    .expect("identity shape");
    assert_eq!(
        (phase, user, username.as_str(), listed),
        (2, Some([0xa1; 16]), "alice", 1)
    );

    // History and the outbox survive.
    let bodies: Vec<String> = decode_timeline(&core.timeline(&GROUP, 0, 200).expect("timeline"))
        .into_iter()
        .map(|r| r.body)
        .collect();
    assert_eq!(
        bodies,
        vec![
            "hello from alice".to_owned(),
            "hello from bob".to_owned(),
            mention_body(),
            self_mention_body(),
            shouted_body(),
            twin_mention_body(),
        ]
    );
    let outbox = decode_outbox(&core.outbox(&GROUP).expect("outbox"));
    assert_eq!(
        outbox
            .iter()
            .map(|o| (o.state, o.body.as_str()))
            .collect::<Vec<_>>(),
        vec![(0, "still queued")]
    );

    // The backfill runs once: a v2 store is opened without one.
    drop(core);
    conn.lock()
        .expect("lock")
        .execute(
            "UPDATE app_groups SET epoch = 99 WHERE group_id = ?1",
            [GROUP.as_slice()],
        )
        .expect("tamper");
    let core = ClientCore::open(Arc::clone(&conn)).expect("reopen at v2");
    assert_eq!(
        groups(&core)[0].epoch,
        99,
        "a v2 store is not backfilled again"
    );
    drop(core);
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}

/// The backfill evaluates `mentions_me` in SQL (`instr` over the same three needles; it keeps
/// the browser build inside task 1's budget). This pins the two to the same answer on
/// `mentions_me`'s own vectors and a few more (an embedded NUL, non-ASCII text), and pins the
/// row filter: status 0, type 0, another user.
#[test]
fn a_v1_store_flags_mentions_as_mentions_me_does() {
    let me = "a1".repeat(16);
    let bodies = [
        format!("hi <@{me}>"),
        format!("<@{me}>"),
        "<@everyone> standup".to_owned(),
        "x<@here>y".to_owned(),
        format!("hi <@{}>", "A1".repeat(16)),
        format!("hi <@{}>", "b2".repeat(16)),
        format!("hi <@{me}"),
        format!("hi @{me}"),
        "<@Everyone>".to_owned(),
        "<@everyone >".to_owned(),
        String::new(),
        "nul\0 then <@everyone>".to_owned(),
        format!("héllo <@{me}> ✓"),
        "<@here".to_owned(),
    ];
    // (status, type, sender_user): only the first is eligible.
    let senders: [(i64, i64, [u8; 16]); 4] = [
        (0, 0, [0xb2; 16]),
        (1, 0, [0xb2; 16]),
        (0, 1, [0xb2; 16]),
        (0, 0, [0xa1; 16]),
    ];
    let (path, conn) = fixture_copy("mention-vectors");
    let mut want = Vec::new();
    {
        let c = conn.lock().expect("lock");
        let mut seq = 10_000i64;
        for body in &bodies {
            for (status, ty, user) in senders {
                c.execute(
                    "INSERT INTO app_messages (group_id, seq, epoch, recv_ts, status, \
                     sender_user, sender_device, type, body, franking_tag) \
                     VALUES (?1, ?2, 1, 0, ?3, ?4, ?5, ?6, ?7, x'00')",
                    rusqlite::params![
                        OTHER_GROUP.as_slice(),
                        seq,
                        status,
                        user.as_slice(),
                        [0x0du8; 16].as_slice(),
                        ty,
                        body
                    ],
                )
                .expect("seed a row");
                let eligible = status == 0 && ty == 0 && user != [0xa1; 16];
                want.push((seq, i64::from(eligible && mentions_me(body, &[0xa1; 16]))));
                seq += 1;
            }
        }
    }
    assert!(
        want.iter().filter(|(_, m)| *m == 1).count() >= 6,
        "the vectors flag something"
    );
    drop(ClientCore::open(Arc::clone(&conn)).expect("open the v1 fixture"));
    let got: Vec<(i64, i64)> = {
        let c = conn.lock().expect("lock");
        let mut stmt = c
            .prepare("SELECT seq, mention FROM app_messages WHERE seq >= 10000 ORDER BY seq")
            .expect("prepare");
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    };
    assert_eq!(got, want, "mention = 1 exactly where mentions_me says so");
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}

#[test]
fn a_v1_store_whose_backfill_fails_stays_v1() {
    let (path, conn) = fixture_copy("rollback");
    conn.lock()
        .expect("lock")
        .execute("UPDATE app_meta SET v = x'00' WHERE k = 'identity'", [])
        .expect("corrupt the identity record");
    let err = match ClientCore::open(Arc::clone(&conn)) {
        Ok(_) => panic!("a v1 store whose identity record does not decode must not open"),
        Err(e) => e,
    };
    assert_eq!(
        err,
        ClientError {
            code: "E_CORE_STORAGE",
            detail: "app_meta identity is malformed".into()
        }
    );
    let c = conn.lock().expect("lock");
    assert_eq!(
        meta_of(&c, "schema"),
        Some(vec![0x01]),
        "the migration rolled back with the backfill"
    );
    assert!(!columns(&c, "app_groups").iter().any(|n| n == "epoch"));
    assert!(!app_tables(&c).iter().any(|n| n == "app_read_state"));
    drop(c);
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}

#[test]
fn migrate_app_reports_the_schema_it_found() {
    let (path, conn) = fixture_copy("report");
    assert_eq!(
        migrate_app(&DillaStorage::new(Arc::clone(&conn))).expect("v1"),
        1
    );
    assert_eq!(
        meta_of(&conn.lock().expect("lock"), "schema"),
        Some(vec![0x02])
    );
    assert_eq!(
        conn.lock()
            .expect("lock")
            .query_row(
                "SELECT epoch FROM app_groups WHERE group_id = ?1",
                [GROUP.as_slice()],
                |r| r.get::<_, i64>(0)
            )
            .expect("backfilled epoch"),
        2
    );
    let record = meta_of(&conn.lock().expect("lock"), "identity").expect("backfilled identity");
    assert_eq!(
        decode_strict(&record, |d| {
            d.array(13)?;
            let v = d.uint()?;
            for _ in 0..12 {
                d.skip()?;
            }
            Ok(v)
        })
        .expect("v2 identity"),
        2
    );
    assert_eq!(
        migrate_app(&DillaStorage::new(Arc::clone(&conn))).expect("v2"),
        2
    );
    assert_eq!(migrate_app(&DillaStorage::new(memory())).expect("fresh"), 2);
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}

/// The bytes a group id leaves inside the openmls tables' `group_id` key: the provider's CBOR
/// serialises the id's `Vec<u8>` as an array of integers, and each byte of GROUP and OTHER_GROUP
/// (0x44, 0x45 >= 24) is the two-byte integer `0x18, b`.
fn stored_id(id: &[u8; 16]) -> Vec<u8> {
    id.iter().flat_map(|b| [0x18, *b]).collect()
}

/// Pre-flight ruling (b): a group whose stored MLS state does not load fails the migration, in
/// `open` and in `migrate_app` alike; the unit rolls back and the store is exactly the v1 store it
/// was, so the next open migrates again. Attacker: none from outside. The store is device-local
/// and written only by this browser; a group state that does not decode was not written by this
/// build (or the disk failed). Keeping the row at epoch 0 instead would be silent: `take_group`
/// compares only id, kind, target and community, so nothing would report the wrong column.
#[test]
fn a_v1_store_whose_mls_group_fails_to_load_stays_v1() {
    let (path, conn) = fixture_copy("mls-load-error");
    let changed = conn
        .lock()
        .expect("lock")
        .execute(
            "UPDATE openmls_group_data SET group_data = x'00' \
             WHERE data_type = 'group_state' AND instr(group_id, ?1) > 0",
            [stored_id(&GROUP)],
        )
        .expect("corrupt GROUP's stored state");
    assert_eq!(changed, 1, "GROUP's group_state row");
    let before = {
        let c = conn.lock().expect("lock");
        (
            meta_of(&c, "identity").expect("identity"),
            column_info(&c, "app_groups"),
            app_tables(&c),
        )
    };

    let error = match ClientCore::open(Arc::clone(&conn)) {
        Ok(_) => panic!("a v1 store whose MLS group does not load must not open"),
        Err(e) => e,
    };
    assert_eq!(error.code, "E_CORE_STORAGE");
    let public_error = migrate_app(&DillaStorage::new(Arc::clone(&conn)))
        .expect_err("the public migration also rolls back a failed MLS load");
    assert!(
        matches!(public_error, dilla_core::mls::StorageError::Codec(_)),
        "{public_error:?}"
    );

    let c = conn.lock().expect("lock");
    assert_eq!(meta_of(&c, "schema"), Some(vec![0x01]), "still v1");
    assert_eq!(
        (
            meta_of(&c, "identity").expect("identity"),
            column_info(&c, "app_groups"),
            app_tables(&c),
        ),
        before,
        "the identity record, the columns and the tables are unchanged"
    );
    let flagged: i64 = c
        .query_row(
            "SELECT count(*) FROM pragma_table_info('app_messages') WHERE name = 'mention'",
            [],
            |r| r.get(0),
        )
        .expect("pragma");
    assert_eq!(flagged, 0, "no mention column");
    drop(c);
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}

/// Pre-flight ruling (b): a row whose MLS group is missing (no stored state, as after a discarded
/// resync) migrates with `epoch = 0, pending_commit = 0`, which is what the writers leave for it.
#[test]
fn a_v1_row_without_a_stored_mls_group_migrates_at_epoch_0() {
    let (path, conn) = fixture_copy("mls-missing");
    let deleted = conn
        .lock()
        .expect("lock")
        .execute(
            "DELETE FROM openmls_group_data WHERE instr(group_id, ?1) > 0",
            [stored_id(&OTHER_GROUP)],
        )
        .expect("drop OTHER_GROUP's stored state");
    assert!(deleted > 0, "OTHER_GROUP had stored state");
    let core = ClientCore::open(Arc::clone(&conn)).expect("open");
    let rows: Vec<_> = groups(&core)
        .into_iter()
        .map(|r| (r.group_id, r.state, r.epoch, r.pending_commit))
        .collect();
    assert_eq!(rows, vec![(GROUP, 2, 2, 0), (OTHER_GROUP, 2, 0, 0)]);
    assert_mls_columns(&core, &conn, "a migration with a missing group");
    drop(core);
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}

/// A web-1 store in phase 1 (pre-flight ruling (d), S2b): `signup_begin` ran and nothing else. It
/// is copied as `write_the_v1_fixture` copies Alice's store: the openmls tables whole (they hold
/// the DSK) and `app_meta` but its `schema` row, into a file created from `APP_SCHEMA_V1`.
#[test]
#[ignore = "writes tests/fixtures/app_v1_pending.db; run once with --ignored and commit the file"]
fn write_the_v1_pending_fixture() {
    let conn = memory();
    let mut core = ClientCore::open(Arc::clone(&conn)).expect("open");
    core.signup_begin(&INSTANCE).expect("signup_begin");
    drop(core);
    let path = Path::new(PENDING_FIXTURE);
    let _ = std::fs::remove_file(path);
    {
        let file = rusqlite::Connection::open(path).expect("create the fixture");
        file.execute_batch(APP_SCHEMA_V1)
            .expect("the v1 app schema");
        DillaStorage::new(Arc::new(Mutex::new(file)))
            .migrate()
            .expect("the openmls schema");
    }
    {
        let c = conn.lock().expect("lock");
        c.execute("ATTACH DATABASE ?1 AS v1", [PENDING_FIXTURE])
            .expect("attach");
        let tables: Vec<String> = {
            let mut stmt = c
                .prepare(
                    "SELECT name FROM main.sqlite_master WHERE type = 'table' \
                     AND (name LIKE 'openmls_%' OR name = 'storage_meta') ORDER BY name",
                )
                .expect("prepare");
            stmt.query_map([], |r| r.get(0))
                .expect("query")
                .collect::<Result<Vec<_>, _>>()
                .expect("names")
        };
        for t in &tables {
            c.execute(
                &format!("INSERT OR REPLACE INTO v1.\"{t}\" SELECT * FROM main.\"{t}\""),
                [],
            )
            .expect("copy an openmls table");
        }
        c.execute(
            "INSERT INTO v1.app_meta (k, v) SELECT k, v FROM main.app_meta WHERE k <> 'schema'",
            [],
        )
        .expect("copy app_meta");
        c.execute("DETACH DATABASE v1", []).expect("detach");
    }
    let file = rusqlite::Connection::open(path).expect("reopen the fixture");
    file.execute_batch("VACUUM").expect("vacuum");
    for (t, cols) in V1_COLUMNS {
        assert_eq!(
            columns(&file, t),
            cols.split(',').collect::<Vec<_>>(),
            "{t}"
        );
    }
    assert_eq!(meta_of(&file, "schema"), Some(vec![0x01]));
    assert!(meta_of(&file, "signup").is_some(), "a pending signup");
    assert!(meta_of(&file, "root_sealed").is_some(), "its sealed root");
    assert!(meta_of(&file, "identity").is_none(), "no identity yet");
}

/// Pre-flight ruling (d): a v1 store in phase 1 migrates (no identity record to rewrite, no
/// mention to flag, no group), stays in phase 1 with its signup record untouched, and
/// `signup_complete` then writes the thirteen-element v2 identity record.
#[test]
fn a_v1_pending_signup_migrates_and_completes_to_a_v2_identity() {
    let path = std::env::temp_dir().join(format!(
        "dilla-client-migrate-{}-pending.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::copy(PENDING_FIXTURE, &path).expect("copy the v1 pending fixture");
    let conn: ConnHandle = Arc::new(Mutex::new(
        rusqlite::Connection::open(&path).expect("open the copy"),
    ));
    let signup = {
        let c = conn.lock().expect("lock");
        assert_eq!(
            meta_of(&c, "schema"),
            Some(vec![0x01]),
            "the committed fixture is v1"
        );
        meta_of(&c, "signup").expect("the signup record")
    };
    let mut core = ClientCore::open(Arc::clone(&conn)).expect("open the v1 pending fixture");
    {
        let c = conn.lock().expect("lock");
        assert_eq!(meta_of(&c, "schema"), Some(vec![0x02]));
        assert_eq!(
            meta_of(&c, "signup"),
            Some(signup),
            "the signup record is untouched"
        );
        assert_eq!(meta_of(&c, "identity"), None);
    }
    let phase = |core: &ClientCore| {
        decode_strict(&core.identity().expect("identity"), |d| {
            d.array(6)?;
            let phase = d.uint()?;
            for _ in 0..5 {
                d.skip()?;
            }
            Ok(phase)
        })
        .expect("identity shape")
    };
    assert_eq!(phase(&core), 1, "still a pending signup");
    core.signup_complete(&[0xa1; 16], "alice", NOW)
        .expect("signup_complete");
    assert_eq!(phase(&core), 2);
    let record = meta_of(&conn.lock().expect("lock"), "identity").expect("the identity record");
    let (len, version) = decode_strict(&record, |d| {
        let n = d.array_len()?;
        let v = d.uint()?;
        for _ in 1..n {
            d.skip()?;
        }
        Ok((n, v))
    })
    .expect("the identity record decodes");
    assert_eq!((len, version), (13, 2));
    drop(core);
    drop(conn);
    std::fs::remove_file(&path).expect("cleanup");
}
