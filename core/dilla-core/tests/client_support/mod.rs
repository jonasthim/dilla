//! Fixtures shared by `tests/client_groups.rs` (task 5) and `tests/client_sync.rs` (task 6).
//!
//! `Relay` is one group's delivery service as these tests need it: one sequence space for
//! handshakes and messages, its own public view of the group (`DillaPublicGroup`, so a commit, an
//! external join or a GroupInfo it accepts is one dillad accepts structurally), and the exact CBOR
//! bodies of protocol/02 lines 79-97. `RawPeer` is a member built directly on `DillaGroup`, for the
//! inputs no `ClientCore` method produces (a member Add that yields a Welcome). `Instance` holds the
//! external-sender key; dilla-core cannot depend on dilla-testkit, so the key is generated here.
#![allow(dead_code)]

use dilla_core::cbor::{Encoder, decode_strict};
use dilla_core::client::{ClientCore, ClientError};
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::identity::{CredentialIdentity, Kind, SignerTier, SskSigner, Tier, UmkSigner};
use dilla_core::ids::{CommunityId, DeviceId, InstanceId, MsgId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, ConnHandle, DillaBinding, DillaGroup, DillaProvider, GroupKind, external_senders,
};
use dilla_core::public_group::{DillaPublicGroup, PublicProcessed, validate_key_package};
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use std::sync::{Arc, Mutex};
use tls_codec::{Deserialize as _, Serialize as _};

pub const INSTANCE: [u8; 16] = [0x11; 16];
pub const COMMUNITY: [u8; 16] = [0x22; 16];
pub const CHANNEL: [u8; 16] = [0x33; 16];
pub const OTHER_CHANNEL: [u8; 16] = [0x99; 16];
pub const GROUP: [u8; 16] = [0x44; 16];
pub const OTHER_GROUP: [u8; 16] = [0x45; 16];
pub const POLICY: u64 = 1;
pub const NOW: u64 = 1_790_000_000;
pub const EPOCH_CHANGED: u64 = 1;
pub const OWN_ADOPTED: u64 = 2;

pub fn memory() -> ConnHandle {
    Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ))
}

pub fn code<T: core::fmt::Debug>(result: Result<T, ClientError>) -> &'static str {
    result.expect_err("expected a ClientError").code
}

pub fn text_binding(channel: [u8; 16]) -> DillaBinding {
    DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes(INSTANCE),
        community_id: Some(CommunityId::from_bytes(COMMUNITY)),
        target_id: channel,
        kind: GroupKind::Text,
        policy_version: POLICY,
        e2ee_version: 1,
        media_version: GroupKind::Text.media_version(),
    }
}

#[allow(clippy::type_complexity)] // The fixture names each byte-array position at its call sites.
pub fn expected_body(entries: &[([u8; 16], [u8; 16], [u8; 16], u64)]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(entries.len());
    for (group, community, channel, policy) in entries {
        e.array(4)
            .bytes(group)
            .bytes(community)
            .bytes(channel)
            .uint(*policy);
    }
    e.into_vec()
}

// ---------------------------------------------------------------------------------------------
// What ClientCore returns, decoded.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupRow {
    pub group_id: [u8; 16],
    pub kind: u64,
    pub community_id: Option<[u8; 16]>,
    pub target_id: [u8; 16],
    pub state: u64,
    pub epoch: u64,
    pub next_seq: u64,
    pub proposals_pending: u64,
    pub pending_commit: u64,
}

pub fn groups(core: &ClientCore) -> Vec<GroupRow> {
    let bytes = core.groups().expect("groups");
    decode_strict(&bytes, |d| {
        let n = d.array_len()?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(9)?;
            out.push(GroupRow {
                group_id: d.bytes_exact::<16>()?,
                kind: d.uint()?,
                community_id: d.opt_bytes_exact::<16>()?,
                target_id: d.bytes_exact::<16>()?,
                state: d.uint()?,
                epoch: d.uint()?,
                next_seq: d.uint()?,
                proposals_pending: d.uint()?,
                pending_commit: d.uint()?,
            });
        }
        Ok(out)
    })
    .expect("groups shape")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    pub state: u64,
    pub epoch: u64,
    pub next_seq: u64,
    pub new_seqs: Vec<u64>,
    pub proposals_pending: u64,
    pub flags: u64,
}

