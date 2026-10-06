//! The delivery service's structural view of a group.
//!
//! This module never holds a group secret. It exists so dillad - through the wasi ABI - can
//! validate every Proposal, Commit and GroupInfo, maintain the ratchet tree it serves to joiners,
//! and issue external Add and Remove proposals bound to the permission system.

mod state;
mod storage;

pub use state::{
    DillaPublicGroup, ExternalSenderInfo, MemberInfo, PublicGroupError, PublicProcessed,
    external_propose_add, external_propose_remove, validate_key_package,
};
pub use storage::{PublicStore, PublicStoreError};
