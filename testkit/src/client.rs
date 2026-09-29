//! A headless dilla client: a `DillaProvider` over an in-memory SQLite database, one signing key,
//! one credential and the groups it belongs to.
//!
//! Every method that talks to a delivery service takes `&mut dyn DeliveryService`, so the same
//! client drives the in-memory `DsStub` and a real instance through `HttpDs`. Against the stub the
//! caller names the acting device first (`DsStub::act_as`); `HttpDs` is one device's client by
//! construction.

use crate::ds::{CommitRequest, DeliveryService, Device, NewAccount, RegisterGroup, ResyncRequest};
use crate::{Frame, TestkitError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{CredentialIdentity, Kind, SskSigner, Tier, UmkSigner};
use dilla_core::ids::{DeviceId, MsgId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, CommitBundle, DillaBinding, DillaGroup, DillaProcessed, DillaProvider,
    MAX_ADDS_PER_COMMIT, build_key_package,
};
// Not re-exported by `openmls::prelude` in 0.9.0: the prelude carries nothing from
// `messages::group_info` (verified in openmls-0.9.0/src/prelude.rs:20 — `messages::*` stops at the
// module boundary), so `VerifiableGroupInfo` has to be named through its own path.
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use rand_chacha::ChaCha20Rng;
use rand_chacha::rand_core::{RngCore, SeedableRng};
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
    /// The decoded credential, kept for the account half of `POST /v1/accounts`.
    identity: CredentialIdentity,
    /// The device signing key (DSK), which also signs session challenges.
    dsk: ed25519_dalek::SigningKey,
    groups: BTreeMap<Vec<u8>, DillaGroup>,
    inbox: Vec<Received>,
    /// Every frame `sync` drained, in arrival order, for a scenario's `expect_frame`.
    frames: Vec<Frame>,
    next_msg: u64,
}

impl TestClient {
    /// `seed` fixes this client's identity material: the device id, the UMK, the SSK and the MLS
    /// signature keypair are all derived from it, so the same seed always yields the same
    /// credential. It does **not** make a run byte-for-byte reproducible: everything the OpenMLS
    /// provider draws from the OS RNG (HPKE init keys, leaf secrets, nonces) is still random, so
    /// commits, GroupInfos and ciphertext differ run to run. Reproduction is structural.
    ///
    /// `user_id` is not derived from the seed, so the same seed under another user id yields the
    /// same device and keys with a credential naming that user — which is how a remote client
    /// rebuilds itself around the user id the instance minted at registration.
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

        // Deterministic, which `SignatureKeyPair::new` is not: it draws the key from the OS RNG.
        // The seed stream is `rand_chacha`, which is what testkit/Cargo.toml declares it for.
        if CIPHERSUITE.signature_algorithm() != SignatureScheme::ED25519 {
            return Err(TestkitError::Scenario(
                "the seeded signature keypair assumes an Ed25519 ciphersuite".into(),
            ));
        }
        let mut dsk_seed = [0u8; 32];
        ChaCha20Rng::from_seed(material).fill_bytes(&mut dsk_seed);
        let dsk = ed25519_dalek::SigningKey::from_bytes(&dsk_seed);
        let signer = SignatureKeyPair::from_raw(
            CIPHERSUITE.signature_algorithm(),
            dsk.to_bytes().to_vec(),
            dsk.verifying_key().to_bytes().to_vec(),
        );
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
            identity,
            dsk,
            groups: BTreeMap::new(),
            inbox: Vec::new(),
            frames: Vec::new(),
            next_msg: 1,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    /// This client's device as a delivery service authenticates it: its id and its DSK.
    pub fn device(&self) -> Device {
        Device::new(self.device_id, self.dsk.clone())
    }

    pub fn credential(&self) -> CredentialWithKey {
        self.credential.clone()
    }

    pub fn provider(&self) -> &DillaProvider {
        &self.provider
    }

