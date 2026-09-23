// The constraint this pins: `openmls_traits` ships
// `impl<T: StorageProvider<VERSION>> PublicStorageProvider<VERSION> for T`, so one type cannot
// implement both traits — a second, explicit `PublicStorageProvider` impl is E0119 (gap-1
// section 3a). That is why `DillaStorage` and `public_group::PublicStore` are two distinct types.
//
// `Both` implements `StorageProvider` **in full**, with 53 `todo!()` bodies, purely so that E0119
// is the only error rustc reports. An impl with no methods is E0046 first, and the checked-in
// `.stderr` then has to pin all 53 method names plus a `help: implement the missing item: fn …`
// line each, spelled with their exact generic parameter names: 59 lines of expectation that have
// nothing to do with what this test asserts, and that turn any rustc diagnostic rewording into a
// fail-closed CI failure with a diff that reads like a catastrophe.
//
// The obvious alternative — `impl PublicStorageProvider<CURRENT_VERSION> for DillaStorage` —
// does not work: inside this fixture crate both the trait and `DillaStorage` are foreign, so it
// is E0117 (orphan rule) and never reaches the coherence check. The type has to be local.
//
// The bodies below are mechanically derived from `openmls_traits-0.6.0/src/storage.rs`: every
// ungated method, parameters anonymised, `VERSION` spelled `CURRENT_VERSION`. When OpenMLS adds a
// method, this file fails to compile and gains one line; nothing else changes.

use openmls_traits::public_storage::PublicStorageProvider;
use openmls_traits::storage::{CURRENT_VERSION, StorageProvider, traits};

#[derive(Debug, thiserror::Error)]
#[error("both")]
struct BothError;

struct Both;

// The offending impl comes first so that the line number the `.stderr` pins does not move every
// time the stub impl below gains or loses a method.
impl PublicStorageProvider<CURRENT_VERSION> for Both {
    type PublicError = BothError;
}

impl StorageProvider<CURRENT_VERSION> for Both {
    type Error = BothError;

