//! Deterministic CBOR values returned by the client and sent to the delivery service.

use super::ClientError;
use super::error::{E_CORE_INPUT, E_CORE_LIMIT, E_CORE_MLS};
use crate::cbor::{CborError, Decoder, Encoder, decode_strict};
use crate::envelope::Attachment;
use crate::identity::DeviceList;
use crate::mls::StorageError;
use openmls::prelude::{MlsMessageIn, ProtocolMessage};
use tls_codec::Deserialize as _;

#[allow(dead_code)] // Task 6 consumes the remaining handshake metadata.
pub(crate) struct HandshakeRow {
    pub seq: u64,
    pub epoch: u64,
    pub kind: u8,
    pub sender: Option<u32>,
    pub blob: Vec<u8>,
}
#[allow(dead_code)] // The commitment is retained for task 6's sync rules.
pub(crate) struct MessageRow {
    pub seq: u64,
    pub epoch: u64,
    pub uploader_device: [u8; 16],
    pub blob: Option<Vec<u8>>,
    pub commitment: Option<[u8; 32]>,
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
    pub deleted: bool,
    /// The upload class the host stored (web3.7): 0 for a post, 1 for every other type, `None`
    /// for a legacy row (eight elements, or a null ninth).
    pub class: Option<u64>,
}
pub(crate) struct ApplyResult {
    pub state: u8,
    pub epoch: u64,
    pub next_seq: u64,
    pub new_seqs: Vec<u64>,
    pub proposals_pending: u64,
    pub flags: u8,
}
pub(crate) struct ProposalItem {
    pub reference: Vec<u8>,
    pub kind: u64,
    pub target_leaf: Option<u32>,
    pub blob: Vec<u8>,
    pub void: bool,
}

pub(crate) fn decode_proposals_body(bytes: &[u8]) -> Result<Vec<ProposalItem>, ClientError> {
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(ClientError::new(E_CORE_LIMIT, ""));
    }
    let mut header = Decoder::new(bytes);
    let count = header.array_len().map_err(|e| shape("proposals_body", e))?;
    if count > 1024 {
        header.array(5).map_err(|e| shape("proposals_body", e))?;
        return Err(ClientError::new(E_CORE_LIMIT, ""));
    }
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            d.array(5)?;
            let reference = d.bytes()?.to_vec();
            let kind = d.uint()?;
            let target_leaf = d
                .opt_uint()?
                .map(u32::try_from)
                .transpose()
                .map_err(|_| crate::cbor::CborError::IntegerOverflow)?;
            let blob = d.bytes()?.to_vec();
            let void = d.uint()?;
            if void > 1 {
                return Err(crate::cbor::CborError::IntegerOverflow);
            }
            rows.push(ProposalItem {
                reference,
                kind,
                target_leaf,
                blob,
                void: void == 1,
            });
        }
        Ok(rows)
    })
    .map_err(|e| shape("proposals_body", e))
}

#[allow(dead_code)] // next_seq is part of the delivery-service body.
pub(crate) struct InfoBody {
    pub epoch: u64,
    pub group_info: Vec<u8>,
    pub tree_hash: [u8; 32],
    pub next_seq: u64,
}
pub(crate) struct TreeBody {
    pub epoch: u64,
    pub ratchet_tree: Vec<u8>,
    pub tree_hash: [u8; 32],
}
#[allow(dead_code)] // All Welcome metadata is decoded at the boundary.
pub(crate) struct WelcomeItem {
    pub welcome_id: u64,
    pub group_id: [u8; 16],
    pub epoch: u64,
    pub commit_seq: u64,
    pub blob: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
    pub tree_hash: [u8; 32],
}
pub(crate) struct ExpectedGroup {
    pub group_id: [u8; 16],
    pub community_id: Option<[u8; 16]>,
    pub channel_id: [u8; 16],
    pub policy_version: u64,
}
pub(crate) struct SendResponse {
    pub seq: u64,
    pub franking_tag: [u8; 32],
    pub recv_ts: u64,
}

