//! The two handle classes of interfaces §2.10: public groups and staged commits.
//!
//! R9: PublicGroup state lives in module memory. A handle is valid only inside the instance that
//! created it; wazero gives every goroutine its own instance (facts-wazero §3), so the table is a
//! plain `thread_local!` with no locking.

use core::cell::RefCell;
use std::collections::BTreeMap;

use dilla_core::public_group::{DillaPublicGroup, PublicProcessed};

use crate::abi::AbiError;

/// No `#[derive(Default)]`: a derived default would set `next: 0`, and handle 0 is the one value the
/// ABI treats as never valid. `Table::new()` is the only constructor — the `Default` impl below
/// delegates to it rather than deriving, which is what keeps `next` at 1.
pub struct Table {
    groups: BTreeMap<u32, DillaPublicGroup>,
    staged: BTreeMap<u32, PublicProcessed>,
    next: u32,
}

/// Hand-written, never derived (`clippy::new_without_default` asks for it and a derive would be
/// wrong): every `Table` starts with `next == 1`.
impl Default for Table {
    fn default() -> Self {
        Self::new()
    }
}

impl Table {
    pub fn new() -> Self {
        Self {
            groups: BTreeMap::new(),
            staged: BTreeMap::new(),
            next: 1,
        }
    }

    /// Handles never repeat and never wrap to 0, so a stale handle is always a miss, never a hit
    /// on somebody else's group.
    fn next_id(&mut self) -> u32 {
        let id = self.next;
        self.next = self.next.checked_add(1).expect("handle space exhausted");
        id
    }

    pub fn insert_group(&mut self, group: DillaPublicGroup) -> u32 {
        let id = self.next_id();
        self.groups.insert(id, group);
        id
    }

    pub fn group(&self, handle: u32) -> Result<&DillaPublicGroup, AbiError> {
        self.groups
            .get(&handle)
            .ok_or_else(|| AbiError::handle(format!("no group for handle {handle}")))
    }

    pub fn group_mut(&mut self, handle: u32) -> Result<&mut DillaPublicGroup, AbiError> {
        self.groups
            .get_mut(&handle)
            .ok_or_else(|| AbiError::handle(format!("no group for handle {handle}")))
    }

    pub fn close_group(&mut self, handle: u32) -> Result<(), AbiError> {
        self.groups
            .remove(&handle)
            .map(|_| ())
            .ok_or_else(|| AbiError::handle(format!("no group for handle {handle}")))
    }

    pub fn insert_staged(&mut self, processed: PublicProcessed) -> u32 {
        let id = self.next_id();
        self.staged.insert(id, processed);
        id
    }

    pub fn take_staged(&mut self, handle: u32) -> Result<PublicProcessed, AbiError> {
        self.staged
            .remove(&handle)
            .ok_or_else(|| AbiError::handle(format!("no staged commit for handle {handle}")))
    }

    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    pub fn staged_count(&self) -> usize {
        self.staged.len()
    }
}

thread_local! {
    static TABLE: RefCell<Table> = RefCell::new(Table::new());
}

/// Runs `f` against this instance's table.
pub fn with_table<T>(f: impl FnOnce(&mut Table) -> T) -> T {
    TABLE.with(|t| f(&mut t.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_group_handle_is_e_abi_handle_not_a_panic() {
        let t = Table::new();
        let err = t.group(1).unwrap_err();
        assert_eq!(err.code, crate::abi::E_ABI_HANDLE);
        assert!(err.detail.contains('1'));
    }

    #[test]
    fn a_missing_staged_handle_is_e_abi_handle() {
        let mut t = Table::new();
        assert_eq!(t.take_staged(9).unwrap_err().code, crate::abi::E_ABI_HANDLE);
    }

    /// The staged table's full positive path, because `PublicProcessed::Rejected` is the one variant
    /// constructible without an MLS fixture. The group table's positive path
    /// (`insert_group` → `group` hit → `close_group` Ok → second `close_group` E_ABI_HANDLE) is driven
    /// end to end by `public_group_close_twice_is_a_bad_handle_the_second_time` in step 10, which has a
    /// real `DillaPublicGroup` from the committed fixture.
    #[test]
    fn a_staged_handle_is_issued_once_taken_once_and_then_gone() {
        let mut t = Table::new();
        assert_eq!(t.staged_count(), 0);
        let a = t.insert_staged(PublicProcessed::Rejected(
            dilla_core::ProtocolError::Binding,
        ));
        let b = t.insert_staged(PublicProcessed::Rejected(
            dilla_core::ProtocolError::Binding,
        ));
        assert_ne!(a, b, "handles never repeat");
        assert_eq!(t.staged_count(), 2);
        assert!(matches!(t.take_staged(a), Ok(PublicProcessed::Rejected(_))));
        assert_eq!(t.staged_count(), 1);
        assert_eq!(
            t.take_staged(a).unwrap_err().code,
            crate::abi::E_ABI_HANDLE,
            "taking the same staged handle twice must be a bad handle, not a second hit"
        );
    }

    #[test]
    fn ids_are_shared_between_the_two_classes_so_a_staged_id_is_never_a_group_id() {
        let mut t = Table::new();
        let staged = t.insert_staged(PublicProcessed::Rejected(
            dilla_core::ProtocolError::Binding,
        ));
        assert_eq!(t.group(staged).unwrap_err().code, crate::abi::E_ABI_HANDLE);
        assert_eq!(t.group_count(), 0);
    }

    #[test]
    fn handles_start_at_one_so_zero_is_never_valid() {
        let mut t = Table::new();
        assert_eq!(t.next_id(), 1);
        assert_eq!(t.group(0).unwrap_err().code, crate::abi::E_ABI_HANDLE);
    }
}