pub fn decode_applied(bytes: &[u8]) -> Applied {
    decode_strict(bytes, |d| {
        d.array(6)?;
        let state = d.uint()?;
        let epoch = d.uint()?;
        let next_seq = d.uint()?;
        let n = d.array_len()?;
        let mut new_seqs = Vec::with_capacity(n);
        for _ in 0..n {
            new_seqs.push(d.uint()?);
        }
        Ok(Applied {
            state,
            epoch,
            next_seq,
            new_seqs,
            proposals_pending: d.uint()?,
            flags: d.uint()?,
        })
    })
    .expect("apply result shape")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineRow {
    pub seq: u64,
    pub epoch: u64,
    pub recv_ts: u64,
    pub status: u64,
    pub reason: String,
    pub sender_user: Option<[u8; 16]>,
    pub sender_device: [u8; 16],
    pub sender_kind: Option<u64>,
    pub sender_tier: Option<u64>,
    pub msg_id: Option<[u8; 16]>,
    pub ty: Option<u64>,
    pub body: String,
}

pub fn decode_timeline(bytes: &[u8]) -> Vec<TimelineRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(12)?;
            rows.push(TimelineRow {
                seq: d.uint()?,
                epoch: d.uint()?,
                recv_ts: d.uint()?,
                status: d.uint()?,
                reason: d.text()?.to_owned(),
                sender_user: d.opt_bytes_exact::<16>()?,
                sender_device: d.bytes_exact::<16>()?,
                sender_kind: d.opt_uint()?,
                sender_tier: d.opt_uint()?,
                msg_id: d.opt_bytes_exact::<16>()?,
                ty: d.opt_uint()?,
                body: d.text()?.to_owned(),
            });
        }
        Ok(rows)
    })
    .expect("timeline shape")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxRow {
    pub msg_id: [u8; 16],
    pub state: u64,
    pub error: String,
    pub created: u64,
    pub body: String,
}

pub fn decode_outbox(bytes: &[u8]) -> Vec<OutboxRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(5)?;
            rows.push(OutboxRow {
                msg_id: d.bytes_exact::<16>()?,
                state: d.uint()?,
                error: d.text()?.to_owned(),
                created: d.uint()?,
                body: d.text()?.to_owned(),
            });
        }
        Ok(rows)
    })
    .expect("outbox shape")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WelcomeOutcome {
    pub welcome_id: u64,
    pub group_id: [u8; 16],
    pub outcome: u64,
    pub reason: String,
}

pub fn decode_outcomes(bytes: &[u8]) -> Vec<WelcomeOutcome> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(4)?;
            rows.push(WelcomeOutcome {
                welcome_id: d.uint()?,
                group_id: d.bytes_exact::<16>()?,
                outcome: d.uint()?,
                reason: d.text()?.to_owned(),
            });
        }
        Ok(rows)
    })
    .expect("welcome outcome shape")
}

pub fn decode_confirm(bytes: &[u8]) -> ([u8; 16], u64) {
    decode_strict(bytes, |d| {
        d.array(2)?;
        Ok((d.bytes_exact::<16>()?, d.uint()?))
    })
    .expect("send_confirm shape")
}

pub fn seq_of_answer(answer: &[u8]) -> u64 {
    decode_strict(answer, |d| {
        d.array(3)?;
        let seq = d.uint()?;
        d.bytes_exact::<32>()?;
        d.uint()?;
        Ok(seq)
    })
    .expect("POST message 200 body")
}

// ---------------------------------------------------------------------------------------------
// A ready ClientCore.

pub struct Core {
    pub core: ClientCore,
    /// A clone of the connection `core` owns. Used only between `ClientCore` calls, to read the
    /// app tables and to install a failure trigger; never while a call runs (the ownership
    /// invariant of `mls/storage.rs:22-32`).
    pub probe: ConnHandle,
    pub user: [u8; 16],
    pub device: [u8; 16],
}