pub(crate) struct SendRequest {
    pub ty: u64,
    pub reply_to: Option<[u8; 16]>,
    pub body: String,
    pub attachments: Vec<Attachment>,
    /// web3.7: the thread root the message joins; absent (a 4-element request) means none.
    pub thread_id: Option<[u8; 16]>,
}

/// `[type, reply_to b16|null, body, attachments]`, or since web3.7 the same with a fifth element,
/// `thread_id b16|null`. Any other length is malformed.
pub(crate) fn decode_send_request(bytes: &[u8]) -> Result<SendRequest, ClientError> {
    decode_strict(bytes, |d| {
        let len = d.array_len()?;
        if len != 4 && len != 5 {
            return Err(CborError::WrongArrayLen {
                expected: 5,
                actual: len,
            });
        }
        let ty = d.uint()?;
        let reply_to = d.opt_bytes_exact::<16>()?;
        let body = d.text()?.to_owned();
        let n = d.array_len()?;
        let mut attachments = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            d.array(9)?;
            attachments.push(Attachment {
                blob_id: d.bytes_exact::<32>()?,
                key: d.bytes_exact::<32>()?,
                nonce: d.bytes_exact::<12>()?,
                size: d.uint()?,
                mime: d.text()?.to_owned(),
                w: d.opt_uint()?,
                h: d.opt_uint()?,
                thumb: d.opt_bytes()?.map(<[u8]>::to_vec),
                name: d.text()?.to_owned(),
            });
        }
        let thread_id = if len == 5 {
            d.opt_bytes_exact::<16>()?
        } else {
            None
        };
        Ok(SendRequest {
            ty,
            reply_to,
            body,
            attachments,
            thread_id,
        })
    })
    .map_err(|_| ClientError::new(E_CORE_INPUT, "request is malformed"))
}

pub(crate) fn encode_attachment(a: &Attachment) -> Vec<u8> {
    let mut e = Encoder::new();
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
    e.into_vec()
}

pub(crate) fn encode_blob_ids(ids: &[[u8; 32]]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(ids.len());
    for id in ids {
        e.bytes(id);
    }
    e.into_vec()
}

pub(crate) fn decode_blob_ids(bytes: &[u8]) -> Result<Vec<[u8; 32]>, StorageError> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut ids = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            ids.push(d.bytes_exact::<32>()?);
        }
        Ok(ids)
    })
    .map_err(|_| StorageError::Codec("app_purges blob_ids do not decode".into()))
}

pub(crate) struct ReplyView {
    pub reply_to: [u8; 16],
    pub target_seq: Option<u64>,
    pub target_user: Option<[u8; 16]>,
    pub excerpt: String,
    pub state: u8,
    /// Fix round 1 (M3): the thread root of the quoted row when it shows in a thread.
    pub thread_root: Option<[u8; 16]>,
}
pub(crate) struct AttachmentView {
    pub size: u64,
    pub mime: String,
    pub w: Option<u64>,
    pub h: Option<u64>,
    pub has_thumb: bool,
    pub name: String,
}
pub(crate) struct TimelineView {
    pub seq: u64,
    pub epoch: u64,
    pub recv_ts: u64,
    pub status: u64,
    pub reason: String,
    pub sender_user: Option<Vec<u8>>,
    pub sender_device: Vec<u8>,
    pub sender_kind: Option<u64>,
    pub sender_tier: Option<u64>,
    pub msg_id: Option<Vec<u8>>,
    pub ty: Option<u64>,
    pub body: String,
    pub edited_seq: u64,
    pub reply: Option<ReplyView>,
    pub reactions: Vec<(String, u64, bool)>,
    pub pinned: bool,
    pub attachments: Vec<AttachmentView>,
    pub mention: bool,
    /// `(count, last_ts)` of a held thread root with at least one shown reply (web3.7).
    pub thread: Option<(u64, u64)>,
}
pub(crate) struct PinView {
    pub target_seq: u64,
    pub msg_id: [u8; 16],
    pub pinned_seq: u64,
    pub by_user: [u8; 16],
    pub author: Option<[u8; 16]>,
    pub excerpt: String,
    pub target_ts: u64,
    /// Fix round 1 (M3): the thread root of the pinned row when it shows in a thread.
    pub thread_root: Option<[u8; 16]>,
}

