use dilla_core::envelope::{FrankingTagInput, franking_tag};
use dilla_core::ids::{DeviceId, InstanceId};
use dilla_core::mls::DillaBinding;
use dilla_core::public_group::{DillaPublicGroup, PublicProcessed};
use openmls::prelude::*;
// `RatchetTree` is not re-exported by `openmls::prelude` in 0.9.0 — the prelude carries
// `treesync::RatchetTreeIn` only (verified in openmls-0.9.0/src/prelude.rs:48-56), so the
// serialiser below has to name it through its own module.
use openmls::treesync::RatchetTree;
use std::collections::BTreeMap;

/// The stub parses exactly two things: a commit, so `DillaPublicGroup` can validate it, and the
/// ratchet tree it serves back. It never parses an application message — see `post_message`.
fn deserialize_protocol(bytes: &[u8]) -> Result<ProtocolMessage, String> {
    use tls_codec::Deserialize as _;
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|e| format!("{e:?}"))?
        .try_into_protocol_message()
        .map_err(|e| format!("{e:?}"))
}

fn serialize_tree(tree: &RatchetTree) -> Result<Vec<u8>, DsError> {
    use tls_codec::Serialize as _;
    tree.tls_serialize_detached()
        .map_err(|e| DsError::CommitInvalid {
            reason: format!("{e:?}"),
        })
}

/// What the instance is: its identity, its external-sender signing key, its policy snapshot and
/// the key it franks uploads under.
pub struct InstanceConfig {
    pub instance_id: InstanceId,
    pub signing_key: [u8; 32],
    pub policy_version: u64,
    pub k_frank: [u8; 32],
}

/// Every delivery-service refusal. `code()` is the stable `E_*` string a client
/// switches on (protocol/02 § Errors); `http_status()` is the row's HTTP status.
#[derive(Debug, thiserror::Error)]
pub enum DsError {
    #[error("E_BINDING_INVALID")]
    BindingInvalid,
    #[error("E_MODE_READABLE")]
    ModeReadable,
    #[error("E_GROUP_EXISTS")]
    GroupExists,
    #[error("E_NOT_FOUND")]
    NotFound,
    #[error("E_LEAF_NOT_CURRENT")]
    LeafNotCurrent,
    #[error("E_COMMITMENT_INVALID")]
    CommitmentInvalid,
    #[error("E_TOO_LARGE")]
    TooLarge,
    #[error("E_PRUNED")]
    Pruned,
    #[error("E_RATE_LIMITED")]
    RateLimited { retry_after_ms: u64 },
    #[error("E_COMMIT_CONFLICT")]
    CommitConflict {
        winning_commit: Vec<u8>,
        proposals: Vec<Vec<u8>>,
    },
    #[error("E_COMMIT_REQUIRED")]
    CommitRequired { proposals: Vec<Vec<u8>> },
    #[error("E_COMMIT_INVALID")]
    CommitInvalid { reason: String },
}

impl DsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::BindingInvalid => "E_BINDING_INVALID",
            Self::ModeReadable => "E_MODE_READABLE",
            Self::GroupExists => "E_GROUP_EXISTS",
            Self::NotFound => "E_NOT_FOUND",
            Self::LeafNotCurrent => "E_LEAF_NOT_CURRENT",
            Self::CommitmentInvalid => "E_COMMITMENT_INVALID",
            Self::TooLarge => "E_TOO_LARGE",
            Self::Pruned => "E_PRUNED",
            Self::RateLimited { .. } => "E_RATE_LIMITED",
            Self::CommitConflict { .. } => "E_COMMIT_CONFLICT",
            Self::CommitRequired { .. } => "E_COMMIT_REQUIRED",
            Self::CommitInvalid { .. } => "E_COMMIT_INVALID",
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::BindingInvalid => 400,
            Self::ModeReadable | Self::LeafNotCurrent => 403,
            Self::NotFound => 404,
            Self::GroupExists | Self::CommitConflict { .. } => 409,
            Self::Pruned => 410,
            Self::TooLarge => 413,
            Self::CommitmentInvalid | Self::CommitInvalid { .. } => 422,
            Self::CommitRequired { .. } => 425,
            Self::RateLimited { .. } => 429,
        }
    }

    /// `retry_after_ms` is element 2 of the CBOR error array; it is present only
    /// for E_RATE_LIMITED and E_COMMIT_REQUIRED (protocol/02 § Errors).
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::RateLimited { retry_after_ms } => Some(*retry_after_ms),
            Self::CommitRequired { .. } => Some(0),
            _ => None,
        }
    }
}

