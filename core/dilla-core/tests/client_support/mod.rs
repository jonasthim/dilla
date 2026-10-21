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
use dilla_core::envelope::{Attachment, Envelope, EnvelopeType};
use dilla_core::identity::{
    CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier, SskSigner,
    Tier, UmkSigner,
};
use dilla_core::ids::{CommunityId, DeviceId, InstanceId, MsgId, UserId};
use dilla_core::mls::{
    CIPHERSUITE, ConnHandle, DillaBinding, DillaGroup, DillaProcessed, DillaProvider, GroupKind,
    external_senders,
};
use dilla_core::public_group::{
    DillaPublicGroup, PublicProcessed, external_propose_add, external_propose_remove,
    validate_key_package,
};
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
pub const DM_CHANNEL: [u8; 16] = [0x66; 16];
pub const DM_GROUP: [u8; 16] = [0x46; 16];
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

/// The binding of a DM's text group: no community, the DM's channel id as the target.
pub fn dm_binding(channel: [u8; 16]) -> DillaBinding {
    DillaBinding {
        community_id: None,
        ..text_binding(channel)
    }
}

/// `welcomes_apply`'s `expected` with a nullable community.
#[allow(clippy::type_complexity)] // The fixture names each position at its call sites.
pub fn expected_entries(entries: &[([u8; 16], Option<[u8; 16]>, [u8; 16], u64)]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(entries.len());
    for (group, community, channel, policy) in entries {
        e.array(4)
            .bytes(group)
            .opt_bytes(community.as_ref().map(|c| c.as_slice()))
            .bytes(channel)
            .uint(*policy);
    }
    e.into_vec()
}

#[allow(clippy::type_complexity)] // The fixture names each byte-array position at its call sites.
pub fn expected_body(entries: &[([u8; 16], [u8; 16], [u8; 16], u64)]) -> Vec<u8> {
    expected_entries(
        &entries
            .iter()
            .map(|(g, c, ch, p)| (*g, Some(*c), *ch, *p))
            .collect::<Vec<_>>(),
    )
}

// ---------------------------------------------------------------------------------------------
// What ClientCore returns, decoded.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    pub group_id: [u8; 16],
    pub unread: u64,
    pub mentions: u64,
    pub last_seq: u64,
    pub last_ts: u64,
    pub last_read_seq: u64,
}

pub fn activity(core: &ClientCore) -> Vec<Activity> {
    let bytes = core.activity().expect("activity");
    decode_strict(&bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(6)?;
            rows.push(Activity {
                group_id: d.bytes_exact::<16>()?,
                unread: d.uint()?,
                mentions: d.uint()?,
                last_seq: d.uint()?,
                last_ts: d.uint()?,
                last_read_seq: d.uint()?,
            });
        }
        Ok(rows)
    })
    .expect("activity shape")
}

pub fn settings_of(core: &ClientCore) -> Vec<(String, String)> {
    let bytes = core.settings().expect("settings");
    decode_strict(&bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(2)?;
            rows.push((d.text()?.to_owned(), d.text()?.to_owned()));
        }
        Ok(rows)
    })
    .expect("settings shape")
}

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

fn listed_row(
    d: &mut dilla_core::cbor::Decoder<'_>,
) -> Result<GroupRow, dilla_core::cbor::CborError> {
    d.array(9)?;
    Ok(GroupRow {
        group_id: d.bytes_exact::<16>()?,
        kind: d.uint()?,
        community_id: d.opt_bytes_exact::<16>()?,
        target_id: d.bytes_exact::<16>()?,
        state: d.uint()?,
        epoch: d.uint()?,
        next_seq: d.uint()?,
        proposals_pending: d.uint()?,
        pending_commit: d.uint()?,
    })
}

pub fn groups(core: &ClientCore) -> Vec<GroupRow> {
    let bytes = core.groups().expect("groups");
    decode_strict(&bytes, |d| {
        let n = d.array_len()?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(listed_row(d)?);
        }
        Ok(out)
    })
    .expect("groups shape")
}

/// `ClientCore::group_row`, decoded: `None` for CBOR null.
pub fn group_row_of(core: &ClientCore, group_id: &[u8; 16]) -> Option<GroupRow> {
    let bytes = core.group_row(group_id).expect("group_row");
    decode_strict(&bytes, |d| {
        if d.try_null()? {
            return Ok(None);
        }
        listed_row(d).map(Some)
    })
    .expect("group_row shape")
}

/// L-CORE-21's invariant: for every row in state 0–3 whose MLS group loads, epoch/pending_commit
/// equal the loaded group's; for a state-4 row and for a state-3 row whose group was deleted, both
/// are 0; and `group_row` answers the `groups()` entry. Loads through a second provider over the
/// probe, between core calls only.
pub fn assert_mls_columns(core: &ClientCore, probe: &ConnHandle, step: &str) {
    let provider = DillaProvider::new(Arc::clone(probe));
    for row in groups(core) {
        let loaded =
            DillaGroup::load(&provider, &GroupId::from_slice(&row.group_id)).expect("load");
        let epoch = loaded.as_ref().map_or(0, DillaGroup::epoch);
        let pending = u64::from(loaded.as_ref().is_some_and(DillaGroup::has_pending_commit));
        assert_eq!(
            (row.epoch, row.pending_commit),
            (epoch, pending),
            "after {step}: group {:02x} in state {}",
            row.group_id[0],
            row.state
        );
        if row.state == 4 {
            assert_eq!(
                (row.epoch, row.pending_commit),
                (0, 0),
                "after {step}: a gone row"
            );
        }
        assert_eq!(
            group_row_of(core, &row.group_id),
            Some(row.clone()),
            "after {step}: group_row is the groups() row"
        );
    }
}

impl Core {
    pub fn check_columns(&self, step: &str) {
        assert_mls_columns(&self.core, &self.probe, step);
    }
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
pub struct Reply {
    pub reply_to: [u8; 16],
    pub target_seq: Option<u64>,
    pub target_user: Option<[u8; 16]>,
    pub excerpt: String,
    pub state: u64,
    /// The thread root of the quoted row when it shows in a thread (web3.7 fix round 1, M3).
    pub thread_root: Option<[u8; 16]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentSummary {
    pub index: u64,
    pub size: u64,
    pub mime: String,
    pub w: Option<u64>,
    pub h: Option<u64>,
    pub has_thumb: u64,
    pub name: String,
}

/// The row of L-CORE-34 (web-2b task 2), 19 elements since web3.7: the 19th is the thread summary.
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
    pub edited_seq: u64,
    pub reply: Option<Reply>,
    pub reactions: Vec<(String, u64, u64)>,
    pub pinned: u64,
    pub attachments: Vec<AttachmentSummary>,
    pub mention: u64,
    /// `[count, last_ts]` of a held thread root with at least one reply (web3.7 TB1), else None.
    pub thread: Option<(u64, u64)>,
}

pub fn decode_timeline(bytes: &[u8]) -> Vec<TimelineRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            rows.push(decode_timeline_row(d)?);
        }
        Ok(rows)
    })
    .expect("timeline shape")
}

