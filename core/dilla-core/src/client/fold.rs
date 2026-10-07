//! The fold of envelope types 1..6 onto their targets (protocol/04 § Semantics; L-CORE-33).
//! Derived rows are recomputed in the caller's storage unit; nothing here refuses.

use crate::mls::StorageError;
use rusqlite::{OptionalExtension, params};

#[allow(dead_code)] // Task 3's purge record reads these fields.
pub(super) struct FoldTrigger {
    pub seq: u64,
    pub ty: u8,
    pub sender_user: [u8; 16],
    pub sender_device: [u8; 16],
}

pub(super) struct Target {
    pub seq: u64,
    pub status: i64,
    pub sender_user: Option<[u8; 16]>,
    pub shown_body: String,
}

pub(super) fn resolve(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    msg_id: &[u8; 16],
) -> Result<Option<Target>, StorageError> {
    c.query_row(
        "SELECT seq, status, sender_user, COALESCE(edit_body, body) FROM app_messages WHERE group_id = ?1 AND msg_id = ?2 AND type = 0 AND status IN (0, 2) ORDER BY seq LIMIT 1",
        params![group_id.as_slice(), msg_id.as_slice()],
        |r| Ok(Target { seq: r.get::<_, i64>(0)? as u64, status: r.get(1)?, sender_user: r.get(2)?, shown_body: r.get(3)? }),
    ).optional().map_err(Into::into)
}

pub(super) fn target_of(
    ty: Option<i64>,
    msg_id: Option<[u8; 16]>,
    reply_to: Option<[u8; 16]>,
) -> Option<[u8; 16]> {
    match ty {
        Some(0) => msg_id,
        Some(1..=6) => reply_to,
        _ => None,
    }
}

pub(super) fn excerpt(body: &str) -> String {
    body.chars()
        .take(120)
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .collect()
}

pub(super) enum FoldScope {
    Full,
    Edit,
    Delete { user: [u8; 16] },
    Reaction { user: [u8; 16], emoji: String },
    Pin,
}

pub(super) fn scope_of(ty: Option<i64>, sender_user: Option<[u8; 16]>, body: &str) -> FoldScope {
    match (ty, sender_user) {
        (Some(1), _) => FoldScope::Edit,
        (Some(2), Some(user)) => FoldScope::Delete { user },
        (Some(3 | 4), Some(user)) => FoldScope::Reaction {
            user,
            emoji: body.to_owned(),
        },
        (Some(5 | 6), _) => FoldScope::Pin,
        _ => FoldScope::Full,
    }
}

pub(super) const UNHELD_DELETERS: &str = "SELECT DISTINCT sender_user FROM app_messages INDEXED BY app_messages_by_reply WHERE group_id = ?1 AND reply_to = ?2 AND type = 2 AND status = 0 AND sender_user IS NOT NULL";
pub(super) const BLANK_EDITS_OF: &str = "UPDATE app_messages INDEXED BY app_messages_by_reply SET body = '', envelope = NULL WHERE group_id = ?1 AND reply_to = ?2 AND type = 1 AND status = 0 AND sender_user = ?3";
pub(super) const AUTHOR_DELETED: &str = "SELECT 1 FROM app_messages INDEXED BY app_messages_by_reply WHERE group_id = ?1 AND reply_to = ?2 AND type = 2 AND sender_user = ?3 AND status = 0 LIMIT 1";
pub(super) const FIRST_UNHELD_DELETE: &str = "SELECT seq FROM app_messages INDEXED BY app_messages_by_reply WHERE group_id = ?1 AND reply_to = ?2 AND type = 2 AND sender_user = ?3 AND status = 0 ORDER BY seq LIMIT 1";
pub(super) const BLANK_EDITS: &str = "UPDATE app_messages INDEXED BY app_messages_by_reply SET body = '', envelope = NULL WHERE group_id = ?1 AND reply_to = ?2 AND type = 1 AND sender_user = ?3";
pub(super) const LATEST_EDIT: &str = "SELECT body, seq FROM app_messages INDEXED BY app_messages_by_reply WHERE group_id = ?1 AND reply_to = ?2 AND type = 1 AND sender_user = ?3 AND status = 0 ORDER BY seq DESC LIMIT 1";
pub(super) const REACTIONS_FULL: &str = "INSERT INTO app_reactions (group_id, target, user_id, emoji, seq) SELECT ?1, ?2, u, b, s FROM (SELECT sender_user AS u, body AS b, type AS t, MAX(seq) AS s FROM app_messages INDEXED BY app_messages_by_reaction WHERE group_id = ?1 AND reply_to = ?2 AND status = 0 AND type IN (3, 4) AND sender_user IS NOT NULL GROUP BY sender_user, body) WHERE t = 3";
pub(super) const REACTION_PAIR: &str = "SELECT type, seq FROM app_messages INDEXED BY app_messages_by_reaction WHERE group_id = ?1 AND reply_to = ?2 AND sender_user = ?3 AND body = ?4 AND status = 0 AND type IN (3, 4) ORDER BY seq DESC LIMIT 1";
pub(super) const PIN_LATEST: &str = "SELECT seq, sender_user FROM app_messages INDEXED BY app_messages_by_pin WHERE group_id = ?1 AND reply_to = ?2 AND type = ?3 AND status = 0 ORDER BY seq DESC LIMIT 1";