    pub fn signer(&self) -> &SignatureKeyPair {
        &self.signer
    }

    /// The account half and the first device of `POST /v1/accounts`, from this client's own key
    /// material. `credential` is the `CredentialIdentity` CBOR the MLS leaf carries.
    pub fn new_account(&self, username: &str, display: &str) -> NewAccount {
        NewAccount {
            username: username.to_owned(),
            display: display.to_owned(),
            umk_pub: self.identity.umk_pub,
            ssk_pub: self.identity.ssk_pub,
            sig_umk_ssk: self.identity.sig_umk_ssk,
            device_id: self.device_id,
            dsk_pub: self.dsk.verifying_key().to_bytes(),
            tier: self.identity.tier as u8,
            signer_tier: self.identity.signer_tier as u8,
            credential: self.identity.encode(),
        }
    }

    /// The groups this client is a member of, in id order.
    pub fn group_ids(&self) -> Vec<Vec<u8>> {
        self.groups.keys().cloned().collect()
    }

    pub fn is_member(&self, group_id: &[u8]) -> bool {
        self.groups.contains_key(group_id)
    }

    pub fn publish_key_packages(
        &mut self,
        ds: &mut dyn DeliveryService,
        n: usize,
    ) -> Result<(), TestkitError> {
        // Each package travels as an RFC 9420 `MLSMessage` carrying a KeyPackage, the framing the
        // instance's `validate_key_package` reads (`dilla-core-wasi` `abi::tls::key_package_in`); a
        // bare `KeyPackage` is `E_COMMIT_INVALID` there.
        let wrap = |kp: &KeyPackage| serialize(&MlsMessageOut::from(kp.clone()));
        let mut packages = Vec::with_capacity(n);
        for _ in 0..n {
            let kp = build_key_package(&self.provider, &self.signer, self.credential(), false)?;
            packages.push(wrap(kp.key_package())?);
        }
        let last = build_key_package(&self.provider, &self.signer, self.credential(), true)?;
        ds.publish_key_packages(&self.device(), packages, Some(wrap(last.key_package())?))?;
        Ok(())
    }

    /// Registers the group with its binding, the GroupInfo and the tree. The delivery service
    /// builds its own structural view from those two (invariant 2) and its own fan-out list.
    pub fn create_group(
        &mut self,
        ds: &mut dyn DeliveryService,
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
        let registered = ds.register_group(RegisterGroup {
            binding: binding.encode(),
            group_info,
            ratchet_tree,
        })?;
        self.groups.insert(registered.group_id.clone(), group);
        Ok(registered.group_id)
    }

    /// Takes a KeyPackage for `device` from the directory, commits the Add and uploads the commit
    /// with one Welcome addressed to that device.
    pub fn invite(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        device: DeviceId,
    ) -> Result<(), TestkitError> {
        self.invite_many(ds, group_id, &[device])
    }

    /// One Add commit for every device named, which is at most `MAX_ADDS_PER_COMMIT`: the
    /// instance's batching bound, and the most one commit may carry.
    pub fn invite_many(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        devices: &[DeviceId],
    ) -> Result<(), TestkitError> {
        if devices.len() > MAX_ADDS_PER_COMMIT {
            return Err(TestkitError::Scenario(format!(
                "{} Adds in one commit; the bound is {MAX_ADDS_PER_COMMIT}",
                devices.len()
            )));
        }
        let mut key_packages = Vec::with_capacity(devices.len());
        for device in devices {
            let blob = ds.take_key_package(device)?.blob;
            let key_package = {
                let incoming = match deserialize_message(&blob)?.extract() {
                    MlsMessageBodyIn::KeyPackage(kp) => kp,
                    other => {
                        return Err(TestkitError::Scenario(format!(
                            "expected a KeyPackage, got {other:?}"
                        )));
                    }
                };
                use openmls_traits::OpenMlsProvider as _;
                dilla_core::public_group::validate_key_package(self.provider.crypto(), incoming)
                    .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?
            };
            key_packages.push(key_package);
        }
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let bundle = group.add_members(&self.provider, &self.signer, &key_packages)?;
        let welcomes = bundle
            .welcomes
            .iter()
            .map(|(d, w)| Ok((*d, serialize(w)?)))
            .collect::<Result<Vec<_>, TestkitError>>()?;
        self.upload_commit(ds, group_id, bundle, welcomes)
    }

