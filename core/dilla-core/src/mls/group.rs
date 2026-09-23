//! The transactional `MlsGroup` wrapper.
//!
//! Every state-changing OpenMLS call runs inside one `BEGIN IMMEDIATE ... COMMIT`, because the
//! `StorageProvider` trait has no transaction hook and `merge_staged_commit` alone performs up to
//! 15 writes (gap-7 section 2.1). After a rollback the in-memory `MlsGroup` is invalid, so the
//! wrapper returns `MlsError::NeedsReload` and the caller reloads.

use super::{
    DillaBinding, DillaProvider, GroupKind, StorageError, TxError, create_config, join_config,
    past_epoch_sweep, validate_staged_commit,
};
use crate::envelope::Envelope;
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};
use crate::sframe::NK;
use openmls::extensions::ExternalSendersExtension;
// Not in `openmls::prelude` in 0.9.0 (verified: `prelude.rs` re-exports `messages::{external_proposals,
// proposals, proposals_in}::*` but not `messages::group_info`, and `treesync::RatchetTreeIn` but not
// `treesync::RatchetTree`), so both are named by their own paths.
use openmls::messages::group_info::{GroupInfo, VerifiableGroupInfo};
use openmls::prelude::*;
use openmls::treesync::RatchetTree;
use openmls_basic_credential::SignatureKeyPair;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum MlsError {
    #[error(transparent)]
    Protocol(ProtocolError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("transaction: {0}")]
    Tx(String),
    #[error("openmls: {0}")]
    OpenMls(String),
    #[error("group handle is stale after a rollback; reload it")]
    NeedsReload,
    #[error("group not found")]
    NotFound,
}

/// Lives here rather than in `binding.rs`: `MlsError` is defined in this module, and `binding` is
/// ungated so that `wasm32-wasip1` — which has no `rusqlite` and therefore no `group` module —
/// still gets `DillaBinding`. An `impl` in `binding.rs` would not resolve there.
impl From<ProtocolError> for MlsError {
    fn from(e: ProtocolError) -> Self {
        MlsError::Protocol(e)
    }
}

/// A rollback caused by the **database** leaves the in-memory `MlsGroup` invalid (gap-7 section 4
/// item 1): the caller must drop the handle and `DillaGroup::load` again, which is what
/// `NeedsReload` says. A rollback caused by a **protocol** rejection - dilla's own binding check,
/// or an OpenMLS validation failure such as `InsufficientCapabilities` - wrote nothing and must
/// reach the caller as itself; collapsing it into `NeedsReload` would hide every refusal behind
/// "reload me". `mls_err` below is what puts a storage failure into `MlsError::Storage` so this
/// can tell the two apart.
impl From<TxError<MlsError>> for MlsError {
    fn from(e: TxError<MlsError>) -> Self {
        match e {
            TxError::RolledBack(MlsError::Storage(_)) => MlsError::NeedsReload,
            TxError::RolledBack(inner) => inner,
            other => MlsError::Tx(format!("{other:?}")),
        }
    }
}

/// What a committer uploads. `group_info` is **without** the ratchet tree (DS invariant 2).
///
/// OpenMLS produces one `Welcome` addressed to every member added by the commit; dilla's DS API
/// wants it per device, so the same blob is listed once per added device and the DS fans it out.
///
/// `Debug` because the tests `expect_err` on `Result<CommitBundle, MlsError>`, which requires it.
#[derive(Debug)]
pub struct CommitBundle {
    pub commit: MlsMessageOut,
    pub welcomes: Vec<(DeviceId, MlsMessageOut)>,
    pub group_info: Option<GroupInfo>,
}

#[derive(Debug)]
pub enum DillaProcessed {
    Application(Envelope),
    Proposal(Box<QueuedProposal>),
    ExternalJoinProposal(Box<QueuedProposal>),
    StagedCommit(Box<StagedCommit>),
    OwnPendingCommit,
    OwnPrivateMessage,
}

/// `Debug` because the tests `expect_err` on `Result<DillaGroup, MlsError>`, which requires it.
/// `MlsGroup` itself derives `Debug` in 0.9.0, and nothing here prints a secret: the derive only
/// reaches OpenMLS's own redacted formatting.
#[derive(Debug)]
pub struct DillaGroup {
    group: MlsGroup,
    binding: DillaBinding,
}

fn openmls<E: core::fmt::Debug>(e: E) -> MlsError {
    MlsError::OpenMls(format!("{e:?}"))
}

