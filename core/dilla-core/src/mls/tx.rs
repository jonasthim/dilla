//! `BEGIN IMMEDIATE … COMMIT` around an OpenMLS call (R12).
//!
//! `merge_staged_commit` performs up to 15 storage writes with no transaction hook on the trait
//! (gap-7 section 2.1), so the boundary has to be drawn here, outside the provider.
//!
//! `BEGIN IMMEDIATE` rather than the default deferred begin: it takes the write lock up front, so
//! two clients sharing a file fail fast instead of half-way through a merge.

use super::{DillaStorage, StorageError};

/// What went wrong, and how far the transaction got.
#[derive(Debug, thiserror::Error)]
pub enum TxError<E> {
    #[error("begin: {0}")]
    Begin(StorageError),
    #[error("commit: {0}")]
    Commit(StorageError),
    #[error("rolled back")]
    RolledBack(#[source] E),
    #[error("rollback failed after {cause}: {rollback}")]
    RollbackFailed {
        cause: String,
        rollback: StorageError,
    },
}

impl DillaStorage {
    /// Runs `f` inside one SQLite transaction. On any error the transaction is rolled back and the
    /// caller's error is returned inside `TxError::RolledBack`.
    ///
    /// **After a rollback the in-memory `MlsGroup` is invalid** (gap-7 section 4 item 1): the
    /// caller drops its handle and reloads. `DillaGroup` turns that into `MlsError::NeedsReload`.
    /// `E: Debug` beyond the interface's `E: From<StorageError>`: `RollbackFailed.cause` is a
    /// `String` rendered from the caller's error, which needs `Debug` on `E`. Every error type
    /// that reaches here already derives it.
    pub fn transaction<T, E: From<StorageError> + core::fmt::Debug>(
        &self,
        f: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, TxError<E>> {
        self.exec("BEGIN IMMEDIATE").map_err(TxError::Begin)?;
        match f() {
            Ok(value) => match self.exec("COMMIT") {
                Ok(()) => Ok(value),
                Err(e) => Err(TxError::Commit(e)),
            },
            Err(cause) => match self.exec("ROLLBACK") {
                Ok(()) => Err(TxError::RolledBack(cause)),
                Err(rollback) => Err(TxError::RollbackFailed {
                    cause: format!("{cause:?}"),
                    rollback,
                }),
            },
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::{TKey, TVal};
    use crate::mls::{DillaStorage, StorageError};
    use openmls_traits::storage::StorageProvider as _;
    use std::sync::{Arc, Mutex};

    fn memory() -> DillaStorage {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        let s = DillaStorage::new(Arc::new(Mutex::new(conn)));
        s.migrate().expect("migrate");
        s
    }

    #[test]
    fn a_committed_transaction_keeps_every_write() {
        let s = memory();
        let g = TKey(b"group-1".to_vec());
        let out: Result<u8, TxError<StorageError>> = s.transaction(|| {
            s.write_tree(&g, &TVal(1))?;
            s.write_context(&g, &TVal(2))?;
            Ok(7)
        });
        assert_eq!(out.unwrap(), 7);
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(2)));
    }

    #[test]
    fn a_failing_transaction_leaves_no_row_behind() {
        let s = memory();
        let g = TKey(b"group-1".to_vec());
        let out: Result<(), TxError<StorageError>> = s.transaction(|| {
            s.write_tree(&g, &TVal(1))?;
            s.write_context(&g, &TVal(2))?;
            Err(StorageError::Codec("deliberate".into()))
        });
        assert!(matches!(
            out,
            Err(TxError::RolledBack(StorageError::Codec(_)))
        ));
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, None);
    }

    #[test]
    fn a_nested_transaction_is_refused_rather_than_silently_flattened() {
        let s = memory();
        let out: Result<(), TxError<StorageError>> = s.transaction(|| {
            let inner: Result<(), TxError<StorageError>> = s.transaction(|| Ok(()));
            assert!(matches!(inner, Err(TxError::Begin(_))));
            Ok(())
        });
        assert!(out.is_ok());
    }
}