    /// Posts a commit this client staged and merges it once the delivery service accepts it.
    ///
    /// Spec line 591 / protocol/02 `commit_conflict`: the loser of an epoch clears its pending
    /// commit, syncs, and re-applies. Without the clear the group stays in
    /// `MlsGroupState::PendingCommit` and every later commit from this client fails with
    /// `MlsGroupStateError::PendingCommit` instead of the error the caller expects.
    fn upload_commit(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        bundle: CommitBundle,
        welcomes: Vec<(DeviceId, Vec<u8>)>,
    ) -> Result<(), TestkitError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let epoch = group.epoch();
        let accepted = ds.post_commit(
            group_id,
            CommitRequest {
                epoch,
                commit: serialize(&bundle.commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
                welcomes,
            },
        );
        if let Err(refused) = accepted {
            group.clear_pending_commit(&self.provider)?;
            return Err(refused.into());
        }
        group.merge_pending_commit(&self.provider)?;
        Ok(())
    }

    /// Collects this device's Welcome for `group_id` (row 15), joins with the tree **as of the
    /// welcoming epoch** that the Welcome row carries, and acknowledges it (row 16) only once the
    /// join has succeeded: `StagedWelcome::new_from_welcome` consumes the key material even when
    /// the join then fails, so a fetch must not consume.
    ///
    /// `expected` is the binding of the channel the joiner was invited into; the Welcome's
    /// GroupContext must carry exactly it. The joiner does not ask the delivery service what to
    /// expect.
    pub fn join_welcome(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        expected: &DillaBinding,
    ) -> Result<(), TestkitError> {
        let item = ds
            .welcomes()?
            .into_iter()
            .find(|w| w.group_id == group_id)
            .ok_or_else(|| TestkitError::Assertion("no welcome for this device".into()))?;
        let welcome = deserialize_welcome(&item.blob)?;
        let group = DillaGroup::join_from_welcome(
            &self.provider,
            welcome,
            deserialize_tree(&item.ratchet_tree)?,
            expected,
        )?;
        ds.ack_welcome(item.welcome_id)?;
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    /// Invariant 2: verify `tree_hash` from the served GroupInfo against the served tree before
    /// joining. A joiner that skips this trusts the DS with the membership list.
    pub fn join_external(
        &mut self,
        ds: &mut dyn DeliveryService,
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
        // The joiner re-exports the GroupInfo from its own merged state either way, so the
        // `Option<GroupInfo>` the commit builder returned is not used here; it is named so the
        // unused-variable lint stays quiet and so a reader can see it was considered.
        let _ = &group_info;
        ds.post_external_commit(
            group_id,
            ResyncRequest {
                external_commit: serialize(&commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, &self.signer)?)?,
            },
        )?;
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    pub fn send(
        &mut self,
        ds: &mut dyn DeliveryService,
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
        // The commitment `C` travels in the message's `authenticated_data`, which is where the
        // delivery service reads it: the upload carries nothing else.
        let out = group.create_message(&self.provider, &self.signer, &envelope)?;
        let epoch = group.epoch();
        ds.post_message_from(group_id, epoch, serialize(&out)?)?;
        Ok(envelope.msg_id)
    }

    /// Commits a `Remove` of `target`'s leaf. The leaf is found by parsing `GET /tree` and
    /// walking its leaves' credentials, which is what a real client does: `remove <actor> <group>
    /// <target>` removes the **target**, and committing `own_leaf_index()` here would make every
    /// scenario remove its own committer and would leave `E_MEMBER_REMOVE_FORBIDDEN` untested end
    /// to end.
    pub fn remove(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        target: DeviceId,
    ) -> Result<(), TestkitError> {
        let leaf = leaf_of(&ds.ratchet_tree(group_id)?.ratchet_tree, target)?;
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let bundle = group.remove_members(&self.provider, &self.signer, &[leaf])?;
        self.upload_commit(ds, group_id, bundle, Vec::new())
    }

    /// Commits for the group's current epoch: a self-update, which also carries every proposal
    /// this client holds for the epoch. This is what lets a scenario drive invariant 3 without an
    /// implicit commit hiding inside `send`.
    pub fn commit(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let bundle = group.self_update(&self.provider, &self.signer)?;
        self.upload_commit(ds, group_id, bundle, Vec::new())
    }

    /// Drains this device's frames and applies everything in order: handshakes first, then the
    /// application messages of the epoch they belong to. Every frame is also kept, in order, for
    /// `take_frame`.
    pub fn sync(&mut self, ds: &mut dyn DeliveryService) -> Result<Vec<Received>, TestkitError> {
        let frames = ds.drain()?;
        self.frames.extend(frames.iter().cloned());
        let mut new = Vec::new();
        for frame in frames {
            match frame {
                Frame::MlsWelcome { .. }
                | Frame::MlsEpochChanged { .. }
                | Frame::CommitNeeded { .. }
                | Frame::MessageDeleted { .. }
                | Frame::GatewayError { .. } => {}
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

    /// Every frame `sync` has drained and no `take_frame` has claimed yet, in arrival order.
    pub fn frames(&self) -> &[Frame] {
        &self.frames
    }

    /// Claims the first drained frame `matches` accepts, so one frame satisfies one assertion.
    pub fn take_frame(&mut self, matches: impl Fn(&Frame) -> bool) -> Option<Frame> {
        let at = self.frames.iter().position(matches)?;
        Some(self.frames.remove(at))
    }
}

/// The leaf index of `target` in a serialized ratchet tree.
///
/// `RatchetTreeIn` keeps its node vector private and `leaves()` flattens the blanks away, which
/// loses the positions a leaf index is. Its serde form keeps every position (`null` for a blank,
/// leaves at even node indices), so the positions come from there and the credentials from
/// `leaves()`, and the two are zipped in order.
fn leaf_of(tree: &[u8], target: DeviceId) -> Result<LeafNodeIndex, TestkitError> {
    let tree = deserialize_tree(tree)?;
    let positions: Vec<usize> = match serde_json::to_value(&tree)
        .map_err(|e| TestkitError::Scenario(format!("ratchet tree: {e}")))?
    {
        serde_json::Value::Array(nodes) => nodes
            .iter()
            .enumerate()
            .filter(|(i, node)| i % 2 == 0 && !node.is_null())
            .map(|(i, _)| i / 2)
            .collect(),
        _ => {
            return Err(TestkitError::Scenario(
                "ratchet tree: not a node array".into(),
            ));
        }
    };
    let leaves: Vec<_> = tree.leaves().collect();
    if leaves.len() != positions.len() {
        return Err(TestkitError::Scenario(format!(
            "ratchet tree: {} leaves at {} positions",
            leaves.len(),
            positions.len()
        )));
    }
    for (index, leaf) in positions.into_iter().zip(leaves) {
        let basic = BasicCredential::try_from(leaf.credential().clone())
            .map_err(|e| TestkitError::Scenario(format!("{e:?}")))?;
        if CredentialIdentity::decode(basic.identity())?.device_id == target {
            let index = u32::try_from(index)
                .map_err(|_| TestkitError::Scenario("leaf index overflows u32".into()))?;
            return Ok(LeafNodeIndex::new(index));
        }
    }
    Err(TestkitError::Assertion(format!(
        "{} is not a member of this group",
        target.to_hex()
    )))
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
