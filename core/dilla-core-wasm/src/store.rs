//! The browser store: OPFS sahpool + SQLite3 Multiple Ciphers `chacha20` (gap-13, gap-11, R6).
//!
//! wasm-only: `install()` returns `NotSupported` outside a dedicated worker in a secure context,
//! and `rusqlite` on this target is the `sqlite-wasm-rs` FFI backend. The target gate is on
//! `lib.rs`'s `pub mod store;` declaration, not an inner `#![cfg(…)]` here — one gate, one place, and
//! the re-exports in `lib.rs` carry the identical cfg.

use core::cell::RefCell;

use js_sys::Reflect;
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_vfs::sahpool::{OpfsSAHError, OpfsSAHPoolCfgBuilder, OpfsSAHPoolUtil, install};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// The pool registers under the plain name; sqlite3mc creates the encrypting wrapper lazily
/// (gap-13 §3). Opening `opfs-sahpool` directly fails at `PRAGMA key` with the exact message
/// "Setting key failed. Encryption is not supported by the VFS."
const POOL_VFS: &str = "opfs-sahpool";
const ENCRYPTED_VFS: &str = "multipleciphers-opfs-sahpool";
/// Slots include journals; 12 leaves room for one database plus its `-journal` and `-wal`.
const INITIAL_CAPACITY: u32 = 12;
/// Deviation A2-14: the message for a failure of the keyed-pragma batch. Fixed, because the only
/// detail rusqlite could add is built from the statement text, and that statement contains the KEK.
const E_STORE_CIPHER: &str = "E_STORE_CIPHER: setting the cipher or key failed";

#[wasm_bindgen]
#[derive(Clone)]
pub struct StoreOpenConfig {
    directory: String,
    db_name: String,
    kek_hex: String,
}

#[wasm_bindgen]
impl StoreOpenConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(directory: String, db_name: String, kek_hex: String) -> StoreOpenConfig {
        StoreOpenConfig {
            directory,
            db_name,
            kek_hex,
        }
    }
    #[wasm_bindgen(getter)]
    pub fn directory(&self) -> String {
        self.directory.clone()
    }
    #[wasm_bindgen(setter)]
    pub fn set_directory(&mut self, v: String) {
        self.directory = v;
    }
    #[wasm_bindgen(getter)]
    pub fn db_name(&self) -> String {
        self.db_name.clone()
    }
    #[wasm_bindgen(setter)]
    pub fn set_db_name(&mut self, v: String) {
        self.db_name = v;
    }
    #[wasm_bindgen(getter)]
    pub fn kek_hex(&self) -> String {
        self.kek_hex.clone()
    }
    #[wasm_bindgen(setter)]
    pub fn set_kek_hex(&mut self, v: String) {
        self.kek_hex = v;
    }
}

/// NV-7: the variant carrying the `createSyncAccessHandle` DOMException on 0.2.0.
fn error_value(e: &OpfsSAHError) -> JsValue {
    match e {
        OpfsSAHError::CreateSyncAccessHandle(v) => v.clone(),
        other => JsValue::from(js_sys::Error::new(&format!("E_STORE_INSTALL: {other}"))),
    }
}

/// True when the error is OPFS sync-access-handle contention. This is SQLite upstream's own
/// predicate, including the documented Chromium `name` inconsistency (gap-14 §4). Never match on
/// the Display string: 0.2.0's omits the DOMException name entirely.
#[wasm_bindgen]
pub fn is_sah_contention(err: &JsValue) -> bool {
    let prop = |k: &str| {
        Reflect::get(err, &JsValue::from_str(k))
            .ok()
            .and_then(|v| v.as_string())
    };
    match (prop("name").as_deref(), prop("message").as_deref()) {
        (Some("NoModificationAllowedError"), _) => true,
        (Some("DOMException"), Some(m)) => m.starts_with("Access Handles cannot"),
        _ => false,
    }
}

#[wasm_bindgen]
pub struct StoreHandle {
    util: OpfsSAHPoolUtil,
    conn: RefCell<Option<Connection>>,
    db_name: String,
    /// Deviation A2-14. The raw 256-bit device KEK, kept only because `resume()` has to replay
    /// `PRAGMA key` after `unpause_vfs()`. `Zeroizing` wipes it when the handle drops; without it the
    /// key would sit in freed wasm linear memory for the life of the page.
    kek_hex: Zeroizing<String>,
}