/// One 19-element timeline row.
pub fn decode_timeline_row(
    d: &mut dilla_core::cbor::Decoder<'_>,
) -> Result<TimelineRow, dilla_core::cbor::CborError> {
    {
        {
            d.array(19)?;
            let seq = d.uint()?;
            let epoch = d.uint()?;
            let recv_ts = d.uint()?;
            let status = d.uint()?;
            let reason = d.text()?.to_owned();
            let sender_user = d.opt_bytes_exact::<16>()?;
            let sender_device = d.bytes_exact::<16>()?;
            let sender_kind = d.opt_uint()?;
            let sender_tier = d.opt_uint()?;
            let msg_id = d.opt_bytes_exact::<16>()?;
            let ty = d.opt_uint()?;
            let body = d.text()?.to_owned();
            let edited_seq = d.uint()?;
            let reply = if d.try_null()? {
                None
            } else {
                d.array(6)?;
                let reply_to = d.bytes_exact::<16>()?;
                let target_seq = d.opt_uint()?;
                let target_user = d.opt_bytes_exact::<16>()?;
                let excerpt = d.text()?.to_owned();
                let state = d.uint()?;
                let thread_root = d.opt_bytes_exact::<16>()?;
                Some(Reply {
                    reply_to,
                    target_seq,
                    target_user,
                    excerpt,
                    state,
                    thread_root,
                })
            };
            let k = d.array_len()?;
            let mut reactions = Vec::with_capacity(k);
            for _ in 0..k {
                d.array(3)?;
                let emoji = d.text()?.to_owned();
                let count = d.uint()?;
                let mine = d.uint()?;
                reactions.push((emoji, count, mine));
            }
            let pinned = d.uint()?;
            let k = d.array_len()?;
            let mut attachments = Vec::with_capacity(k);
            for _ in 0..k {
                d.array(7)?;
                let index = d.uint()?;
                let size = d.uint()?;
                let mime = d.text()?.to_owned();
                let w = d.opt_uint()?;
                let h = d.opt_uint()?;
                let has_thumb = d.uint()?;
                let name = d.text()?.to_owned();
                attachments.push(AttachmentSummary {
                    index,
                    size,
                    mime,
                    w,
                    h,
                    has_thumb,
                    name,
                });
            }
            let mention = d.uint()?;
            let thread = if d.try_null()? {
                None
            } else {
                d.array(2)?;
                Some((d.uint()?, d.uint()?))
            };
            Ok(TimelineRow {
                seq,
                epoch,
                recv_ts,
                status,
                reason,
                sender_user,
                sender_device,
                sender_kind,
                sender_tier,
                msg_id,
                ty,
                body,
                edited_seq,
                reply,
                reactions,
                pinned,
                attachments,
                mention,
                thread,
            })
        }
    }
}

/// thread_timeline's `[root_row|null, [row…]]` (web3.7 TB1).
pub fn decode_thread_timeline(bytes: &[u8]) -> (Option<TimelineRow>, Vec<TimelineRow>) {
    decode_strict(bytes, |d| {
        d.array(2)?;
        let root = if d.try_null()? {
            None
        } else {
            Some(decode_timeline_row(d)?)
        };
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            rows.push(decode_timeline_row(d)?);
        }
        Ok((root, rows))
    })
    .expect("thread timeline shape")
}

/// One `threads` row: [root_msg_id, root_seq|null, count, last_ts, excerpt] (web3.7 TB1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadRow {
    pub root: [u8; 16],
    pub root_seq: Option<u64>,
    pub count: u64,
    pub last_ts: u64,
    pub excerpt: String,
}

pub fn decode_threads(bytes: &[u8]) -> Vec<ThreadRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(5)?;
            rows.push(ThreadRow {
                root: d.bytes_exact::<16>()?,
                root_seq: d.opt_uint()?,
                count: d.uint()?,
                last_ts: d.uint()?,
                excerpt: d.text()?.to_owned(),
            });
        }
        Ok(rows)
    })
    .expect("threads shape")
}

/// These are the test decoders of L-CORE-35; task 3 reads them unchanged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinRow {
    pub target_seq: u64,
    pub msg_id: [u8; 16],
    pub pinned_seq: u64,
    pub by_user: [u8; 16],
    pub author: Option<[u8; 16]>,
    pub excerpt: String,
    pub target_ts: u64,
    /// The thread root of the pinned row when it shows in a thread (web3.7 fix round 1, M3).
    pub thread_root: Option<[u8; 16]>,
}

pub fn decode_pins(bytes: &[u8]) -> Vec<PinRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(8)?;
            let target_seq = d.uint()?;
            let msg_id = d.bytes_exact::<16>()?;
            let pinned_seq = d.uint()?;
            let by_user = d.bytes_exact::<16>()?;
            let author = d.opt_bytes_exact::<16>()?;
            let excerpt = d.text()?.to_owned();
            let target_ts = d.uint()?;
            let thread_root = d.opt_bytes_exact::<16>()?;
            rows.push(PinRow {
                target_seq,
                msg_id,
                pinned_seq,
                by_user,
                author,
                excerpt,
                target_ts,
                thread_root,
            });
        }
        Ok(rows)
    })
    .expect("pins shape")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxRow {
    pub msg_id: [u8; 16],
    pub state: u64,
    pub error: String,
    pub created: u64,
    pub body: String,
    pub ty: u64,
    pub reply_to: Option<[u8; 16]>,
    /// [blob_id, size, mime, name] per attachment (L-CORE-37: no key, no nonce).
    pub attachments: Vec<([u8; 32], u64, String, String)>,
}

pub fn decode_outbox(bytes: &[u8]) -> Vec<OutboxRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(8)?;
            let msg_id = d.bytes_exact::<16>()?;
            let state = d.uint()?;
            let error = d.text()?.to_owned();
            let created = d.uint()?;
            let body = d.text()?.to_owned();
            let ty = d.uint()?;
            let reply_to = d.opt_bytes_exact::<16>()?;
            let m = d.array_len()?;
            let mut attachments = Vec::with_capacity(m);
            for _ in 0..m {
                d.array(4)?;
                attachments.push((
                    d.bytes_exact::<32>()?,
                    d.uint()?,
                    d.text()?.to_owned(),
                    d.text()?.to_owned(),
                ));
            }
            rows.push(OutboxRow {
                msg_id,
                state,
                error,
                created,
                body,
                ty,
                reply_to,
                attachments,
            });
        }
        Ok(rows)
    })
    .expect("outbox shape")
}

/// The L-CORE-36 request: [type, reply_to|null, body, [nine-element attachment…]].
pub fn request(
    ty: u64,
    reply_to: Option<&[u8; 16]>,
    body: &str,
    attachments: &[Attachment],
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(4)
        .uint(ty)
        .opt_bytes(reply_to.map(|r| r.as_slice()))
        .text(body)
        .array(attachments.len());
    for a in attachments {
        e.array(9)
            .bytes(&a.blob_id)
            .bytes(&a.key)
            .bytes(&a.nonce)
            .uint(a.size)
            .text(&a.mime)
            .opt_uint(a.w)
            .opt_uint(a.h)
            .opt_bytes(a.thumb.as_deref())
            .text(&a.name);
    }
    e.into_vec()
}

