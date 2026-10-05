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

// Named explicitly: the openmls prelude glob above also exports a `GroupId`, and an explicit import
// shadows a glob one.
use super::{
    CommitRequest, CommitResult, DeliveryService, Device, GroupId, GroupInfoResp, HealRequest,
    KeyPackageResp, RegisterRequest, RegisterResult, ResyncRequest, TreeResp, UploadResult,
    WelcomeItem,
};

/// The stub parses three things: a commit, so `DillaPublicGroup` can validate it; the ratchet tree
/// and GroupInfo a creator registers, so it can build that view; and the cleartext
/// `authenticated_data` header of an application message, which is where the franking commitment
/// travels. It never decrypts anything — see `post_message`.
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
    /// The Display carries the rule, because "which rule refused it" is the whole diagnosis.
    #[error("E_COMMIT_INVALID: {reason}")]
    CommitInvalid { reason: String },
    /// A refusal from a remote instance whose code the stub never raises itself (`E_FORBIDDEN`,
    /// `E_UNAUTHENTICATED`, `E_INVALID_REQUEST`, …). `code` is interned from protocol/02's one
    /// vocabulary, so `code()` stays `&'static str`; an answer carrying a code outside that
    /// vocabulary is a `Protocol` error, not one of these.
    #[error("{code} ({status}): {detail}")]
    Remote {
        status: u16,
        code: &'static str,
        detail: String,
    },
    /// The testkit's own client could not make sense of an answer: a body that is not the CBOR
    /// shape its route promises, a missing environment variable, an unknown frame. Not a wire code.
    #[error("testkit protocol: {0}")]
    Protocol(String),
    /// The socket, the HTTP connection or the WebSocket failed. Not a wire code.
    #[error("testkit transport: {0}")]
    Transport(String),
    /// The delivery service behind the trait does not model this call. `DsStub` answers it for
    /// invariants 9 and 11 (fork reports, heal) and for the control-listener verbs, so a scenario
    /// that needs them fails loudly against the stub instead of passing vacuously.
    #[error("testkit unsupported: {0}")]
    Unsupported(String),
}

/// protocol/02's error vocabulary, the one table `internal/server/errors.go` holds and
/// `scripts/check-protocol-docs.mjs` diffs in both directions. `DsError::from_code` interns a
/// remote answer's code against it.
const WIRE_CODES: &[&str] = &[
    "E_BINDING_INVALID",
    "E_CHANNEL_MODE",
    "E_COMMIT_CONFLICT",
    "E_COMMIT_INVALID",
    "E_COMMITMENT_INVALID",
    "E_COMMIT_REQUIRED",
    "E_ENVELOPE_LIMIT",
    "E_ENVELOPE_SHAPE",
    "E_ENVELOPE_TYPE",
    "E_FORBIDDEN",
    "E_GROUP_EXISTS",
    "E_INTERNAL",
    "E_INVALID_REQUEST",
    "E_INVITE_INVALID",
    "E_LEAF_NOT_CURRENT",
    "E_MODE_READABLE",
    "E_NOT_FOUND",
    "E_NOT_UPLOADER",
    "E_PROVISIONAL_OUTSIDE_PAIRING",
    "E_PRUNED",
    "E_RATE_LIMITED",
    "E_REMOVE_PENDING",
    "E_STORAGE_FULL",
    "E_TOO_LARGE",
    "E_UNAUTHENTICATED",
    "E_VERSION",
];

