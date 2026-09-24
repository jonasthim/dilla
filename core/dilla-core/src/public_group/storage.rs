//! The 16-method `PublicStorageProvider`, in memory, with a versioned export.
//!
//! It implements **only** that trait. `openmls_traits` ships a blanket impl of the public trait
//! for every `StorageProvider`, so a type implementing both is `E0119` (gap-1 section 3a) - which
//! is why `mls::DillaStorage` and this are two types, not one with two impls.
//!
//! State lives in module memory rather than on a WASI filesystem (R9): dillad persists the blob
//! `export()` returns through `public_group_export_state`, in its own transaction, and hands it
//! back through `public_group_import_state`.

use crate::cbor::{Encoder, decode_strict};
use crate::mls::{CborCodec, DillaCodec};
use openmls_traits::public_storage::PublicStorageProvider;
use openmls_traits::storage::{CURRENT_VERSION, traits};
use serde::{Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PublicStoreError {
    #[error("codec: {0}")]
    Codec(String),
    #[error("state version {0} unsupported")]
    StateVersion(u8),
    #[error("truncated state blob")]
    Truncated,
}

/// The four entity discriminants the public trait stores, and nothing else.
const TREE: u64 = 0;
const INTERIM_TRANSCRIPT_HASH: u64 = 1;
const CONTEXT: u64 = 2;
const CONFIRMATION_TAG: u64 = 3;

/// One row of the proposal queue.
///
/// Ledger ruling A: the `MLSMessage` the DS received for this proposal is kept **here**, beside
/// the encoded `QueuedProposal`, rather than in a map owned by `DillaPublicGroup`. That is what
/// puts it inside `export()`, so a pending proposal survives a dillad restart; and because the two
/// live in one entry, `remove_proposal` and `clear_proposal_queue` drop the kept bytes with the
/// proposal they belong to, which is what bounds the memory a remote peer can make the module
/// hold.
///
/// `received` is empty for a proposal queued through `DillaPublicGroup::add_proposal`, which never
/// saw a wire message.
#[derive(Default)]
struct QueuedEntry {
    proposal: Vec<u8>,
    received: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    /// (group_id, discriminant) -> encoded entity
    group_data: BTreeMap<(Vec<u8>, u64), Vec<u8>>,
    /// (group_id, proposal_ref) -> the queued proposal and the message it arrived in
    proposals: BTreeMap<(Vec<u8>, Vec<u8>), QueuedEntry>,
}

#[derive(Default)]
pub struct PublicStore {
    inner: Mutex<Inner>,
}

impl PublicStore {
    /// Bumped whenever the blob layout changes. dillad stores it alongside the blob so an old
    /// server and a new module can tell each other apart rather than misparse.
    pub const STATE_VERSION: u8 = 1;

    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn enc<T: Serialize>(value: &T) -> Result<Vec<u8>, PublicStoreError> {
        CborCodec::to_vec(value).map_err(|e| PublicStoreError::Codec(e.to_string()))
    }

    fn dec<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, PublicStoreError> {
        CborCodec::from_slice(bytes).map_err(|e| PublicStoreError::Codec(e.to_string()))
    }

    pub fn is_empty(&self) -> bool {
        let inner = self.lock();
        inner.group_data.is_empty() && inner.proposals.is_empty()
    }

    /// `[STATE_VERSION] || CBOR([group_data, proposals])` where
    /// `group_data = [[group_id(bstr), discriminant(uint), value(bstr)], ...]` and
    /// `proposals = [[group_id(bstr), proposal_ref(bstr), proposal(bstr),
    /// received_mls_message(bstr)], ...]` (the fourth element is ledger ruling A).
    /// Both maps are `BTreeMap`s, so the iteration order - and therefore the blob - is
    /// deterministic for a given state.
    pub fn export(&self) -> Vec<u8> {
        let inner = self.lock();
        let mut e = Encoder::with_capacity(4096);
        e.array(2);
        e.array(inner.group_data.len());
        for ((group_id, disc), value) in inner.group_data.iter() {
            e.array(3).bytes(group_id).uint(*disc).bytes(value);
        }
        e.array(inner.proposals.len());
        for ((group_id, proposal_ref), entry) in inner.proposals.iter() {
            e.array(4)
                .bytes(group_id)
                .bytes(proposal_ref)
                .bytes(&entry.proposal)
                .bytes(&entry.received);
        }
        let mut out = Vec::with_capacity(e.as_slice().len() + 1);
        out.push(Self::STATE_VERSION);
        out.extend_from_slice(e.as_slice());
        out
    }

    pub fn import(bytes: &[u8]) -> Result<Self, PublicStoreError> {
        let (version, body) = bytes.split_first().ok_or(PublicStoreError::Truncated)?;
        if *version != Self::STATE_VERSION {
            return Err(PublicStoreError::StateVersion(*version));
        }
        let (group_data, proposals) = decode_strict(body, |d| {
            d.array(2)?;
            let n = d.array_len()?;
            let mut group_data = BTreeMap::new();
            for _ in 0..n {
                d.array(3)?;
                let group_id = d.bytes()?.to_vec();
                let disc = d.uint()?;
                group_data.insert((group_id, disc), d.bytes()?.to_vec());
            }
            let n = d.array_len()?;
            let mut proposals = BTreeMap::new();
            for _ in 0..n {
                d.array(4)?;
                let group_id = d.bytes()?.to_vec();
                let proposal_ref = d.bytes()?.to_vec();
                let proposal = d.bytes()?.to_vec();
                let received = d.bytes()?.to_vec();
                proposals.insert((group_id, proposal_ref), QueuedEntry { proposal, received });
            }
            Ok((group_data, proposals))
        })
        .map_err(|e| PublicStoreError::Codec(e.to_string()))?;
        Ok(Self {
            inner: Mutex::new(Inner {
                group_data,
                proposals,
            }),
        })
    }

    /// Records the `MLSMessage` bytes a proposal arrived in, against a proposal the trait's
    /// `queue_proposal` has already stored. A no-op if that proposal is not queued: the kept bytes
    /// exist only for the lifetime of the queue entry (ledger ruling A).
    ///
    /// Not part of the `PublicStorageProvider` trait - OpenMLS never sees the wire message - and
    /// crate-private, so the store's public surface is still exactly `new`/`export`/`import`/
    /// `is_empty` plus the trait.
    pub(crate) fn set_received<K: Serialize, R: Serialize>(
        &self,
        group_id: &K,
        proposal_ref: &R,
        message: Vec<u8>,
    ) -> Result<(), PublicStoreError> {
        let (g, r) = (Self::enc(group_id)?, Self::enc(proposal_ref)?);
        if let Some(entry) = self.lock().proposals.get_mut(&(g, r)) {
            entry.received = message;
        }
        Ok(())
    }

    /// The `MLSMessage` bytes kept for a queued proposal, or `None` when none were recorded.
    pub(crate) fn received<K: Serialize, R: Serialize>(
        &self,
        group_id: &K,
        proposal_ref: &R,
    ) -> Result<Option<Vec<u8>>, PublicStoreError> {
        let (g, r) = (Self::enc(group_id)?, Self::enc(proposal_ref)?);
        Ok(self
            .lock()
            .proposals
            .get(&(g, r))
            .filter(|entry| !entry.received.is_empty())
            .map(|entry| entry.received.clone()))
    }

    fn put_entity<K: Serialize, V: Serialize>(
        &self,
        group_id: &K,
        disc: u64,
        value: &V,
    ) -> Result<(), PublicStoreError> {
        let (g, v) = (Self::enc(group_id)?, Self::enc(value)?);
        self.lock().group_data.insert((g, disc), v);
        Ok(())
    }

    fn get_entity<K: Serialize, V: DeserializeOwned>(
        &self,
        group_id: &K,
        disc: u64,
    ) -> Result<Option<V>, PublicStoreError> {
        let g = Self::enc(group_id)?;
        let raw = self.lock().group_data.get(&(g, disc)).cloned();
        raw.map(|b| Self::dec(&b)).transpose()
    }

    fn del_entity<K: Serialize>(&self, group_id: &K, disc: u64) -> Result<(), PublicStoreError> {
        let g = Self::enc(group_id)?;
        self.lock().group_data.remove(&(g, disc));
        Ok(())
    }
}

impl PublicStorageProvider<CURRENT_VERSION> for PublicStore {
    type PublicError = PublicStoreError;

    fn write_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        tree: &TreeSync,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, TREE, tree)
    }

    fn write_interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        interim_transcript_hash: &InterimTranscriptHash,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, INTERIM_TRANSCRIPT_HASH, interim_transcript_hash)
    }

    fn write_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_context: &GroupContext,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, CONTEXT, group_context)
    }

    fn write_confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        confirmation_tag: &ConfirmationTag,
    ) -> Result<(), Self::PublicError> {
        self.put_entity(group_id, CONFIRMATION_TAG, confirmation_tag)
    }

    fn queue_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<(), Self::PublicError> {
        let (g, r, p) = (
            Self::enc(group_id)?,
            Self::enc(proposal_ref)?,
            Self::enc(proposal)?,
        );
        let mut inner = self.lock();
        // Keep any bytes already recorded for this exact proposal: OpenMLS re-queues an unchanged
        // proposal on some paths, and the wire message is still the one that arrived.
        let received = inner
            .proposals
            .get(&(g.clone(), r.clone()))
            .map(|e| e.received.clone())
            .unwrap_or_default();
        inner.proposals.insert(
            (g, r),
            QueuedEntry {
                proposal: p,
                received,
            },
        );
        Ok(())
    }

    fn queued_proposals<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::PublicError> {
        let g = Self::enc(group_id)?;
        let rows: Vec<(Vec<u8>, Vec<u8>)> = self
            .lock()
            .proposals
            .iter()
            .filter(|((gid, _), _)| gid == &g)
            .map(|((_, r), entry)| (r.clone(), entry.proposal.clone()))
            .collect();
        rows.iter()
            .map(|(r, p)| Ok((Self::dec(r)?, Self::dec(p)?)))
            .collect()
    }

    fn tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<TreeSync>, Self::PublicError> {
        self.get_entity(group_id, TREE)
    }

    fn group_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupContext>, Self::PublicError> {
        self.get_entity(group_id, CONTEXT)
    }

    fn interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<InterimTranscriptHash>, Self::PublicError> {
        self.get_entity(group_id, INTERIM_TRANSCRIPT_HASH)
    }

    fn confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ConfirmationTag>, Self::PublicError> {
        self.get_entity(group_id, CONFIRMATION_TAG)
    }

    fn delete_tree<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, TREE)
    }

    fn delete_confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, CONFIRMATION_TAG)
    }

    fn delete_context<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, CONTEXT)
    }

    fn delete_interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        self.del_entity(group_id, INTERIM_TRANSCRIPT_HASH)
    }

    fn remove_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<(), Self::PublicError> {
        let (g, r) = (Self::enc(group_id)?, Self::enc(proposal_ref)?);
        self.lock().proposals.remove(&(g, r));
        Ok(())
    }

    /// Both type parameters are unconstrained by the arguments; OpenMLS turbofishes them at every
    /// call site and the body ignores both.
    fn clear_proposal_queue<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::PublicError> {
        let g = Self::enc(group_id)?;
        self.lock().proposals.retain(|(gid, _), _| gid != &g);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::{TKey, TVal};
    // `PublicStorageProvider` itself arrives through `use super::*`, which picks up the parent
    // module's own import; naming it again here is an unused-import warning, and the crate is
    // built with `-D warnings`.

    fn gid() -> TKey {
        TKey(b"group-1".to_vec())
    }

    #[test]
    fn a_fresh_store_is_empty_and_reads_return_none() {
        let s = PublicStore::new();
        let g = TKey(b"g".to_vec());
        assert!(s.is_empty());
        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, None);
        let interim: Option<TVal> = s.interim_transcript_hash(&g).unwrap();
        assert_eq!(interim, None);
        let tag: Option<TVal> = s.confirmation_tag(&g).unwrap();
        assert_eq!(tag, None);
        let none: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn the_four_entities_and_the_proposal_queue_round_trip_and_delete() {
        let s = PublicStore::new();
        let g = gid();
        let ref_a = TKey(b"ref-a".to_vec());
        let ref_b = TKey(b"ref-b".to_vec());
        s.write_tree(&g, &TVal(1)).unwrap();
        s.write_interim_transcript_hash(&g, &TVal(2)).unwrap();
        s.write_context(&g, &TVal(3)).unwrap();
        s.write_confirmation_tag(&g, &TVal(4)).unwrap();
        s.queue_proposal(&g, &ref_a, &TVal(5)).unwrap();
        s.queue_proposal(&g, &ref_b, &TVal(6)).unwrap();
        assert!(!s.is_empty());

        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let interim: Option<TVal> = s.interim_transcript_hash(&g).unwrap();
        assert_eq!(interim, Some(TVal(2)));
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(3)));
        let tag: Option<TVal> = s.confirmation_tag(&g).unwrap();
        assert_eq!(tag, Some(TVal(4)));
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 2);

        s.remove_proposal(&g, &ref_a).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 1);
        s.clear_proposal_queue::<TKey, TKey>(&g).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert!(all.is_empty());

        s.delete_tree(&g).unwrap();
        s.delete_confirmation_tag(&g).unwrap();
        s.delete_context(&g).unwrap();
        s.delete_interim_transcript_hash(&g).unwrap();
        assert!(s.is_empty());
    }

    #[test]
    fn export_and_import_round_trip_and_carry_a_version_byte() {
        let s = PublicStore::new();
        let g = gid();
        s.write_tree(&g, &TVal(1)).unwrap();
        s.write_context(&g, &TVal(3)).unwrap();
        s.queue_proposal(&g, &TKey(b"ref-a".to_vec()), &TVal(5))
            .unwrap();

        let blob = s.export();
        assert_eq!(blob[0], PublicStore::STATE_VERSION);

        let back = PublicStore::import(&blob).expect("import");
        let tree: Option<TVal> = back.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let context: Option<TVal> = back.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(3)));
        let all: Vec<(TKey, TVal)> = back.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(back.export(), blob, "export must be stable");
    }

    /// Ledger ruling A: the received `MLSMessage` bytes that
    /// `DillaPublicGroup::queue_proposal` keeps travel **inside** the exported blob, so a pending
    /// proposal survives a dillad restart.
    #[test]
    fn the_received_message_bytes_survive_an_export_import_round_trip() {
        let s = PublicStore::new();
        let g = gid();
        let r = TKey(b"ref-a".to_vec());
        s.queue_proposal(&g, &r, &TVal(5)).unwrap();
        s.set_received(&g, &r, b"the-wire-bytes".to_vec()).unwrap();
        assert_eq!(
            s.received(&g, &r).unwrap().as_deref(),
            Some(&b"the-wire-bytes"[..])
        );

        let back = PublicStore::import(&s.export()).expect("import");
        assert_eq!(
            back.received(&g, &r).unwrap().as_deref(),
            Some(&b"the-wire-bytes"[..]),
            "the kept MLSMessage must survive a restart (ledger ruling A)"
        );

        // Dropping the proposal drops the kept bytes with it: the map is bounded by the queue.
        back.remove_proposal(&g, &r).unwrap();
        assert_eq!(back.received(&g, &r).unwrap(), None);
    }

    #[test]
    fn import_rejects_an_unknown_version_and_a_truncated_blob() {
        let s = PublicStore::new();
        s.write_tree(&TKey(b"g".to_vec()), &TVal(1)).unwrap();
        let mut blob = s.export();
        blob[0] = 9;
        assert_eq!(
            PublicStore::import(&blob).err(),
            Some(PublicStoreError::StateVersion(9))
        );
        assert_eq!(
            PublicStore::import(&[]).err(),
            Some(PublicStoreError::Truncated)
        );

        let mut short = s.export();
        short.truncate(3);
        assert!(matches!(
            PublicStore::import(&short),
            Err(PublicStoreError::Codec(_))
        ));
    }
}
