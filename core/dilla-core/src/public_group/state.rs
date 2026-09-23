//! The delivery service's view of a group: the public tree, the epoch, the extensions and the leaf
//! credentials. It holds no group secret and cannot decrypt.

use super::{PublicStore, PublicStoreError};
use crate::error::ProtocolError;
use crate::identity::CredentialIdentity;
use crate::mls::{DILLA_BINDING, DillaBinding, instance_sender_index};
// None of these four is re-exported by `openmls::prelude` in 0.9.0 (the same finding as
// `mls::group`: the prelude re-exports `hash_ref::KeyPackageRef` but not `ProposalRef`,
// `treesync::RatchetTreeIn` but not `RatchetTree`, and nothing from `messages::group_info`).
use openmls::ciphersuite::hash_ref::ProposalRef;
use openmls::messages::group_info::{GroupInfo, VerifiableGroupInfo};
use openmls::prelude::*;
use openmls::treesync::RatchetTree;
use openmls_traits::signatures::Signer;
use tls_codec::Serialize as _;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PublicGroupError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Store(#[from] PublicStoreError),
    #[error("openmls: {0}")]
    OpenMls(String),
    /// `PublicGroup::load` returns `Ok(None)` on a torn write - indistinguishable from "absent"
    /// (gap-1 section 6.1 hazard 1). The wrapper turns that into this error, never into a new
    /// group: re-bootstrapping over live state would silently fork every member.
    #[error("public group state is absent or torn")]
    StateMissing,
}

fn openmls<E: core::fmt::Debug>(e: E) -> PublicGroupError {
    PublicGroupError::OpenMls(format!("{e:?}"))
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MemberInfo {
    pub leaf_index: u32,
    pub signature_key: [u8; 32],
    pub identity: CredentialIdentity,
}

#[derive(Debug)]
pub enum PublicProcessed {
    Proposal {
        proposal_ref: Vec<u8>,
        sender_leaf: Option<u32>,
    },
    ExternalJoinProposal {
        proposal_ref: Vec<u8>,
    },
    StagedCommit {
        staged: Box<StagedCommit>,
        sender_leaf: Option<u32>,
    },
    /// The DS never sees an application message: `process_message` refuses a `PrivateMessage`.
    Rejected(ProtocolError),
}

pub struct DillaPublicGroup {
    group: PublicGroup,
    store: PublicStore,
    binding: DillaBinding,
}

/// Hand-written because neither `PublicGroup` nor `PublicStore` is `Debug`, and because a debug
/// dump of the DS view must never print a tree or a credential into a log line. The two fields
/// here are what identifies the view in an error message.
impl core::fmt::Debug for DillaPublicGroup {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DillaPublicGroup")
            .field("group_id", &self.group.group_id().as_slice())
            .field("epoch", &self.epoch())
            .finish_non_exhaustive()
    }
}

fn sender_leaf(sender: &Sender) -> Option<u32> {
    match sender {
        Sender::Member(index) => Some(index.u32()),
        _ => None,
    }
}

/// Re-frames a `ProtocolMessage` as the `MLSMessage` it arrived in.
///
/// **Deviation from the brief, forced by the crate.** The brief's line was
/// `MlsMessageIn::from(message)`, with a fallback through `MlsMessageIn::from(PublicMessageIn)`.
/// Neither exists in openmls 0.9.0: `src/framing/message_in.rs` declares `MlsMessageIn`'s two
/// fields `pub(crate)` and defines no constructor, `src/framing/message_out.rs:208` has only
/// `From<MlsMessageOut> for MlsMessageIn`, and the one route out of `PublicMessageIn` -
/// `impl From<PublicMessageIn> for PublicMessage` at `src/framing/public_message_in.rs:291` - is
/// `#[cfg(any(feature = "test-utils", test))]` with a comment saying it MUST NOT be available
/// outside tests. So the two-field `MLSMessage` header is written here instead, from public items:
/// `ProtocolVersion` and `WireFormat` both serialise as the `u16` the RFC 9420 presentation
/// language gives them (`versions.rs:48`, `framing/mod.rs:125-136`), and `PublicMessageIn`
/// implements `tls_codec::Serialize` publicly (`framing/public_message_in.rs:264`). The
/// `MlsMessageBodyIn::PublicMessage` discriminant is 1, the same value as
/// `WireFormat::PublicMessage`.
///
/// `queue_proposal`'s byte-for-byte test over a real external Remove proposal is what keeps this
/// honest.
fn reframe_mls_message(message: &ProtocolMessage) -> Result<Vec<u8>, PublicGroupError> {
    let public = match message {
        ProtocolMessage::PublicMessage(public) => public,
        // The DS holds no group secret and must never be asked to decrypt.
        ProtocolMessage::PrivateMessage(_) => return Err(ProtocolError::EnvelopeShape.into()),
    };
    let mut out = Vec::new();
    ProtocolVersion::Mls10
        .tls_serialize(&mut out)
        .map_err(openmls)?;
    WireFormat::PublicMessage
        .tls_serialize(&mut out)
        .map_err(openmls)?;
    public.tls_serialize(&mut out).map_err(openmls)?;
    Ok(out)
}