pub(crate) fn encode_timeline(rows: &[TimelineView]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for r in rows {
        timeline_row(&mut e, r);
    }
    e.into_vec()
}

/// `[root_row|null, [row…]]` (web3.7 R25): the held root, then the replies.
pub(crate) fn encode_thread_timeline(
    root: Option<&TimelineView>,
    rows: &[TimelineView],
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2);
    match root {
        Some(r) => timeline_row(&mut e, r),
        None => {
            e.null();
        }
    }
    e.array(rows.len());
    for r in rows {
        timeline_row(&mut e, r);
    }
    e.into_vec()
}

pub(crate) struct ThreadView {
    pub root: [u8; 16],
    pub root_seq: Option<u64>,
    pub count: u64,
    pub last_ts: u64,
    pub excerpt: String,
}

/// `[[root_msg_id b16, root_seq uint|null, count uint, last_ts uint, excerpt tstr]]` (web3.7).
pub(crate) fn encode_threads(rows: &[ThreadView]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for r in rows {
        e.array(5)
            .bytes(&r.root)
            .opt_uint(r.root_seq)
            .uint(r.count)
            .uint(r.last_ts)
            .text(&r.excerpt);
    }
    e.into_vec()
}

/// One 19-element timeline row (18 before web3.7; the 19th is the thread summary).
fn timeline_row(e: &mut Encoder, r: &TimelineView) {
    {
        e.array(19)
            .uint(r.seq)
            .uint(r.epoch)
            .uint(r.recv_ts)
            .uint(r.status)
            .text(&r.reason)
            .opt_bytes(r.sender_user.as_deref())
            .bytes(&r.sender_device)
            .opt_uint(r.sender_kind)
            .opt_uint(r.sender_tier)
            .opt_bytes(r.msg_id.as_deref())
            .opt_uint(r.ty)
            .text(&r.body)
            .uint(r.edited_seq);
        if let Some(reply) = &r.reply {
            e.array(6)
                .bytes(&reply.reply_to)
                .opt_uint(reply.target_seq)
                .opt_bytes(reply.target_user.as_ref().map(|u| u.as_slice()))
                .text(&reply.excerpt)
                .uint(u64::from(reply.state))
                .opt_bytes(reply.thread_root.as_ref().map(|t| t.as_slice()));
        } else {
            e.null();
        }
        e.array(r.reactions.len());
        for (emoji, count, mine) in &r.reactions {
            e.array(3).text(emoji).uint(*count).uint(u64::from(*mine));
        }
        e.uint(u64::from(r.pinned)).array(r.attachments.len());
        for (i, a) in r.attachments.iter().enumerate() {
            e.array(7)
                .uint(i as u64)
                .uint(a.size)
                .text(&a.mime)
                .opt_uint(a.w)
                .opt_uint(a.h)
                .uint(u64::from(a.has_thumb))
                .text(&a.name);
        }
        e.uint(u64::from(r.mention));
        match r.thread {
            Some((count, last_ts)) => {
                e.array(2).uint(count).uint(last_ts);
            }
            None => {
                e.null();
            }
        }
    }
}

pub(crate) fn encode_pins(rows: &[PinView]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for r in rows {
        e.array(8)
            .uint(r.target_seq)
            .bytes(&r.msg_id)
            .uint(r.pinned_seq)
            .bytes(&r.by_user)
            .opt_bytes(r.author.as_ref().map(|u| u.as_slice()))
            .text(&r.excerpt)
            .uint(r.target_ts)
            .opt_bytes(r.thread_root.as_ref().map(|t| t.as_slice()));
    }
    e.into_vec()
}