/// A `ClientCore` over a fresh in-memory database, signed up with a fabricated user id: phase 2.
pub fn ready_core(user: u8, username: &str) -> Core {
    let conn = memory();
    let probe = Arc::clone(&conn);
    let mut core = ClientCore::open(conn).expect("open");
    core.signup_begin(&INSTANCE).expect("signup_begin");
    core.signup_complete(&[user; 16], username, NOW)
        .expect("signup_complete");
    let identity = core.identity().expect("identity");
    let (phase, device) = decode_strict(&identity, |d| {
        d.array(6)?;
        let phase = d.uint()?;
        d.opt_bytes_exact::<16>()?;
        d.opt_bytes_exact::<16>()?;
        let device = d.opt_bytes_exact::<16>()?;
        d.text()?;
        d.uint()?;
        Ok((phase, device))
    })
    .expect("identity shape");
    assert_eq!(phase, 2, "signup completed");
    Core {
        core,
        probe,
        user: [user; 16],
        device: device.expect("a device id in phase 2"),
    }
}

impl Core {
    /// Drops the `ClientCore` and opens a new one over the same connection, as a reload does.
    pub fn reopen(self) -> Core {
        let Core {
            core,
            probe,
            user,
            device,
        } = self;
        drop(core);
        let core = ClientCore::open(Arc::clone(&probe)).expect("reopen");
        Core {
            core,
            probe,
            user,
            device,
        }
    }

    pub fn group(&self, group_id: &[u8; 16]) -> Option<GroupRow> {
        groups(&self.core)
            .into_iter()
            .find(|g| &g.group_id == group_id)
    }

    pub fn timeline(&self, group_id: &[u8; 16]) -> Vec<TimelineRow> {
        decode_timeline(&self.core.timeline(group_id, 0, 200).expect("timeline"))
    }

    pub fn outbox(&self, group_id: &[u8; 16]) -> Vec<OutboxRow> {
        decode_outbox(&self.core.outbox(group_id).expect("outbox"))
    }

    pub fn first_key_package(&mut self) -> Vec<u8> {
        let body = self.core.key_packages(1, false).expect("key_packages");
        decode_strict(&body, |d| {
            d.array(2)?;
            d.array(1)?;
            let package = d.bytes()?.to_vec();
            d.null()?;
            Ok(package)
        })
        .expect("POST /v1/keypackages body")
    }

    /// group_create → POST /v1/groups → group_registered.
    pub fn create_and_register(&mut self, relay: &mut Relay, instance: &Instance) {
        let body = self
            .core
            .group_create(
                &relay.group_id,
                &COMMUNITY,
                &CHANNEL,
                POLICY,
                &instance.public(),
            )
            .expect("group_create");
        let created = relay.register(&body).expect("register");
        let next_seq = decode_strict(&created, |d| {
            d.array(2)?;
            d.bytes_exact::<16>()?;
            d.uint()
        })
        .expect("201 body");
        self.core
            .group_registered(&relay.group_id, next_seq)
            .expect("group_registered");
    }

    /// group_join_external → POST /v1/groups/{id}/resync → group_joined.
    pub fn join_external(&mut self, relay: &mut Relay) {
        let body = self
            .core
            .group_join_external(
                &relay.group_id,
                &COMMUNITY,
                &CHANNEL,
                POLICY,
                &relay.info_body(),
                &relay.tree_body(),
            )
            .expect("group_join_external");
        let answer = relay.resync(&body).expect("resync");
        let seq = decode_strict(&answer, |d| {
            d.array(2)?;
            let seq = d.uint()?;
            d.uint()?;
            Ok(seq)
        })
        .expect("200 body");
        self.core
            .group_joined(&relay.group_id, seq)
            .expect("group_joined");
    }

