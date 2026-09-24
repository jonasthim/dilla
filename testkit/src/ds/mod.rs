//! An in-memory delivery service. It is a **test double**, not a specification: it covers R20's
//! week-1 subset of protocol/02 and nothing else — registration with the binding (invariant 1,
//! minus the `mode_readable` channel check), the tree service (invariant 2), one commit per epoch
//! (invariant 3), the KeyPackage directory (Role 1, not an invariant) and the structural clause of
//! invariant 4. The rest of invariant 4's commit-validity rules, and invariants 5-11, arrive with
//! the dillad plan; the methods that would enforce them succeed without checking.

mod invariants;
mod state;

pub use state::{
    CommitAccepted, CommitUpload, DsError, DsStub, Frame, GroupInfoResponse, GroupRegistered,
    HandshakeItem, InstanceConfig, MessageAccepted, MessageItem, RegisterGroup, TreeResponse,
};
