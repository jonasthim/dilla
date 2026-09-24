//! The functional persistence probe of gap-15 §6. Presence checks are insufficient: Firefox and
//! Safari private browsing expose the whole API surface and only fail the call. Run this BEFORE
//! `store_open`, so a `memory` boot never leaves a half-created pool behind (gap-15 AC-5).
//!
//! The target gate is on `lib.rs`'s `pub mod probe;` declaration, not an inner `#![cfg(…)]` here.

use js_sys::Reflect;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    DedicatedWorkerGlobalScope, FileSystemDirectoryHandle, FileSystemFileHandle,
    FileSystemGetFileOptions, FileSystemSyncAccessHandle,
};

/// Deliberately outside the sahpool's own directory (default `.opfs-sahpool`) so a crashed probe
/// can never be mistaken for a pool slot.
const PROBE_NAME: &str = ".dilla-probe";

fn report(mode: &str, reason: Option<&str>) -> String {
    match reason {
        Some(r) => format!("{{\"mode\":\"{mode}\",\"reason\":\"{r}\"}}"),
        None => format!("{{\"mode\":\"{mode}\"}}"),
    }
}

fn dom_name(err: &JsValue) -> String {
    Reflect::get(err, &JsValue::from_str("name"))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_else(|| "UnknownError".to_owned())
}

/// Returns JSON `{"mode":"opfs"|"memory","reason":"…"}`. Never rejects: every failure mode here is
/// a supported product state, and a rejection would be indistinguishable from a bug.
#[wasm_bindgen]
pub async fn probe_persistence() -> Result<String, JsError> {
    let global = js_sys::global();

    let secure = Reflect::get(&global, &JsValue::from_str("isSecureContext"))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !secure {
        return Ok(report("memory", Some("insecure-context")));
    }

    let scope: DedicatedWorkerGlobalScope = match global.dyn_into::<DedicatedWorkerGlobalScope>() {
        Ok(s) => s,
        Err(_) => return Ok(report("memory", Some("not-a-dedicated-worker"))),
    };

    let root: FileSystemDirectoryHandle =
        match JsFuture::from(scope.navigator().storage().get_directory()).await {
            Ok(v) => v.unchecked_into(),
            // Firefox private browsing -> SecurityError; Safari private browsing -> UnknownError.
            Err(e) => {
                return Ok(report(
                    "memory",
                    Some(&format!("getDirectory:{}", dom_name(&e))),
                ));
            }
        };

    let opts = FileSystemGetFileOptions::new();
    opts.set_create(true);
    let file: FileSystemFileHandle =
        match JsFuture::from(root.get_file_handle_with_options(PROBE_NAME, &opts)).await {
            Ok(v) => v.unchecked_into(),
            Err(e) => {
                return Ok(report(
                    "memory",
                    Some(&format!("getFileHandle:{}", dom_name(&e))),
                ));
            }
        };

    match JsFuture::from(file.create_sync_access_handle()).await {
        Ok(v) => {
            let handle: FileSystemSyncAccessHandle = v.unchecked_into();
            handle.close();
            let _ = JsFuture::from(root.remove_entry(PROBE_NAME)).await;
            Ok(report("opfs", None))
        }
        Err(e) => {
            let _ = JsFuture::from(root.remove_entry(PROBE_NAME)).await;
            Ok(report(
                "memory",
                Some(&format!("createSyncAccessHandle:{}", dom_name(&e))),
            ))
        }
    }
}