fn shape(arg: &str, error: impl core::fmt::Display) -> ClientError {
    ClientError::new(E_CORE_INPUT, format!("{arg}: {error}"))
}

/// An empty vector for `claimed` decoded elements whose up-front reservation never exceeds the
/// `remaining` input bytes. `Decoder::array_len` bounds the count by the input, not by the input
/// divided by an element's size (`cbor/dec.rs` `array_len`: a caller must not scale it into a
/// larger allocation); the vector grows past this only as elements actually decode.
fn reserve<T>(claimed: usize, remaining: usize) -> Vec<T> {
    Vec::with_capacity(claimed.min(remaining / core::mem::size_of::<T>().max(1)))
}

pub(crate) fn decode_handshake_rows(bytes: &[u8]) -> Result<Vec<HandshakeRow>, ClientError> {
    let rows = decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            d.array(5)?;
            rows.push((
                d.uint()?,
                d.uint()?,
                d.uint()?,
                d.opt_uint()?,
                d.bytes()?.to_vec(),
            ));
        }
        Ok(rows)
    })
    .map_err(|e| shape("handshakes", e))?;
    rows.into_iter()
        .map(|(seq, epoch, kind, sender, blob)| {
            if kind > 2 {
                return Err(shape("handshakes", format!("kind {kind} at seq {seq}")));
            }
            let sender = sender
                .map(|s| {
                    u32::try_from(s).map_err(|_| {
                        shape(
                            "handshakes",
                            format!("sender leaf out of range at seq {seq}"),
                        )
                    })
                })
                .transpose()?;
            Ok(HandshakeRow {
                seq,
                epoch,
                kind: kind as u8,
                sender,
                blob,
            })
        })
        .collect()
}

pub(crate) fn decode_message_rows(bytes: &[u8]) -> Result<Vec<MessageRow>, ClientError> {
    let rows = decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            // Nine elements since web3.7, the ninth the upload class (uint or null); eight from a
            // host that predates it. Any other length is a shape error.
            let len = d.array_len()?;
            if len != 8 && len != 9 {
                return Err(CborError::WrongArrayLen {
                    expected: 9,
                    actual: len,
                });
            }
            rows.push((
                d.uint()?,
                d.uint()?,
                d.bytes_exact::<16>()?,
                d.opt_bytes()?.map(<[u8]>::to_vec),
                d.opt_bytes_exact::<32>()?,
                d.bytes_exact::<32>()?,
                d.uint()?,
                d.uint()?,
                if len == 9 { d.opt_uint()? } else { None },
            ));
        }
        Ok(rows)
    })
    .map_err(|e| shape("messages", e))?;
    rows.into_iter()
        .map(
            |(
                seq,
                epoch,
                uploader_device,
                blob,
                commitment,
                franking_tag,
                recv_ts,
                deleted,
                class,
            )| {
                if deleted > 1 {
                    return Err(shape("messages", format!("deleted {deleted} at seq {seq}")));
                }
                if class.is_some_and(|c| c > 1) {
                    return Err(shape("messages", format!("class {class:?} at seq {seq}")));
                }
                Ok(MessageRow {
                    seq,
                    epoch,
                    uploader_device,
                    blob,
                    commitment,
                    franking_tag,
                    recv_ts,
                    deleted: deleted == 1,
                    class,
                })
            },
        )
        .collect()
}