    pub fn prepare(&mut self, group_id: &[u8; 16], body: &str, now: u64) -> [u8; 16] {
        let out = self
            .core
            .send_prepare(group_id, body, now)
            .expect("send_prepare");
        decode_strict(&out, |d| {
            d.array(1)?;
            d.bytes_exact::<16>()
        })
        .expect("send_prepare shape")
    }

    pub fn encrypt(&mut self, msg_id: &[u8; 16]) -> ([u8; 16], Vec<u8>) {
        let out = self.core.send_encrypt(msg_id).expect("send_encrypt");
        decode_strict(&out, |d| {
            d.array(2)?;
            Ok((d.bytes_exact::<16>()?, d.bytes()?.to_vec()))
        })
        .expect("send_encrypt shape")
    }

    /// prepare → encrypt → POST …/message → confirm. Returns (msg_id, seq).
    pub fn send(
        &mut self,
        relay: &mut Relay,
        group_id: &[u8; 16],
        body: &str,
        now: u64,
    ) -> ([u8; 16], u64) {
        let msg_id = self.prepare(group_id, body, now);
        let (_, message_body) = self.encrypt(&msg_id);
        let answer = relay
            .post_message(self.device, &message_body)
            .expect("upload");
        let (gid, seq) = decode_confirm(
            &self
                .core
                .send_confirm(&msg_id, &answer)
                .expect("send_confirm"),
        );
        assert_eq!(&gid, group_id);
        (msg_id, seq)
    }

    /// Everything the relay holds from this core's next_seq on, declared complete through the head.
    pub fn try_sync(&mut self, relay: &Relay) -> Result<Applied, ClientError> {
        let from = self
            .group(&relay.group_id)
            .expect("a row for the relay's group")
            .next_seq;
        self.core
            .group_apply(
                &relay.group_id,
                &relay.handshakes_from(from),
                &relay.messages_from(from),
                relay.through(),
            )
            .map(|bytes| decode_applied(&bytes))
    }

    pub fn sync(&mut self, relay: &Relay) -> Applied {
        self.try_sync(relay).expect("group_apply")
    }
}

/// Alice creates and registers GROUP (relay seq 1 is the first row), Bob joins it by external
/// commit (seq 1, epoch 1), Alice applies the join. Both are active at epoch 1, next_seq 2.
pub fn alice_and_bob() -> (Instance, Relay, Core, Core) {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    let mut b = ready_core(0xb2, "bob");
    a.create_and_register(&mut relay, &instance);
    b.join_external(&mut relay);
    a.sync(&relay);
    (instance, relay, a, b)
}

// ---------------------------------------------------------------------------------------------
// The instance's external-sender key.

pub struct Instance {
    pub signer: SignatureKeyPair,
}

impl Instance {
    pub fn generate() -> Self {
        Self {
            signer: SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("instance key"),
        }
    }

    pub fn public(&self) -> [u8; 32] {
        self.signer
            .public()
            .try_into()
            .expect("an Ed25519 public key is 32 bytes")
    }
}

// ---------------------------------------------------------------------------------------------
// The delivery service of one group.

