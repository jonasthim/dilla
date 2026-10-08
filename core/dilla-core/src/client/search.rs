//! Local search over displayable folded text.

use super::error::E_CORE_INPUT;
use super::{ClientCore, ClientError};
use crate::cbor::Encoder;
use crate::mls::StorageError;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value};

fn normal_char(ch: char) -> char {
    match ch {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' => 'u',
        'ý' | 'ÿ' => 'y',
        'ß' => 's',
        other => other,
    }
}

fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut term = String::new();
    for ch in input.chars().flat_map(char::to_lowercase) {
        let ch = normal_char(ch);
        if ch.is_alphanumeric() {
            term.push(ch);
        } else if !term.is_empty() {
            out.push(core::mem::take(&mut term));
        }
    }
    if !term.is_empty() {
        out.push(term);
    }
    out
}

/// Quotes SQL LIKE wildcards in a normalized token.
pub(super) fn escape_like(term: &str) -> String {
    let mut out = String::new();
    for ch in term.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn parse_query(query: &str) -> Result<Vec<String>, ClientError> {
    let trimmed = query.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(ClientError::new(
            E_CORE_INPUT,
            "query must be 1..=128 bytes",
        ));
    }
    let terms = tokenize(trimmed);
    if terms.is_empty() || terms.len() > 8 {
        return Err(ClientError::new(
            E_CORE_INPUT,
            "query must have 1..=8 terms",
        ));
    }
    Ok(terms)
}

/// Refresh the auxiliary row from the current folded target inside its write unit.
pub(super) fn index_fold(
    c: &rusqlite::Connection,
    group_id: &[u8; 16],
    seq: u64,
) -> Result<(), StorageError> {
    let row:Option<(i64,Option<i64>,String)>=c.query_row(
        "SELECT status,type,COALESCE(edit_body,body) FROM app_messages WHERE group_id=?1 AND seq=?2",
        params![group_id.as_slice(),seq as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((0, Some(0), body)) = row
        && !body.is_empty()
    {
        let terms = tokenize(&body);
        if !terms.is_empty() {
            let terms = format!(" {}", terms.join(" "));
            c.execute("INSERT INTO app_search_rows(group_id,seq,body,terms) VALUES(?1,?2,?3,?4) ON CONFLICT(group_id,seq) DO UPDATE SET body=excluded.body,terms=excluded.terms",params![group_id.as_slice(),seq as i64,body,terms])?;
            return Ok(());
        }
    }
    c.execute(
        "DELETE FROM app_search_rows WHERE group_id=?1 AND seq=?2",
        params![group_id.as_slice(), seq as i64],
    )?;
    Ok(())
}

impl ClientCore {
    pub fn search(
        &self,
        scope_kind: u8,
        scope_id: Option<&[u8; 16]>,
        query: &str,
        before: Option<(u64, [u8; 16], u64)>,
        limit: u32,
    ) -> Result<Vec<u8>, ClientError> {
        if !matches!(
            (scope_kind, scope_id),
            (0, Some(_)) | (1, Some(_)) | (2, None)
        ) || !(1..=50).contains(&limit)
            || before.as_ref().is_some_and(|b| b.0 != 0)
        {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "invalid search scope, cursor or limit",
            ));
        }
        let terms = parse_query(query)?;
        let rows:Vec<([u8;16],u64,String)>=self.read(|c| {
            let fts:Option<Vec<u8>>=c.query_row("SELECT v FROM app_meta WHERE k='search_fts5'",[],|r|r.get(0)).optional()?;
            let use_fts=fts.as_deref()==Some(&[1]);
            let mut sql=if use_fts {String::from("SELECT r.group_id,r.seq,r.body FROM app_search AS f JOIN app_search_rows AS r ON r.rowid=f.rowid JOIN app_groups AS g ON g.group_id=r.group_id WHERE app_search MATCH ?1 AND g.state<>4 ")}
                else {String::from("SELECT r.group_id,r.seq,r.body FROM app_search_rows AS r JOIN app_groups AS g ON g.group_id=r.group_id WHERE g.state<>4 ")};
            sql.push_str("AND (?2=2 OR (?2=0 AND g.target_id=?3) OR (?2=1 AND g.community_id=?3)) AND (?4 IS NULL OR r.group_id<?4 OR (r.group_id=?4 AND r.seq<?5)) ");
            let mut args=vec![
                if use_fts {Value::Text(terms.iter().map(|t|format!("{t}*")).collect::<Vec<_>>().join(" AND "))} else {Value::Null},
                Value::Integer(i64::from(scope_kind)),
                scope_id.map_or(Value::Null,|id|Value::Blob(id.to_vec())),
                before.map_or(Value::Null,|b|Value::Blob(b.1.to_vec())),
                before.map_or(Value::Null,|b|Value::Integer(b.2 as i64)),
                Value::Integer(i64::from(limit)),
            ];
            if !use_fts {
                for (i,term) in terms.iter().enumerate() {
                    sql.push_str(&format!("AND r.terms LIKE '% ' || ?{} || '%' ESCAPE '\\' ",i+7));
                    args.push(Value::Text(escape_like(term)));
                }
            }
            sql.push_str("ORDER BY r.group_id DESC,r.seq DESC LIMIT ?6");
            let mut stmt=c.prepare(&sql)?;
            stmt.query_map(params_from_iter(args.iter()),|r|Ok((r.get::<_,[u8;16]>(0)?,r.get::<_,i64>(1)? as u64,r.get::<_,String>(2)?)))?.collect::<Result<_,_>>().map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        let safe:Vec<_>=rows.into_iter().filter(|(group,seq,_)|self.read(|c| {
            let visible:Option<i64>=c.query_row("SELECT 1 FROM app_messages WHERE group_id=?1 AND seq=?2 AND status=0 AND type=0",params![group.as_slice(),*seq as i64],|r|r.get(0)).optional()?;
            Ok(visible.is_some())
        }).unwrap_or(false)).collect();
        e.array(safe.len());
        for (group, seq, body) in safe {
            let snippet: String = body.chars().take(160).collect();
            e.array(4).bytes(&group).uint(seq).text(&snippet).uint(0);
        }
        Ok(e.into_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::escape_like;

    #[test]
    fn like_wildcards_and_escape_character_are_quoted() {
        assert_eq!(escape_like("plain"), "plain");
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }
}
