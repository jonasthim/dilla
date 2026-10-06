//! Device-local settings (L-CORE-25, Q24): text keys and values in app_settings; nothing syncs across devices.

use super::error::E_CORE_INPUT;
use super::{ClientCore, ClientError};
use crate::cbor::Encoder;
use rusqlite::params;

const MAX_KEY: usize = 128;
const MAX_VALUE: usize = 1024;

impl ClientCore {
    /// [[key tstr, value tstr]] in key order.
    pub fn settings(&self) -> Result<Vec<u8>, ClientError> {
        let rows: Vec<(String, String)> = self.read(|c| {
            let mut stmt = c.prepare("SELECT k, v FROM app_settings ORDER BY k")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(Into::into)
        })?;
        let mut e = Encoder::new();
        e.array(rows.len());
        for (k, v) in rows {
            e.array(2).text(&k).text(&v);
        }
        Ok(e.into_vec())
    }

    pub fn setting_put(&mut self, k: &str, v: &str) -> Result<(), ClientError> {
        if !(1..=MAX_KEY).contains(&k.len()) {
            return Err(ClientError::new(E_CORE_INPUT, "key must be 1..=128 bytes"));
        }
        if v.len() > MAX_VALUE {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "value must be at most 1024 bytes",
            ));
        }
        self.write(|_, u| {
            u.with_conn(|c| {
                c.execute(
                    "INSERT INTO app_settings (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
                    params![k, v],
                )?;
                Ok(())
            })?;
            Ok(())
        })
    }

    pub fn setting_delete(&mut self, k: &str) -> Result<(), ClientError> {
        self.write(|_, u| {
            u.with_conn(|c| {
                c.execute("DELETE FROM app_settings WHERE k = ?1", [k])?;
                Ok(())
            })?;
            Ok(())
        })
    }
}