impl DillaPublicGroup {
    /// Seeds the view from the first committer's GroupInfo and the ratchet tree, and verifies
    /// `dilla_binding` before returning. There is no tree-less variant: the DS must be seeded once
    /// and maintains the tree itself afterwards.
    pub fn from_external(
        crypto: &impl OpenMlsCrypto,
        ratchet_tree: RatchetTreeIn,
        group_info: VerifiableGroupInfo,
    ) -> Result<(Self, GroupInfo), PublicGroupError> {
        let store = PublicStore::new();
        let (group, info) = PublicGroup::from_external(
            crypto,
            &store,
            ratchet_tree,
            group_info,
            ProposalStore::new(),
        )
        .map_err(openmls)?;
        let binding = DillaBinding::from_group_context(group.group_context())?;
        Ok((
            Self {
                group,
                store,
                binding,
            },
            info,
        ))
    }

    pub fn import_state(state: &[u8], group_id: &GroupId) -> Result<Self, PublicGroupError> {
        let store = PublicStore::import(state)?;
        // Two shapes of a torn write reach here and both mean the same thing to the DS, so both
        // become `StateMissing` and neither becomes a new group:
        //   * `PublicGroup::load` returns `Ok(None)` when one of the four entities is absent - it
        //     discards the other three and reports "absent" (gap-1 section 6.1 hazard 1);
        //   * it returns `Err` when an entity is present but does not decode into the type OpenMLS
        //     expects, which is the same damage seen one layer down.
        // The blob itself is a separate question: a body that is not this module's CBOR at all
        // fails in `PublicStore::import` above and surfaces as `Store(Codec(..))`.
        let group = PublicGroup::load(&store, group_id)
            .map_err(|_| PublicGroupError::StateMissing)?
            .ok_or(PublicGroupError::StateMissing)?;
        let binding = DillaBinding::from_group_context(group.group_context())?;
        Ok(Self {
            group,
            store,
            binding,
        })
    }

    pub fn export_state(&self) -> Vec<u8> {
        self.store.export()
    }