/// The positions after `[code, detail, retry_after_ms]` in a remote error body: the four
/// extended shapes of protocol/02 § Errors. `check_status` in `ds::remote` fills in what the
/// body carries; everything else is left empty.
#[derive(Default)]
pub struct ErrorExtras {
    pub retry_after_ms: Option<u64>,
    pub winning_commit: Vec<u8>,
    pub proposals: Vec<Vec<u8>>,
    pub rule: String,
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
            Self::Remote { code, .. } => code,
            Self::Protocol(_) => "testkit:protocol",
            Self::Transport(_) => "testkit:transport",
            Self::Unsupported(_) => "testkit:unsupported",
        }
    }

    /// Rebuilds the refusal a remote instance answered with. The twelve codes the stub raises
    /// itself come back as their own variants, carrying what the extended body positions hold, so
    /// a scenario's `expect_reject` matches one Display whichever delivery service ran it.
    pub fn from_code(status: u16, code: &str, detail: &str, extras: ErrorExtras) -> Self {
        let typed = match code {
            "E_BINDING_INVALID" => Some(Self::BindingInvalid),
            "E_MODE_READABLE" => Some(Self::ModeReadable),
            "E_GROUP_EXISTS" => Some(Self::GroupExists),
            "E_NOT_FOUND" => Some(Self::NotFound),
            "E_LEAF_NOT_CURRENT" => Some(Self::LeafNotCurrent),
            "E_COMMITMENT_INVALID" => Some(Self::CommitmentInvalid),
            "E_TOO_LARGE" => Some(Self::TooLarge),
            "E_PRUNED" => Some(Self::Pruned),
            "E_RATE_LIMITED" => Some(Self::RateLimited {
                retry_after_ms: extras.retry_after_ms.unwrap_or(0),
            }),
            "E_COMMIT_CONFLICT" => Some(Self::CommitConflict {
                winning_commit: extras.winning_commit,
                proposals: extras.proposals,
            }),
            "E_COMMIT_REQUIRED" => Some(Self::CommitRequired {
                proposals: extras.proposals,
            }),
            "E_COMMIT_INVALID" => Some(Self::CommitInvalid {
                reason: if extras.rule.is_empty() {
                    detail.to_owned()
                } else {
                    extras.rule
                },
            }),
            _ => None,
        };
        // A typed variant carries its own default status; a remote instance that answered the
        // same code at another status (protocol/02 permits exactly one such override, a duplicate
        // username at 409) is kept as `Remote` so the status the scenario sees is the real one.
        match typed {
            Some(e) if e.http_status() == status => e,
            _ => match WIRE_CODES.iter().find(|c| **c == code) {
                Some(code) => Self::Remote {
                    status,
                    code,
                    detail: detail.to_owned(),
                },
                None => Self::Protocol(format!(
                    "HTTP {status} carried {code:?}, which is not in protocol/02's vocabulary: {detail}"
                )),
            },
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
            Self::Remote { status, .. } => *status,
            // Not an HTTP answer at all: the request never produced one the client could read.
            Self::Protocol(_) | Self::Transport(_) | Self::Unsupported(_) => 0,
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
    /// Op 17, invariant 7's election. The stub never sends it: it does not model the watchdog.
    CommitNeeded {
        group_id: Vec<u8>,
        epoch: u64,
        proposal_refs: Vec<Vec<u8>>,
        deadline_ms: u64,
        round: u64,
    },
    /// Op 21. The stub never sends it: it has no message delete.
    MessageDeleted {
        group_id: Vec<u8>,
        seq: u64,
        deleted_at: u64,
    },
    /// Op 9, the structured failure an instance sends before it closes a connection.
    GatewayError {
        cid: u64,
        code: String,
        detail: String,
    },
}

impl Frame {
    /// protocol/02's documentation label for the frame's opcode, which is what a scenario's
    /// `expect_frame` names.
    pub fn label(&self) -> &'static str {
        match self {
            Self::MlsHandshake { .. } => "mls.handshake",
            Self::CommitNeeded { .. } => "mls.commit_needed",
            Self::MlsEpochChanged { .. } => "mls.epoch_changed",
            Self::MessageCt { .. } => "message.ct",
            Self::MlsWelcome { .. } => "mls.welcome",
            Self::MessageDeleted { .. } => "message.deleted",
            Self::GatewayError { .. } => "error",
        }
    }

    /// One payload field by its protocol/02 name, rendered the way a scenario writes it: decimal
    /// for a uint, lowercase hex for a byte string. `group_id` is element 2 of every group frame.
    pub fn field(&self, name: &str) -> Option<String> {
        let uint = |v: u64| Some(v.to_string());
        let hex = |v: &[u8]| Some(hex::encode(v));
        match (self, name) {
            (
                Self::MlsHandshake { group_id, .. }
                | Self::MlsWelcome { group_id, .. }
                | Self::MlsEpochChanged { group_id, .. }
                | Self::MessageCt { group_id, .. }
                | Self::CommitNeeded { group_id, .. }
                | Self::MessageDeleted { group_id, .. },
                "group_id",
            ) => hex(group_id),
            (Self::MlsHandshake { item, .. }, "seq") => uint(item.seq),
            (Self::MlsHandshake { item, .. }, "epoch") => uint(item.epoch),
            (Self::MlsHandshake { item, .. }, "kind") => uint(u64::from(item.kind)),
            (Self::MlsHandshake { item, .. }, "sender") => {
                item.sender.map(u64::from).and_then(uint)
            }
            (Self::MlsEpochChanged { epoch, .. }, "epoch") => uint(*epoch),
            (Self::MlsEpochChanged { seq, .. }, "seq") => uint(*seq),
            (Self::MessageCt { item, .. }, "seq") => uint(item.seq),
            (Self::MessageCt { item, .. }, "epoch") => uint(item.epoch),
            (Self::MessageCt { item, .. }, "uploader_device") => {
                hex(item.uploader_device.as_bytes())
            }
            (Self::CommitNeeded { epoch, .. }, "epoch") => uint(*epoch),
            (Self::CommitNeeded { deadline_ms, .. }, "deadline_ms") => uint(*deadline_ms),
            (Self::CommitNeeded { round, .. }, "round") => uint(*round),
            (Self::CommitNeeded { proposal_refs, .. }, "proposals") => {
                uint(proposal_refs.len() as u64)
            }
            (Self::MessageDeleted { seq, .. }, "seq") => uint(*seq),
            (Self::GatewayError { code, .. }, "code") => Some(code.clone()),
            _ => None,
        }
    }
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
    /// Row 15's durable Welcome queue: fetched without being consumed, acknowledged by id.
    welcomes: Vec<WelcomeItem>,
}

