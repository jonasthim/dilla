//! dilla-testkit v0: N headless native `dilla-core` clients against an in-memory delivery service,
//! driven by a line-oriented scenario language.
//!
//! The stub enforces the four week-1 DS invariants (registration with the binding, tree service,
//! one commit per epoch, the KeyPackage directory) and nothing else. Invariants 5-11 belong to the
//! dillad plan; the methods that would enforce them here succeed without checking.

mod client;
mod ds;
mod scenario;

pub use client::{Received, TestClient};
pub use ds::{
    CommitAccepted, CommitUpload, DsError, DsStub, Frame, GroupInfoResponse, GroupRegistered,
    HandshakeItem, InstanceConfig, MessageAccepted, MessageItem, RegisterGroup, TreeResponse,
};
pub use scenario::{ParseError, RunReport, Runner, Scenario, StepResult, Stmt, parse};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TestkitError {
    #[error(transparent)]
    Ds(#[from] DsError),
    #[error(transparent)]
    Core(#[from] dilla_core::CoreError),
    #[error("scenario: {0}")]
    Scenario(String),
    #[error("assertion: {0}")]
    Assertion(String),
}

impl From<dilla_core::ProtocolError> for TestkitError {
    fn from(e: dilla_core::ProtocolError) -> Self {
        TestkitError::Core(e.into())
    }
}

impl From<dilla_core::mls::MlsError> for TestkitError {
    fn from(e: dilla_core::mls::MlsError) -> Self {
        TestkitError::Core(e.into())
    }
}

impl From<dilla_core::mls::StorageError> for TestkitError {
    fn from(e: dilla_core::mls::StorageError) -> Self {
        TestkitError::Core(e.into())
    }
}