#[derive(Clone, Debug)]
pub struct HsRow {
    pub seq: u64,
    pub epoch: u64,
    pub kind: u64,
    pub sender: Option<u64>,
    pub blob: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct MsgRow {
    pub seq: u64,
    pub epoch: u64,
    pub uploader: [u8; 16],
    pub blob: Option<Vec<u8>>,
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
    pub deleted: bool,
}

#[derive(Clone, Debug)]
pub struct WelcomeRow {
    pub welcome_id: u64,
    pub device: [u8; 16],
    pub epoch: u64,
    pub commit_seq: u64,
    pub blob: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
    pub tree_hash: Vec<u8>,
}

/// An outstanding proposal as `GET /v1/groups/{id}/proposals` lists it (task 6 fills it).
#[derive(Clone, Debug)]
pub struct RelayProposal {
    pub reference: Vec<u8>,
    pub kind: u64,
    pub target_leaf: Option<u64>,
    pub blob: Vec<u8>,
}

pub struct Relay {
    pub group_id: [u8; 16],
    crypto: RustCrypto,
    public: Option<DillaPublicGroup>,
    group_info: Vec<u8>,
    next_seq: u64,
    next_welcome: u64,
    pub handshakes: Vec<HsRow>,
    pub messages: Vec<MsgRow>,
    pub welcomes: Vec<WelcomeRow>,
    pub proposals: Vec<RelayProposal>,
}

pub fn encode_handshakes(rows: &[&HsRow]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for h in rows {
        e.array(5)
            .uint(h.seq)
            .uint(h.epoch)
            .uint(h.kind)
            .opt_uint(h.sender)
            .bytes(&h.blob);
    }
    e.into_vec()
}

pub fn encode_messages(rows: &[&MsgRow]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for m in rows {
        e.array(8)
            .uint(m.seq)
            .uint(m.epoch)
            .bytes(&m.uploader)
            .opt_bytes(m.blob.as_deref())
            .null()
            .bytes(&m.franking_tag)
            .uint(m.recv_ts)
            .uint(u64::from(m.deleted));
    }
    e.into_vec()
}

fn protocol_in(bytes: &[u8]) -> Result<ProtocolMessage, &'static str> {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| "E_COMMIT_INVALID")?
        .try_into_protocol_message()
        .map_err(|_| "E_COMMIT_INVALID")
}

fn group_info_in(bytes: &[u8]) -> Result<VerifiableGroupInfo, &'static str> {
    match MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| "E_INVALID_REQUEST")?
        .extract()
    {
        MlsMessageBodyIn::GroupInfo(info) => Ok(info),
        _ => Err("E_INVALID_REQUEST"),
    }
}

fn pair(a: u64, b: u64) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).uint(a).uint(b);
    e.into_vec()
}

impl Relay {
    pub fn new(group_id: [u8; 16]) -> Self {
        Self::starting_at(group_id, 1)
    }

    /// A relay whose registration answers `next_seq`.
    pub fn starting_at(group_id: [u8; 16], next_seq: u64) -> Self {
        Self {
            group_id,
            crypto: RustCrypto::default(),
            public: None,
            group_info: Vec::new(),
            next_seq,
            next_welcome: 1,
            handshakes: Vec::new(),
            messages: Vec::new(),
            welcomes: Vec::new(),
            proposals: Vec::new(),
        }
    }

    fn public(&self) -> &DillaPublicGroup {
        self.public.as_ref().expect("the group is registered")
    }

    pub fn epoch(&self) -> u64 {
        self.public().epoch()
    }

    /// The highest seq the relay has handed out: what a complete catch-up declares as `through`.
    pub fn through(&self) -> u64 {
        self.next_seq - 1
    }

