//! Stable client error codes at the caller boundary.

use crate::ProtocolError;
use crate::mls::{MlsError, StorageError, TxError};

pub(crate) const E_CORE_INPUT: &str = "E_CORE_INPUT";
pub(crate) const E_CORE_STATE: &str = "E_CORE_STATE";
pub(crate) const E_CORE_NO_IDENTITY: &str = "E_CORE_NO_IDENTITY";
pub(crate) const E_CORE_NOT_FOUND: &str = "E_CORE_NOT_FOUND";
pub(crate) const E_CORE_MLS: &str = "E_CORE_MLS";
pub(crate) const E_CORE_STORAGE: &str = "E_CORE_STORAGE";
pub(crate) const E_CORE_RELOAD: &str = "E_CORE_RELOAD";

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
            MlsError::Storage(e) => Self::new(E_CORE_STORAGE, e.to_string()),
            MlsError::Tx(s) => Self::new(E_CORE_STORAGE, s),
            MlsError::OpenMls(s) => Self::new(E_CORE_MLS, s),
            MlsError::NeedsReload => Self::new(E_CORE_RELOAD, ""),
            MlsError::NotFound => Self::new(E_CORE_NOT_FOUND, ""),
        }
    }
}
impl From<StorageError> for ClientError {
    fn from(e: StorageError) -> Self {
        Self::new(E_CORE_STORAGE, e.to_string())
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
