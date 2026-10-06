//! `BEGIN IMMEDIATE … COMMIT` around an OpenMLS call (R12).
//!
//! `merge_staged_commit` performs up to 15 storage writes with no transaction hook on the trait
//! (gap-7 section 2.1), so the boundary has to be drawn here, outside the provider.
//!
//! `BEGIN IMMEDIATE` rather than the default deferred begin: it takes the write lock up front, so
//! two clients sharing a file fail fast instead of half-way through a merge.
//!
//! A unit is one outer transaction opened by `ClientCore`. Transactions on the same storage
//! inside it become savepoints, so MLS and app writes commit or roll back together.

use super::{DillaStorage, StorageError};
use core::sync::atomic::Ordering;

const UNIT_NONE: u8 = 0;
const UNIT_OPEN: u8 = 1;
const UNIT_SAVEPOINT: u8 = 2;
const SAVEPOINT: &str = "dilla_tx";

/// What went wrong, and how far the transaction got.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TxError<E> {
    /// A transaction is already open on this `DillaStorage` — a nested `transaction()`, or a
    /// second one from another thread. Nothing was begun, so the open transaction is untouched.
    /// (Addition to interfaces section 1's four variants: SQLite's own nested-BEGIN message is
    /// an implementation detail, and callers need to tell "you asked wrong" apart from "the
    /// database refused".)
    #[error("a transaction is already open on this storage")]
    AlreadyOpen,
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

/// Rolls the transaction back if it is still open when this is dropped — which is what happens
/// when `f` panics and the unwind walks straight past both the COMMIT and the ROLLBACK arm.
/// Without it the `Connection` stays inside an open write transaction for the rest of its life:
/// every later `transaction()` fails at BEGIN, and every later write silently joins the orphan
/// transaction and is thrown away when the handle is dropped.
///
/// The flag is released on every path, armed or not, so a failed BEGIN does not leak the slot.
/// A rollback failure during an unwind cannot be reported anywhere and is deliberately dropped;
/// on the ordinary paths the explicit ROLLBACK below reports it as `TxError::RollbackFailed`.
struct TxGuard<'a> {
    storage: &'a DillaStorage,
    armed: bool,
}

impl Drop for TxGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.storage.exec("ROLLBACK");
        }
        self.storage.leave_tx();
    }
}

struct SavepointGuard<'a> {
    storage: &'a DillaStorage,
    armed: bool,
}

impl Drop for SavepointGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.storage.exec("ROLLBACK TO dilla_tx");
            let _ = self.storage.exec("RELEASE dilla_tx");
        }
        self.storage.unit_state.store(UNIT_OPEN, Ordering::Release);
    }
}

struct UnitGuard<'a> {
    storage: &'a DillaStorage,
    armed: bool,
}

impl Drop for UnitGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.storage.exec("ROLLBACK");
        }
        self.storage.unit_state.store(UNIT_NONE, Ordering::Release);
        #[cfg(not(target_arch = "wasm32"))]
        {
            *self
                .storage
                .unit_owner
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
        }
        self.storage.leave_tx();
    }
}

/// The open unit; the only way to reach the connection while it is open.
pub struct UnitScope<'a> {
    storage: &'a DillaStorage,
}

impl UnitScope<'_> {
    /// Runs `f` while the connection is borrowed. Do not call a storage or group method in `f`;
    /// read raw values there and decode them after it returns.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        if self.storage.unit_state.load(Ordering::Acquire) == UNIT_SAVEPOINT {
            return Err(StorageError::Sqlite(
                "the unit connection is not usable inside a nested transaction".into(),
            ));
        }
        super::storage::with_conn(self.storage.conn(), f)
    }
}

impl DillaStorage {
    fn owns_open_unit(&self) -> bool {
        if self.unit_state.load(Ordering::Acquire) != UNIT_OPEN {
            return false;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.unit_owner
                .lock()
                .is_ok_and(|owner| *owner == Some(std::thread::current().id()))
        }
        #[cfg(target_arch = "wasm32")]
        {
            true
        }
    }