fn open_encrypted(db_name: &str, kek_hex: &str) -> Result<Connection, JsValue> {
    let conn = Connection::open_with_flags_and_vfs(db_name, OpenFlags::default(), ENCRYPTED_VFS)
        .map_err(|e| JsValue::from(js_sys::Error::new(&format!("E_STORE_OPEN: {e}"))))?;
    // Order is load-bearing: cipher, then key, then a real read. `PRAGMA key` always reports ok
    // (gap-13 §2.2), so the SELECT is the key check. The statement text carries the key, so it is
    // built into a Zeroizing<String> and wiped as soon as SQLite has parsed it (deviation A2-14).
    let pragmas = Zeroizing::new(format!(
        "PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{kek_hex}';"
    ));
    // Deviation A2-14. The rusqlite error is deliberately dropped instead of being formatted into
    // the message: `Error::SqlInputError` Displays as "{msg} in {sql} at offset {offset}" — the
    // whole statement text — and this statement carries the raw device KEK, which `store_open`
    // would then hand to JavaScript as an Error the worker logs. Only the SQLite result code is
    // safe to keep, and it adds nothing a caller can act on here, so the message is fixed.
    conn.execute_batch(&pragmas)
        .map_err(|_| JsValue::from(js_sys::Error::new(E_STORE_CIPHER)))?;
    drop(pragmas);
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|e| JsValue::from(js_sys::Error::new(&format!("E_STORE_KEY: {e}"))))?;
    Ok(conn)
}

/// Deviation A2-3: the error type is `JsValue`, not `JsError`, so the original DOMException reaches
/// [`is_sah_contention`] unchanged. One attempt only — gap-14 §5's 6-attempt schedule lives in the
/// worker, which is where the attempt count is observable.
#[wasm_bindgen]
pub async fn store_open(cfg: StoreOpenConfig) -> Result<StoreHandle, JsValue> {
    if cfg.kek_hex.len() != 64 || !cfg.kek_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(JsValue::from(js_sys::Error::new(
            "E_STORE_KEK: kek_hex must be 64 hex characters",
        )));
    }
    let pool_cfg = OpfsSAHPoolCfgBuilder::new()
        .vfs_name(POOL_VFS)
        .directory(&cfg.directory)
        .clear_on_init(false)
        .initial_capacity(INITIAL_CAPACITY)
        .build();
    // default_vfs = false: making the pool the default would displace the sqlite3mc-wrapped default
    // and PRAGMA key would fail (gap-13 §3). The bound on 0.2.0 is `C: OsCallback` alone.
    let util = install::<WasmOsCallback>(&pool_cfg, false)
        .await
        .map_err(|e| error_value(&e))?;
    let conn = open_encrypted(&cfg.db_name, &cfg.kek_hex)?;
    Ok(StoreHandle {
        util,
        conn: RefCell::new(Some(conn)),
        db_name: cfg.db_name,
        kek_hex: Zeroizing::new(cfg.kek_hex),
    })
}

#[wasm_bindgen]
impl StoreHandle {
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, JsError> {
        let guard = self.conn.borrow();
        let conn = guard
            .as_ref()
            .ok_or_else(|| JsError::new("E_STORE_PAUSED: the store is paused"))?;
        f(conn).map_err(|e| JsError::new(&format!("E_STORE_SQL: {e}")))
    }

    pub fn exec(&self, sql: &str) -> Result<(), JsError> {
        self.with_conn(|c| c.execute_batch(sql))
    }

    pub fn query_scalar_i64(&self, sql: &str) -> Result<i64, JsError> {
        self.with_conn(|c| c.query_row(sql, [], |r| r.get::<_, i64>(0)))
    }

    /// `get_capacity` — the 0.2.0 spelling (gap-11 §0), not `capacity()`.
    pub fn capacity(&self) -> u32 {
        self.util.get_capacity()
    }

    /// `reserve_minimum_capacity` — the 0.2.0 spelling, not `ensure_capacity`.
    ///
    /// NV-13: `&self` on an exported `async fn` is what step 1 item 5 confirms. wasm-bindgen
    /// 0.2.128 accepts a borrowed receiver on an exported `async fn` — its codegen selects
    /// `LongRefFromWasmAbi` for exactly this case — so §2.11's signature stands unchanged.
    /// `reserve_capacity` is called for real by task 17's worker right after open; `resume()` is not
    /// exercised by the week-1 spike, which only ever pauses on the resign path.
    pub async fn reserve_capacity(&self, n: u32) -> Result<(), JsError> {
        self.util
            .reserve_minimum_capacity(n)
            .await
            .map_err(|e| JsError::new(&format!("E_STORE_CAPACITY: {e}")))
    }

    /// Deviation A2-4: drops the connection first — `pause_vfs()` errors while any file handle is
    /// open, and 0.2.0 has no typed `Busy` to tell that apart from a real failure (gap-11 §9 item 5).
    pub fn pause(&self) -> Result<(), JsError> {
        drop(self.conn.borrow_mut().take());
        self.util
            .pause_vfs()
            .map_err(|e| JsError::new(&format!("E_STORE_PAUSE: {e}")))
    }

    /// Deviation A2-4: reacquires the slots, then reopens the connection and replays the pragmas.
    pub async fn resume(&self) -> Result<(), JsError> {
        self.util
            .unpause_vfs()
            .await
            .map_err(|e| JsError::new(&format!("E_STORE_RESUME: {e}")))?;
        // `open_encrypted` already redacts the one arm whose statement carries the KEK (A2-14).
        // The JsValue is still dropped rather than re-wrapped here, so a future arm added over
        // there cannot leak through this path either.
        let conn = open_encrypted(&self.db_name, &self.kek_hex)
            .map_err(|_| JsError::new("E_STORE_RESUME: reopening the keyed connection failed"))?;
        *self.conn.borrow_mut() = Some(conn);
        Ok(())
    }