    /// `&self`: structural validation writes nothing (facts-openmls section 6). A `PrivateMessage`
    /// is refused outright - the DS holds no secret and must never be asked to decrypt.
    pub fn process_message(
        &self,
        crypto: &impl OpenMlsCrypto,
        message: ProtocolMessage,
    ) -> Result<PublicProcessed, PublicGroupError> {
        if matches!(message, ProtocolMessage::PrivateMessage(_)) {
            return Ok(PublicProcessed::Rejected(ProtocolError::EnvelopeShape));
        }
        let processed = self
            .group
            .process_message(crypto, message)
            .map_err(openmls)?;
        let leaf = sender_leaf(processed.sender());
        Ok(match processed.into_content() {
            ProcessedMessageContent::ProposalMessage(p) => PublicProcessed::Proposal {
                proposal_ref: p.proposal_reference_ref().as_slice().to_vec(),
                sender_leaf: leaf,
            },
            ProcessedMessageContent::ExternalJoinProposalMessage(p) => {
                PublicProcessed::ExternalJoinProposal {
                    proposal_ref: p.proposal_reference_ref().as_slice().to_vec(),
                }
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => PublicProcessed::StagedCommit {
                staged,
                sender_leaf: leaf,
            },
            _ => PublicProcessed::Rejected(ProtocolError::EnvelopeShape),
        })
    }

    /// `PublicGroup::merge_commit` calls `clear_proposal_queue` (gap-1 section 4's call table), and
    /// under ledger ruling A the received `MLSMessage` bytes live in the same queue entries, so
    /// they are dropped with the queue. Without that the map would grow for the lifetime of the
    /// wazero instance - which R9 keeps alive for the whole dillad process - driven purely by
    /// remote input. That is a memory-exhaustion path, not a tidiness question.
    pub fn merge_commit(&mut self, staged: StagedCommit) -> Result<(), PublicGroupError> {
        self.group
            .merge_commit(&self.store, staged)
            .map_err(openmls)
    }

    pub fn add_proposal(&mut self, proposal: QueuedProposal) -> Result<Vec<u8>, PublicGroupError> {
        let reference = proposal.proposal_reference_ref().as_slice().to_vec();
        self.group
            .add_proposal(&self.store, proposal)
            .map_err(openmls)?;
        Ok(reference)
    }

    /// Frames, verifies and queues a proposal the DS received, keeping the original `MLSMessage`
    /// bytes beside it (NV-4 and deviation A2-11, both settled by ruling). Returns the new
    /// proposal's reference bytes.
    ///
    /// This is the **only** route from received bytes to a queued proposal, and it lives here
    /// rather than in `dilla-core-wasi` because building a `QueuedProposal` needs the group context
    /// and signature verification: the wasi crate has no public OpenMLS 0.9.0 route from bytes to
    /// `AuthenticatedContent` and must not invent one. Task 14's `public_group_proposal_put` op 0
    /// is its caller.
    ///
    /// The kept bytes are re-framed from the `ProtocolMessage` rather than passed in beside it: TLS
    /// presentation encoding is canonical, so re-framing reproduces exactly what arrived on the
    /// wire, and there is no second copy for a caller to get wrong. Ledger ruling A puts them in
    /// `PublicStore`, so `export_state()` carries them and a dillad restart does not lose a pending
    /// proposal.
    pub fn queue_proposal(
        &mut self,
        crypto: &impl OpenMlsCrypto,
        message: ProtocolMessage,
    ) -> Result<Vec<u8>, PublicGroupError> {
        // Refuses a `PrivateMessage` exactly as `process_message` refuses it.
        let received = reframe_mls_message(&message)?;

        let processed = self
            .group
            .process_message(crypto, message)
            .map_err(openmls)?;
        let queued = match processed.into_content() {
            ProcessedMessageContent::ProposalMessage(p)
            | ProcessedMessageContent::ExternalJoinProposalMessage(p) => *p,
            // A Commit goes through `process_message` + `merge_commit`, never through the queue.
            _ => return Err(ProtocolError::EnvelopeShape.into()),
        };
        let proposal_ref = queued.proposal_reference_ref().clone();
        let reference = proposal_ref.as_slice().to_vec();
        self.group
            .add_proposal(&self.store, queued)
            .map_err(openmls)?;
        self.store
            .set_received(self.group.group_id(), &proposal_ref, received)?;
        Ok(reference)
    }

    pub fn remove_proposal(&mut self, proposal_ref: &ProposalRef) -> Result<(), PublicGroupError> {
        // The kept `MLSMessage` bytes live in the same queue entry, so they go with it.
        self.group
            .remove_proposal(&self.store, proposal_ref)
            .map_err(openmls)
    }

    /// Each pair is the proposal's reference and the original `MLSMessage` bytes the DS received -
    /// deviation A2-11. The second element is deliberately **not** a bare `Proposal`: interfaces
    /// section 2.12 hands this list
    /// straight back to clients in `CommitConflict { proposals }` and `CommitRequired { proposals }`,
    /// and a bare `Proposal` has lost its `FramedContent` and its signature, so the client that
    /// receives it cannot process what it got back.
    ///
    /// Under ledger ruling A the bytes live in `PublicStore` and are therefore carried by
    /// `export_state()`, so a handle rebuilt with `import_state` reports them unchanged. A proposal
    /// queued through `add_proposal`, which never saw a wire message, has none, and that is
    /// reported as `StateMissing` rather than by inventing a re-serialised `Proposal` or handing
    /// back an empty byte string - either would be exactly the interoperability defect A2-11 exists
    /// to prevent.
    pub fn queued_proposals(&self) -> Result<Vec<(ProposalRef, Vec<u8>)>, PublicGroupError> {
        let queued = self.group.queued_proposals(&self.store).map_err(openmls)?;
        queued
            .into_iter()
            .map(|(reference, _queued): (ProposalRef, QueuedProposal)| {
                let message = self
                    .store
                    .received(self.group.group_id(), &reference)?
                    .ok_or(PublicGroupError::StateMissing)?;
                Ok((reference, message))
            })
            .collect()
    }

    pub fn export_ratchet_tree(&self) -> RatchetTree {
        self.group.export_ratchet_tree()
    }

    /// `PublicGroup` has no `tree_hash()`; it lives on the group context.
    pub fn tree_hash(&self) -> Vec<u8> {
        self.group.group_context().tree_hash().to_vec()
    }

    pub fn group_id(&self) -> &GroupId {
        self.group.group_id()
    }

    pub fn epoch(&self) -> u64 {
        self.group.group_context().epoch().as_u64()
    }

    pub fn binding(&self) -> &DillaBinding {
        &self.binding
    }

    pub fn members(&self) -> Vec<MemberInfo> {
        self.group
            .members()
            .filter_map(|m| {
                let basic = BasicCredential::try_from(m.credential.clone()).ok()?;
                let identity = CredentialIdentity::decode(basic.identity()).ok()?;
                let key = m.signature_key.as_slice();
                let mut signature_key = [0u8; 32];
                if key.len() != 32 {
                    return None;
                }
                signature_key.copy_from_slice(key);
                Some(MemberInfo {
                    leaf_index: m.index.u32(),
                    signature_key,
                    identity,
                })
            })
            .collect()
    }

    pub fn leaf(&self, index: LeafNodeIndex) -> Option<&LeafNode> {
        self.group.leaf(index)
    }

    pub fn required_capabilities(&self) -> Option<&RequiredCapabilitiesExtension> {
        self.group
            .group_context()
            .extensions()
            .required_capabilities()
    }

    pub fn ext_commit_sender_index(
        &self,
        staged: &StagedCommit,
    ) -> Result<LeafNodeIndex, PublicGroupError> {
        self.group.ext_commit_sender_index(staged).map_err(openmls)
    }
}

/// `KeyPackageIn::validate` plus dilla's own checks: the leaf must advertise 0xF001, and the
/// credential identity must decode. Both are invariant 6's "before proposing" gate.
pub fn validate_key_package(
    crypto: &impl OpenMlsCrypto,
    kp: KeyPackageIn,
) -> Result<KeyPackage, PublicGroupError> {
    let validated = kp
        .validate(crypto, ProtocolVersion::Mls10)
        .map_err(openmls)?;
    let leaf = validated.leaf_node();
    if !leaf.capabilities().extensions().contains(&DILLA_BINDING) {
        return Err(ProtocolError::Binding.into());
    }
    let basic = BasicCredential::try_from(leaf.credential().clone()).map_err(openmls)?;
    CredentialIdentity::decode(basic.identity())?;
    Ok(validated)
}

/// The `Provider` type parameter of `ExternalProposal::new_*` is used for **nothing but its
/// error type** (`ProposeAddMemberError<Provider::StorageError>`; gap-16 §"External proposal
/// signing", facts-wazero §6: "all three constructors are generic over `Provider: OpenMlsProvider`
/// even though only the signer is used"). It must therefore not be `DillaProvider`, which exists
/// only on the two targets that have `rusqlite`: this module is the one the wasi tier is built
/// for, and naming `DillaProvider` here would drag SQLite back into the `wasm32-wasip1` build.
/// `openmls_rust_crypto::OpenMlsRustCrypto` is a full `OpenMlsProvider` over `MemoryStorage`
/// (facts-openmls §3), is already in the dependency graph on every target, and no instance of it
/// is ever created.
pub fn external_propose_add(
    kp: KeyPackage,
    group_id: GroupId,
    epoch: GroupEpoch,
    signer: &impl Signer,
) -> Result<MlsMessageOut, PublicGroupError> {
    ExternalProposal::new_add::<openmls_rust_crypto::OpenMlsRustCrypto>(
        kp,
        group_id,
        epoch,
        signer,
        instance_sender_index(),
    )
    .map_err(openmls)
}

pub fn external_propose_remove(
    removed: LeafNodeIndex,
    group_id: GroupId,
    epoch: GroupEpoch,
    signer: &impl Signer,
) -> Result<MlsMessageOut, PublicGroupError> {
    // Same provider-as-error-type-only parameter as `external_propose_add` above.
    ExternalProposal::new_remove::<openmls_rust_crypto::OpenMlsRustCrypto>(
        removed,
        group_id,
        epoch,
        signer,
        instance_sender_index(),
    )
    .map_err(openmls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::TVal;
    use openmls_traits::public_storage::PublicStorageProvider as _;

    /// A torn write - one of the four entities missing - must surface as `StateMissing`, never as
    /// "this group does not exist" (gap-1 section 6.1 hazard 1).
    ///
    /// The key here is a real `openmls::group::GroupId`, which OpenMLS implements
    /// `traits::GroupId` for; only the entity side needs a local newtype.
    #[test]
    fn a_torn_state_is_reported_as_missing_not_as_absent() {
        let store = PublicStore::new();
        let group_id = openmls::group::GroupId::from_slice(&[0x44; 16]);
        // Three of the four entities present: exactly the shape a crash mid-`store()` leaves.
        store.write_tree(&group_id, &TVal(1)).unwrap();
        store.write_context(&group_id, &TVal(2)).unwrap();
        store.write_confirmation_tag(&group_id, &TVal(3)).unwrap();
        let blob = store.export();

        let err = DillaPublicGroup::import_state(&blob, &group_id)
            .expect_err("a torn state must not import");
        assert!(matches!(err, PublicGroupError::StateMissing), "{err:?}");
    }

    #[test]
    fn an_empty_state_is_reported_as_missing() {
        let group_id = openmls::group::GroupId::from_slice(&[0x44; 16]);
        let blob = PublicStore::new().export();
        assert!(matches!(
            DillaPublicGroup::import_state(&blob, &group_id),
            Err(PublicGroupError::StateMissing)
        ));
    }
}