pub(crate) fn decode_info_body(bytes: &[u8]) -> Result<InfoBody, ClientError> {
    decode_strict(bytes, |d| {
        d.array(4)?;
        Ok(InfoBody {
            epoch: d.uint()?,
            group_info: d.bytes()?.to_vec(),
            tree_hash: d.bytes_exact()?,
            next_seq: d.uint()?,
        })
    })
    .map_err(|e| shape("info_body", e))
}
pub(crate) fn decode_tree_body(bytes: &[u8]) -> Result<TreeBody, ClientError> {
    decode_strict(bytes, |d| {
        d.array(3)?;
        Ok(TreeBody {
            epoch: d.uint()?,
            ratchet_tree: d.bytes()?.to_vec(),
            tree_hash: d.bytes_exact()?,
        })
    })
    .map_err(|e| shape("tree_body", e))
}
pub(crate) fn decode_welcomes_body(bytes: &[u8]) -> Result<Vec<WelcomeItem>, ClientError> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut v = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            d.array(7)?;
            v.push(WelcomeItem {
                welcome_id: d.uint()?,
                group_id: d.bytes_exact()?,
                epoch: d.uint()?,
                commit_seq: d.uint()?,
                blob: d.bytes()?.to_vec(),
                ratchet_tree: d.bytes()?.to_vec(),
                tree_hash: d.bytes_exact()?,
            });
        }
        Ok(v)
    })
    .map_err(|e| shape("welcomes_body", e))
}
pub(crate) fn decode_expected(bytes: &[u8]) -> Result<Vec<ExpectedGroup>, ClientError> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut v = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            d.array(4)?;
            v.push(ExpectedGroup {
                group_id: d.bytes_exact()?,
                community_id: d.opt_bytes_exact()?,
                channel_id: d.bytes_exact()?,
                policy_version: d.uint()?,
            });
        }
        Ok(v)
    })
    .map_err(|e| shape("expected", e))
}
pub(crate) fn decode_send_response(bytes: &[u8]) -> Result<SendResponse, ClientError> {
    decode_strict(bytes, |d| {
        d.array(3)?;
        Ok(SendResponse {
            seq: d.uint()?,
            franking_tag: d.bytes_exact()?,
            recv_ts: d.uint()?,
        })
    })
    .map_err(|e| shape("response", e))
}
pub(crate) fn encode_apply_result(r: &ApplyResult) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(6)
        .uint(u64::from(r.state))
        .uint(r.epoch)
        .uint(r.next_seq)
        .array(r.new_seqs.len());
    for seq in &r.new_seqs {
        e.uint(*seq);
    }
    e.uint(r.proposals_pending).uint(u64::from(r.flags));
    e.into_vec()
}
pub(crate) fn protocol_message(blob: &[u8]) -> Result<ProtocolMessage, ClientError> {
    MlsMessageIn::tls_deserialize_exact(blob)
        .ok()
        .and_then(|m| m.try_into_protocol_message().ok())
        .ok_or_else(|| ClientError::new(E_CORE_MLS, "not an MLS protocol message"))
}
/// The commitment `C` a `PrivateMessage` blob carries as its 32-byte `authenticated_data`
/// (protocol/04; unverified, as the delivery service reads it); `None` for anything else.
pub(crate) fn blob_commitment(blob: &[u8]) -> Option<[u8; 32]> {
    match MlsMessageIn::tls_deserialize_exact(blob)
        .ok()?
        .try_into_protocol_message()
        .ok()?
    {
        ProtocolMessage::PrivateMessage(p) => p.aad().try_into().ok(),
        ProtocolMessage::PublicMessage(_) => None,
    }
}
pub(crate) fn tls<T: tls_codec::Serialize>(v: &T) -> Result<Vec<u8>, ClientError> {
    v.tls_serialize_detached()
        .map_err(|_| ClientError::new(E_CORE_MLS, "TLS serialization failed"))
}

