//! Stable client error codes at the caller boundary.

use crate::ProtocolError;
use crate::mls::{MlsError, StorageError, TxError};

pub(crate) const E_CORE_INPUT: &str = "E_CORE_INPUT";
pub(crate) const E_CORE_LIMIT: &str = "E_CORE_LIMIT";
pub(crate) const E_CREDENTIAL: &str = "E_CREDENTIAL";
pub(crate) const E_UMK_CHANGED: &str = "E_UMK_CHANGED";
pub(crate) const E_DEVICE_UNLISTED: &str = "E_DEVICE_UNLISTED";
pub(crate) const E_DEVICE_LIST_STALE: &str = "E_DEVICE_LIST_STALE";
pub(crate) const E_TIER_MISMATCH: &str = "E_TIER_MISMATCH";
pub(crate) const E_CORE_STATE: &str = "E_CORE_STATE";
pub(crate) const E_CORE_NO_IDENTITY: &str = "E_CORE_NO_IDENTITY";
pub(crate) const E_CORE_NOT_FOUND: &str = "E_CORE_NOT_FOUND";
pub(crate) const E_CORE_MLS: &str = "E_CORE_MLS";
pub(crate) const E_CORE_STORAGE: &str = "E_CORE_STORAGE";
pub(crate) const E_CORE_RELOAD: &str = "E_CORE_RELOAD";
pub(crate) const E_RECOVERY_KEY: &str = "E_RECOVERY_KEY";
pub(crate) const E_BINDING: &str = "E_BINDING";
/// The store was written by a newer client (`StorageError::StoreNewer`); the detail is exactly
/// `found <n>, supported <m>`, which the worker reads at the core's boundary.
pub(crate) const E_STORE_NEWER: &str = "E_STORE_NEWER";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub code: &'static str,
    pub detail: String,
}

impl ClientError {
    pub(crate) fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl core::fmt::Display for ClientError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        if self.detail.is_empty() {
            f.write_str(self.code)
        } else {
            write!(f, "{}: {}", self.code, self.detail)
        }
    }
}
impl std::error::Error for ClientError {}

impl From<ProtocolError> for ClientError {
    fn from(e: ProtocolError) -> Self {
        Self::new(e.code(), "")
    }
}
impl From<MlsError> for ClientError {
    fn from(e: MlsError) -> Self {
        match e {
            MlsError::Protocol(e) => e.into(),
            MlsError::Storage(e) => e.into(),
            MlsError::Tx(s) => Self::new(E_CORE_STORAGE, s),
            MlsError::OpenMls(s) => Self::new(E_CORE_MLS, s),
            MlsError::NeedsReload => Self::new(E_CORE_RELOAD, ""),
            MlsError::NotFound => Self::new(E_CORE_NOT_FOUND, ""),
            MlsError::WelcomeLabel => Self::new(
                E_CORE_INPUT,
                "the Welcome's epoch or tree hash is not the served label",
            ),
        }
    }
}
impl From<StorageError> for ClientError {
    fn from(e: StorageError) -> Self {
        storage_error(e)
    }
}

/// The one mapping of a storage error, out of line so that each `?` carries one call instead of
/// its own copy of the match (wasm size).
#[inline(never)]
fn storage_error(e: StorageError) -> ClientError {
    match e {
        StorageError::StoreNewer { found, supported } => ClientError::new(
            E_STORE_NEWER,
            format!("found {found}, supported {supported}"),
        ),
        other => ClientError::new(E_CORE_STORAGE, other.to_string()),
    }
}
impl From<TxError<ClientError>> for ClientError {
    fn from(e: TxError<ClientError>) -> Self {
        match e {
            TxError::RolledBack(e) => e,
            other => Self::new(E_CORE_STORAGE, other.to_string()),
        }
    }
}
