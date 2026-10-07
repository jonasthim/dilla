//! Deterministic CBOR values returned by the client and sent to the delivery service.

use super::ClientError;
use super::error::{E_CORE_INPUT, E_CORE_MLS};
use crate::cbor::{Encoder, decode_strict};
use crate::identity::DeviceList;
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
    let rows = decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut rows = reserve(n, bytes.len() - d.position());
        for _ in 0..n {
            d.array(5)?;
            rows.push((
                d.bytes()?.to_vec(),
                d.uint()?,
                d.opt_uint()?,
                d.bytes()?.to_vec(),
                d.uint()?,
            ));
        }
        Ok(rows)
    })
    .map_err(|e| shape("proposals_body", e))?;
    rows.into_iter()
        .map(|(reference, kind, target_leaf, blob, void)| {
            let target_leaf = target_leaf
                .map(|v| {
                    u32::try_from(v)
                        .map_err(|_| shape("proposals_body", "target leaf out of range"))
                })
                .transpose()?;
            if void > 1 {
                return Err(shape("proposals_body", format!("void {void}")));
            }
            Ok(ProposalItem {
                reference,
                kind,
                target_leaf,
                blob,
                void: void == 1,
            })
        })
        .collect()
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

pub(crate) struct ReplyView {
    pub reply_to: [u8; 16],
    pub target_seq: Option<u64>,
    pub target_user: Option<[u8; 16]>,
    pub excerpt: String,
    pub state: u8,
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
}
pub(crate) struct PinView {
    pub target_seq: u64,
    pub msg_id: [u8; 16],
    pub pinned_seq: u64,
    pub by_user: [u8; 16],
    pub author: Option<[u8; 16]>,
    pub excerpt: String,
    pub target_ts: u64,
}

pub(crate) fn encode_timeline(rows: &[TimelineView]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for r in rows {
        e.array(18)
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
            e.array(5)
                .bytes(&reply.reply_to)
                .opt_uint(reply.target_seq)
                .opt_bytes(reply.target_user.as_ref().map(|u| u.as_slice()))
                .text(&reply.excerpt)
                .uint(u64::from(reply.state));
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
    }
    e.into_vec()
}

pub(crate) fn encode_pins(rows: &[PinView]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(rows.len());
    for r in rows {
        e.array(7)
            .uint(r.target_seq)
            .bytes(&r.msg_id)
            .uint(r.pinned_seq)
            .bytes(&r.by_user)
            .opt_bytes(r.author.as_ref().map(|u| u.as_slice()))
            .text(&r.excerpt)
            .uint(r.target_ts);
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
            d.array(8)?;
            rows.push((
                d.uint()?,
                d.uint()?,
                d.bytes_exact::<16>()?,
                d.opt_bytes()?.map(<[u8]>::to_vec),
                d.opt_bytes_exact::<32>()?,
                d.bytes_exact::<32>()?,
                d.uint()?,
                d.uint()?,
            ));
        }
        Ok(rows)
    })
    .map_err(|e| shape("messages", e))?;
    rows.into_iter()
        .map(
            |(seq, epoch, uploader_device, blob, commitment, franking_tag, recv_ts, deleted)| {
                if deleted > 1 {
                    return Err(shape("messages", format!("deleted {deleted} at seq {seq}")));
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