/// OpenMLS names the provider's own failure in a plain `StorageError(_)` variant: no `#[from]`,
/// no `#[source]`, so `std::error::Error::source()` never reaches it and `format!("{e:?}")`
/// flattens it into a string. A typed match is the only way the wrapper can tell "the database
/// refused the write" from "the protocol refused the operation"; see the `From<TxError<MlsError>>`
/// impl above for why the difference matters.
trait SplitStorage: Sized {
    fn split_storage(self) -> Result<StorageError, Self>;
}

macro_rules! split_storage {
    ($($ty:ident),* $(,)?) => {$(
        impl SplitStorage for $ty<StorageError> {
            // `DeletePastEpochSecretsError` has exactly one variant, so its `other` arm is
            // unreachable; every other enum in the list needs it.
            #[allow(unreachable_patterns)]
            fn split_storage(self) -> Result<StorageError, Self> {
                match self {
                    $ty::StorageError(e) => Ok(e),
                    other => Err(other),
                }
            }
        }
    )*};
}

split_storage!(
    NewGroupError,
    WelcomeError,
    ExternalCommitError,
    ProcessMessageError,
    DeletePastEpochSecretsError,
    MergeCommitError,
);

/// The three commit builders wrap theirs one level deeper, in
/// `CommitBuilderStageError::KeyStoreError` - the only storage variant that enum has.
macro_rules! split_storage_commit {
    ($($ty:ident),* $(,)?) => {$(
        impl SplitStorage for $ty<StorageError> {
            fn split_storage(self) -> Result<StorageError, Self> {
                match self {
                    $ty::StorageError(e)
                    | $ty::CommitBuilderStageError(CommitBuilderStageError::KeyStoreError(e)) => {
                        Ok(e)
                    }
                    other => Err(other),
                }
            }
        }
    )*};
}

split_storage_commit!(AddMembersError, RemoveMembersError, SelfUpdateError);

impl SplitStorage for MergePendingCommitError<StorageError> {
    fn split_storage(self) -> Result<StorageError, Self> {
        match self {
            MergePendingCommitError::MergeCommitError(MergeCommitError::StorageError(e)) => Ok(e),
            other => Err(other),
        }
    }
}

/// `openmls`, but keeping a storage failure typed.
fn mls_err<E: SplitStorage + core::fmt::Debug>(e: E) -> MlsError {
    match e.split_storage() {
        Ok(storage) => MlsError::Storage(storage),
        Err(other) => openmls(other),
    }
}

/// The user a credential belongs to, read from its `CredentialIdentity`.
fn user_of_credential(credential: &Credential) -> Result<UserId, MlsError> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(openmls)?;
    crate::identity::CredentialIdentity::decode(basic.identity())
        .map(|id| id.user_id)
        .map_err(MlsError::Protocol)
}

/// The device a KeyPackage belongs to, read from its leaf credential.
fn device_of(kp: &KeyPackage) -> Result<DeviceId, MlsError> {
    // Verified in step 1: `KeyPackage::leaf_node(&self) -> &LeafNode`
    // (openmls-0.9.0/src/key_packages/mod.rs:477).
    let credential = kp.leaf_node().credential().clone();
    let basic = BasicCredential::try_from(credential).map_err(openmls)?;
    let identity = crate::identity::CredentialIdentity::decode(basic.identity())
        .map_err(MlsError::Protocol)?;
    Ok(identity.device_id)
}

impl DillaGroup {
    /// T1 create: 8 writes in one transaction.
    pub fn create(
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        credential: CredentialWithKey,
        group_id: GroupId,
        binding: DillaBinding,
        ext_senders: Option<ExternalSendersExtension>,
    ) -> Result<Self, MlsError> {
        let config = create_config(&binding, ext_senders)?;
        let group = provider.storage().transaction(|| {
            MlsGroup::new_with_group_id(provider, signer, &config, group_id, credential)
                .map_err(mls_err)
        })?;
        Ok(Self { group, binding })
    }

    pub fn load(provider: &DillaProvider, group_id: &GroupId) -> Result<Option<Self>, MlsError> {
        let Some(group) =
            MlsGroup::load(provider.storage(), group_id).map_err(MlsError::Storage)?
        else {
            return Ok(None);
        };
        let binding = DillaBinding::from_group_context(group.public_group().group_context())
            .map_err(MlsError::Protocol)?;
        Ok(Some(Self { group, binding }))
    }

