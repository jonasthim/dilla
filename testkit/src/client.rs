//! A headless dilla client: a `DillaProvider` over an in-memory SQLite database, one signing key,
//! one credential and the groups it belongs to.
//!
//! Every method that talks to a delivery service takes `&mut dyn DeliveryService`, so the same
//! client drives the in-memory `DsStub` and a real instance through `HttpDs`. Against the stub the
//! caller names the acting device first (`DsStub::act_as`); `HttpDs` is one device's client by
//! construction.

use crate::ds::{
    CommitRequest, DeliveryService, Device, DsError, HandshakeItem, HealRequest, NewAccount,
    RegisterGroup, ResyncRequest,
};
use crate::{Frame, TestkitError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{
    CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SskSigner, Tier,
    UmkSigner,
};
use dilla_core::ids::{DeviceId, MsgId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, CommitBundle, DillaBinding, DillaGroup, DillaProcessed, DillaProvider,
    MAX_ADDS_PER_COMMIT, build_key_package,
};
// Not re-exported by `openmls::prelude` in 0.9.0: the prelude carries nothing from
// `messages::group_info` (verified in openmls-0.9.0/src/prelude.rs:20 — `messages::*` stops at the
// module boundary), so `VerifiableGroupInfo` has to be named through its own path.
use openmls::extensions::ExternalSendersExtension;
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use rand_chacha::ChaCha20Rng;
use rand_chacha::rand_core::{RngCore, SeedableRng};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Received {
    pub group_id: Vec<u8>,
    pub seq: u64,
    pub sender: DeviceId,
    pub envelope: Envelope,
}

/// How many handshakes a client keeps per group for a heal: protocol/02's bound on the tail an
/// instance accepts, which is also what a client is asked to buffer.
pub const HEAL_TAIL: usize = 64;

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
    /// The SSK's seed: the SSK signs this device into the user's device list.
    ssk_seed: [u8; 32],
    groups: BTreeMap<Vec<u8>, DillaGroup>,
    inbox: Vec<Received>,
    /// Every frame `sync` drained, in arrival order, for a scenario's `expect_frame`.
    frames: Vec<Frame>,
    /// The last `HEAL_TAIL` handshakes drained per group, in seq order: what a heal uploads to a
    /// restored instance (invariant 11), and where a fork report finds the commit it names.
    tails: BTreeMap<Vec<u8>, VecDeque<HandshakeItem>>,
    /// Per group, the ProposalRefs queued for this client's next commit, so a proposal that
    /// arrives twice — as an `mls.handshake` frame and in row 19's list — is queued once. OpenMLS
    /// empties its queue on every merge, and so does `merged`.
    queued: BTreeMap<Vec<u8>, BTreeSet<Vec<u8>>>,
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
            ssk_seed,
            groups: BTreeMap::new(),
            inbox: Vec::new(),
            frames: Vec::new(),
            tails: BTreeMap::new(),
            queued: BTreeMap::new(),
            next_msg: 1,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    /// The user this client's credential names: the id the instance minted at registration.
    pub fn user_id(&self) -> UserId {
        self.identity.user_id
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

    /// protocol/03's signed device list, version 1, naming this one device: what the user
    /// publishes with `PUT /v1/users/{user_id}/device-list`, and what invariant 4 checks an Add's
    /// DSK against. `added_at` is the list's own timestamp for the entry.
    pub fn signed_device_list(&self, added_at: u64) -> DeviceList {
        self.signed_device_list_with(added_at, None)
    }

    /// `signed_device_list` with this device's entry revoked at `revoked_at`: a list the user
    /// signed that no longer vouches for the device, which invariant 4's Add clause must refuse
    /// to find the device's DSK in.
    pub fn signed_device_list_with(&self, added_at: u64, revoked_at: Option<u64>) -> DeviceList {
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id: self.identity.user_id,
            version: 1,
            prev_hash: [0u8; 32],
            entries: vec![DeviceEntry {
                device_id: self.device_id,
                dsk_pub: self.dsk.verifying_key().to_bytes(),
                tier: self.identity.tier,
                added_at,
                revoked_at,
            }],
        };
        let sig_ssk = SskSigner::from_bytes(&self.ssk_seed).sign_device_list(&unsigned);
        DeviceList { unsigned, sig_ssk }
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
        self.create_group_with(ds, binding, None)
    }

    /// `create_group` with the instance's external sender in the group context, which protocol/01
    /// requires of every `text` and `call` group: without it the instance can issue no Add or
    /// Remove proposal for the group (invariants 5 and 6).
    pub fn create_group_with(
        &mut self,
        ds: &mut dyn DeliveryService,
        binding: DillaBinding,
        external_senders: Option<ExternalSendersExtension>,
    ) -> Result<Vec<u8>, TestkitError> {
        let group_id = GroupId::from_slice(&binding.target_id);
        let group = DillaGroup::create(
            &self.provider,
            &self.signer,
            self.credential(),
            group_id.clone(),
            binding.clone(),
            external_senders,
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
        // The GroupInfo of epoch n + 1 that the commit builder signed while staging (invariant 4):
        // exporting one here, before the merge, would name epoch n, and merging first would leave
        // a refused commit applied.
        let Some(group_info) = bundle.group_info else {
            group.clear_pending_commit(&self.provider)?;
            return Err(TestkitError::Scenario(
                "the staged commit carries no GroupInfo".into(),
            ));
        };
        let accepted = ds.post_commit(
            group_id,
            CommitRequest {
                epoch,
                commit: serialize(&bundle.commit)?,
                group_info: serialize(&MlsMessageOut::from(group_info))?,
                welcomes,
            },
        );
        if let Err(refused) = accepted {
            group.clear_pending_commit(&self.provider)?;
            return Err(refused.into());
        }
        group.merge_pending_commit(&self.provider)?;
        self.queued.remove(group_id);
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
        self.join_external_with(ds, group_id, expected, false)
    }

    /// `join_external`, optionally with a leaf whose signature key is a fresh one rather than this
    /// device's DSK: the credential still names this device and user, so only a check that the
    /// leaf key IS the device's DSK tells the two apart (invariant 4's external-joiner clause,
    /// deviation B36). The fresh key signs the commit and the GroupInfo, as a joiner that held
    /// it would.
    pub fn join_external_with(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        expected: &DillaBinding,
        fresh_leaf_key: bool,
    ) -> Result<(), TestkitError> {
        let fresh = if fresh_leaf_key {
            let key = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
                .map_err(|e| TestkitError::Scenario(format!("a fresh leaf key: {e:?}")))?;
            key.store(self.provider.storage())?;
            Some(key)
        } else {
            None
        };
        let (signer, credential) = match &fresh {
            Some(key) => (
                key,
                CredentialWithKey {
                    credential: self.credential.credential.clone(),
                    signature_key: key.public().into(),
                },
            ),
            None => (&self.signer, self.credential()),
        };
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
            signer,
            credential,
            verifiable,
            deserialize_tree(&tree.ratchet_tree)?,
            expected,
        )?;
        // The joiner re-exports the GroupInfo from its own merged state either way, so the
        // `Option<GroupInfo>` the commit builder returned is not used here; it is named so the
        // unused-variable lint stays quiet and so a reader can see it was considered.
        let _ = &group_info;
        let posted = ds.post_external_commit(
            group_id,
            ResyncRequest {
                external_commit: serialize(&commit)?,
                group_info: serialize(&group.export_group_info(&self.provider, signer)?)?,
            },
        );
        if let Err(refused) = posted {
            // The join already wrote the joiner's group state under this group id; a refused join
            // must not leave it behind, or the next attempt finds a group that never existed.
            let mut group = group;
            group.delete(&self.provider)?;
            return Err(refused.into());
        }
        self.queued.remove(group_id);
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    pub fn send(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        body: &str,
    ) -> Result<MsgId, TestkitError> {
        let (epoch, message, msg_id) = self.seal(group_id, body)?;
        ds.post_message_from(group_id, epoch, message)?;
        Ok(msg_id)
    }

    /// Invariant 8's malformed upload: a real message of this group whose `authenticated_data` —
    /// the 32-byte franking commitment — is rewritten to `len` bytes. The field is cleartext in a
    /// `PrivateMessage` (RFC 9420 §6.3), so the rewritten message still parses; only its AEAD no
    /// longer opens, which the instance cannot see and a receiver would refuse.
    pub fn send_bad_commitment(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        len: usize,
    ) -> Result<(), TestkitError> {
        let (epoch, message, _) = self.seal(group_id, "a commitment of the wrong length")?;
        ds.post_message_from(group_id, epoch, with_authenticated_data_len(&message, len)?)?;
        Ok(())
    }

    /// Frames `body` as an application message of the group's current epoch.
    fn seal(&mut self, group_id: &[u8], body: &str) -> Result<(u64, Vec<u8>, MsgId), TestkitError> {
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
        Ok((group.epoch(), serialize(&out)?, envelope.msg_id))
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

    /// Proposes this device's removal from `group_id` (`leave <client> <group>`): the member Remove
    /// proposal of protocol/01 "Leaving", posted to `POST /v1/groups/{id}/proposal`. Another
    /// member's commit applies it.
    ///
    /// When the instance is already removing this leaf (a kick, a ban, an eviction), the delivery
    /// service refuses the proposal with `E_INVALID_REQUEST`, "a removal of this leaf is already
    /// pending" (protocol/02 invariant 6). That is not a failure of the leave: the device is being
    /// removed, by the instance's own Remove. The refused proposal is withdrawn from this client's
    /// queue — no other member holds it — and the leave succeeds. Any other refusal withdraws it too
    /// and is returned.
    pub fn leave(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let epoch = group.epoch();
        let proposal = group.leave(&self.provider, &self.signer)?;
        match ds.post_proposal(group_id, epoch, serialize(&proposal)?) {
            Ok(_) => Ok(()),
            Err(refused) => {
                group.withdraw_leave(&self.provider)?;
                if is_removal_pending(&refused) {
                    Ok(())
                } else {
                    Err(refused.into())
                }
            }
        }
    }

    /// Commits for the group's current epoch: a self-update, which also carries every proposal
    /// this client holds for the epoch. This is what lets a scenario drive invariant 3 without an
    /// implicit commit hiding inside `send`.
    pub fn commit(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        self.commit_with(ds, group_id, false)
    }

    /// `commit` by a committer whose queue holds a member's `Remove` BEHIND the instance's `Remove`
    /// of the same leaf (`commit <actor> <group> member_removes_last`): OpenMLS then commits the
    /// member's, which is what a client not following dilla-core's queue rule sends. Fails when
    /// the queue holds no such pair, so a scenario cannot pass without exercising it.
    pub fn commit_member_removes_last(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        self.commit_with(ds, group_id, true)
    }

    fn commit_with(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        member_removes_last: bool,
    ) -> Result<(), TestkitError> {
        self.absorb_proposals(ds, group_id)?;
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        if member_removes_last && group.requeue_member_removes_last(&self.provider)? == 0 {
            return Err(TestkitError::Scenario(
                "member_removes_last: no member Remove shares its leaf with a queued instance Remove"
                    .into(),
            ));
        }
        let bundle = group.self_update(&self.provider, &self.signer)?;
        // A queued instance Add makes the commit carry a Welcome, addressed by `self_update` to
        // the device the Add names; the instance stores it for that device (row 15).
        let welcomes = bundle
            .welcomes
            .iter()
            .map(|(d, w)| Ok((*d, serialize(w)?)))
            .collect::<Result<Vec<_>, TestkitError>>()?;
        self.upload_commit(ds, group_id, bundle, welcomes)
    }

    /// Queues every non-void instance proposal the delivery service lists for the group's current
    /// epoch (row 19) that this client has not queued already. A void one is left out: invariant 6
    /// lets a commit omit it, and that is what a committer does.
    ///
    /// The list, not only the `mls.handshake` frames, because a frame is fanned out asynchronously
    /// and may not have reached the socket when the committer builds its commit; invariant 4
    /// refuses a commit that misses an outstanding proposal.
    fn absorb_proposals(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        let items = ds.proposals(group_id)?;
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        for item in items.into_iter().filter(|i| !i.void) {
            let message = deserialize_protocol(&item.blob)?;
            if message.epoch().as_u64() != group.epoch() {
                continue;
            }
            if let DillaProcessed::Proposal(proposal) =
                group.process_message(&self.provider, message)?
            {
                let reference = proposal.proposal_reference_ref().as_slice().to_vec();
                if self
                    .queued
                    .entry(group_id.to_vec())
                    .or_default()
                    .insert(reference)
                {
                    group.store_pending_proposal(&self.provider, *proposal)?;
                }
            }
        }
        Ok(())
    }

    /// Drains this device's frames and applies everything in order: handshakes first, then the
    /// application messages of the epoch they belong to. Every frame is also kept, in order, for
    /// `take_frame`.
    /// The client's current epoch in `group_id`, or None when it holds no state for the group.
    pub fn epoch_of(&self, group_id: &[u8]) -> Option<u64> {
        self.groups.get(group_id).map(|g| g.epoch())
    }

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
                    let tail = self.tails.entry(group_id.clone()).or_default();
                    if tail.back().is_none_or(|last| last.seq < item.seq) {
                        tail.push_back(item.clone());
                        if tail.len() > HEAL_TAIL {
                            tail.pop_front();
                        }
                    }
                    if let Some(group) = self.groups.get_mut(&group_id) {
                        // The DS fans a commit out to every member, the committer included, and a
                        // committer has already merged its own commit before the frame arrives.
                        // Feeding OpenMLS a handshake for an epoch the group has left is a
                        // `WrongEpoch` validation failure, so a frame that is already applied is
                        // skipped rather than processed.
                        //
                        // The epoch compared is the one the MLS message is FRAMED in, not the
                        // record's `epoch`: the instance records a commit under the epoch it
                        // creates (`GetCommitAtEpoch`: "the handshake that carried a group into
                        // `epoch`") while the stub records the epoch it was sent in, and only the
                        // framing says which epoch OpenMLS will process it against.
                        let message = deserialize_protocol(&item.blob)?;
                        if message.epoch().as_u64() < group.epoch() {
                            continue;
                        }
                        match group.process_message(&self.provider, message)? {
                            DillaProcessed::StagedCommit(staged) => {
                                group.merge_staged_commit(&self.provider, *staged)?;
                                self.queued.remove(&group_id);
                            }
                            // An instance proposal (or a member's own-device Remove) is queued for
                            // this client's next commit: invariant 4 refuses a commit that does
                            // not reference every outstanding instance proposal.
                            DillaProcessed::Proposal(proposal) => {
                                let reference =
                                    proposal.proposal_reference_ref().as_slice().to_vec();
                                if self
                                    .queued
                                    .entry(group_id.clone())
                                    .or_default()
                                    .insert(reference)
                                {
                                    group.store_pending_proposal(&self.provider, *proposal)?;
                                }
                            }
                            _ => {}
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

    /// Invariant 9 and R25: the client drops its own copy of the group and returns to the
    /// instance's head by an own-leaf external commit. OpenMLS removes the leaf that carries this
    /// client's signature key in the same commit (external_commits.rs: the Remove of the member
    /// whose `signature_key` is the joiner's), so the device ends with one leaf, not two.
    pub fn resync(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
        expected: &DillaBinding,
    ) -> Result<(), TestkitError> {
        if let Some(mut stale) = self.groups.remove(group_id) {
            stale.delete(&self.provider)?;
        }
        self.join_external(ds, group_id, expected)
    }

    /// Invariant 9: reports the last commit this client received for the group as one it cannot
    /// process. The seq and epoch are the handshake record's own.
    pub fn fork_report(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        self.sync(ds)?;
        let commit = self
            .tails
            .get(group_id)
            .and_then(|tail| tail.iter().rev().find(|h| h.kind == 1 || h.kind == 2))
            .cloned()
            .ok_or_else(|| {
                TestkitError::Scenario(format!("{} received no commit to report", self.name))
            })?;
        ds.fork_report(
            group_id,
            commit.epoch,
            commit.seq,
            "dilla-testkit: this commit does not process",
        )?;
        Ok(())
    }

    /// Invariant 11: after a restore, uploads this member's GroupInfo and the handshake tail it
    /// holds. The instance replays what its restored log lacks and adopts the result only when the
    /// GroupInfo's tree hash matches the tree it rebuilt.
    pub fn heal(
        &mut self,
        ds: &mut dyn DeliveryService,
        group_id: &[u8],
    ) -> Result<(), TestkitError> {
        self.sync(ds)?;
        let group = self
            .groups
            .get(group_id)
            .ok_or_else(|| TestkitError::Scenario("not a member of this group".into()))?;
        let group_info = serialize(&group.export_group_info(&self.provider, &self.signer)?)?;
        let tail = self
            .tails
            .get(group_id)
            .map(|t| t.iter().cloned().collect())
            .unwrap_or_default();
        ds.heal(
            group_id,
            HealRequest {
                group_info,
                tail,
                ratchet_tree: None,
            },
        )?;
        Ok(())
    }

    /// Invariant 7: acknowledges the most recent `mls.commit_needed` this client received, and
    /// does nothing else. A round that is acknowledged and then not committed is a lost round.
    pub fn ack_commit(&mut self, ds: &mut dyn DeliveryService) -> Result<(), TestkitError> {
        self.sync(ds)?;
        let latest = self
            .frames
            .iter()
            .rposition(|f| matches!(f, Frame::CommitNeeded { .. }))
            .ok_or_else(|| {
                TestkitError::Assertion(format!("{} was never asked to commit", self.name))
            })?;
        // Claimed, with every older election frame: one acknowledgement answers one round, and
        // the next `ack_commit` must find the NEXT round rather than this one again.
        let mut claimed = Vec::new();
        let mut index = 0;
        self.frames.retain(|f| {
            let keep = !(index <= latest && matches!(f, Frame::CommitNeeded { .. }));
            if !keep {
                claimed.push(f.clone());
            }
            index += 1;
            keep
        });
        match claimed.pop() {
            Some(Frame::CommitNeeded {
                group_id, round, ..
            }) => {
                ds.ack_commit(&group_id, round)?;
                Ok(())
            }
            _ => unreachable!("the latest CommitNeeded frame was claimed"),
        }
    }

    /// The `CredentialIdentity` CBOR this device registered with, which a session challenge
    /// carries.
    pub fn credential_blob(&self) -> Vec<u8> {
        self.identity.encode()
    }

    /// How many members this client's tree of the group holds.
    pub fn member_count(&self, group_id: &[u8]) -> Option<usize> {
        self.groups.get(group_id).map(DillaGroup::member_count)
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

/// RFC 9420 §2.1.2's variable-length integer at `at`: (value, length of the prefix).
fn read_varint(bytes: &[u8], at: usize) -> Result<(usize, usize), TestkitError> {
    let truncated = || TestkitError::Scenario("a truncated MLS vector length".into());
    let first = *bytes.get(at).ok_or_else(truncated)?;
    let width = match first >> 6 {
        0 => 1,
        1 => 2,
        2 => 4,
        _ => {
            return Err(TestkitError::Scenario(
                "an invalid MLS vector length".into(),
            ));
        }
    };
    let prefix = bytes.get(at..at + width).ok_or_else(truncated)?;
    let value = prefix[1..]
        .iter()
        .fold(usize::from(first & 0x3f), |n, b| (n << 8) | usize::from(*b));
    Ok((value, width))
}

/// RFC 9420 §2.1.2's variable-length integer, in its shortest form.
fn write_varint(n: usize) -> Result<Vec<u8>, TestkitError> {
    match n {
        0..=0x3f => Ok(vec![n as u8]),
        0x40..=0x3fff => Ok(vec![0x40 | (n >> 8) as u8, n as u8]),
        0x4000..=0x3fff_ffff => Ok(vec![
            0x80 | (n >> 24) as u8,
            (n >> 16) as u8,
            (n >> 8) as u8,
            n as u8,
        ]),
        _ => Err(TestkitError::Scenario(format!(
            "{n} bytes do not fit an MLS vector"
        ))),
    }
}

/// Where `authenticated_data` sits in a serialized `MLSMessage` that carries a `PrivateMessage`:
/// the start of its length prefix, the start of its bytes and their end. RFC 9420 §6.3:
/// `version(u16) wire_format(u16) group_id<V> epoch(u64) content_type(u8) authenticated_data<V> …`.
fn authenticated_data_span(message: &[u8]) -> Result<(usize, usize, usize), TestkitError> {
    const MLS_PRIVATE_MESSAGE: [u8; 2] = [0x00, 0x02];
    if message.get(2..4) != Some(&MLS_PRIVATE_MESSAGE[..]) {
        return Err(TestkitError::Scenario(
            "not a serialized PrivateMessage".into(),
        ));
    }
    let (group_id_len, prefix) = read_varint(message, 4)?;
    let start = 4 + prefix + group_id_len + 8 + 1;
    let (aad_len, prefix) = read_varint(message, start)?;
    let data = start + prefix;
    let end = data + aad_len;
    if end > message.len() {
        return Err(TestkitError::Scenario(
            "authenticated_data runs past the message".into(),
        ));
    }
    Ok((start, data, end))
}

/// The same message with its `authenticated_data` rewritten to `len` bytes: the original bytes as
/// far as they go, then zeros. Everything around the field is kept byte for byte.
fn with_authenticated_data_len(message: &[u8], len: usize) -> Result<Vec<u8>, TestkitError> {
    let (start, data, end) = authenticated_data_span(message)?;
    let original = &message[data..end];
    let mut out = message[..start].to_vec();
    out.extend(write_varint(len)?);
    out.extend((0..len).map(|i| original.get(i).copied().unwrap_or(0)));
    out.extend_from_slice(&message[end..]);
    Ok(out)
}

/// The delivery service's refusal of a member's own `Remove` of a leaf the instance is already
/// removing (protocol/02 invariant 6): `E_INVALID_REQUEST` with this detail. A leaving client reads
/// it as "I am being removed".
const REMOVAL_PENDING: &str = "a removal of this leaf is already pending";

fn is_removal_pending(e: &DsError) -> bool {
    matches!(e, DsError::Remote { code: "E_INVALID_REQUEST", detail, .. } if detail == REMOVAL_PENDING)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dilla_core::ids::InstanceId;
    use dilla_core::mls::GroupKind;

    #[test]
    fn only_the_removal_pending_refusal_reads_as_being_removed() {
        let pending = DsError::Remote {
            status: 400,
            code: "E_INVALID_REQUEST",
            detail: REMOVAL_PENDING.into(),
        };
        assert!(is_removal_pending(&pending));
        for other in [
            DsError::Remote {
                status: 400,
                code: "E_INVALID_REQUEST",
                detail: "something else".into(),
            },
            DsError::Remote {
                status: 403,
                code: "E_FORBIDDEN",
                detail: REMOVAL_PENDING.into(),
            },
            DsError::LeafNotCurrent,
        ] {
            assert!(!is_removal_pending(&other), "{other:?}");
        }
    }

    /// A real application message of a one-member text group, serialized as it is uploaded.
    fn an_application_message() -> Vec<u8> {
        let client = TestClient::new(
            "alice",
            UserId::from_bytes([0x01; 16]),
            Tier::Native,
            Kind::User,
            7,
        )
        .expect("client");
        let binding = DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: [0x22; 16],
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: GroupKind::Text.media_version(),
        };
        let mut group = DillaGroup::create(
            client.provider(),
            client.signer(),
            client.credential(),
            GroupId::from_slice(&[0x22; 16]),
            binding,
            None,
        )
        .expect("group");
        let envelope = Envelope {
            v: 1,
            msg_id: MsgId::from_bytes([0x33; 16]),
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: "hello".into(),
            attachments: Vec::new(),
            previews: Vec::new(),
            k_f: [0x06; 32],
        };
        let out = group
            .create_message(client.provider(), client.signer(), &envelope)
            .expect("message");
        serialize(&out).expect("serialize")
    }

    #[test]
    fn a_sent_message_carries_a_32_byte_commitment_where_the_span_says() {
        let message = an_application_message();
        let (_, data, end) = authenticated_data_span(&message).expect("span");
        assert_eq!(end - data, 32);
    }

    /// The rewritten message still parses as the same group's message of the same epoch — the
    /// instance must see a well-framed upload whose only fault is the commitment's length — and
    /// everything after the field is untouched.
    #[test]
    fn the_commitment_is_rewritten_to_any_length_and_the_message_still_parses() {
        let message = an_application_message();
        let (_, _, end) = authenticated_data_span(&message).expect("span");
        let original = deserialize_protocol(&message).expect("original");
        for len in [0, 1, 31, 33, 63, 64, 100, 20_000] {
            let bad = with_authenticated_data_len(&message, len).expect("rewrite");
            let (_, data, new_end) = authenticated_data_span(&bad).expect("span");
            assert_eq!(new_end - data, len, "len {len}");
            assert_eq!(
                &bad[new_end..],
                &message[end..],
                "len {len}: the tail moved"
            );
            let parsed = deserialize_protocol(&bad).unwrap_or_else(|e| panic!("len {len}: {e}"));
            assert_eq!(parsed.epoch(), original.epoch(), "len {len}");
            assert_eq!(parsed.group_id(), original.group_id(), "len {len}");
        }
    }

    #[test]
    fn only_a_private_message_is_rewritten() {
        let mut message = an_application_message();
        message[3] = 0x01; // mls_public_message
        assert!(with_authenticated_data_len(&message, 31).is_err());
        assert!(with_authenticated_data_len(&[0x00, 0x01], 31).is_err());
    }

    #[test]
    fn varints_round_trip_at_each_width() {
        for n in [0, 0x3f, 0x40, 0x3fff, 0x4000, 0x3fff_ffff] {
            let bytes = write_varint(n).expect("fits");
            assert_eq!(
                read_varint(&bytes, 0).expect("reads"),
                (n, bytes.len()),
                "{n}"
            );
        }
        assert!(write_varint(0x4000_0000).is_err());
        assert!(read_varint(&[0xc0], 0).is_err());
        assert!(read_varint(&[0x40], 0).is_err());
    }
}