/// The web3.7 request: the L-CORE-36 request with a fifth element, `thread_id` (b16 or null).
pub fn thread_request(
    ty: u64,
    reply_to: Option<&[u8; 16]>,
    body: &str,
    thread_id: Option<&[u8; 16]>,
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(5)
        .uint(ty)
        .opt_bytes(reply_to.map(|r| r.as_slice()))
        .text(body)
        .array(0)
        .opt_bytes(thread_id.map(|t| t.as_slice()));
    e.into_vec()
}

/// A descriptor whose every byte is derived from `n`: blob_id n, key n+1, nonce n+2, size 1000 + n,
/// image/png 640×480, a 26-byte thumb of n, name "file-<n as two hex digits>.png".
pub fn attachment(n: u8) -> Attachment {
    Attachment {
        blob_id: [n; 32],
        key: [n.wrapping_add(1); 32],
        nonce: [n.wrapping_add(2); 12],
        size: 1000 + u64::from(n),
        mime: "image/png".to_owned(),
        w: Some(640),
        h: Some(480),
        thumb: Some(vec![n; 26]),
        name: format!("file-{n:02x}.png"),
    }
}

/// attachment_get's nine elements.
pub fn decode_attachment(bytes: &[u8]) -> Attachment {
    decode_strict(bytes, |d| {
        d.array(9)?;
        Ok(Attachment {
            blob_id: d.bytes_exact::<32>()?,
            key: d.bytes_exact::<32>()?,
            nonce: d.bytes_exact::<12>()?,
            size: d.uint()?,
            mime: d.text()?.to_owned(),
            w: d.opt_uint()?,
            h: d.opt_uint()?,
            thumb: d.opt_bytes()?.map(<[u8]>::to_vec),
            name: d.text()?.to_owned(),
        })
    })
    .expect("attachment_get shape")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurgeRow {
    pub group_id: [u8; 16],
    pub seq: u64,
    pub channel_id: [u8; 16],
    pub blob_ids: Vec<[u8; 32]>,
}

pub fn decode_purges(bytes: &[u8]) -> Vec<PurgeRow> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(4)?;
            let group_id = d.bytes_exact::<16>()?;
            let seq = d.uint()?;
            let channel_id = d.bytes_exact::<16>()?;
            let m = d.array_len()?;
            let mut blob_ids = Vec::with_capacity(m);
            for _ in 0..m {
                blob_ids.push(d.bytes_exact::<32>()?);
            }
            rows.push(PurgeRow {
                group_id,
                seq,
                channel_id,
                blob_ids,
            });
        }
        Ok(rows)
    })
    .expect("purges shape")
}

