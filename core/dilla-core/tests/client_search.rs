#![cfg(not(target_arch = "wasm32"))]
mod client_support;
use client_support::*;
use dilla_core::cbor::decode_strict;

fn hits(bytes: &[u8]) -> Vec<([u8; 16], u64, String, u64)> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut out = Vec::new();
        for _ in 0..n {
            d.array(4)?;
            out.push((
                d.bytes_exact::<16>()?,
                d.uint()?,
                d.text()?.to_owned(),
                d.uint()?,
            ));
        }
        Ok(out)
    })
    .expect("search CBOR")
}

#[test]
fn folded_search_is_prefix_unicode_bounded_and_removes_deleted_text() {
    let (_, mut relay, mut alice, _) = alice_and_bob();
    let (_, seq) = alice.send(&mut relay, &GROUP, "naïve lantern", NOW + 1);
    let found = hits(
        &alice
            .core
            .search(2, None, "naive lan", None, 50)
            .expect("search"),
    );
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].0, found[0].1, found[0].3), (GROUP, seq, 0));
    assert!(found[0].2.contains("naïve lantern"));
    alice.core.message_deleted(&GROUP, seq).expect("delete");
    assert!(
        hits(
            &alice
                .core
                .search(2, None, "naive lan", None, 50)
                .expect("search")
        )
        .is_empty()
    );
}

#[test]
fn search_rejects_unbounded_inputs_and_nonzero_cursor_rank() {
    let (_, _, alice, _) = alice_and_bob();
    let cases = [
        (2, None, "", None, 10),
        (2, None, "x", None, 0),
        (2, None, "x", None, 51),
        (0, None, "x", None, 10),
        (2, Some(&GROUP), "x", None, 10),
        (2, None, "x", Some((1, GROUP, 1)), 10),
    ];
    for (kind, scope, query, cursor, limit) in cases {
        assert_eq!(
            code(alice.core.search(kind, scope, query, cursor, limit)),
            "E_CORE_INPUT"
        );
    }
    assert_eq!(
        code(alice.core.search(2, None, &"q".repeat(129), None, 10)),
        "E_CORE_INPUT"
    );
    assert_eq!(
        code(alice.core.search(2, None, "a b c d e f g h i", None, 10)),
        "E_CORE_INPUT"
    );
}

#[test]
fn punctuation_is_tokenized_without_matching_an_unrelated_word() {
    let (_, mut relay, mut alice, _) = alice_and_bob();
    alice.send(&mut relay, &GROUP, "literal percent_%\\word", NOW + 1);
    alice.send(&mut relay, &GROUP, "different percentABCword", NOW + 2);
    let result = hits(
        &alice
            .core
            .search(2, None, "percent_%\\word", None, 50)
            .expect("search"),
    );
    assert_eq!(result.len(), 1);
    assert!(result[0].2.contains("percent_%\\word"));
}

#[test]
fn query_plan_uses_the_auxiliary_index_and_result_count_is_capped() {
    let (_, mut relay, mut alice, _) = alice_and_bob();
    for i in 0..51 {
        alice.send(&mut relay, &GROUP, &format!("capacity {i}"), NOW + 1 + i);
    }
    let found = hits(
        &alice
            .core
            .search(2, None, "cap", None, 50)
            .expect("bounded search"),
    );
    assert_eq!(found.len(), 50);
    let db = alice.probe.lock().expect("db");
    let cap: Vec<u8> = db
        .query_row("SELECT v FROM app_meta WHERE k='search_fts5'", [], |r| {
            r.get(0)
        })
        .expect("capability");
    let sql = if cap == [1] {
        "EXPLAIN QUERY PLAN SELECT r.group_id,r.seq FROM app_search AS f JOIN app_search_rows AS r ON r.rowid=f.rowid WHERE app_search MATCH 'cap*' LIMIT 50"
    } else {
        "EXPLAIN QUERY PLAN SELECT r.group_id,r.seq FROM app_search_rows AS r WHERE r.terms LIKE '% cap%' ESCAPE '\\' LIMIT 50"
    };
    let mut stmt = db.prepare(sql).expect("query plan");
    let details: Vec<String> = stmt
        .query_map([], |r| r.get(3))
        .expect("plan rows")
        .collect::<Result<_, _>>()
        .expect("plan text");
    assert!(
        details.iter().any(|d| if cap == [1] {
            d.contains("VIRTUAL TABLE INDEX")
        } else {
            d.contains("SCAN r")
        }),
        "plan: {details:?}"
    );
}

#[test]
fn postfilter_rejects_a_stale_auxiliary_row_for_a_deleted_message() {
    let (_, mut relay, mut alice, _) = alice_and_bob();
    let (_, seq) = alice.send(&mut relay, &GROUP, "naïve lantern", NOW + 1);
    alice.core.message_deleted(&GROUP, seq).expect("delete");
    alice.probe.lock().expect("db").execute(
        "INSERT INTO app_search_rows(group_id,seq,body,terms) VALUES(?1,?2,'naïve lantern',' naive lantern')",
        rusqlite::params![GROUP.as_slice(), seq as i64],
    ).expect("simulate stale auxiliary row");
    assert!(
        hits(
            &alice
                .core
                .search(2, None, "naive", None, 50)
                .expect("search")
        )
        .is_empty()
    );
}