    /// T2 welcome join. The binding is checked on the **staged** welcome, before `into_group`
    /// writes anything: a mismatched Welcome must leave no group behind.
    pub fn join_from_welcome(
        provider: &DillaProvider,
        welcome: Welcome,
        ratchet_tree: RatchetTreeIn,
        expected: &DillaBinding,
    ) -> Result<Self, MlsError> {
        let group = provider.storage().transaction(|| {
            let staged = StagedWelcome::new_from_welcome(
                provider,
                &join_config(expected.kind),
                welcome,
                Some(ratchet_tree),
            )
            .map_err(mls_err)?;
            let binding = DillaBinding::from_group_context(staged.group_context())
                .map_err(MlsError::Protocol)?;
            binding.matches(expected).map_err(MlsError::Protocol)?;
            staged.into_group(provider).map_err(mls_err)
        })?;
        Ok(Self {
            group,
            binding: expected.clone(),
        })
    }

    /// T3 external join: 8 writes.
    ///
    /// `MlsGroup::join_by_external_commit` is `#[deprecated]` in 0.9.0 in favour of
    /// `MlsGroup::external_commit_builder`. The brief pins this call, and replacing it is a
    /// contract change, not an implementation detail, so the deprecation is allowed here and
    /// nowhere else; `-D warnings` would otherwise reject the crate.
    #[allow(deprecated)]
    pub fn join_by_external_commit(
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        credential: CredentialWithKey,
        group_info: VerifiableGroupInfo,
        ratchet_tree: RatchetTreeIn,
        expected: &DillaBinding,
    ) -> Result<(Self, MlsMessageOut, Option<GroupInfo>), MlsError> {
        let (group, commit, info) = provider.storage().transaction(|| {
            MlsGroup::join_by_external_commit(
                provider,
                signer,
                Some(ratchet_tree),
                group_info,
                &join_config(expected.kind),
                Some(super::leaf_capabilities()),
                None,
                &[],
                credential,
            )
            .map_err(mls_err)
        })?;
        let binding = DillaBinding::from_group_context(group.public_group().group_context())
            .map_err(MlsError::Protocol)?;
        binding.matches(expected).map_err(MlsError::Protocol)?;
        Ok((Self { group, binding }, commit, info))
    }

    /// T4 create commit.
    pub fn add_members(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        key_packages: &[KeyPackage],
    ) -> Result<CommitBundle, MlsError> {
        if key_packages.len() > super::MAX_ADDS_PER_COMMIT {
            return Err(MlsError::Protocol(ProtocolError::Binding));
        }
        let devices: Vec<DeviceId> = key_packages
            .iter()
            .map(device_of)
            .collect::<Result<_, _>>()?;
        let group = &mut self.group;
        let (commit, welcome, group_info) = provider.storage().transaction(|| {
            group
                .add_members(provider, signer, key_packages)
                .map_err(mls_err)
        })?;
        Ok(CommitBundle {
            commit,
            welcomes: devices.into_iter().map(|d| (d, welcome.clone())).collect(),
            group_info,
        })
    }

    /// T4 create commit.
    pub fn remove_members(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        members: &[LeafNodeIndex],
    ) -> Result<CommitBundle, MlsError> {
        let group = &mut self.group;
        let (commit, welcome, group_info) = provider.storage().transaction(|| {
            group
                .remove_members(provider, signer, members)
                .map_err(mls_err)
        })?;
        // `CommitBundle.welcomes` is the DS's per-device fan-out key. OpenMLS emits a Welcome only
        // for a commit that adds members, so this is always `None` here; inventing an all-zero
        // `DeviceId` for it would address a Welcome to a device that does not exist. If a future
        // commit path ever both adds and removes, resolve the added devices the way `add_members`
        // does rather than reinstating a placeholder.
        debug_assert!(welcome.is_none(), "a remove-only commit emits no Welcome");
        Ok(CommitBundle {
            commit,
            welcomes: Vec::new(),
            group_info,
        })
    }

    /// T4 create commit.
    pub fn self_update(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
    ) -> Result<CommitBundle, MlsError> {
        let group = &mut self.group;
        let bundle = provider.storage().transaction(|| {
            // Verified in step 1: `LeafNodeParameters` derives `Default`
            // (openmls-0.9.0/src/treesync/node/leaf_node.rs:70) and
            // `CommitMessageBundle::into_contents(self) -> (MlsMessageOut, Option<Welcome>,
            // Option<GroupInfo>)` (src/group/mls_group/commit_builder.rs:1573).
            group
                .self_update(provider, signer, LeafNodeParameters::default())
                .map_err(mls_err)
        })?;
        let (commit, welcome, group_info) = bundle.into_contents();
        // As in `remove_members`: an Update commit adds nobody, so there is no Welcome and no
        // device to address one to.
        debug_assert!(welcome.is_none(), "a self-update commit emits no Welcome");
        Ok(CommitBundle {
            commit,
            welcomes: Vec::new(),
            group_info,
        })
    }