    fn take_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// Processes and merges a commit or an external commit; answers the committer's leaf.
    fn merge(&mut self, blob: &[u8]) -> Result<Option<u64>, &'static str> {
        let message = protocol_in(blob)?;
        let crypto = &self.crypto;
        let public = self.public.as_mut().expect("the group is registered");
        match public.process_message(crypto, message) {
            Ok(PublicProcessed::StagedCommit {
                staged,
                sender_leaf,
            }) => {
                public
                    .merge_commit(*staged)
                    .map_err(|_| "E_COMMIT_INVALID")?;
                Ok(sender_leaf.map(u64::from))
            }
            _ => Err("E_COMMIT_INVALID"),
        }
    }

    /// POST /v1/groups: [group_id, binding, group_info, ratchet_tree] → 201 [group_id, next_seq].
    pub fn register(&mut self, body: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (group_id, binding, info, tree) = decode_strict(body, |d| {
            d.array(4)?;
            Ok((
                d.bytes_exact::<16>()?,
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
                d.bytes()?.to_vec(),
            ))
        })
        .map_err(|_| "E_INVALID_REQUEST")?;
        if group_id != self.group_id {
            return Err("E_INVALID_REQUEST");
        }
        if self.public.is_some() {
            return Err("E_GROUP_EXISTS");
        }
        let verifiable = group_info_in(&info)?;
        let tree_in = RatchetTreeIn::tls_deserialize_exact(tree.as_slice())
            .map_err(|_| "E_INVALID_REQUEST")?;
        let (public, _) = DillaPublicGroup::from_external(&self.crypto, tree_in, verifiable)
            .map_err(|_| "E_BINDING_INVALID")?;
        if public.binding().encode() != binding {
            return Err("E_BINDING_INVALID");
        }
        self.public = Some(public);
        self.group_info = info;
        let mut e = Encoder::new();
        e.array(2).bytes(&self.group_id).uint(self.next_seq);
        Ok(e.into_vec())
    }

    /// GET /v1/groups/{id}/info: [epoch, group_info, tree_hash, next_seq].
    pub fn info_body(&self) -> Vec<u8> {
        let p = self.public();
        let mut e = Encoder::new();
        e.array(4)
            .uint(p.epoch())
            .bytes(&self.group_info)
            .bytes(&p.tree_hash())
            .uint(self.next_seq);
        e.into_vec()
    }

    /// GET /v1/groups/{id}/tree: [epoch, ratchet_tree, tree_hash].
    pub fn tree_body(&self) -> Vec<u8> {
        let p = self.public();
        let tree = p
            .export_ratchet_tree()
            .tls_serialize_detached()
            .expect("tree");
        let mut e = Encoder::new();
        e.array(3)
            .uint(p.epoch())
            .bytes(&tree)
            .bytes(&p.tree_hash());
        e.into_vec()
    }

    /// POST /v1/groups/{id}/commit: [epoch, commit, group_info, [[device_id, blob]], null] →
    /// [seq, epoch]. A body for another epoch is the loser of a race: E_COMMIT_CONFLICT.
    pub fn commit(&mut self, body: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (epoch, commit, info, welcomes) = decode_strict(body, |d| {
            d.array(5)?;
            let epoch = d.uint()?;
            let commit = d.bytes()?.to_vec();
            let info = d.bytes()?.to_vec();
            let n = d.array_len()?;
            let mut welcomes = Vec::with_capacity(n);
            for _ in 0..n {
                d.array(2)?;
                welcomes.push((d.bytes_exact::<16>()?, d.bytes()?.to_vec()));
            }
            d.null()?;
            Ok((epoch, commit, info, welcomes))
        })
        .map_err(|_| "E_INVALID_REQUEST")?;
        if epoch != self.epoch() {
            return Err("E_COMMIT_CONFLICT");
        }
        let sender = self.merge(&commit)?;
        self.proposals.clear();
        let seq = self.take_seq();
        let new_epoch = self.epoch();
        self.handshakes.push(HsRow {
            seq,
            epoch: new_epoch,
            kind: 1,
            sender,
            blob: commit,
        });
        self.group_info = info;
        let tree = self
            .public()
            .export_ratchet_tree()
            .tls_serialize_detached()
            .expect("tree");
        let tree_hash = self.public().tree_hash();
        for (device, blob) in welcomes {
            let welcome_id = self.next_welcome;
            self.next_welcome += 1;
            self.welcomes.push(WelcomeRow {
                welcome_id,
                device,
                epoch: new_epoch,
                commit_seq: seq,
                blob,
                ratchet_tree: tree.clone(),
                tree_hash: tree_hash.clone(),
            });
        }
        Ok(pair(seq, new_epoch))
    }

    /// POST /v1/groups/{id}/resync: [external_commit, group_info] → [seq, epoch].
    pub fn resync(&mut self, body: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (commit, info) = decode_strict(body, |d| {
            d.array(2)?;
            Ok((d.bytes()?.to_vec(), d.bytes()?.to_vec()))
        })
        .map_err(|_| "E_INVALID_REQUEST")?;
        self.merge(&commit)?;
        self.proposals.clear();
        let seq = self.take_seq();
        let epoch = self.epoch();
        self.handshakes.push(HsRow {
            seq,
            epoch,
            kind: 2,
            sender: None,
            blob: commit,
        });
        self.group_info = info;
        Ok(pair(seq, epoch))
    }

    /// POST /v1/groups/{id}/message: [epoch, private_message] → [seq, franking_tag, recv_ts].
    pub fn post_message(
        &mut self,
        uploader: [u8; 16],
        body: &[u8],
    ) -> Result<Vec<u8>, &'static str> {
        let (epoch, blob) = decode_strict(body, |d| {
            d.array(2)?;
            Ok((d.uint()?, d.bytes()?.to_vec()))
        })
        .map_err(|_| "E_INVALID_REQUEST")?;
        if epoch != self.epoch() {
            return Err("E_COMMIT_INVALID");
        }
        Ok(self.push_message(uploader, epoch, Some(blob), false))
    }

    /// Appends a message row as the delivery service stores it; answers the 200 body.
    pub fn push_message(
        &mut self,
        uploader: [u8; 16],
        epoch: u64,
        blob: Option<Vec<u8>>,
        deleted: bool,
    ) -> Vec<u8> {
        let seq = self.take_seq();
        let franking_tag = [seq as u8; 32];
        let recv_ts = NOW + seq;
        self.messages.push(MsgRow {
            seq,
            epoch,
            uploader,
            blob,
            franking_tag,
            recv_ts,
            deleted,
        });
        let mut e = Encoder::new();
        e.array(3).uint(seq).bytes(&franking_tag).uint(recv_ts);
        e.into_vec()
    }

    /// DELETE /v1/groups/{id}/messages/{seq}: the blob is cleared and the row marked deleted.
    pub fn delete_message(&mut self, seq: u64) {
        let row = self
            .messages
            .iter_mut()
            .find(|m| m.seq == seq)
            .expect("a stored message");
        row.blob = None;
        row.deleted = true;
    }

    pub fn handshakes_from(&self, from: u64) -> Vec<u8> {
        let rows: Vec<&HsRow> = self.handshakes.iter().filter(|h| h.seq >= from).collect();
        encode_handshakes(&rows)
    }

    pub fn messages_from(&self, from: u64) -> Vec<u8> {
        let rows: Vec<&MsgRow> = self.messages.iter().filter(|m| m.seq >= from).collect();
        encode_messages(&rows)
    }

    /// GET /v1/welcomes for one device.
    pub fn welcomes_body(&self, device: [u8; 16]) -> Vec<u8> {
        let rows: Vec<&WelcomeRow> = self
            .welcomes
            .iter()
            .filter(|w| w.device == device)
            .collect();
        let mut e = Encoder::new();
        e.array(rows.len());
        for w in rows {
            e.array(7)
                .uint(w.welcome_id)
                .bytes(&self.group_id)
                .uint(w.epoch)
                .uint(w.commit_seq)
                .bytes(&w.blob)
                .bytes(&w.ratchet_tree)
                .bytes(&w.tree_hash);
        }
        e.into_vec()
    }
}