pub struct RegisterGroup {
    pub binding: Vec<u8>,
    pub group_info: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
}
/// `Debug` because the invariant-1 tests `expect_err` on `Result<GroupRegistered, DsError>`,
/// which requires the success type to be printable.
#[derive(Debug)]
pub struct GroupRegistered {
    pub group_id: Vec<u8>,
    pub seq: u64,
}
pub struct GroupInfoResponse {
    pub epoch: u64,
    pub group_info: Vec<u8>,
    pub tree_hash: Vec<u8>,
    pub seq: u64,
}
pub struct TreeResponse {
    pub epoch: u64,
    pub ratchet_tree: Vec<u8>,
    pub tree_hash: Vec<u8>,
}
pub struct CommitUpload {
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
    pub welcomes: Vec<(DeviceId, Vec<u8>)>,
}
pub struct CommitAccepted {
    pub seq: u64,
    pub epoch: u64,
}
pub struct MessageAccepted {
    pub seq: u64,
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
}
#[derive(Clone, Debug)]
pub struct HandshakeItem {
    pub seq: u64,
    pub epoch: u64,
    /// 0 proposal, 1 commit, 2 external commit.
    pub kind: u8,
    pub sender: Option<u32>,
    pub blob: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct MessageItem {
    pub seq: u64,
    pub epoch: u64,
    pub uploader_device: DeviceId,
    pub blob: Vec<u8>,
    pub commitment: [u8; 32],
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
}
#[derive(Clone, Debug)]
pub enum Frame {
    MlsHandshake {
        group_id: Vec<u8>,
        item: HandshakeItem,
    },
    MlsWelcome {
        group_id: Vec<u8>,
        blob: Vec<u8>,
    },
    MlsEpochChanged {
        group_id: Vec<u8>,
        epoch: u64,
        seq: u64,
    },
    MessageCt {
        group_id: Vec<u8>,
        item: MessageItem,
    },
}

struct GroupState {
    binding: DillaBinding,
    public: Option<DillaPublicGroup>,
    group_info: Vec<u8>,
    ratchet_tree: Vec<u8>,
    tree_hash: Vec<u8>,
    epoch: u64,
    /// Invariant 3: the commit that won each epoch, keyed by the epoch it was made at.
    winners: BTreeMap<u64, Vec<u8>>,
    proposals: Vec<Vec<u8>>,
    handshakes: Vec<HandshakeItem>,
    messages: Vec<MessageItem>,
    seq: u64,
    members: Vec<DeviceId>,
}

struct DeviceState {
    packages: Vec<Vec<u8>>,
    last_resort: Vec<u8>,
    online: bool,
    queue: Vec<Frame>,
}

pub struct DsStub {
    cfg: InstanceConfig,
    groups: BTreeMap<Vec<u8>, GroupState>,
    devices: BTreeMap<[u8; 16], DeviceState>,
    clock: u64,
}

impl DsStub {
    pub fn new(cfg: InstanceConfig) -> Self {
        Self {
            cfg,
            groups: BTreeMap::new(),
            devices: BTreeMap::new(),
            clock: 1_758_659_640,
        }
    }

    fn device(&mut self, device: &DeviceId) -> &mut DeviceState {
        self.devices
            .entry(*device.as_bytes())
            .or_insert_with(|| DeviceState {
                packages: Vec::new(),
                last_resort: Vec::new(),
                online: true,
                queue: Vec::new(),
            })
    }

    fn group(&self, group_id: &[u8]) -> Result<&GroupState, DsError> {
        self.groups.get(group_id).ok_or(DsError::NotFound)
    }

    fn fanout(&mut self, group_id: &[u8], frame: Frame, except: Option<DeviceId>) {
        let members = match self.groups.get(group_id) {
            Some(g) => g.members.clone(),
            None => return,
        };
        for device in members {
            if Some(device) == except {
                continue;
            }
            self.device(&device).queue.push(frame.clone());
        }
    }

    /// Invariant 1. The group is registered with its `dilla_binding`; the binding must decode and
    /// must name this instance.
    pub fn register_group(&mut self, req: RegisterGroup) -> Result<GroupRegistered, DsError> {
        let binding = DillaBinding::decode(&req.binding).map_err(|_| DsError::BindingInvalid)?;
        if binding.instance_id != self.cfg.instance_id {
            return Err(DsError::BindingInvalid);
        }
        let group_id = binding.target_id.to_vec();
        if self.groups.contains_key(&group_id) {
            return Err(DsError::GroupExists);
        }
        self.groups.insert(
            group_id.clone(),
            GroupState {
                binding,
                public: None,
                group_info: req.group_info,
                ratchet_tree: req.ratchet_tree,
                tree_hash: Vec::new(),
                epoch: 0,
                winners: BTreeMap::new(),
                proposals: Vec::new(),
                handshakes: Vec::new(),
                messages: Vec::new(),
                seq: 1,
                members: Vec::new(),
            },
        );
        Ok(GroupRegistered { group_id, seq: 1 })
    }