    /// T11 housekeeping: drop a staged commit that will never be merged.
    ///
    /// Two callers need this. The DS 409 loser — "the loser clears its pending commit" (spec line
    /// 591, `protocol/02-delivery-service.md` `commit_conflict`) — and task 13's fixture
    /// generator, which produces ten **alternative** commits at one epoch. Without it the group
    /// stays in `MlsGroupState::PendingCommit` after the first staged commit and every later
    /// `add_members` / `remove_members` / `self_update` fails with
    /// `MlsGroupStateError::PendingCommit`.
    ///
    /// `MlsGroup::clear_pending_commit` takes the **storage**, not the provider (facts-openmls
    /// §4.4, verified from source), and writes `group_state`, so it runs inside a transaction like
    /// every other state change (gap-7 §4, T11).
    pub fn clear_pending_commit(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider.storage().transaction(|| {
            group
                .clear_pending_commit(provider.storage())
                .map_err(MlsError::Storage)
        })?;
        Ok(())
    }

    /// T5 merge: 13-15 writes.
    pub fn merge_pending_commit(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider
            .storage()
            .transaction(|| group.merge_pending_commit(provider).map_err(mls_err))?;
        self.sweep_past_epochs(provider)
    }

    /// T5 merge: 13-15 writes.
    ///
    /// Call this **only** with a `StagedCommit` that `process_message` handed back: that is where
    /// the proposal policy of protocol/01 is enforced (`validate_staged_commit`), and this method
    /// has neither the commit's `Sender` nor its pre-merge tree to re-check it.
    pub fn merge_staged_commit(
        &mut self,
        provider: &DillaProvider,
        staged: StagedCommit,
    ) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider
            .storage()
            .transaction(|| group.merge_staged_commit(provider, staged).map_err(mls_err))?;
        self.sweep_past_epochs(provider)
    }

    /// T6 send. The MLS `authenticated_data` is set to the envelope's 32-byte commitment before
    /// framing, which is what the DS reads and what the receiver checks.
    pub fn create_message(
        &mut self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
        envelope: &Envelope,
    ) -> Result<MlsMessageOut, MlsError> {
        let commitment = envelope.commitment().map_err(MlsError::Protocol)?;
        let body = envelope.encode().map_err(MlsError::Protocol)?;
        let group = &mut self.group;
        // `transaction` returns `Result<T, TxError<MlsError>>`, not `Result<T, MlsError>`; every
        // other call site here ends in `?`, which applies `impl From<TxError<E>> for MlsError`.
        // Returning it directly would be a type error.
        let out = provider.storage().transaction(|| {
            // Verified in step 1: `MlsGroup::set_aad(&mut self, aad: Vec<u8>)`
            // (openmls-0.9.0/src/group/mls_group/mod.rs:329).
            group.set_aad(commitment.to_vec());
            group
                .create_message(provider, signer, &body)
                .map_err(openmls)
        })?;
        Ok(out)
    }

    /// T7 receive. A `PublicMessage` writes nothing; a `PrivateMessage` writes the secret tree
    /// exactly once (gap-7 section 1.2).
    pub fn process_message(
        &mut self,
        provider: &DillaProvider,
        message: ProtocolMessage,
    ) -> Result<DillaProcessed, MlsError> {
        let group = &mut self.group;
        let processed = provider
            .storage()
            .transaction(|| group.process_message(provider, message).map_err(mls_err))?;
        let aad = processed.aad().to_vec();
        // Read before `into_content` consumes the message. `sender()` and `credential()` are
        // verified accessors (facts-openmls section 4.10).
        let sender = processed.sender().clone();
        let committer_user = user_of_credential(processed.credential())?;
        Ok(match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                let envelope = Envelope::decode(&app.into_bytes()).map_err(MlsError::Protocol)?;
                envelope
                    .verify_commitment(&aad)
                    .map_err(MlsError::Protocol)?;
                DillaProcessed::Application(envelope)
            }
            ProcessedMessageContent::ProposalMessage(p) => DillaProcessed::Proposal(p),
            ProcessedMessageContent::ExternalJoinProposalMessage(p) => {
                DillaProcessed::ExternalJoinProposal(p)
            }
            ProcessedMessageContent::StagedCommitMessage(c) => {
                // The proposal policy of protocol/01-groups.md is enforced here, before the caller
                // ever sees the commit: `merge_staged_commit` is a separate call, and a caller
                // that skipped this check would install a commit the protocol forbids.
                // `public_group()` is the tree as it stands *before* the merge, which is the state
                // a `Remove` names.
                validate_staged_commit(
                    self.binding.kind,
                    &self.own_user()?,
                    &committer_user,
                    &sender,
                    self.group.public_group(),
                    c.as_ref(),
                )
                .map_err(MlsError::Protocol)?;
                DillaProcessed::StagedCommit(c)
            }
            ProcessedMessageContent::OwnPendingCommit => DillaProcessed::OwnPendingCommit,
            ProcessedMessageContent::OwnPrivateMessage => DillaProcessed::OwnPrivateMessage,
        })
    }

    /// T8 delete: 14 writes.
    pub fn delete(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let group = &mut self.group;
        provider
            .storage()
            .transaction(|| group.delete(provider.storage()).map_err(MlsError::Storage))?;
        Ok(())
    }

    /// T11 housekeeping. A no-op for pairing and interaction groups, which keep no past epochs.
    pub fn sweep_past_epochs(&mut self, provider: &DillaProvider) -> Result<(), MlsError> {
        let Some(policy) = past_epoch_sweep(self.binding.kind) else {
            return Ok(());
        };
        let group = &mut self.group;
        provider.storage().transaction(|| {
            group
                .delete_past_epoch_secrets(provider, policy)
                .map_err(mls_err)
        })?;
        Ok(())
    }

    pub fn binding(&self) -> &DillaBinding {
        &self.binding
    }

    pub fn kind(&self) -> GroupKind {
        self.binding.kind
    }

    pub fn group_id(&self) -> &GroupId {
        self.group.group_id()
    }

    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    pub fn own_leaf_index(&self) -> LeafNodeIndex {
        self.group.own_leaf_index()
    }

    /// The user this device belongs to, read from its own leaf credential. `own_leaf_node` is in
    /// the 0.9.0 `MlsGroup` method index (facts-openmls §4.11); `LeafNode::credential()` is
    /// "Needs verification" item 9.
    fn own_user(&self) -> Result<UserId, MlsError> {
        let leaf = self.group.own_leaf_node().ok_or(MlsError::NotFound)?;
        user_of_credential(leaf.credential())
    }

    pub fn epoch_authenticator(&self) -> Result<[u8; 32], MlsError> {
        // Verified in step 1: `EpochAuthenticator::as_slice(&self) -> &[u8]`
        // (openmls-0.9.0/src/schedule/mod.rs:209).
        let raw = self.group.epoch_authenticator().as_slice();
        if raw.len() != 32 {
            return Err(MlsError::OpenMls(format!(
                "epoch authenticator is {} bytes",
                raw.len()
            )));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(raw);
        Ok(out)
    }

    /// `MLS-Exporter("SFrame 1.0 Base Key", "", 16)` - the spec's corrected definition.
    pub fn sframe_base_key(&self, provider: &DillaProvider) -> Result<[u8; NK], MlsError> {
        use openmls_traits::OpenMlsProvider as _;
        let raw = self
            .group
            .export_secret(provider.crypto(), crate::sframe::LABEL_BASE_KEY, &[], NK)
            .map_err(openmls)?;
        let mut out = [0u8; NK];
        out.copy_from_slice(&raw);
        Ok(out)
    }

    /// The GroupInfo a committer uploads: **without** the ratchet tree, because the DS serves the
    /// tree from its own `PublicGroup` (DS invariant 2).
    ///
    /// Returns the `MlsMessageOut` that carries it: `MlsGroup::export_group_info` returns a
    /// message, not a bare `GroupInfo` (facts-openmls section 4.7).
    pub fn export_group_info(
        &self,
        provider: &DillaProvider,
        signer: &SignatureKeyPair,
    ) -> Result<MlsMessageOut, MlsError> {
        use openmls_traits::OpenMlsProvider as _;
        self.group
            .export_group_info(provider.crypto(), signer, false)
            .map_err(openmls)
    }

    pub fn export_ratchet_tree(&self) -> RatchetTree {
        self.group.export_ratchet_tree()
    }
}