/// A type-0 envelope whose one attachment has eight elements: what web-2a's core accepted and
/// stored, and what this build's `Envelope::decode` refuses (AI-2). `body` is under 24 bytes.
pub fn legacy_eight_element_envelope(msg_id: &[u8; 16], body: &str) -> Vec<u8> {
    assert!(
        body.len() < 24,
        "a short body keeps the one-byte text header"
    );
    let mut v = vec![0x89, 0x01, 0x50];
    v.extend_from_slice(msg_id);
    v.extend_from_slice(&[0x00, 0xf6, 0xf6]);
    v.push(0x60 + body.len() as u8);
    v.extend_from_slice(body.as_bytes());
    v.extend_from_slice(&[0x81, 0x88, 0x58, 0x20]);
    v.extend_from_slice(&[0x41; 32]);
    v.extend_from_slice(&[0x58, 0x20]);
    v.extend_from_slice(&[0x44; 32]);
    v.push(0x4c);
    v.extend_from_slice(&[0x45; 12]);
    v.extend_from_slice(&[0x01, 0x61, b'x', 0xf6, 0xf6, 0xf6, 0x80, 0x58, 0x20]);
    v.extend_from_slice(&[0x46; 32]);
    v
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

/// A type-`kind` envelope as the fold tests send it (web-2b task 2).
pub fn fold_envelope(
    msg_id: [u8; 16],
    kind: EnvelopeType,
    reply_to: Option<[u8; 16]>,
    body: &str,
) -> Envelope {
    Envelope {
        v: 1,
        msg_id: MsgId::from_bytes(msg_id),
        kind,
        thread_id: None,
        reply_to: reply_to.map(MsgId::from_bytes),
        body: body.to_owned(),
        attachments: Vec::new(),
        previews: Vec::new(),
        k_f: [0x06; 32],
    }
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
        self.create_and_register_in(relay, instance, Some(&COMMUNITY), &CHANNEL);
    }

    pub fn create_and_register_in(
        &mut self,
        relay: &mut Relay,
        instance: &Instance,
        community: Option<&[u8; 16]>,
        channel: &[u8; 16],
    ) {
        let body = self
            .core
            .group_create(
                &relay.group_id,
                community,
                channel,
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
        self.join_external_in(relay, Some(&COMMUNITY), &CHANNEL);
    }

    pub fn join_external_in(
        &mut self,
        relay: &mut Relay,
        community: Option<&[u8; 16]>,
        channel: &[u8; 16],
    ) {
        let body = self
            .core
            .group_join_external(
                &relay.group_id,
                community,
                channel,
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

    pub fn prepare_request(&mut self, group_id: &[u8; 16], request: &[u8], now: u64) -> [u8; 16] {
        let out = self
            .core
            .send_prepare(group_id, request, now)
            .expect("send_prepare");
        decode_strict(&out, |d| {
            d.array(1)?;
            d.bytes_exact::<16>()
        })
        .expect("send_prepare shape")
    }

    pub fn prepare(&mut self, group_id: &[u8; 16], body: &str, now: u64) -> [u8; 16] {
        self.prepare_request(group_id, &request(0, None, body, &[]), now)
    }

    pub fn encrypt(&mut self, msg_id: &[u8; 16]) -> ([u8; 16], Vec<u8>) {
        let out = self.core.send_encrypt(msg_id).expect("send_encrypt");
        decode_strict(&out, |d| {
            d.array(2)?;
            Ok((d.bytes_exact::<16>()?, d.bytes()?.to_vec()))
        })
        .expect("send_encrypt shape")
    }

    /// prepare → encrypt → POST …/message, without send_confirm: the echo path. Returns (msg_id, seq).
    pub fn post_request(
        &mut self,
        relay: &mut Relay,
        group_id: &[u8; 16],
        request: &[u8],
        now: u64,
    ) -> ([u8; 16], u64) {
        let msg_id = self.prepare_request(group_id, request, now);
        let (_, message_body) = self.encrypt(&msg_id);
        let answer = relay
            .post_message(self.device, &message_body)
            .expect("upload");

        (msg_id, seq_of_answer(&answer))
    }

    /// encrypt → POST …/message → confirm for a prepared row. Returns its seq.
    pub fn encrypt_and_confirm(
        &mut self,
        relay: &mut Relay,
        group_id: &[u8; 16],
        msg_id: &[u8; 16],
    ) -> u64 {
        let (_, message_body) = self.encrypt(msg_id);
        let answer = relay
            .post_message(self.device, &message_body)
            .expect("upload");
        let (gid, seq) = decode_confirm(
            &self
                .core
                .send_confirm(msg_id, &answer)
                .expect("send_confirm"),
        );
        assert_eq!(&gid, group_id);
        seq
    }

    /// prepare → encrypt → POST …/message → confirm. Returns (msg_id, seq).
    pub fn send_request(
        &mut self,
        relay: &mut Relay,
        group_id: &[u8; 16],
        request: &[u8],
        now: u64,
    ) -> ([u8; 16], u64) {
        let msg_id = self.prepare_request(group_id, request, now);
        let seq = self.encrypt_and_confirm(relay, group_id, &msg_id);
        (msg_id, seq)
    }

    pub fn send(
        &mut self,
        relay: &mut Relay,
        group_id: &[u8; 16],
        body: &str,
        now: u64,
    ) -> ([u8; 16], u64) {
        self.send_request(relay, group_id, &request(0, None, body, &[]), now)
    }

    /// The displayable timeline row at `seq`; panics when there is none.
    pub fn row_at(&self, group_id: &[u8; 16], seq: u64) -> TimelineRow {
        self.timeline(group_id)
            .into_iter()
            .find(|r| r.seq == seq)
            .unwrap_or_else(|| panic!("no displayable row at seq {seq}"))
    }

    pub fn purges(&self) -> Vec<PurgeRow> {
        decode_purges(&self.core.purges().expect("purges"))
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

/// Existing message fixtures begin with both current leaves backed by signed v1 lists.
pub fn alice_and_bob_trusted() -> (Instance, Relay, Core, Core) {
    let (instance, relay, mut alice, mut bob) = alice_and_bob();
    ingest_core_list(&mut alice, &relay, &bob);
    ingest_core_list(&mut bob, &relay, &alice);
    (instance, relay, alice, bob)
}

/// Publish one fixture core's genuinely signed list to a receiver after its leaf exists.
pub fn ingest_core_list(receiver: &mut Core, relay: &Relay, sender: &Core) {
    ingest_list_body(
        receiver,
        relay,
        sender.user,
        sender.device,
        &sender.core.device_list_body().expect("list body"),
    );
}

/// Feed a real signed list through the authenticated proposal path before committing an Add.
pub fn ingest_add_candidate(receiver: &mut Core, relay: &Relay, sender: &Core) {
    ingest_add_candidate_in(receiver, relay, sender, &GROUP);
}

pub fn ingest_add_candidate_in(
    receiver: &mut Core,
    relay: &Relay,
    sender: &Core,
    group_id: &[u8; 16],
) {
    let proposals = relay.proposals_body();
    ingest_add_candidate_body(receiver, &proposals, sender, group_id);
}

/// Ingest the authentic signed list for one distinct Add without repeatedly validating every
/// other queued candidate in the test's large Welcome fixture.
pub fn ingest_add_candidate_proposal(
    receiver: &mut Core,
    relay: &Relay,
    proposal_index: usize,
    sender: &Core,
    group_id: &[u8; 16],
) {
    let proposal = relay.proposals.get(proposal_index).expect("proposal index");
    let mut e = Encoder::new();
    e.array(1)
        .array(5)
        .bytes(&proposal.reference)
        .uint(proposal.kind)
        .opt_uint(proposal.target_leaf)
        .bytes(&proposal.blob)
        .uint(0);
    ingest_add_candidate_body(receiver, &e.into_vec(), sender, group_id);
}

fn ingest_add_candidate_body(
    receiver: &mut Core,
    proposals: &[u8],
    sender: &Core,
    group_id: &[u8; 16],
) {
    let candidates = receiver
        .core
        .proposed_adds(group_id, proposals)
        .expect("candidates");
    let index = decode_strict(&candidates, |d| {
        let n = d.array_len()?;
        let mut found = None;
        for _ in 0..n {
            d.array(3)?;
            let index = d.uint()?;
            let user = d.bytes_exact::<16>()?;
            d.uint()?;
            if user == sender.user {
                found = Some(index);
            }
        }
        Ok(found)
    })
    .expect("candidate list")
    .expect("sender candidate");
    let put = sender.core.device_list_body().expect("signed PUT");
    let (version, blob, sig, prev) = decode_strict(&put, |d| {
        d.array(4)?;
        Ok((
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes_exact::<64>()?,
            d.bytes_exact::<32>()?,
        ))
    })
    .expect("PUT body");
    let mut history = Encoder::new();
    history
        .array(1)
        .array(4)
        .uint(version)
        .bytes(&blob)
        .bytes(&sig)
        .bytes(&prev);
    receiver
        .core
        .device_list_ingest_add(
            group_id,
            proposals,
            index,
            &sender.user,
            &history.into_vec(),
            &blob,
            NOW,
        )
        .expect("authenticated pre-Add list");
}

pub fn ingest_list_body(
    receiver: &mut Core,
    relay: &Relay,
    user: [u8; 16],
    device: [u8; 16],
    body: &[u8],
) {
    let (version, blob, sig, prev) = decode_strict(body, |d| {
        d.array(4)?;
        Ok((
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes_exact::<64>()?,
            d.bytes_exact::<32>()?,
        ))
    })
    .expect("signed PUT body");
    let mut history = Encoder::new();
    history
        .array(1)
        .array(4)
        .uint(version)
        .bytes(&blob)
        .bytes(&sig)
        .bytes(&prev);
    receiver
        .core
        .device_list_ingest(
            &relay.group_id,
            relay.leaf_of(device),
            &user,
            &history.into_vec(),
            &blob,
            NOW,
        )
        .expect("fixture list ingest");
}

/// Publish a signed v2 list containing two real MLS keys for one fixture user.
pub fn ingest_raw_peer_pair(receiver: &mut Core, relay: &Relay, first: &RawPeer, second: &RawPeer) {
    assert_eq!(first.user, second.user);
    let first_body = first.device_list_body();
    let (_, first_blob, first_sig, first_prev) = decode_strict(&first_body, |d| {
        d.array(4)?;
        Ok((
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes_exact::<64>()?,
            d.bytes_exact::<32>()?,
        ))
    })
    .expect("first PUT");
    let first_list = DeviceList::decode(&first_blob).expect("first signed list");
    let ssk = SskSigner::from_bytes(&[first.user[0].wrapping_add(0x40); 32]);
    let entries = [first, second]
        .map(|peer| DeviceEntry {
            device_id: DeviceId::from_bytes(peer.device),
            dsk_pub: peer.signer.public().try_into().expect("DSK"),
            tier: Tier::Native,
            added_at: NOW,
            revoked_at: None,
        })
        .to_vec();
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: UserId::from_bytes(first.user),
        version: 2,
        prev_hash: first_list.hash(),
        entries,
    };
    let second_list = DeviceList {
        sig_ssk: ssk.sign_device_list(&unsigned),
        unsigned,
    };
    let mut history = Encoder::new();
    history
        .array(2)
        .array(4)
        .uint(1)
        .bytes(&first_blob)
        .bytes(&first_sig)
        .bytes(&first_prev)
        .array(4)
        .uint(2)
        .bytes(&second_list.encode())
        .bytes(&second_list.sig_ssk)
        .bytes(&second_list.unsigned.prev_hash);
    receiver
        .core
        .device_list_ingest(
            &relay.group_id,
            relay.leaf_of(second.device),
            &first.user,
            &history.into_vec(),
            &second_list.encode(),
            NOW,
        )
        .expect("two-device signed list");
}

/// Supply the signed list extension created when a second local device enrols.
pub fn ingest_enrolled_pair(receiver: &mut Core, relay: &Relay, first: &Core, second: &Core) {
    ingest_enrolled_pair_bodies(
        receiver,
        relay,
        first.user,
        second.device,
        &first.core.device_list_body().expect("first PUT"),
        &second.core.device_list_body().expect("enrolled PUT"),
    );
}

pub fn ingest_enrolled_pair_bodies(
    receiver: &mut Core,
    relay: &Relay,
    user: [u8; 16],
    device: [u8; 16],
    first_body: &[u8],
    second_body: &[u8],
) {
    let parse = |body: &[u8]| {
        decode_strict(body, |d| {
            d.array(4)?;
            Ok((
                d.uint()?,
                d.bytes()?.to_vec(),
                d.bytes_exact::<64>()?,
                d.bytes_exact::<32>()?,
            ))
        })
        .expect("signed PUT")
    };
    let a = parse(first_body);
    let b = parse(second_body);
    assert_eq!((a.0, b.0), (1, 2));
    let mut history = Encoder::new();
    history
        .array(2)
        .array(4)
        .uint(a.0)
        .bytes(&a.1)
        .bytes(&a.2)
        .bytes(&a.3)
        .array(4)
        .uint(b.0)
        .bytes(&b.1)
        .bytes(&b.2)
        .bytes(&b.3);
    receiver
        .core
        .device_list_ingest(
            &relay.group_id,
            relay.leaf_of(device),
            &user,
            &history.into_vec(),
            &b.1,
            NOW,
        )
        .expect("enrolled signed list");
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
    /// The `C` the delivery service read from the upload's `authenticated_data`, kept when the
    /// message is deleted (`mls_app_messages.commitment_c`); `None` as a live op-19 frame sends it.
    pub commitment: Option<[u8; 32]>,
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
    pub deleted: bool,
    /// The upload class the host stored (web3.7): `Some` serves the row with nine elements, `None`
    /// with the legacy eight.
    pub class: Option<u64>,
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
        e.array(if m.class.is_some() { 9 } else { 8 })
            .uint(m.seq)
            .uint(m.epoch)
            .bytes(&m.uploader)
            .opt_bytes(m.blob.as_deref())
            .opt_bytes(m.commitment.as_ref().map(|c| c.as_slice()))
            .bytes(&m.franking_tag)
            .uint(m.recv_ts)
            .uint(u64::from(m.deleted));
        if let Some(class) = m.class {
            e.uint(class);
        }
    }
    e.into_vec()
}

/// The 32-byte `authenticated_data` of a `PrivateMessage` blob: the commitment `C` the delivery
/// service stores with the row (protocol/02 "`commitment` … is the stored value of `C`").
pub fn commitment_of(blob: &[u8]) -> Option<[u8; 32]> {
    match protocol_in(blob).ok()? {
        ProtocolMessage::PrivateMessage(p) => p.aad().try_into().ok(),
        ProtocolMessage::PublicMessage(_) => None,
    }
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

    /// POST /v1/groups/{id}/message: [epoch, private_message, class] → [seq, franking_tag,
    /// recv_ts]. A legacy two-element body stores no class (web3.7).
    pub fn post_message(
        &mut self,
        uploader: [u8; 16],
        body: &[u8],
    ) -> Result<Vec<u8>, &'static str> {
        let (epoch, blob, class) = decode_strict(body, |d| {
            let len = d.array_len()?;
            let (epoch, blob) = (d.uint()?, d.bytes()?.to_vec());
            let class = match len {
                2 => None,
                3 => Some(d.uint()?),
                _ => {
                    return Err(dilla_core::cbor::CborError::WrongArrayLen {
                        expected: 3,
                        actual: len,
                    });
                }
            };
            Ok((epoch, blob, class))
        })
        .map_err(|_| "E_INVALID_REQUEST")?;
        if epoch != self.epoch() || class.is_some_and(|c| c > 1) {
            return Err(if epoch != self.epoch() {
                "E_COMMIT_INVALID"
            } else {
                "E_INVALID_REQUEST"
            });
        }
        let answer = self.push_message(uploader, epoch, Some(blob), false);
        if let Some(row) = self.messages.last_mut() {
            row.class = class;
        }
        Ok(answer)
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
        let commitment = blob.as_deref().and_then(commitment_of);
        self.messages.push(MsgRow {
            seq,
            epoch,
            uploader,
            blob,
            commitment,
            franking_tag,
            recv_ts,
            deleted,
            class: None,
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
    /// A KeyPackage for adding this real MLS device to a fixture group.
    pub fn key_package(&self) -> Vec<u8> {
        let package = KeyPackage::builder()
            .leaf_node_capabilities(dilla_core::mls::leaf_capabilities())
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .expect("key package");
        MlsMessageOut::from(package.key_package().clone())
            .tls_serialize_detached()
            .expect("serialize key package")
    }

    /// A signed v1 list for fixture-only trust ingress.
    pub fn device_list_body(&self) -> Vec<u8> {
        let ssk = SskSigner::from_bytes(&[self.user[0].wrapping_add(0x40); 32]);
        let dsk_pub: [u8; 32] = self.signer.public().try_into().expect("dsk");
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id: UserId::from_bytes(self.user),
            version: 1,
            prev_hash: [0; 32],
            entries: vec![DeviceEntry {
                device_id: DeviceId::from_bytes(self.device),
                dsk_pub,
                tier: Tier::Native,
                added_at: NOW,
                revoked_at: None,
            }],
        };
        let list = DeviceList {
            sig_ssk: ssk.sign_device_list(&unsigned),
            unsigned,
        };
        let mut e = Encoder::new();
        e.array(4)
            .uint(1)
            .bytes(&list.encode())
            .bytes(&list.sig_ssk)
            .bytes(&[0; 32]);
        e.into_vec()
    }
    /// A native-tier user whose credential is a well-formed `CredentialIdentity`.
    pub fn new(user: u8, device: u8) -> Self {
        Self::new_with_keys(user, device, user, user.wrapping_add(0x40))
    }

    /// A new real MLS device for the same user with rotated identity keys.
    pub fn new_with_keys(user: u8, device: u8, umk_seed: u8, ssk_seed: u8) -> Self {
        let umk = UmkSigner::from_bytes(&[umk_seed; 32]);
        let ssk = SskSigner::from_bytes(&[ssk_seed; 32]);
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
        let dsk_pub: [u8; 32] = signer.public().try_into().expect("32-byte DSK");
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
            sig_ssk_dev: ssk.sign_device(
                &DeviceId::from_bytes([device; 16]),
                &dsk_pub,
                Kind::User,
                Tier::Native,
                SignerTier::Native,
            ),
        };
        let provider = DillaProvider::new(memory());
        provider.storage().migrate().expect("migrate");
        signer.store(provider.storage()).expect("store signer");
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.encode()).into(),
            signature_key: signer.public().into(),
        };
        Self {
            provider,
            signer,
            credential,
            user: [user; 16],
            device: [device; 16],
            group: None,
        }
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
        self.create_as(relay, instance, &text_binding(CHANNEL));
    }

    /// `create` under `binding`.
    pub fn create_as(&mut self, relay: &mut Relay, instance: &Instance, binding: &DillaBinding) {
        let group = DillaGroup::create(
            &self.provider,
            &self.signer,
            self.credential.clone(),
            GroupId::from_slice(&relay.group_id),
            binding.clone(),
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
            .bytes(&binding.encode())
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
        self.send_typed(relay, EnvelopeType::Message, body)
    }

    pub fn send_typed(&mut self, relay: &mut Relay, kind: EnvelopeType, body: &str) -> u64 {
        let reply_to = (kind != EnvelopeType::Message).then_some([0x5b; 16]);
        self.send_envelope(relay, &fold_envelope([0x5a; 16], kind, reply_to, body))
    }

    /// Uploads `envelope` as one application message; answers its seq.
    pub fn send_envelope(&mut self, relay: &mut Relay, envelope: &Envelope) -> u64 {
        let group = self.group.as_mut().expect("created");
        let blob = group
            .create_message(&self.provider, &self.signer, envelope)
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

    /// Processes and merges another member's commit, the relay's handshake row at `seq`.
    pub fn apply_commit(&mut self, relay: &Relay, seq: u64) {
        let row = relay
            .handshakes
            .iter()
            .find(|h| h.seq == seq)
            .expect("a handshake row at that seq");
        let message = protocol_in(&row.blob).expect("a protocol message");
        let group = self.group.as_mut().expect("joined");
        match group
            .process_message(&self.provider, message)
            .expect("process the commit")
        {
            DillaProcessed::StagedCommit(staged, _) => group
                .merge_staged_commit(&self.provider, *staged)
                .expect("merge"),
            other => panic!("expected a commit at seq {seq}, got {other:?}"),
        }
    }
}

impl Instance {
    /// The instance's Add of the device whose KeyPackage `MLSMessage` is `key_package`, queued by
    /// the relay as invariant 6 queues it. Answers the proposal's seq.
    pub fn propose_add(&self, relay: &mut Relay, key_package: &[u8]) -> u64 {
        let incoming = match MlsMessageIn::tls_deserialize_exact(key_package)
            .expect("an MLSMessage")
            .extract()
        {
            MlsMessageBodyIn::KeyPackage(kp) => kp,
            other => panic!("expected a KeyPackage, got {other:?}"),
        };
        let kp =
            validate_key_package(&RustCrypto::default(), incoming).expect("a valid KeyPackage");
        let message = external_propose_add(
            kp,
            GroupId::from_slice(&relay.group_id),
            relay.epoch().into(),
            &self.signer,
        )
        .expect("instance Add");
        relay.propose(message)
    }

    /// The instance's Remove of `device`'s leaf. Answers the proposal's seq.
    pub fn propose_remove(&self, relay: &mut Relay, device: [u8; 16]) -> u64 {
        let leaf = relay.leaf_of(device);
        let message = external_propose_remove(
            LeafNodeIndex::new(leaf),
            GroupId::from_slice(&relay.group_id),
            relay.epoch().into(),
            &self.signer,
        )
        .expect("instance Remove");
        relay.propose(message)
    }
}

impl Relay {
    /// Queues a proposal in the public view, appends its handshake row (kind 0, sender null: the
    /// instance) and lists it as outstanding. Answers its seq.
    pub fn propose(&mut self, message: MlsMessageOut) -> u64 {
        let blob = message.tls_serialize_detached().expect("serialize");
        let crypto = &self.crypto;
        let public = self.public.as_mut().expect("the group is registered");
        let reference = public
            .queue_proposal(crypto, protocol_in(&blob).expect("a protocol message"))
            .expect("the relay queues the proposal");
        let (kind, _, target_leaf, _) = public
            .queued_proposal_detail(&reference)
            .expect("detail")
            .expect("queued");
        let seq = self.take_seq();
        let epoch = self.epoch();
        self.handshakes.push(HsRow {
            seq,
            epoch,
            kind: 0,
            sender: None,
            blob: blob.clone(),
        });
        self.proposals.push(RelayProposal {
            reference,
            kind,
            target_leaf: target_leaf.map(u64::from),
            blob,
        });
        seq
    }

    /// GET /v1/groups/{id}/proposals: [[ref, kind, target_leaf|null, blob, void]].
    pub fn proposals_body(&self) -> Vec<u8> {
        let mut e = Encoder::new();
        e.array(self.proposals.len());
        for p in &self.proposals {
            e.array(5)
                .bytes(&p.reference)
                .uint(p.kind)
                .opt_uint(p.target_leaf)
                .bytes(&p.blob)
                .uint(0);
        }
        e.into_vec()
    }

    /// The leaf `device` holds in the relay's current tree.
    pub fn leaf_of(&self, device: [u8; 16]) -> u32 {
        self.public()
            .members()
            .into_iter()
            .find(|m| m.identity.device_id.as_bytes() == &device)
            .expect("a member of the group")
            .leaf_index
    }

    /// Appends a handshake row the public view never saw (a delivery service that stored garbage).
    pub fn push_handshake(&mut self, kind: u64, blob: Vec<u8>) -> u64 {
        let seq = self.take_seq();
        let epoch = self.epoch();
        self.handshakes.push(HsRow {
            seq,
            epoch,
            kind,
            sender: None,
            blob,
        });
        seq
    }
}

impl Core {
    /// commit_build over the relay's outstanding proposals → POST …/commit → commit_confirm.
    pub fn commit(&mut self, relay: &mut Relay) -> Applied {
        let body = self
            .core
            .commit_build(&relay.group_id, &relay.proposals_body())
            .expect("commit_build");
        relay.commit(&body).expect("commit accepted");
        decode_applied(
            &self
                .core
                .commit_confirm(&relay.group_id)
                .expect("commit_confirm"),
        )
    }
}

impl RawPeer {
    /// Joins the relay's group by external commit (POST …/resync) against the CHANNEL binding.
    /// Answers the seq of the external commit.
    pub fn join_external(&mut self, relay: &mut Relay) -> u64 {
        self.join_external_as(relay, &text_binding(CHANNEL))
    }

    /// `join_external` against `binding`.
    pub fn join_external_as(&mut self, relay: &mut Relay, binding: &DillaBinding) -> u64 {
        let info = group_info_in(&relay.group_info).expect("the relay's GroupInfo");
        let tree_bytes = relay
            .public()
            .export_ratchet_tree()
            .tls_serialize_detached()
            .expect("tree");
        let tree = RatchetTreeIn::tls_deserialize_exact(tree_bytes.as_slice()).expect("tree");
        let (group, commit, _) = DillaGroup::join_by_external_commit(
            &self.provider,
            &self.signer,
            self.credential.clone(),
            info,
            tree,
            binding,
        )
        .expect("external join");
        let own_info = group
            .export_group_info(&self.provider, &self.signer)
            .expect("group info")
            .tls_serialize_detached()
            .expect("serialize");
        let mut e = Encoder::new();
        e.array(2)
            .bytes(&commit.tls_serialize_detached().expect("serialize"))
            .bytes(&own_info);
        let answer = relay.resync(&e.into_vec()).expect("resync accepted");
        self.group = Some(group);
        decode_strict(&answer, |d| {
            d.array(2)?;
            let seq = d.uint()?;
            d.uint()?;
            Ok(seq)
        })
        .expect("200 body")
    }

    /// One self-update commit (it carries no proposal here), posted and merged. Answers its seq.
    pub fn self_update(&mut self, relay: &mut Relay) -> u64 {
        let group = self.group.as_mut().expect("joined");
        let epoch = group.epoch();
        let bundle = group
            .self_update(&self.provider, &self.signer)
            .expect("self_update");
        let info = MlsMessageOut::from(bundle.group_info.expect("the GroupInfo of epoch n + 1"))
            .tls_serialize_detached()
            .expect("serialize");
        let mut e = Encoder::new();
        e.array(5)
            .uint(epoch)
            .bytes(&bundle.commit.tls_serialize_detached().expect("serialize"))
            .bytes(&info);
        e.array(0);
        e.null();
        let answer = relay.commit(&e.into_vec()).expect("commit accepted");
        group.merge_pending_commit(&self.provider).expect("merge");
        decode_strict(&answer, |d| {
            d.array(2)?;
            let seq = d.uint()?;
            d.uint()?;
            Ok(seq)
        })
        .expect("200 body")
    }
}

fn device_of(core: &ClientCore) -> [u8; 16] {
    let identity = core.identity().expect("identity");
    decode_strict(&identity, |d| {
        d.array(6)?;
        assert_eq!(d.uint()?, 2, "phase 2");
        d.opt_bytes_exact::<16>()?;
        d.opt_bytes_exact::<16>()?;
        let device = d.opt_bytes_exact::<16>()?;
        d.text()?;
        d.uint()?;
        Ok(device)
    })
    .expect("identity shape")
    .expect("a device id in phase 2")
}

/// `ready_core` that also returns the recovery key `signup_begin` showed, its list v1 accepted
/// (web-2a task 3).
pub fn ready_core_with_key(user: u8, username: &str) -> (Core, String) {
    let conn = memory();
    let probe = Arc::clone(&conn);
    let mut core = ClientCore::open(conn).expect("open");
    let rk = core.signup_begin(&INSTANCE).expect("signup_begin");
    core.signup_complete(&[user; 16], username, NOW)
        .expect("signup_complete");
    core.device_list_published().expect("device_list_published");
    let device = device_of(&core);
    (
        Core {
            core,
            probe,
            user: [user; 16],
            device,
        },
        rk,
    )
}

/// A second browser of `first`'s account, enrolled by recovery key from `first`'s sealed objects and
/// its current list, then published (web-2a task 3): enrol_begin → enrol_session_sign →
/// enrol_registered → enrol_complete → device_list_published.
pub fn enrolled_core(first: &Core, recovery_key: &str, now: u64) -> Core {
    let conn = memory();
    let probe = Arc::clone(&conn);
    let mut core = ClientCore::open(conn).expect("open");
    core.enrol_begin(&INSTANCE).expect("enrol_begin");
    core.enrol_session_sign(&[0x5e; 32], b"assertion")
        .expect("enrol_session_sign");
    core.enrol_registered(&first.user)
        .expect("enrol_registered");
    let sealed = first.core.sealed_objects().expect("sealed_objects");
    let (root, state) = decode_strict(&sealed, |d| {
        d.array(3)?;
        let root = d.bytes()?.to_vec();
        let state = d.bytes()?.to_vec();
        d.uint()?;
        Ok((root, state))
    })
    .expect("[root, state, state_uploaded]");
    let identity = first.core.identity().expect("identity");
    let username = decode_strict(&identity, |d| {
        d.array(6)?;
        for _ in 0..4 {
            d.skip()?;
        }
        let name = d.text()?.to_owned();
        d.uint()?;
        Ok(name)
    })
    .expect("identity shape");
    let list = first.core.device_list_body().expect("device_list_body");
    core.enrol_complete(recovery_key, &root, &state, &list, &username, now)
        .expect("enrol_complete");
    core.device_list_published().expect("device_list_published");
    let device = device_of(&core);
    Core {
        core,
        probe,
        user: first.user,
        device,
    }
}

// ---------------------------------------------------------------------------------------------
// Signed-list helpers (moved unchanged from tests/client_trust.rs for tests/client_calls.rs).

pub fn sec_entry(peer: &RawPeer) -> DeviceEntry {
    DeviceEntry {
        device_id: DeviceId::from_bytes(peer.device),
        dsk_pub: peer.signer.public().try_into().unwrap(),
        tier: Tier::Native,
        added_at: NOW + 2,
        revoked_at: None,
    }
}

pub fn sec_next(prev: &DeviceList, entries: Vec<DeviceEntry>, ssk_seed: u8) -> DeviceList {
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: prev.unsigned.user_id,
        version: prev.unsigned.version + 1,
        prev_hash: prev.hash(),
        entries,
    };
    DeviceList {
        sig_ssk: SskSigner::from_bytes(&[ssk_seed; 32]).sign_device_list(&unsigned),
        unsigned,
    }
}

pub fn sec_history(lists: &[&DeviceList]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(lists.len());
    for list in lists {
        e.array(4)
            .uint(list.unsigned.version)
            .bytes(&list.encode())
            .bytes(&list.sig_ssk)
            .bytes(&list.unsigned.prev_hash);
    }
    e.into_vec()
}

pub fn sec_ingest(
    alice: &mut Core,
    relay: &Relay,
    user: &[u8; 16],
    via: [u8; 16],
    lists: &[&DeviceList],
) -> (u64, u64, u64) {
    let head = lists.last().unwrap().encode();
    let answer = alice
        .core
        .device_list_ingest(
            &GROUP,
            relay.leaf_of(via),
            user,
            &sec_history(lists),
            &head,
            NOW + 3,
        )
        .expect("signed ingest");
    decode_strict(&answer, |d| {
        d.array(3)?;
        Ok((d.uint()?, d.uint()?, d.uint()?))
    })
    .unwrap()
}

pub fn sec_cached_umk(alice: &Core, user: &[u8; 16]) -> [u8; 32] {
    alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT umk_pub FROM app_device_lists WHERE user_id=?1",
            [user.as_slice()],
            |r| r.get(0),
        )
        .unwrap()
}

// ---------------------------------------------------------------------------------------------
// Call groups (web-3 task 5): the call group of a voice channel or a DM, its media epoch.

/// A call group id, apart from GROUP so a DM's text group and call group can be held together.
pub const CALL: [u8; 16] = [0xca; 16];
/// A voice channel of COMMUNITY.
pub const VOICE: [u8; 16] = [0x77; 16];
/// A DM's channel: the target of its text group and of its call group.
pub const DM: [u8; 16] = DM_CHANNEL;

/// The binding of a call group: kind call, media version 1.
pub fn call_binding(community: Option<[u8; 16]>, channel: [u8; 16]) -> DillaBinding {
    DillaBinding {
        community_id: community.map(CommunityId::from_bytes),
        kind: GroupKind::Call,
        media_version: GroupKind::Call.media_version(),
        ..text_binding(channel)
    }
}

impl Core {
    /// call_group_create → POST /v1/groups → group_registered.
    pub fn call_create_and_register(
        &mut self,
        relay: &mut Relay,
        instance: &Instance,
        community: Option<&[u8; 16]>,
        channel: &[u8; 16],
    ) {
        let body = self
            .core
            .call_group_create(
                &relay.group_id,
                community,
                channel,
                POLICY,
                &instance.public(),
            )
            .expect("call_group_create");
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
}

impl RawPeer {
    /// Creates and registers the relay's call group for VOICE in COMMUNITY.
    pub fn create_call(&mut self, relay: &mut Relay, instance: &Instance) {
        self.create_as(relay, instance, &call_binding(Some(COMMUNITY), VOICE));
    }

    /// Joins the relay's call group for VOICE in COMMUNITY by external commit.
    pub fn join_external_call(&mut self, relay: &mut Relay) -> u64 {
        self.join_external_as(relay, &call_binding(Some(COMMUNITY), VOICE))
    }

    /// The same device (credential and signature key) in a fresh store, holding no group: for a
    /// second group the fixture device must be a member of.
    pub fn twin(&self) -> RawPeer {
        let signer = SignatureKeyPair::tls_deserialize_exact(
            self.signer
                .tls_serialize_detached()
                .expect("serialize")
                .as_slice(),
        )
        .expect("deserialize");
        let provider = DillaProvider::new(memory());
        provider.storage().migrate().expect("migrate");
        signer.store(provider.storage()).expect("store signer");
        RawPeer {
            provider,
            signer,
            credential: self.credential.clone(),
            user: self.user,
            device: self.device,
            group: None,
        }
    }
}

/// Alice's call group CALL for VOICE in COMMUNITY with a fixture Bob (UMK seed 0xb2, SSK seed
/// 0xf2), both active at epoch 1; Bob's v1 list is ingested through the call group.
pub fn call_raw_bob() -> (Relay, Core, RawPeer, DeviceList) {
    let instance = Instance::generate();
    let mut call = Relay::new(CALL);
    let mut alice = ready_core(0xa1, "alice");
    alice.call_create_and_register(&mut call, &instance, Some(&COMMUNITY), &VOICE);
    let mut bob = RawPeer::new(0xb2, 0xb3);
    bob.join_external_call(&mut call);
    alice.sync(&call);
    let body = bob.device_list_body();
    ingest_list_body(&mut alice, &call, bob.user, bob.device, &body);
    (call, alice, bob, list_of(&body))
}

/// The signed list a `device_list_body` PUT body carries.
pub fn list_of(body: &[u8]) -> DeviceList {
    let blob = decode_strict(body, |d| {
        d.array(4)?;
        d.uint()?;
        let blob = d.bytes()?.to_vec();
        d.skip()?;
        d.skip()?;
        Ok(blob)
    })
    .expect("signed PUT body");
    DeviceList::decode(&blob).expect("a signed list")
}

/// `sec_ingest` through the relay's own group (a call group, or any other one).
pub fn call_ingest(
    alice: &mut Core,
    relay: &Relay,
    user: &[u8; 16],
    via: [u8; 16],
    lists: &[&DeviceList],
) -> (u64, u64, u64) {
    let head = lists.last().expect("a list").encode();
    let answer = alice
        .core
        .device_list_ingest(
            &relay.group_id,
            relay.leaf_of(via),
            user,
            &sec_history(lists),
            &head,
            NOW + 3,
        )
        .expect("signed ingest");
    decode_strict(&answer, |d| {
        d.array(3)?;
        Ok((d.uint()?, d.uint()?, d.uint()?))
    })
    .expect("ingest answer")
}

/// Pins `peer`'s signed v1 list on `alice` before she holds any group with it: through a text
/// group GROUP on CHANNEL that a twin of the peer's device joins.
pub fn pin_list(alice: &mut Core, peer: &RawPeer) {
    let instance = Instance::generate();
    let mut text = Relay::new(GROUP);
    alice.create_and_register(&mut text, &instance);
    let mut twin = peer.twin();
    twin.join_external(&mut text);
    alice.sync(&text);
    ingest_list_body(
        alice,
        &text,
        peer.user,
        peer.device,
        &peer.device_list_body(),
    );
}

/// `call_media_epoch`'s answer: [epoch, base_key, own_leaf, [[leaf, device_id, user_id]], code].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaEpochOut {
    pub epoch: u64,
    pub base_key: [u8; 16],
    pub own_leaf: u64,
    pub roster: Vec<(u64, [u8; 16], [u8; 16])>,
    pub code: String,
}

pub fn decode_media_epoch(bytes: &[u8]) -> MediaEpochOut {
    decode_strict(bytes, |d| {
        d.array(5)?;
        let epoch = d.uint()?;
        let base_key = d.bytes_exact::<16>()?;
        let own_leaf = d.uint()?;
        let n = d.array_len()?;
        let mut roster = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(3)?;
            roster.push((d.uint()?, d.bytes_exact::<16>()?, d.bytes_exact::<16>()?));
        }
        let code = d.text()?.to_owned();
        Ok(MediaEpochOut {
            epoch,
            base_key,
            own_leaf,
            roster,
            code,
        })
    })
    .expect("call_media_epoch shape")
}

/// `call_leave_proposal`'s answer: [epoch, proposal].
pub fn decode_epoch_proposal(bytes: &[u8]) -> (u64, Vec<u8>) {
    decode_strict(bytes, |d| {
        d.array(2)?;
        Ok((d.uint()?, d.bytes()?.to_vec()))
    })
    .expect("call_leave_proposal shape")
}
