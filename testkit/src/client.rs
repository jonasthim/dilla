//! A headless dilla client: a `DillaProvider` over an in-memory SQLite database, one signing key,
//! one credential and the groups it belongs to.

use crate::{DsStub, Frame, TestkitError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{CredentialIdentity, Kind, SskSigner, Tier, UmkSigner};
use dilla_core::ids::{DeviceId, MsgId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, DillaBinding, DillaGroup, DillaProcessed, DillaProvider, build_key_package,
};
use dilla_core::public_group::DillaPublicGroup;
// Not re-exported by `openmls::prelude` in 0.9.0: the prelude carries nothing from
// `messages::group_info` (verified in openmls-0.9.0/src/prelude.rs:20 — `messages::*` stops at the
// module boundary), so `VerifiableGroupInfo` has to be named through its own path.
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Received {
    pub group_id: Vec<u8>,
    pub seq: u64,
    pub sender: DeviceId,
    pub envelope: Envelope,
}

pub struct TestClient {
    name: String,
    device_id: DeviceId,
    provider: DillaProvider,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    groups: BTreeMap<Vec<u8>, DillaGroup>,
    inbox: Vec<Received>,
    next_msg: u64,
}

impl TestClient {
    /// `seed` makes every key deterministic, so a failing scenario reproduces exactly.
    pub fn new(
        name: &str,
        user_id: UserId,
        tier: Tier,
        kind: Kind,
        seed: u64,
    ) -> Result<Self, TestkitError> {
        let mut material = [0u8; 32];
        material[..8].copy_from_slice(&seed.to_be_bytes());
        material[8..16].copy_from_slice(&seed.wrapping_mul(0x9e37_79b9).to_be_bytes());
        let device_id = DeviceId::from_bytes({
            let mut id = [0u8; 16];
            id.copy_from_slice(&material[..16]);
            id
        });

        let conn = rusqlite::Connection::open_in_memory()
            .map_err(|e| TestkitError::Scenario(e.to_string()))?;
        let provider = DillaProvider::new(Arc::new(Mutex::new(conn)));
        provider.storage().migrate()?;

        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
        signer.store(provider.storage())?;

        let umk = UmkSigner::from_bytes(&material);
        let mut ssk_seed = material;
        ssk_seed[0] ^= 0x40;
        let ssk = SskSigner::from_bytes(&ssk_seed);
        let mut dsk_pub = [0u8; 32];
        let public = signer.public();
        if public.len() != 32 {
            return Err(TestkitError::Scenario(
                "signature key is not 32 bytes".into(),
            ));
        }
        dsk_pub.copy_from_slice(public);

        let identity = CredentialIdentity {
            v: 1,
            umk_pub: umk.public(),
            user_id,
            device_id,
            kind,
            tier,
            signer_tier: match tier {
                Tier::Native => dilla_core::identity::SignerTier::Native,
                Tier::Browser => dilla_core::identity::SignerTier::Browser,
            },
            ssk_pub: ssk.public(),
            sig_umk_ssk: umk.sign_ssk(&ssk.public()),
            sig_ssk_dev: ssk.sign_device(
                &device_id,
                &dsk_pub,
                kind,
                tier,
                match tier {
                    Tier::Native => dilla_core::identity::SignerTier::Native,
                    Tier::Browser => dilla_core::identity::SignerTier::Browser,
                },
            ),
        };
        identity.verify_signatures(&dsk_pub)?;

        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.encode()).into(),
            signature_key: signer.public().into(),
        };

        Ok(Self {
            name: name.to_owned(),
            device_id,
            provider,
            signer,
            credential,
            groups: BTreeMap::new(),
            inbox: Vec::new(),
            next_msg: 1,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    pub fn credential(&self) -> CredentialWithKey {
        self.credential.clone()
    }

    pub fn publish_key_packages(&mut self, ds: &mut DsStub, n: usize) -> Result<(), TestkitError> {
        let mut packages = Vec::with_capacity(n);
        for _ in 0..n {
            let kp = build_key_package(&self.provider, &self.signer, self.credential(), false)?;
            packages.push(serialize(kp.key_package())?);
        }
        let last = build_key_package(&self.provider, &self.signer, self.credential(), true)?;
        ds.publish_key_packages(self.device_id, packages, serialize(last.key_package())?)?;
        Ok(())
    }

    pub fn create_group(
        &mut self,
        ds: &mut DsStub,
        binding: DillaBinding,
    ) -> Result<Vec<u8>, TestkitError> {
        let group_id = GroupId::from_slice(&binding.target_id);
        let group = DillaGroup::create(
            &self.provider,
            &self.signer,
            self.credential(),
            group_id.clone(),
            binding.clone(),
            None,
        )?;
        let group_info = serialize(&group.export_group_info(&self.provider, &self.signer)?)?;
        let ratchet_tree = serialize(&group.export_ratchet_tree())?;
        let registered = ds.register_group(crate::RegisterGroup {
            binding: binding.encode(),
            group_info: group_info.clone(),
            ratchet_tree: ratchet_tree.clone(),
        })?;

        // Invariant 2: hand the DS the structural view it serves the tree and `tree_hash` from,
        // built from exactly the GroupInfo and tree just uploaded. Everything after this point -
        // every commit, every joiner - goes through it.
        let crypto = openmls_rust_crypto::RustCrypto::default();
        let (public, _committer_info) = DillaPublicGroup::from_external(
            &crypto,
            deserialize_tree(&ratchet_tree)?,
            deserialize_group_info(&group_info)?,
        )
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
        ds.attach_public_group(&registered.group_id, public);

        ds.add_member_device(&registered.group_id, self.device_id);
        self.groups.insert(registered.group_id.clone(), group);
        Ok(registered.group_id)
    }

    /// Takes a KeyPackage for `device` from the directory, commits the Add and uploads the commit
    /// with one Welcome addressed to that device.
    pub fn invite(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        device: DeviceId,
    ) -> Result<(), TestkitError> {
        let (blob, _was_last_resort) = ds.take_key_package(&device)?;
        let key_package = {
            use tls_codec::Deserialize as _;
            let incoming = KeyPackageIn::tls_deserialize_exact(&blob)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
            use openmls_traits::OpenMlsProvider as _;
            dilla_core::public_group::validate_key_package(self.provider.crypto(), incoming)
                .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
        };
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let epoch = group.epoch();
        let bundle = group.add_members(&self.provider, &self.signer, &[key_package])?;
        let welcomes = bundle
            .welcomes
            .iter()
            .map(|(d, w)| Ok((*d, serialize(w)?)))
            .collect::<Result<Vec<_>, TestkitError>>()?;
        ds.post_commit(
            group_id,
            crate::CommitUpload {
                epoch,
                commit: serialize(&bundle.commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes,
            },
        )?;
        group.merge_pending_commit(&self.provider)?;
        Ok(())
    }

    pub fn join_welcome(&mut self, ds: &mut DsStub, group_id: &[u8]) -> Result<(), TestkitError> {
        let expected = ds
            .binding(group_id)
            .cloned()
            .ok_or_else(|| TestkitError::Scenario("unknown group".into()))?;
        let welcome_blob = ds
            .drain(&self.device_id)
            .into_iter()
            .find_map(|f| match f {
                Frame::MlsWelcome { group_id: g, blob } if g == group_id => Some(blob),
                _ => None,
            })
            .ok_or_else(|| TestkitError::Assertion("no welcome for this device".into()))?;
        let tree = ds.ratchet_tree(group_id)?;
        let welcome = deserialize_welcome(&welcome_blob)?;
        let group = DillaGroup::join_from_welcome(
            &self.provider,
            welcome,
            deserialize_tree(&tree.ratchet_tree)?,
            &expected,
        )?;
        ds.add_member_device(group_id, self.device_id);
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    /// Invariant 2: verify `tree_hash` from the served GroupInfo against the served tree before
    /// joining. A joiner that skips this trusts the DS with the membership list.
    pub fn join_external(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        expected: &DillaBinding,
    ) -> Result<(), TestkitError> {
        let info = ds.group_info(group_id)?;
        let tree = ds.ratchet_tree(group_id)?;
        // No `is_empty()` escape: an empty `tree_hash` means the DS has no structural view of the
        // group, and joining on a tree nobody validated is exactly what invariant 2 forbids.
        if info.tree_hash.is_empty() {
            return Err(TestkitError::Assertion("the DS served no tree_hash".into()));
        }
        if info.tree_hash != tree.tree_hash {
            return Err(TestkitError::Assertion(
                "tree_hash does not match the served tree".into(),
            ));
        }
        let verifiable = deserialize_group_info(&info.group_info)?;
        let (group, commit, group_info) = DillaGroup::join_by_external_commit(
            &self.provider,
            &self.signer,
            self.credential(),
            verifiable,
            deserialize_tree(&tree.ratchet_tree)?,
            expected,
        )?;
        let epoch = info.epoch;
        // The joiner re-exports the GroupInfo from its own merged state either way, so the
        // `Option<GroupInfo>` the commit builder returned is not used here; it is named so the
        // unused-variable lint stays quiet and so a reader can see it was considered.
        let _ = &group_info;
        ds.post_external_commit(
            group_id,
            crate::CommitUpload {
                epoch,
                commit: serialize(&commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes: Vec::new(),
            },
        )?;
        ds.add_member_device(group_id, self.device_id);
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    pub fn send(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        body: &str,
    ) -> Result<MsgId, TestkitError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let mut msg_id = [0u8; 16];
        msg_id[..8].copy_from_slice(&self.next_msg.to_be_bytes());
        msg_id[8..].copy_from_slice(self.device_id.as_bytes()[..8].try_into().expect("8 bytes"));
        self.next_msg += 1;
        let envelope = Envelope {
            v: 1,
            msg_id: MsgId::from_bytes(msg_id),
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: body.to_owned(),
            attachments: Vec::new(),
            previews: Vec::new(),
            k_f: [0x06; 32],
        };
        let commitment = envelope.commitment()?;
        let out = group.create_message(&self.provider, &self.signer, &envelope)?;
        let epoch = group.epoch();
        ds.post_message_from(
            group_id,
            epoch,
            self.device_id,
            serialize(&out)?,
            Some(commitment),
        )?;
        Ok(envelope.msg_id)
    }

    pub fn remove(
        &mut self,
        ds: &mut DsStub,
        group_id: &[u8],
        target: DeviceId,
    ) -> Result<(), TestkitError> {
        // Resolve the target's leaf from the DS's structural view, which carries every member's
        // decoded `CredentialIdentity` (invariant 2). `remove <actor> <group> <target>` removes the
        // **target**; committing `own_leaf_index()` here would make every scenario remove its own
        // committer and would leave `E_MEMBER_REMOVE_FORBIDDEN` untested end to end.
        let leaf = ds
            .public_group(group_id)
            .ok_or_else(|| TestkitError::Assertion("the DS has no view of this group".into()))?
            .members()
            .into_iter()
            .find(|m| m.identity.device_id == target)
            .map(|m| LeafNodeIndex::new(m.leaf_index))
            .ok_or_else(|| {
                TestkitError::Assertion(format!(
                    "{} is not a member of this group",
                    target.to_hex()
                ))
            })?;
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let bundle = group.remove_members(&self.provider, &self.signer, &[leaf])?;
        let epoch = group.epoch();
        let accepted = ds.post_commit(
            group_id,
            crate::CommitUpload {
                epoch,
                commit: serialize(&bundle.commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes: Vec::new(),
            },
        );
        if let Err(refused) = accepted {
            // Spec line 591 / protocol/02 `commit_conflict`: the loser of an epoch clears its
            // pending commit, syncs, and re-applies. Without this the group stays in
            // `MlsGroupState::PendingCommit` and every later commit from this client fails with
            // `MlsGroupStateError::PendingCommit` instead of the error the caller expects.
            group.clear_pending_commit(&self.provider)?;
            return Err(refused.into());
        }
        group.merge_pending_commit(&self.provider)?;
        Ok(())
    }

    /// Drains this device's queue and applies everything in order: handshakes first, then the
    /// application messages of the epoch they belong to.
    pub fn sync(&mut self, ds: &mut DsStub) -> Result<Vec<Received>, TestkitError> {
        let frames = ds.drain(&self.device_id);
        let mut new = Vec::new();
        for frame in frames {
            match frame {
                Frame::MlsWelcome { .. } | Frame::MlsEpochChanged { .. } => {}
                Frame::MlsHandshake { group_id, item } => {
                    if let Some(group) = self.groups.get_mut(&group_id) {
                        // The DS fans a commit out to every member, the committer included, and a
                        // committer has already merged its own commit before the frame arrives.
                        // Feeding OpenMLS a handshake for an epoch the group has left is a
                        // `WrongEpoch` validation failure, so a frame that is already applied is
                        // skipped rather than processed.
                        if item.epoch < group.epoch() {
                            continue;
                        }
                        let message = deserialize_protocol(&item.blob)?;
                        if let DillaProcessed::StagedCommit(staged) =
                            group.process_message(&self.provider, message)?
                        {
                            group.merge_staged_commit(&self.provider, *staged)?;
                        }
                    }
                }
                Frame::MessageCt { group_id, item } => {
                    if let Some(group) = self.groups.get_mut(&group_id) {
                        let message = deserialize_protocol(&item.blob)?;
                        if let DillaProcessed::Application(envelope) =
                            group.process_message(&self.provider, message)?
                        {
                            let received = Received {
                                group_id: group_id.clone(),
                                seq: item.seq,
                                sender: item.uploader_device,
                                envelope,
                            };
                            self.inbox.push(received.clone());
                            new.push(received);
                        }
                    }
                }
            }
        }
        Ok(new)
    }

    pub fn inbox(&self) -> &[Received] {
        &self.inbox
    }
}

fn serialize<T: tls_codec::Serialize>(value: &T) -> Result<Vec<u8>, TestkitError> {
    value
        .tls_serialize_detached()
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

fn deserialize_message(bytes: &[u8]) -> Result<MlsMessageIn, TestkitError> {
    use tls_codec::Deserialize as _;
    MlsMessageIn::tls_deserialize_exact(bytes).map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

fn deserialize_protocol(bytes: &[u8]) -> Result<ProtocolMessage, TestkitError> {
    deserialize_message(bytes)?
        .try_into_protocol_message()
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}

fn deserialize_welcome(bytes: &[u8]) -> Result<Welcome, TestkitError> {
    match deserialize_message(bytes)?.extract() {
        MlsMessageBodyIn::Welcome(w) => Ok(w),
        other => Err(TestkitError::Scenario(format!(
            "expected a Welcome, got {other:?}"
        ))),
    }
}

fn deserialize_group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, TestkitError> {
    match deserialize_message(bytes)?.extract() {
        MlsMessageBodyIn::GroupInfo(info) => Ok(info),
        other => Err(TestkitError::Scenario(format!(
            "expected a GroupInfo, got {other:?}"
        ))),
    }
}

fn deserialize_tree(bytes: &[u8]) -> Result<RatchetTreeIn, TestkitError> {
    use tls_codec::Deserialize as _;
    RatchetTreeIn::tls_deserialize_exact(bytes)
        .map_err(|e| TestkitError::Scenario(format!("{e:?}")))
}