pub(crate) fn identity_info(
    phase: u64,
    instance: Option<&[u8; 16]>,
    user: Option<&[u8; 16]>,
    device: Option<&[u8; 16]>,
    username: &str,
    published: bool,
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(6)
        .uint(phase)
        .opt_bytes(instance.map(|x| x.as_slice()))
        .opt_bytes(user.map(|x| x.as_slice()))
        .opt_bytes(device.map(|x| x.as_slice()))
        .text(username)
        .uint(u64::from(published));
    e.into_vec()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn account_body(
    invite: &str,
    username: &str,
    display: &str,
    umk_pub: &[u8; 32],
    ssk_pub: &[u8; 32],
    sig: &[u8; 64],
    password: Option<&str>,
    device: &[u8; 16],
    dsk_pub: &[u8; 32],
    credential: &[u8],
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(8)
        .text(invite)
        .text(username)
        .text(display)
        .bytes(umk_pub)
        .bytes(ssk_pub)
        .bytes(sig);
    match password {
        Some(s) => {
            e.text(s);
        }
        None => {
            e.null();
        }
    }
    e.array(5)
        .bytes(device)
        .bytes(dsk_pub)
        .uint(1)
        .uint(1)
        .bytes(credential);
    e.into_vec()
}

pub(crate) fn device_list_put_body(list: &DeviceList) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(4)
        .uint(list.unsigned.version)
        .bytes(&list.encode())
        .bytes(&list.sig_ssk)
        .bytes(&list.unsigned.prev_hash);
    e.into_vec()
}

/// enrol_complete and device_list_revoke: `[device_list_put_body, state_sealed, interrupted|null]`,
/// the third the PUT body of an interrupted publication to send first (BACKUPS-RECOVERY-02).
pub(crate) fn signed_lists(put: &[u8], state: &[u8], interrupted: Option<&[u8]>) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(3).bytes(put).bytes(state);
    match interrupted {
        Some(body) => e.bytes(body),
        None => e.null(),
    };
    e.into_vec()
}

pub(crate) fn bytes_pair(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).bytes(a).bytes(b);
    e.into_vec()
}

pub(crate) fn enrol_session_body(
    nonce: &[u8; 32],
    sig: &[u8],
    device_id: &[u8; 16],
    dsk_pub: &[u8; 32],
    placeholder: &[u8],
    login: &[u8],
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(5)
        .bytes(nonce)
        .uint(0)
        .bytes(sig)
        .array(5)
        .bytes(device_id)
        .bytes(dsk_pub)
        .uint(1)
        .uint(1)
        .bytes(placeholder)
        .bytes(login);
    e.into_vec()
}

pub(crate) fn list_status(version: u64, listed: bool) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).uint(version).uint(u64::from(listed));
    e.into_vec()
}

pub(crate) fn own_device_list(
    version: u64,
    published: bool,
    entries: &[crate::identity::DeviceEntry],
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(3)
        .uint(version)
        .uint(u64::from(published))
        .array(entries.len());
    for entry in entries {
        e.array(5)
            .bytes(entry.device_id.as_bytes())
            .bytes(&entry.dsk_pub)
            .uint(u64::from(entry.tier.as_u8()))
            .uint(entry.added_at)
            .opt_uint(entry.revoked_at);
    }
    e.into_vec()
}

pub(crate) struct ServedList {
    pub version: u64,
    pub blob: Vec<u8>,
    pub ssk_signature: [u8; 64],
    pub prev_hash: [u8; 32],
}

fn served_row(d: &mut crate::cbor::Decoder<'_>) -> Result<ServedList, crate::cbor::CborError> {
    d.array(4)?;
    Ok(ServedList {
        version: d.uint()?,
        blob: d.bytes()?.to_vec(),
        ssk_signature: d.bytes_exact()?,
        prev_hash: d.bytes_exact()?,
    })
}

pub(crate) fn decode_device_list_body(bytes: &[u8]) -> Result<ServedList, crate::cbor::CborError> {
    decode_strict(bytes, served_row)
}

pub(crate) fn decode_history_body(bytes: &[u8]) -> Result<Vec<ServedList>, crate::cbor::CborError> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            rows.push(served_row(d)?);
        }
        Ok(rows)
    })
}

pub(crate) fn session_body(nonce: &[u8; 32], purpose: u8, sig: &[u8]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(5)
        .bytes(nonce)
        .uint(u64::from(purpose))
        .bytes(sig)
        .null()
        .null();
    e.into_vec()
}