pub struct DsStub {
    cfg: InstanceConfig,
    groups: BTreeMap<Vec<u8>, GroupState>,
    devices: BTreeMap<[u8; 16], DeviceState>,
    clock: u64,
    /// The device the `DeliveryService` impl speaks for; see `act_as`.
    current: Option<DeviceId>,
    /// Row 18: each device's `(last_seq, last_epoch)` per group.
    cursors: BTreeMap<([u8; 16], Vec<u8>), (u64, u64)>,
    next_welcome_id: u64,
}

impl DsStub {
    pub fn new(cfg: InstanceConfig) -> Self {
        Self {
            cfg,
            groups: BTreeMap::new(),
            devices: BTreeMap::new(),
            clock: 1_758_659_640,
            current: None,
            cursors: BTreeMap::new(),
            next_welcome_id: 1,
        }
    }

    /// The device whose view the `DeliveryService` impl speaks for. `HttpDs` is one device's client
    /// by construction; the stub is every device's, so the trait impl needs to know which one.
    pub fn act_as(&mut self, device: DeviceId) {
        self.current = Some(device);
    }

    fn current_device(&self) -> Result<DeviceId, DsError> {
        self.current
            .ok_or_else(|| DsError::Protocol("no current device: call act_as first".into()))
    }

    /// The cursor `advance_cursor` last recorded for `device` in `group_id`.
    pub fn cursor(&self, device: &DeviceId, group_id: &[u8]) -> Option<(u64, u64)> {
        self.cursors
            .get(&(*device.as_bytes(), group_id.to_vec()))
            .copied()
    }

    /// The stub's own clock, in unix seconds: `recv_ts` of the next upload.
    pub fn clock(&self) -> u64 {
        self.clock
    }