    fn write_mls_join_config<GroupId: traits::GroupId<CURRENT_VERSION>, MlsGroupJoinConfig: traits::MlsGroupJoinConfig<CURRENT_VERSION>,>(&self, _: &GroupId, _: &MlsGroupJoinConfig,) -> Result<(), Self::Error> { todo!() }
    fn append_own_leaf_node<GroupId: traits::GroupId<CURRENT_VERSION>, LeafNode: traits::LeafNode<CURRENT_VERSION>,>(&self, _: &GroupId, _: &LeafNode,) -> Result<(), Self::Error> { todo!() }
    fn queue_proposal<GroupId: traits::GroupId<CURRENT_VERSION>, ProposalRef: traits::ProposalRef<CURRENT_VERSION>, QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,>(&self, _: &GroupId, _: &ProposalRef, _: &QueuedProposal,) -> Result<(), Self::Error> { todo!() }
    fn write_tree<GroupId: traits::GroupId<CURRENT_VERSION>, TreeSync: traits::TreeSync<CURRENT_VERSION>>(&self, _: &GroupId, _: &TreeSync,) -> Result<(), Self::Error> { todo!() }
    fn write_interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>, InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,>(&self, _: &GroupId, _: &InterimTranscriptHash,) -> Result<(), Self::Error> { todo!() }
    fn write_context<GroupId: traits::GroupId<CURRENT_VERSION>, GroupContext: traits::GroupContext<CURRENT_VERSION>,>(&self, _: &GroupId, _: &GroupContext,) -> Result<(), Self::Error> { todo!() }
    fn write_confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>, ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,>(&self, _: &GroupId, _: &ConfirmationTag,) -> Result<(), Self::Error> { todo!() }
    fn write_group_state<GroupState: traits::GroupState<CURRENT_VERSION>, GroupId: traits::GroupId<CURRENT_VERSION>,>(&self, _: &GroupId, _: &GroupState,) -> Result<(), Self::Error> { todo!() }
    fn write_message_secrets<GroupId: traits::GroupId<CURRENT_VERSION>, MessageSecrets: traits::MessageSecrets<CURRENT_VERSION>,>(&self, _: &GroupId, _: &MessageSecrets,) -> Result<(), Self::Error> { todo!() }
    fn write_resumption_psk_store<GroupId: traits::GroupId<CURRENT_VERSION>, ResumptionPskStore: traits::ResumptionPskStore<CURRENT_VERSION>,>(&self, _: &GroupId, _: &ResumptionPskStore,) -> Result<(), Self::Error> { todo!() }
    fn write_own_leaf_index<GroupId: traits::GroupId<CURRENT_VERSION>, LeafNodeIndex: traits::LeafNodeIndex<CURRENT_VERSION>,>(&self, _: &GroupId, _: &LeafNodeIndex,) -> Result<(), Self::Error> { todo!() }
    fn write_group_epoch_secrets<GroupId: traits::GroupId<CURRENT_VERSION>, GroupEpochSecrets: traits::GroupEpochSecrets<CURRENT_VERSION>,>(&self, _: &GroupId, _: &GroupEpochSecrets,) -> Result<(), Self::Error> { todo!() }
    fn write_signature_key_pair<SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>, SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,>(&self, _: &SignaturePublicKey, _: &SignatureKeyPair,) -> Result<(), Self::Error> { todo!() }
    fn write_encryption_key_pair<EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>, HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,>(&self, _: &EncryptionKey, _: &HpkeKeyPair,) -> Result<(), Self::Error> { todo!() }
    fn write_encryption_epoch_key_pairs<GroupId: traits::GroupId<CURRENT_VERSION>, EpochKey: traits::EpochKey<CURRENT_VERSION>, HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,>(&self, _: &GroupId, _: &EpochKey, _: u32, _: &[HpkeKeyPair],) -> Result<(), Self::Error> { todo!() }
    fn write_key_package<HashReference: traits::HashReference<CURRENT_VERSION>, KeyPackage: traits::KeyPackage<CURRENT_VERSION>,>(&self, _: &HashReference, _: &KeyPackage,) -> Result<(), Self::Error> { todo!() }
    fn write_psk<PskId: traits::PskId<CURRENT_VERSION>, PskBundle: traits::PskBundle<CURRENT_VERSION>>(&self, _: &PskId, _: &PskBundle,) -> Result<(), Self::Error> { todo!() }
    fn mls_group_join_config<GroupId: traits::GroupId<CURRENT_VERSION>, MlsGroupJoinConfig: traits::MlsGroupJoinConfig<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<MlsGroupJoinConfig>, Self::Error> { todo!() }
    fn own_leaf_nodes<GroupId: traits::GroupId<CURRENT_VERSION>, LeafNode: traits::LeafNode<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<Vec<LeafNode>, Self::Error> { todo!() }
    fn queued_proposal_refs<GroupId: traits::GroupId<CURRENT_VERSION>, ProposalRef: traits::ProposalRef<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Vec<ProposalRef>, Self::Error> { todo!() }
    fn queued_proposals<GroupId: traits::GroupId<CURRENT_VERSION>, ProposalRef: traits::ProposalRef<CURRENT_VERSION>, QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::Error> { todo!() }
    fn tree<GroupId: traits::GroupId<CURRENT_VERSION>, TreeSync: traits::TreeSync<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<Option<TreeSync>, Self::Error> { todo!() }
    fn group_context<GroupId: traits::GroupId<CURRENT_VERSION>, GroupContext: traits::GroupContext<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<GroupContext>, Self::Error> { todo!() }
    fn interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>, InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<InterimTranscriptHash>, Self::Error> { todo!() }
    fn confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>, ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<ConfirmationTag>, Self::Error> { todo!() }
    fn group_state<GroupState: traits::GroupState<CURRENT_VERSION>, GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<Option<GroupState>, Self::Error> { todo!() }
    fn message_secrets<GroupId: traits::GroupId<CURRENT_VERSION>, MessageSecrets: traits::MessageSecrets<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<MessageSecrets>, Self::Error> { todo!() }
    fn resumption_psk_store<GroupId: traits::GroupId<CURRENT_VERSION>, ResumptionPskStore: traits::ResumptionPskStore<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<ResumptionPskStore>, Self::Error> { todo!() }
    fn own_leaf_index<GroupId: traits::GroupId<CURRENT_VERSION>, LeafNodeIndex: traits::LeafNodeIndex<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<LeafNodeIndex>, Self::Error> { todo!() }
    fn group_epoch_secrets<GroupId: traits::GroupId<CURRENT_VERSION>, GroupEpochSecrets: traits::GroupEpochSecrets<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<Option<GroupEpochSecrets>, Self::Error> { todo!() }
    fn signature_key_pair<SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>, SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,>(&self, _: &SignaturePublicKey,) -> Result<Option<SignatureKeyPair>, Self::Error> { todo!() }
    fn encryption_key_pair<HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>, EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,>(&self, _: &EncryptionKey,) -> Result<Option<HpkeKeyPair>, Self::Error> { todo!() }
    fn encryption_epoch_key_pairs<GroupId: traits::GroupId<CURRENT_VERSION>, EpochKey: traits::EpochKey<CURRENT_VERSION>, HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,>(&self, _: &GroupId, _: &EpochKey, _: u32,) -> Result<Vec<HpkeKeyPair>, Self::Error> { todo!() }
    fn key_package<KeyPackageRef: traits::HashReference<CURRENT_VERSION>, KeyPackage: traits::KeyPackage<CURRENT_VERSION>,>(&self, _: &KeyPackageRef,) -> Result<Option<KeyPackage>, Self::Error> { todo!() }
    fn psk<PskBundle: traits::PskBundle<CURRENT_VERSION>, PskId: traits::PskId<CURRENT_VERSION>>(&self, _: &PskId,) -> Result<Option<PskBundle>, Self::Error> { todo!() }
    fn remove_proposal<GroupId: traits::GroupId<CURRENT_VERSION>, ProposalRef: traits::ProposalRef<CURRENT_VERSION>,>(&self, _: &GroupId, _: &ProposalRef,) -> Result<(), Self::Error> { todo!() }
    fn delete_own_leaf_nodes<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_group_config<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_tree<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_group_state<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_context<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_message_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_all_resumption_psk_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_own_leaf_index<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_group_epoch_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn clear_proposal_queue<GroupId: traits::GroupId<CURRENT_VERSION>, ProposalRef: traits::ProposalRef<CURRENT_VERSION>,>(&self, _: &GroupId,) -> Result<(), Self::Error> { todo!() }
    fn delete_signature_key_pair<SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>>(&self, _: &SignaturePublicKey,) -> Result<(), Self::Error> { todo!() }
    fn delete_encryption_key_pair<EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>>(&self, _: &EncryptionKey,) -> Result<(), Self::Error> { todo!() }
    fn delete_encryption_epoch_key_pairs<GroupId: traits::GroupId<CURRENT_VERSION>, EpochKey: traits::EpochKey<CURRENT_VERSION>,>(&self, _: &GroupId, _: &EpochKey, _: u32,) -> Result<(), Self::Error> { todo!() }
    fn delete_key_package<KeyPackageRef: traits::HashReference<CURRENT_VERSION>>(&self, _: &KeyPackageRef,) -> Result<(), Self::Error> { todo!() }
    fn delete_psk<PskKey: traits::PskId<CURRENT_VERSION>>(&self, _: &PskKey,) -> Result<(), Self::Error> { todo!() }
}

fn main() {}