pub(crate) fn session_value(record: Option<(&str, u64, u64)>) -> Vec<u8> {
    let mut e = Encoder::new();
    match record {
        Some((token, expires, idle)) => {
            e.array(3).text(token).uint(expires).uint(idle);
        }
        None => {
            e.null();
        }
    }
    e.into_vec()
}

pub(crate) fn key_packages_body(packages: &[Vec<u8>], last: Option<&[u8]>) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).array(packages.len());
    for p in packages {
        e.bytes(p);
    }
    e.opt_bytes(last);
    e.into_vec()
}

pub(crate) fn sealed_objects(
    root: Option<&[u8]>,
    state: Option<&[u8]>,
    state_uploaded: bool,
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(3)
        .opt_bytes(root)
        .opt_bytes(state)
        .uint(u64::from(state_uploaded));
    e.into_vec()
}

#[cfg(test)]
mod proposal_limit_tests {
    use super::*;

    #[test]
    fn oversized_proposal_body_is_refused_before_copying_rows() {
        let mut over_count = Encoder::new();
        over_count.array(1025);
        for _ in 0..1025 {
            over_count
                .array(5)
                .bytes(&[])
                .uint(0)
                .null()
                .bytes(&[])
                .uint(0);
        }
        assert_eq!(
            decode_proposals_body(&over_count.into_vec())
                .err()
                .unwrap()
                .code,
            "E_CORE_LIMIT"
        );
        let mut oversized = Encoder::new();
        oversized
            .array(1)
            .array(5)
            .bytes(&[])
            .uint(0)
            .null()
            .bytes(&vec![0; 4 * 1024 * 1024])
            .uint(0);
        assert_eq!(
            decode_proposals_body(&oversized.into_vec())
                .err()
                .unwrap()
                .code,
            "E_CORE_LIMIT"
        );
    }
}

#[cfg(test)]
mod message_row_tests {
    use super::*;

    /// One messages row: the eight elements of web3.6, then `class` when `ninth` is `Some`
    /// (`Some(None)` writes a null ninth).
    fn rows(ninth: Option<Option<u64>>, tenth: bool) -> Vec<u8> {
        let mut e = Encoder::new();
        let len = 8 + usize::from(ninth.is_some()) + usize::from(tenth);
        e.array(1)
            .array(len)
            .uint(5)
            .uint(2)
            .bytes(&[8; 16])
            .bytes(&[1, 2, 3])
            .null()
            .bytes(&[10; 32])
            .uint(1_758_659_700)
            .uint(0);
        if let Some(class) = ninth {
            e.opt_uint(class);
        }
        if tenth {
            e.uint(0);
        }
        e.into_vec()
    }

    #[test]
    fn a_nine_element_row_carries_its_class() {
        let row = &decode_message_rows(&rows(Some(Some(0)), false)).expect("nine")[0];
        assert_eq!((row.seq, row.class), (5, Some(0)));
        let row = &decode_message_rows(&rows(Some(Some(1)), false)).expect("nine")[0];
        assert_eq!(row.class, Some(1));
    }

    #[test]
    fn an_eight_element_row_or_a_null_class_is_legacy() {
        let row = &decode_message_rows(&rows(None, false)).expect("eight")[0];
        assert_eq!((row.seq, row.recv_ts, row.class), (5, 1_758_659_700, None));
        let row = &decode_message_rows(&rows(Some(None), false)).expect("null ninth")[0];
        assert_eq!(row.class, None);
    }

    #[test]
    fn ten_elements_or_a_class_of_two_is_a_shape_error() {
        let code = |b: Vec<u8>| decode_message_rows(&b).err().map(|e| e.code);
        assert_eq!(code(rows(Some(Some(0)), true)), Some(E_CORE_INPUT));
        assert_eq!(code(rows(Some(Some(2)), false)), Some(E_CORE_INPUT));
    }
}