    /// Runs one outer transaction. `transaction` on its owner thread nests as a savepoint;
    /// other callers are refused. An error or panic rolls back the unit. After rollback every
    /// `DillaGroup` touched inside it is stale and must be reloaded.
    pub fn unit<T, E: From<StorageError> + core::fmt::Debug>(
        &self,
        f: impl FnOnce(&UnitScope<'_>) -> Result<T, E>,
    ) -> Result<T, TxError<E>> {
        if !self.try_enter_tx() {
            return Err(TxError::AlreadyOpen);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            *self.unit_owner.lock().unwrap_or_else(|p| p.into_inner()) =
                Some(std::thread::current().id());
        }
        self.unit_state.store(UNIT_OPEN, Ordering::Release);
        let mut guard = UnitGuard {
            storage: self,
            armed: false,
        };
        self.exec("BEGIN IMMEDIATE").map_err(TxError::Begin)?;
        guard.armed = true;
        match f(&UnitScope { storage: self }) {
            Ok(value) => match self.exec("COMMIT") {
                Ok(()) => {
                    guard.armed = false;
                    Ok(value)
                }
                Err(e) => Err(TxError::Commit(e)),
            },
            Err(cause) => {
                guard.armed = false;
                match self.exec("ROLLBACK") {
                    Ok(()) => Err(TxError::RolledBack(cause)),
                    Err(rollback) => Err(TxError::RollbackFailed {
                        cause: format!("{cause:?}"),
                        rollback,
                    }),
                }
            }
        }
    }

    /// Runs `f` inside one SQLite transaction. On any error the transaction is rolled back and the
    /// caller's error is returned inside `TxError::RolledBack`. If `f` **panics**, the transaction
    /// is rolled back by an RAII guard and the panic continues to the caller.
    ///
    /// **One transaction at a time, one storage per connection.** A second `transaction()` on this
    /// storage — nested, or from another thread — is refused with `TxError::AlreadyOpen` and
    /// changes nothing. What this cannot police is a *different* `DillaStorage` (or any other
    /// user) writing through a clone of the same `ConnHandle` while a transaction is open: the
    /// transaction belongs to the connection, so those writes join it and are rolled back with it.
    /// See the ownership invariant documented on `ConnHandle`.
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
        if !self.try_enter_tx() {
            if self.owns_open_unit()
                && self
                    .unit_state
                    .compare_exchange(
                        UNIT_OPEN,
                        UNIT_SAVEPOINT,
                        Ordering::Acquire,
                        Ordering::Relaxed,
                    )
                    .is_ok()
            {
                let mut guard = SavepointGuard {
                    storage: self,
                    armed: false,
                };
                self.exec(&format!("SAVEPOINT {SAVEPOINT}"))
                    .map_err(TxError::Begin)?;
                guard.armed = true;
                return match f() {
                    Ok(value) => match self.exec(&format!("RELEASE {SAVEPOINT}")) {
                        Ok(()) => {
                            guard.armed = false;
                            Ok(value)
                        }
                        Err(e) => Err(TxError::Commit(e)),
                    },
                    Err(cause) => {
                        guard.armed = false;
                        let rollback = self
                            .exec(&format!("ROLLBACK TO {SAVEPOINT}"))
                            .and_then(|()| self.exec(&format!("RELEASE {SAVEPOINT}")));
                        match rollback {
                            Ok(()) => Err(TxError::RolledBack(cause)),
                            Err(rollback) => Err(TxError::RollbackFailed {
                                cause: format!("{cause:?}"),
                                rollback,
                            }),
                        }
                    }
                };
            }
            return Err(TxError::AlreadyOpen);
        }
        // From here on the guard owns the slot: every return below, and every unwind, releases it.
        let mut guard = TxGuard {
            storage: self,
            armed: false,
        };
        self.exec("BEGIN IMMEDIATE").map_err(TxError::Begin)?;
        guard.armed = true;
        match f() {
            // The guard stays armed across COMMIT: a failed COMMIT leaves the transaction open,
            // and the guard's ROLLBACK is the only thing that closes it.
            Ok(value) => match self.exec("COMMIT") {
                Ok(()) => {
                    guard.armed = false;
                    Ok(value)
                }
                Err(e) => Err(TxError::Commit(e)),
            },
            Err(cause) => {
                guard.armed = false;
                match self.exec("ROLLBACK") {
                    Ok(()) => Err(TxError::RolledBack(cause)),
                    Err(rollback) => Err(TxError::RollbackFailed {
                        cause: format!("{cause:?}"),
                        rollback,
                    }),
                }
            }
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
            // A dilla-level refusal, not SQLite's "cannot start a transaction within a
            // transaction": the in-process guard catches it before `BEGIN IMMEDIATE` is issued,
            // so the outer transaction's state is never touched.
            let err = inner.unwrap_err();
            assert_eq!(
                err.to_string(),
                "a transaction is already open on this storage"
            );
            assert!(matches!(err, TxError::AlreadyOpen));
            Ok(())
        });
        assert!(out.is_ok());
    }

    /// The same refusal from another thread: the transaction belongs to the connection, so a
    /// second concurrent `transaction()` on this storage must not be allowed to interleave.
    #[test]
    fn a_second_thread_cannot_open_a_transaction_while_one_is_running() {
        let s = memory();
        let out: Result<(), TxError<StorageError>> = s.transaction(|| {
            std::thread::scope(|scope| {
                let other = scope.spawn(|| {
                    let r: Result<(), TxError<StorageError>> = s.transaction(|| Ok(()));
                    r
                });
                assert!(matches!(other.join().unwrap(), Err(TxError::AlreadyOpen)));
            });
            Ok(())
        });
        assert!(out.is_ok());
    }

    /// A panic inside `f` must not leave the connection inside an open write transaction: the
    /// unwind skips both COMMIT and ROLLBACK, so without an RAII guard every later write on this
    /// handle silently joins the orphan transaction and is discarded when the handle is dropped.
    #[test]
    fn a_panic_inside_a_transaction_rolls_back_and_leaves_the_handle_usable() {
        let s = memory();
        let g = TKey(b"group-1".to_vec());

        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: Result<(), TxError<StorageError>> = s.transaction(|| {
                s.write_tree(&g, &TVal(1))?;
                panic!("openmls exploded mid-merge");
            });
        }));
        assert!(unwound.is_err(), "the panic must reach the caller");

        // The half-finished write is gone.
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);

        // And the handle still takes transactions, which it cannot while wedged inside one.
        let out: Result<u8, TxError<StorageError>> = s.transaction(|| {
            s.write_tree(&g, &TVal(2))?;
            Ok(9)
        });
        assert_eq!(out.unwrap(), 9);
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(2)));
    }
}