// ---------------------------------------------------------------------------------------------
// A member built directly on DillaGroup.

pub struct RawPeer {
    pub provider: DillaProvider,
    pub signer: SignatureKeyPair,
    pub credential: CredentialWithKey,
    pub user: [u8; 16],
    pub device: [u8; 16],
    pub group: Option<DillaGroup>,
}

impl RawPeer {
    /// A native-tier user whose credential is a well-formed `CredentialIdentity`.
    pub fn new(user: u8, device: u8) -> Self {
        let umk = UmkSigner::from_bytes(&[user; 32]);
        let ssk = SskSigner::from_bytes(&[user.wrapping_add(0x40); 32]);
        let identity = CredentialIdentity {
            v: 1,
            umk_pub: umk.public(),
            user_id: UserId::from_bytes([user; 16]),
            device_id: DeviceId::from_bytes([device; 16]),
            kind: Kind::User,
            tier: Tier::Native,
            signer_tier: SignerTier::Native,
            ssk_pub: ssk.public(),
            sig_umk_ssk: umk.sign_ssk(&ssk.public()),
            sig_ssk_dev: [0u8; 64],
        };
        Self::with_identity(identity.encode(), [user; 16], [device; 16])
    }

    /// A member whose basic-credential identity is `identity`, verbatim.
    pub fn with_identity(identity: Vec<u8>, user: [u8; 16], device: [u8; 16]) -> Self {
        let provider = DillaProvider::new(memory());
        provider.storage().migrate().expect("migrate");
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
        signer.store(provider.storage()).expect("store signer");
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity).into(),
            signature_key: signer.public().into(),
        };
        Self {
            provider,
            signer,
            credential,
            user,
            device,
            group: None,
        }
    }

    /// Creates the relay's group for CHANNEL with the instance as external sender and registers it.
    pub fn create(&mut self, relay: &mut Relay, instance: &Instance) {
        let group = DillaGroup::create(
            &self.provider,
            &self.signer,
            self.credential.clone(),
            GroupId::from_slice(&relay.group_id),
            text_binding(CHANNEL),
            Some(external_senders(
                instance.signer.public().into(),
                &InstanceId::from_bytes(INSTANCE),
            )),
        )
        .expect("create");
        let info = group
            .export_group_info(&self.provider, &self.signer)
            .expect("group info")
            .tls_serialize_detached()
            .expect("serialize");
        let tree = group
            .export_ratchet_tree()
            .tls_serialize_detached()
            .expect("serialize");
        let mut e = Encoder::new();
        e.array(4)
            .bytes(&relay.group_id)
            .bytes(&text_binding(CHANNEL).encode())
            .bytes(&info)
            .bytes(&tree);
        relay.register(&e.into_vec()).expect("register");
        self.group = Some(group);
    }

    /// One Add commit for every KeyPackage `MLSMessage` given, posted with its Welcomes and merged.
    pub fn add(&mut self, relay: &mut Relay, key_packages: &[&[u8]]) {
        use openmls_traits::OpenMlsProvider as _;
        let mut packages = Vec::with_capacity(key_packages.len());
        for bytes in key_packages {
            let incoming = match MlsMessageIn::tls_deserialize_exact(*bytes)
                .expect("an MLSMessage")
                .extract()
            {
                MlsMessageBodyIn::KeyPackage(kp) => kp,
                other => panic!("expected a KeyPackage, got {other:?}"),
            };
            packages.push(
                validate_key_package(self.provider.crypto(), incoming).expect("a valid KeyPackage"),
            );
        }
        let group = self.group.as_mut().expect("created");
        let epoch = group.epoch();
        let bundle = group
            .add_members(&self.provider, &self.signer, &packages)
            .expect("add_members");
        let info = MlsMessageOut::from(bundle.group_info.expect("the GroupInfo of epoch n + 1"))
            .tls_serialize_detached()
            .expect("serialize");
        let mut e = Encoder::new();
        e.array(5)
            .uint(epoch)
            .bytes(&bundle.commit.tls_serialize_detached().expect("serialize"))
            .bytes(&info);
        e.array(bundle.welcomes.len());
        for (device, welcome) in &bundle.welcomes {
            e.array(2)
                .bytes(device.as_bytes())
                .bytes(&welcome.tls_serialize_detached().expect("serialize"));
        }
        e.null();
        relay.commit(&e.into_vec()).expect("commit accepted");
        group.merge_pending_commit(&self.provider).expect("merge");
    }

    /// Uploads one text message; answers its seq.
    pub fn send(&mut self, relay: &mut Relay, body: &str) -> u64 {
        let group = self.group.as_mut().expect("created");
        let envelope = Envelope {
            v: 1,
            msg_id: MsgId::from_bytes([0x5a; 16]),
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: body.to_owned(),
            attachments: Vec::new(),
            previews: Vec::new(),
            k_f: [0x06; 32],
        };
        let blob = group
            .create_message(&self.provider, &self.signer, &envelope)
            .expect("create_message")
            .tls_serialize_detached()
            .expect("serialize");
        let mut e = Encoder::new();
        e.array(2).uint(group.epoch()).bytes(&blob);
        let answer = relay
            .post_message(self.device, &e.into_vec())
            .expect("upload");
        seq_of_answer(&answer)
    }
}
