//! An in-memory delivery service. It is a **test double**, not a specification: it enforces the
//! four week-1 invariants of protocol/02 and nothing else (R20). Invariants 5-11 arrive with the
//! dillad plan; the methods that would enforce them succeed without checking.

mod invariants;
mod state;

pub use state::{
    CommitAccepted, CommitUpload, DsError, DsStub, Frame, GroupInfoResponse, GroupRegistered,
    HandshakeItem, InstanceConfig, MessageAccepted, MessageItem, RegisterGroup, TreeResponse,
};