    /// Attaches the structural validator once the creator has published a tree. Invariant 2: from
    /// here on the stub serves the tree and `tree_hash` from its own `PublicGroup`, and
    /// `accept_commit` refuses a commit that `PublicGroup` will not accept.
    ///
    /// `TestClient::create_group` calls this immediately after `register_group`, with a
    /// `DillaPublicGroup` built from the very GroupInfo and tree it uploaded. A group whose
    /// `public` is `None` would serve a frozen epoch-0 tree for ever and validate nothing, so
    /// `accept_commit` treats that as `CommitInvalid` rather than silently accepting.
    pub fn attach_public_group(&mut self, group_id: &[u8], public: DillaPublicGroup) {
        if let Some(g) = self.groups.get_mut(group_id) {
            g.tree_hash = public.tree_hash();
            g.epoch = public.epoch();
            g.public = Some(public);
        }
    }

    pub fn add_member_device(&mut self, group_id: &[u8], device: DeviceId) {
        if let Some(g) = self.groups.get_mut(group_id)
            && !g.members.contains(&device)
        {
            g.members.push(device);
        }
    }

    /// Role 1, the KeyPackage directory (protocol/02 line 60) — not one of the eleven invariants.
    pub fn publish_key_packages(
        &mut self,
        device: DeviceId,
        packages: Vec<Vec<u8>>,
        last_resort: Vec<u8>,
    ) -> Result<usize, DsError> {
        let count = packages.len();
        let entry = self.device(&device);
        entry.packages.extend(packages);
        entry.last_resort = last_resort;
        Ok(count)
    }

    /// Role 1, the KeyPackage directory: ordinary packages are consumed; the last-resort package is
    /// served but never consumed. The bool says which was returned, so the caller knows it owes an
    /// `Update`.
    pub fn take_key_package(&mut self, device: &DeviceId) -> Result<(Vec<u8>, bool), DsError> {
        let entry = self
            .devices
            .get_mut(device.as_bytes())
            .ok_or(DsError::NotFound)?;
        // FIFO: the directory hands out the oldest unused package first, which is what
        // protocol/02-delivery-service.md's directory semantics describe and what the invariant-4
        // test asserts. `pop()` would serve them newest-first.
        if !entry.packages.is_empty() {
            return Ok((entry.packages.remove(0), false));
        }
        if entry.last_resort.is_empty() {
            return Err(DsError::NotFound);
        }
        Ok((entry.last_resort.clone(), true))
    }

    pub fn group_info(&self, group_id: &[u8]) -> Result<GroupInfoResponse, DsError> {
        let g = self.group(group_id)?;
        Ok(GroupInfoResponse {
            epoch: g.epoch,
            group_info: g.group_info.clone(),
            tree_hash: g.tree_hash.clone(),
            seq: g.seq,
        })
    }

    /// Invariant 2: the tree and its hash come from the stub's own `PublicGroup`, refreshed by
    /// every accepted commit, and from the creator's upload only for the single epoch between
    /// `register_group` and `attach_public_group`.
    ///
    /// Both this and `group_info` read `tree_hash` from the same `DillaPublicGroup`, because the
    /// stub keeps exactly one view of the group; the joiner-side comparison in
    /// `TestClient::join_external` therefore catches a stub that serves a tree and a GroupInfo
    /// from **different epochs**, not a forged tree. Forgery is caught one layer down, inside
    /// `join_by_external_commit`, which validates the served tree against the GroupInfo's own
    /// `tree_hash` before it joins.
    pub fn ratchet_tree(&self, group_id: &[u8]) -> Result<TreeResponse, DsError> {
        let g = self.group(group_id)?;
        Ok(TreeResponse {
            epoch: g.epoch,
            ratchet_tree: g.ratchet_tree.clone(),
            tree_hash: g.tree_hash.clone(),
        })
    }