/// Recompute the portion covered by `scope`; inserted triggers touch bounded rows.
pub(super) fn refold(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    target: &[u8; 16],
    scope: &FoldScope,
    trigger: Option<&FoldTrigger>,
    _own: Option<&super::Own>,
) -> Result<(), StorageError> {
    let g = group_id.as_slice();
    let id = target.as_slice();
    let Some(t) = resolve(c, group_id, target)? else {
        match (scope, trigger) {
            (FoldScope::Edit, Some(tr)) => {
                let deleted = c
                    .query_row(
                        AUTHOR_DELETED,
                        params![g, id, tr.sender_user.as_slice()],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if deleted {
                    c.execute("UPDATE app_messages SET body = '', envelope = NULL WHERE group_id = ?1 AND seq = ?2", params![g, tr.seq as i64])?;
                }
            }
            (FoldScope::Delete { user }, Some(tr)) => {
                let first: Option<i64> = c
                    .query_row(FIRST_UNHELD_DELETE, params![g, id, user.as_slice()], |r| {
                        r.get(0)
                    })
                    .optional()?;
                if first == Some(tr.seq as i64) {
                    c.execute(BLANK_EDITS_OF, params![g, id, user.as_slice()])?;
                }
            }
            (FoldScope::Full, _) | (FoldScope::Edit, None) => {
                let users: Vec<[u8; 16]> = {
                    let mut q = c.prepare(UNHELD_DELETERS)?;
                    q.query_map(params![g, id], |r| r.get(0))?
                        .collect::<Result<_, _>>()?
                };
                for user in users {
                    c.execute(BLANK_EDITS_OF, params![g, id, user.as_slice()])?;
                }
            }
            _ => {}
        }
        return Ok(());
    };
    if let Some(tr) = trigger
        && tr.ty == 0
        && tr.seq != t.seq
    {
        return Ok(());
    }
    if let FoldScope::Delete { user } = scope {
        if t.sender_user != Some(*user) {
            return Ok(());
        }
        if t.status == 2 {
            return Ok(());
        }
    }
    if t.status == 2 && !matches!(scope, FoldScope::Full) {
        if let Some(tr) = trigger {
            if tr.ty == 1 {
                c.execute("UPDATE app_messages SET body = '', envelope = NULL WHERE group_id = ?1 AND seq = ?2", params![g, tr.seq as i64])?;
            }
            return Ok(());
        }
        return Ok(());
    }
    let author_deleted = if let Some(user) = t.sender_user {
        c.query_row(AUTHOR_DELETED, params![g, id, user.as_slice()], |_| Ok(()))
            .optional()?
            .is_some()
    } else {
        false
    };
    if t.status == 2 || author_deleted {
        c.execute("UPDATE app_messages SET status = 2, body = '', envelope = NULL, reason = '', edit_body = NULL, edit_seq = 0 WHERE group_id = ?1 AND seq = ?2", params![g, t.seq as i64])?;
        if let Some(user) = t.sender_user {
            c.execute(BLANK_EDITS, params![g, id, user.as_slice()])?;
        }
        c.execute(
            "DELETE FROM app_reactions WHERE group_id = ?1 AND target = ?2",
            params![g, id],
        )?;
        c.execute(
            "DELETE FROM app_pins WHERE group_id = ?1 AND target = ?2",
            params![g, id],
        )?;
        return Ok(());
    }
    if matches!(scope, FoldScope::Full | FoldScope::Edit) {
        let latest: Option<(String, i64)> = if let Some(user) = t.sender_user {
            c.query_row(LATEST_EDIT, params![g, id, user.as_slice()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
        } else {
            None
        };
        c.execute("UPDATE app_messages SET edit_body = ?3, edit_seq = ?4 WHERE group_id = ?1 AND seq = ?2",
            params![g, t.seq as i64, latest.as_ref().map(|x| x.0.as_str()), latest.as_ref().map_or(0, |x| x.1)])?;
    }
    match scope {
        FoldScope::Full => {
            c.execute(
                "DELETE FROM app_reactions WHERE group_id = ?1 AND target = ?2",
                params![g, id],
            )?;
            c.execute(REACTIONS_FULL, params![g, id])?;
        }
        FoldScope::Reaction { user, emoji } => {
            let pair: Option<(i64, i64)> = c
                .query_row(REACTION_PAIR, params![g, id, user.as_slice(), emoji], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            if let Some((3, seq)) = pair {
                c.execute("INSERT INTO app_reactions (group_id, target, user_id, emoji, seq) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (group_id, target, user_id, emoji) DO UPDATE SET seq = excluded.seq", params![g, id, user.as_slice(), emoji, seq])?;
            } else {
                c.execute("DELETE FROM app_reactions WHERE group_id = ?1 AND target = ?2 AND user_id = ?3 AND emoji = ?4", params![g, id, user.as_slice(), emoji])?;
            }
        }
        _ => {}
    }
    if matches!(scope, FoldScope::Full | FoldScope::Pin) {
        let pin: Option<(i64, Option<[u8; 16]>)> = c
            .query_row(PIN_LATEST, params![g, id, 5], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let unpin: Option<i64> = c
            .query_row(PIN_LATEST, params![g, id, 6], |r| r.get(0))
            .optional()?;
        if let Some((seq, Some(user))) = pin
            && unpin.is_none_or(|s| seq > s)
        {
            c.execute("INSERT INTO app_pins (group_id, target, seq, by_user) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (group_id, target) DO UPDATE SET seq = excluded.seq, by_user = excluded.by_user", params![g, id, seq, user.as_slice()])?;
        } else {
            c.execute(
                "DELETE FROM app_pins WHERE group_id = ?1 AND target = ?2",
                params![g, id],
            )?;
        }
    }
    Ok(())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn plan(c: &rusqlite::Connection, sql: &str) -> String {
        let mut st = c
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("prepare");
        let n = st.parameter_count();
        let nulls = std::iter::repeat_n(rusqlite::types::Null, n);
        let rows = st
            .query_map(rusqlite::params_from_iter(nulls), |r| r.get::<_, String>(3))
            .expect("plan");
        rows.map(|r| r.expect("detail"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn every_fold_statement_is_an_index_search() {
        let c = rusqlite::Connection::open_in_memory().expect("open");
        c.execute_batch(super::super::schema::APP_SCHEMA)
            .expect("schema");
        c.execute_batch(super::super::schema::APP_INDEXES_V3)
            .expect("indexes");
        let cases: [(&str, &str, &str); 9] = [
            (
                "UNHELD_DELETERS",
                UNHELD_DELETERS,
                "(group_id=? AND reply_to=? AND type=?",
            ),
            (
                "BLANK_EDITS_OF",
                BLANK_EDITS_OF,
                "(group_id=? AND reply_to=? AND type=? AND sender_user=?)",
            ),
            (
                "AUTHOR_DELETED",
                AUTHOR_DELETED,
                "(group_id=? AND reply_to=? AND type=? AND sender_user=?)",
            ),
            (
                "FIRST_UNHELD_DELETE",
                FIRST_UNHELD_DELETE,
                "(group_id=? AND reply_to=? AND type=? AND sender_user=?)",
            ),
            (
                "BLANK_EDITS",
                BLANK_EDITS,
                "(group_id=? AND reply_to=? AND type=?",
            ),
            (
                "LATEST_EDIT",
                LATEST_EDIT,
                "(group_id=? AND reply_to=? AND type=? AND sender_user=?)",
            ),
            (
                "REACTIONS_FULL",
                REACTIONS_FULL,
                "(group_id=? AND reply_to=?",
            ),
            (
                "REACTION_PAIR",
                REACTION_PAIR,
                "(group_id=? AND reply_to=? AND sender_user=? AND body=?",
            ),
            (
                "PIN_LATEST",
                PIN_LATEST,
                "(group_id=? AND reply_to=? AND type=?)",
            ),
        ];
        for (name, sql, want) in cases {
            let p = plan(&c, sql);
            assert!(!p.contains("SCAN app_messages"), "{name} scans: {p}");
            assert!(
                p.contains("INDEX app_messages_by_"),
                "{name} uses no fold index: {p}"
            );
            assert!(p.contains(want), "{name} is not bounded by {want}: {p}");
        }
    }

    #[test]
    fn delete_scope_and_replayed_target_return_without_writing() {
        assert!(
            matches!(scope_of(Some(2), Some([9; 16]), ""), FoldScope::Delete { user } if user == [9; 16])
        );
        let c = rusqlite::Connection::open_in_memory().expect("open");
        c.execute_batch(super::super::schema::APP_SCHEMA)
            .expect("schema");
        c.execute_batch(super::super::schema::APP_INDEXES_V3)
            .expect("indexes");
        let group = [1u8; 16];
        let target = [2u8; 16];
        let author = [3u8; 16];
        let mallory = [9u8; 16];
        c.execute("INSERT INTO app_messages (group_id,seq,epoch,recv_ts,status,sender_user,sender_device,msg_id,type,franking_tag) VALUES (?1,1,0,0,2,?2,?2,?3,0,?4)",
            params![group.as_slice(), author.as_slice(), target.as_slice(), [0u8; 32].as_slice()]).expect("target");
        let changes = c.total_changes();
        let tr = FoldTrigger {
            seq: 2,
            ty: 2,
            sender_user: mallory,
            sender_device: mallory,
        };
        refold(
            &c,
            &group,
            &target,
            &scope_of(Some(2), Some(mallory), ""),
            Some(&tr),
            None,
        )
        .expect("ignored delete");
        assert_eq!(c.total_changes(), changes);
        let replay = FoldTrigger {
            seq: 3,
            ty: 0,
            sender_user: author,
            sender_device: author,
        };
        refold(&c, &group, &target, &FoldScope::Full, Some(&replay), None).expect("replay");
        assert_eq!(c.total_changes(), changes);
    }
}