    pub fn close(self) {
        drop(self.conn.borrow_mut().take());
    }
}

/// Deviation A2-14. The fixed stand-in for a rusqlite error raised by a statement that carries key
/// material and whose `Display` is not known to be key-free.
const E_STORE_PROBE_REDACTED: &str =
    "E_STORE_PROBE: the keyed pragma batch failed (detail withheld: it can carry the statement)";

/// Deviation A2-14, for deviation A2-10's two probes. The only rendering of a rusqlite error that
/// either of them may hand back, because the statement they ran is
/// `PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:<KEK>';` and the caller passes a real device KEK.
///
/// Keeps SQLite's own primary message (`sqlite3_errmsg`, e.g. "Setting key failed. Encryption is
/// not supported by the VFS." — the string the spike asserts on) and withholds every other
/// variant's `Display`, several of which embed text the caller handed to SQLite.
/// `rusqlite::Error::SqlInputError` is the worst of them: it renders as
/// `"{msg} in {sql} at offset {offset}"` — the whole statement — and `execute_batch` produces it
/// for a prepare-time failure whose result code maps to `ErrorCode::Unknown` (which is what
/// SQLITE_ERROR, the code sqlite3mc raises here, does) whenever `sqlite3_error_offset` is
/// non-negative (rusqlite-0.40.2/src/error.rs:346-351 and :502-509). That variant is
/// `#[cfg(feature = "modern_sqlite")]` and this crate's feature set leaves it off, so today the
/// leak is not reachable — exactly as it was not reachable for `E_STORE_CIPHER`. The guard does not
/// depend on that staying true.
pub fn redacted_sqlite_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(msg)) => msg.clone(),
        rusqlite::Error::SqliteFailure(code, None) => code.to_string(),
        _ => E_STORE_PROBE_REDACTED.to_owned(),
    }
}

/// Deviation A2-10. Proves gap-13 §3's trap is real and stays real: a connection opened on the
/// pool's **plain** VFS name cannot be keyed. Returns SQLite's primary error message (through
/// [`redacted_sqlite_message`] — deviation A2-14: the statement this runs carries the caller's
/// KEK), and errors if the open unexpectedly succeeds — that would mean the encrypting wrapper is
/// no longer needed and the store's VFS choice must be revisited. Call only after `store_open` has
/// installed the pool.
#[wasm_bindgen]
pub fn unencrypted_vfs_probe(db_name: &str, kek_hex: &str) -> Result<String, JsError> {
    let conn = Connection::open_with_flags_and_vfs(db_name, OpenFlags::default(), POOL_VFS)
        .map_err(|e| JsError::new(&format!("E_STORE_OPEN: {e}")))?;
    let pragmas = Zeroizing::new(format!(
        "PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{kek_hex}';"
    ));
    match conn.execute_batch(&pragmas) {
        Ok(()) => Err(JsError::new(
            "E_STORE_PROBE: the plain VFS accepted a key; gap-13 §3 no longer holds",
        )),
        Err(e) => Ok(redacted_sqlite_message(&e)),
    }
}

/// Deviation A2-10. Opens an **existing, written** database on the encrypting VFS with the wrong key
/// and returns the text of the failure, so the spike can assert where it happened. gap-13 §2.2: the
/// `PRAGMA key` statement always reports ok, so the only evidence the store is really encrypted is
/// that the first real read fails. Returns an error if the wrong key is accepted all the way through
/// the SELECT — that would mean the database is not encrypted at all.
///
/// Call only after `store_open` has installed the pool **and** something has been written: on an
/// empty database there is no page to decrypt and any key succeeds.
#[wasm_bindgen]
pub async fn wrong_key_probe(db_name: &str, kek_hex: &str) -> Result<String, JsError> {
    if kek_hex.len() != 64 || !kek_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(JsError::new(
            "E_STORE_KEK: kek_hex must be 64 hex characters",
        ));
    }
    let conn = Connection::open_with_flags_and_vfs(db_name, OpenFlags::default(), ENCRYPTED_VFS)
        .map_err(|e| JsError::new(&format!("E_STORE_OPEN: {e}")))?;
    let pragmas = Zeroizing::new(format!(
        "PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{kek_hex}';"
    ));
    // Deviation A2-14: the rusqlite error is rendered through the redacting helper, never with
    // `Display` — this statement carries the key the caller passed.
    conn.execute_batch(&pragmas).map_err(|e| {
        JsError::new(&format!(
            "E_STORE_PROBE: the pragmas rejected the wrong key, so this probe proves nothing: {}",
            redacted_sqlite_message(&e)
        ))
    })?;
    drop(pragmas);
    match conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
        r.get::<_, i64>(0)
    }) {
        Ok(_) => Err(JsError::new(
            "E_STORE_PROBE: a wrong key read sqlite_schema; the database is not encrypted",
        )),
        Err(e) => Ok(format!(
            "E_STORE_KEY: SELECT count(*) FROM sqlite_schema: {e}"
        )),
    }
}