    fn accept_commit(
        &mut self,
        group_id: &[u8],
        req: CommitUpload,
        kind: u8,
    ) -> Result<CommitAccepted, DsError> {
        let g = self.groups.get_mut(group_id).ok_or(DsError::NotFound)?;
        // Invariant 3: the first valid commit for an epoch wins.
        if let Some(winner) = g.winners.get(&req.epoch) {
            return Err(DsError::CommitConflict {
                winning_commit: winner.clone(),
                proposals: g.proposals.clone(),
            });
        }

        // Invariant 2 and the "**valid**" in invariant 3: the commit goes through the stub's own
        // `DillaPublicGroup` before it wins the epoch, and the tree, the tree hash and the epoch
        // the stub serves afterwards are the ones that view computed. Without this the stub would
        // serve the creator's bootstrap tree for ever and "first valid commit" would mean "first
        // commit".
        let public = g.public.as_mut().ok_or_else(|| DsError::CommitInvalid {
            reason: "no PublicGroup attached; call attach_public_group after register_group".into(),
        })?;
        let crypto = openmls_rust_crypto::RustCrypto::default();
        let message =
            deserialize_protocol(&req.commit).map_err(|e| DsError::CommitInvalid { reason: e })?;
        let staged = match public.process_message(&crypto, message) {
            Ok(PublicProcessed::StagedCommit { staged, .. }) => *staged,
            Ok(other) => {
                return Err(DsError::CommitInvalid {
                    reason: format!("not a commit: {other:?}"),
                });
            }
            Err(e) => {
                return Err(DsError::CommitInvalid {
                    reason: format!("{e:?}"),
                });
            }
        };
        public
            .merge_commit(staged)
            .map_err(|e| DsError::CommitInvalid {
                reason: format!("{e:?}"),
            })?;
        let (tree, tree_hash, epoch_after) = (
            serialize_tree(&public.export_ratchet_tree())?,
            public.tree_hash(),
            public.epoch(),
        );

        g.winners.insert(req.epoch, req.commit.clone());
        g.epoch = epoch_after;
        g.ratchet_tree = tree;
        g.tree_hash = tree_hash;
        g.group_info = req.group_info;
        g.proposals.clear();
        let seq = g.seq;
        g.seq += 1;
        let item = HandshakeItem {
            seq,
            epoch: req.epoch,
            kind,
            sender: None,
            blob: req.commit.clone(),
        };
        g.handshakes.push(item.clone());
        let epoch = g.epoch;

        for (device, blob) in req.welcomes {
            self.add_member_device(group_id, device);
            self.device(&device).queue.push(Frame::MlsWelcome {
                group_id: group_id.to_vec(),
                blob,
            });
        }
        self.fanout(
            group_id,
            Frame::MlsHandshake {
                group_id: group_id.to_vec(),
                item,
            },
            None,
        );
        self.fanout(
            group_id,
            Frame::MlsEpochChanged {
                group_id: group_id.to_vec(),
                epoch,
                seq,
            },
            None,
        );
        Ok(CommitAccepted { seq, epoch })
    }

    pub fn post_commit(
        &mut self,
        group_id: &[u8],
        req: CommitUpload,
    ) -> Result<CommitAccepted, DsError> {
        self.accept_commit(group_id, req, 1)
    }

    pub fn post_external_commit(
        &mut self,
        group_id: &[u8],
        req: CommitUpload,
    ) -> Result<CommitAccepted, DsError> {
        self.accept_commit(group_id, req, 2)
    }

    pub fn post_proposal(
        &mut self,
        group_id: &[u8],
        epoch: u64,
        proposal: Vec<u8>,
    ) -> Result<u64, DsError> {
        let g = self.groups.get_mut(group_id).ok_or(DsError::NotFound)?;
        g.proposals.push(proposal.clone());
        let seq = g.seq;
        g.seq += 1;
        let item = HandshakeItem {
            seq,
            epoch,
            kind: 0,
            sender: None,
            blob: proposal,
        };
        g.handshakes.push(item.clone());
        self.fanout(
            group_id,
            Frame::MlsHandshake {
                group_id: group_id.to_vec(),
                item,
            },
            None,
        );
        Ok(seq)
    }

    /// The contract's `post_message`. The real DS reads the franking commitment `C` out of
    /// `private_message.authenticated_data`; this stub does not open application framing at all
    /// (deviation A1-11), so it has no commitment and refuses the upload with
    /// `CommitmentInvalid` — the same refusal the real DS makes when the commitment is missing.
    /// Test clients call `post_message_from`, which is handed `C` explicitly.
    pub fn post_message(
        &mut self,
        group_id: &[u8],
        epoch: u64,
        private_message: Vec<u8>,
    ) -> Result<MessageAccepted, DsError> {
        self.post_message_from(
            group_id,
            epoch,
            DeviceId::from_bytes([0u8; 16]),
            private_message,
            None,
        )
    }