    fn device(&mut self, device: &DeviceId) -> &mut DeviceState {
        self.devices
            .entry(*device.as_bytes())
            .or_insert_with(|| DeviceState {
                packages: Vec::new(),
                last_resort: Vec::new(),
                online: true,
                queue: Vec::new(),
                welcomes: Vec::new(),
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
        let (welcome_tree, welcome_tree_hash) = (g.ratchet_tree.clone(), g.tree_hash.clone());

        for (device, blob) in req.welcomes {
            self.add_member_device(group_id, device);
            let welcome_id = self.next_welcome_id;
            self.next_welcome_id += 1;
            let entry = self.device(&device);
            // Row 15 carries the tree **as of the welcoming epoch** (a dilla Welcome carries no
            // tree, and the live tree moves on before the joiner collects).
            entry.welcomes.push(WelcomeItem {
                welcome_id,
                group_id: group_id.to_vec(),
                epoch,
                commit_seq: seq,
                blob: blob.clone(),
                ratchet_tree: welcome_tree.clone(),
                tree_hash: welcome_tree_hash.clone(),
            });
            entry.queue.push(Frame::MlsWelcome {
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
            Frame::MlsWelcome { blob, .. } => {
                // The durable row goes with the frame: taking a Welcome is its acknowledgement.
                if let Some(row) = entry
                    .welcomes
                    .iter()
                    .position(|w| w.group_id == group_id && w.blob == blob)
                {
                    entry.welcomes.remove(row);
                }
                Some(blob)
            }
            other => unreachable!("position() matched a Welcome, got {other:?}"),
        }
    }

    /// Row 15 for one device: every Welcome not yet acknowledged, oldest first, without consuming
    /// any. An offline device is served nothing, exactly as `drain` and `take_welcome` serve it
    /// nothing.
    fn welcomes_for(&mut self, device: &DeviceId) -> Vec<WelcomeItem> {
        let entry = self.device(device);
        if !entry.online {
            return Vec::new();
        }
        entry.welcomes.clone()
    }

    /// Row 16: marks one Welcome delivered. Its `mls.welcome` frame leaves the queue with it, and
    /// every other queued frame stays where it is, in order — the `take_welcome` bookkeeping.
    fn ack_welcome_for(&mut self, device: &DeviceId, welcome_id: u64) -> Result<(), DsError> {
        let entry = self.device(device);
        let row = entry
            .welcomes
            .iter()
            .position(|w| w.welcome_id == welcome_id)
            .ok_or(DsError::NotFound)?;
        let acked = entry.welcomes.remove(row);
        if let Some(at) = entry.queue.iter().position(|f| {
            matches!(f, Frame::MlsWelcome { group_id, blob }
                if *group_id == acked.group_id && *blob == acked.blob)
        }) {
            entry.queue.remove(at);
        }
        Ok(())
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

/// Invariant 2's structural view, built from exactly the GroupInfo and tree a creator uploaded.
fn public_view(group_info: &[u8], ratchet_tree: &[u8]) -> Result<DillaPublicGroup, DsError> {
    use tls_codec::Deserialize as _;
    let invalid = |reason: String| DsError::CommitInvalid { reason };
    let info = match MlsMessageIn::tls_deserialize_exact(group_info)
        .map_err(|e| invalid(format!("group_info: {e:?}")))?
        .extract()
    {
        MlsMessageBodyIn::GroupInfo(info) => info,
        other => return Err(invalid(format!("expected a GroupInfo, got {other:?}"))),
    };
    let tree = RatchetTreeIn::tls_deserialize_exact(ratchet_tree)
        .map_err(|e| invalid(format!("ratchet_tree: {e:?}")))?;
    let crypto = openmls_rust_crypto::RustCrypto::default();
    DillaPublicGroup::from_external(&crypto, tree, info)
        .map(|(public, _committer)| public)
        .map_err(|e| invalid(format!("{e:?}")))
}

/// protocol/04 "Franking": the commitment `C` is the whole `authenticated_data` of the
/// `PrivateMessage`, 32 bytes, in cleartext. This is the read the real instance makes through the
/// wasi module's `private_message_aad`; `PrivateMessageIn::aad` (openmls-0.9.0
/// `src/framing/private_message_in.rs:59`) is the same field. Anything else is
/// `E_COMMITMENT_INVALID`, the refusal the real instance makes.
fn commitment_of(private_message: &[u8]) -> Result<[u8; 32], DsError> {
    use tls_codec::Deserialize as _;
    let message = MlsMessageIn::tls_deserialize_exact(private_message)
        .map_err(|_| DsError::CommitmentInvalid)?;
    match message.extract() {
        MlsMessageBodyIn::PrivateMessage(m) => {
            <[u8; 32]>::try_from(m.aad()).map_err(|_| DsError::CommitmentInvalid)
        }
        _ => Err(DsError::CommitmentInvalid),
    }
}

/// The adapter between the contract's trait and the stub's inherent methods (interface deviation
/// B16). Every per-device call speaks for the device `act_as` last named.
impl DeliveryService for DsStub {
    fn publish_key_packages(
        &mut self,
        d: &Device,
        kps: Vec<Vec<u8>>,
        last_resort: Option<Vec<u8>>,
    ) -> Result<usize, DsError> {
        DsStub::publish_key_packages(self, d.id(), kps, last_resort.unwrap_or_default())
    }

    /// Invariant 1, then invariant 2's view built by the DS itself. The real instance builds its
    /// own `PublicGroup` from the registration, so the client no longer hands one over
    /// (`attach_public_group` and `add_member_device` are the stub's own business now).
    fn register_group(&mut self, r: RegisterRequest) -> Result<RegisterResult, DsError> {
        let device = self.current_device()?;
        let public = public_view(&r.group_info, &r.ratchet_tree);
        // The binding is checked first, by the inherent method, so a bad binding is
        // E_BINDING_INVALID whatever the GroupInfo looks like.
        let registered = DsStub::register_group(self, r)?;
        match public {
            Ok(public) => self.attach_public_group(&registered.group_id, public),
            Err(e) => {
                self.groups.remove(&registered.group_id);
                return Err(e);
            }
        }
        self.add_member_device(&registered.group_id, device);
        Ok(registered)
    }

    fn group_info(&mut self, g: &GroupId) -> Result<GroupInfoResp, DsError> {
        DsStub::group_info(self, g)
    }

    fn ratchet_tree(&mut self, g: &GroupId) -> Result<TreeResp, DsError> {
        DsStub::ratchet_tree(self, g)
    }

    fn handshakes(&mut self, g: &GroupId, from: u64) -> Result<Vec<HandshakeItem>, DsError> {
        DsStub::handshakes(self, g, from)
    }

    fn take_key_package(&mut self, target: &DeviceId) -> Result<KeyPackageResp, DsError> {
        use sha2::{Digest, Sha256};
        let (blob, last_resort) = DsStub::take_key_package(self, target)?;
        let kp_ref = Sha256::digest(&blob).to_vec();
        Ok(KeyPackageResp {
            blob,
            last_resort,
            kp_ref,
        })
    }

    fn post_commit(&mut self, g: &GroupId, c: CommitRequest) -> Result<CommitResult, DsError> {
        let accepted = DsStub::post_commit(
            self,
            g,
            CommitUpload {
                epoch: c.epoch,
                commit: c.commit,
                group_info: c.group_info,
                welcomes: c.welcomes,
            },
        )?;
        Ok(CommitResult {
            seq: accepted.seq,
            epoch: accepted.epoch,
        })
    }

    /// Row 8 carries no epoch: the instance supplies its own. The joiner becomes a member of the
    /// fan-out list once its commit is accepted, which is the stub's half of what the real
    /// instance derives from the merged tree.
    fn post_external_commit(
        &mut self,
        g: &GroupId,
        c: ResyncRequest,
    ) -> Result<CommitResult, DsError> {
        let device = self.current_device()?;
        let epoch = self.epoch(g).ok_or(DsError::NotFound)?;
        let accepted = DsStub::post_external_commit(
            self,
            g,
            CommitUpload {
                epoch,
                commit: c.external_commit,
                group_info: c.group_info,
                welcomes: Vec::new(),
            },
        )?;
        self.add_member_device(g, device);
        Ok(CommitResult {
            seq: accepted.seq,
            epoch: accepted.epoch,
        })
    }

    fn post_proposal(
        &mut self,
        g: &GroupId,
        epoch: u64,
        proposal: Vec<u8>,
    ) -> Result<u64, DsError> {
        DsStub::post_proposal(self, g, epoch, proposal)
    }

    /// The uploader is the current device and the commitment comes out of the message's own
    /// `authenticated_data`, as it does on the real instance — the caller no longer hands `C` over.
    fn post_message_from(
        &mut self,
        g: &GroupId,
        epoch: u64,
        pm: Vec<u8>,
    ) -> Result<UploadResult, DsError> {
        let device = self.current_device()?;
        let commitment = commitment_of(&pm)?;
        let accepted = DsStub::post_message_from(self, g, epoch, device, pm, Some(commitment))?;
        Ok(UploadResult {
            seq: accepted.seq,
            franking_tag: accepted.franking_tag.to_vec(),
            recv_ts: accepted.recv_ts,
        })
    }

    fn messages(&mut self, g: &GroupId, from: u64) -> Result<Vec<MessageItem>, DsError> {
        DsStub::messages(self, g, from)
    }

    fn welcomes(&mut self) -> Result<Vec<WelcomeItem>, DsError> {
        let device = self.current_device()?;
        Ok(self.welcomes_for(&device))
    }

    fn ack_welcome(&mut self, welcome_id: u64) -> Result<(), DsError> {
        let device = self.current_device()?;
        self.ack_welcome_for(&device, welcome_id)
    }

    fn fork_report(
        &mut self,
        _g: &GroupId,
        _epoch: u64,
        _seq: u64,
        _reason: &str,
    ) -> Result<(), DsError> {
        Err(DsError::Unsupported(
            "DsStub does not model invariant 9/11; use `ds <url>`".into(),
        ))
    }

    fn heal(&mut self, _g: &GroupId, _h: HealRequest) -> Result<CommitResult, DsError> {
        Err(DsError::Unsupported(
            "DsStub does not model invariant 9/11; use `ds <url>`".into(),
        ))
    }

    fn advance_cursor(&mut self, g: &GroupId, seq: u64, epoch: u64) -> Result<(), DsError> {
        let device = self.current_device()?;
        self.group(g)?;
        self.cursors
            .insert((*device.as_bytes(), g.to_vec()), (seq, epoch));
        Ok(())
    }

    fn drain(&mut self) -> Result<Vec<Frame>, DsError> {
        let device = self.current_device()?;
        Ok(DsStub::drain(self, &device))
    }

    fn set_online(&mut self, online: bool) -> Result<(), DsError> {
        let device = self.current_device()?;
        DsStub::set_online(self, &device, online);
        Ok(())
    }

    fn advance_clock(&mut self, secs: u64) -> Result<(), DsError> {
        self.clock = self.clock.saturating_add(secs);
        Ok(())
    }

    fn ack_commit(&mut self, _g: &GroupId, _round: u64) -> Result<(), DsError> {
        Err(DsError::Unsupported(
            "DsStub does not model invariant 7's election; use `ds <url>`".into(),
        ))
    }

    /// The stub issues no instance proposals, so none is ever outstanding.
    fn proposals(&mut self, g: &GroupId) -> Result<Vec<super::ProposalItem>, DsError> {
        if !self.groups.contains_key(g) {
            return Err(DsError::NotFound);
        }
        Ok(Vec::new())
    }
}