    /// The form the test client uses: it knows its own device and the commitment it computed.
    pub fn post_message_from(
        &mut self,
        group_id: &[u8],
        epoch: u64,
        uploader_device: DeviceId,
        private_message: Vec<u8>,
        commitment: Option<[u8; 32]>,
    ) -> Result<MessageAccepted, DsError> {
        let commitment = commitment.ok_or(DsError::CommitmentInvalid)?;
        let k_frank = self.cfg.k_frank;
        let recv_ts = self.clock;
        self.clock += 1;
        let g = self.groups.get_mut(group_id).ok_or(DsError::NotFound)?;
        let seq = g.seq;
        g.seq += 1;
        let group_id_bytes = {
            let mut out = [0u8; 16];
            let n = group_id.len().min(16);
            out[..n].copy_from_slice(&group_id[..n]);
            out
        };
        let tag = franking_tag(
            &k_frank,
            &FrankingTagInput {
                group_id: group_id_bytes,
                epoch,
                seq,
                uploader_device,
                commitment,
                recv_ts,
            },
        );
        let item = MessageItem {
            seq,
            epoch,
            uploader_device,
            blob: private_message,
            commitment,
            franking_tag: tag,
            recv_ts,
        };
        g.messages.push(item.clone());
        self.fanout(
            group_id,
            Frame::MessageCt {
                group_id: group_id.to_vec(),
                item,
            },
            Some(uploader_device),
        );
        Ok(MessageAccepted {
            seq,
            franking_tag: tag,
            recv_ts,
        })
    }

    pub fn handshakes(&self, group_id: &[u8], from: u64) -> Result<Vec<HandshakeItem>, DsError> {
        Ok(self
            .group(group_id)?
            .handshakes
            .iter()
            .filter(|h| h.seq >= from)
            .cloned()
            .collect())
    }

    pub fn messages(&self, group_id: &[u8], from: u64) -> Result<Vec<MessageItem>, DsError> {
        Ok(self
            .group(group_id)?
            .messages
            .iter()
            .filter(|m| m.seq >= from)
            .cloned()
            .collect())
    }

    /// Invariants 5 and 6 (freeze and void) are out of scope for v0: this records the proposal and
    /// returns its sequence number without a TTL or a freeze.
    pub fn ds_propose_add(
        &mut self,
        group_id: &[u8],
        key_package: Vec<u8>,
    ) -> Result<u64, DsError> {
        let epoch = self.group(group_id)?.epoch;
        self.post_proposal(group_id, epoch, key_package)
    }

    pub fn ds_propose_remove(&mut self, group_id: &[u8], leaf: u32) -> Result<u64, DsError> {
        let epoch = self.group(group_id)?.epoch;
        self.post_proposal(group_id, epoch, leaf.to_be_bytes().to_vec())
    }

    pub fn set_online(&mut self, device: &DeviceId, online: bool) {
        self.device(device).online = online;
    }

    /// An offline device's queue is left untouched: `go_offline` then `sync` must deliver nothing,
    /// which is what the commit-conflict scenario relies on.
    pub fn drain(&mut self, device: &DeviceId) -> Vec<Frame> {
        let entry = self.device(device);
        if !entry.online {
            return Vec::new();
        }
        core::mem::take(&mut entry.queue)
    }

    /// Pops **only** the first `mls.welcome` frame for this group out of the device's queue and
    /// leaves every other frame where it is, in order. A joiner is added to `members` by
    /// `accept_commit` before the fan-out, so handshakes, epoch notices and application ciphertext
    /// can already be queued behind the Welcome when the joiner fetches it; `drain` would destroy
    /// them. An offline device is served nothing, exactly as `drain` serves it nothing.
    pub fn take_welcome(&mut self, device: &DeviceId, group_id: &[u8]) -> Option<Vec<u8>> {
        let entry = self.device(device);
        if !entry.online {
            return None;
        }
        let at = entry.queue.iter().position(
            |f| matches!(f, Frame::MlsWelcome { group_id: g, .. } if g.as_slice() == group_id),
        )?;
        match entry.queue.remove(at) {
            Frame::MlsWelcome { blob, .. } => Some(blob),
            other => unreachable!("position() matched a Welcome, got {other:?}"),
        }
    }

    pub fn public_group(&self, group_id: &[u8]) -> Option<&DillaPublicGroup> {
        self.groups.get(group_id).and_then(|g| g.public.as_ref())
    }

    pub fn binding(&self, group_id: &[u8]) -> Option<&DillaBinding> {
        self.groups.get(group_id).map(|g| &g.binding)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Option<u64> {
        self.groups.get(group_id).map(|g| g.epoch)
    }
}
