//! Strict deterministic-CBOR codecs for the built-in bot protocol.
//!
//! This module is deliberately structural: it validates the wire contract and explicit
//! authenticated context, while dispatchers remain responsible for authorization and state.

use crate::cbor::{CborError, Decoder, Encoder, decode_strict};
use crate::ids::{ChannelId, CommunityId, DeviceId, MsgId, UserId};

pub const BODY_PREFIX: &str = "dilla.bot/1:";
pub const APP_BODY_MAX: usize = 4000;
const APP_CBOR_MAX: usize = (APP_BODY_MAX - BODY_PREFIX.len()) * 3 / 4;
pub const EVENT_MAX: usize = 4096;
pub const RECEIPT_MAX: usize = 512;
pub const HELPER_MAX: usize = 1_048_576;
pub const HELPER_PAYLOAD_MAX: usize = 1_048_480;

/// Sanitized, stable bot-codec failure categories. No variant retains caller data.
#[derive(Clone, Copy, PartialEq, Eq, Debug, thiserror::Error)]
pub enum CodecError {
    #[error("E_BOT_FORMAT")]
    Format,
    #[error("E_BOT_CONTEXT")]
    Context,
    #[error("E_BOT_EXPIRED")]
    Expired,
    #[error("E_BOT_LIMIT")]
    Limit,
    #[error("E_BOT_OPERATION")]
    Operation,
    #[error("E_BOT_VALUE")]
    Value,
}

impl From<CborError> for CodecError {
    fn from(_: CborError) -> Self {
        Self::Format
    }
}

fn nonzero<const N: usize>(bytes: [u8; N]) -> Result<[u8; N], CodecError> {
    if bytes.iter().all(|b| *b == 0) {
        Err(CodecError::Value)
    } else {
        Ok(bytes)
    }
}

fn read_msg(d: &mut Decoder<'_>) -> Result<MsgId, CborError> {
    Ok(MsgId::from_bytes(d.bytes_exact::<16>()?))
}
fn read_comm(d: &mut Decoder<'_>) -> Result<CommunityId, CborError> {
    Ok(CommunityId::from_bytes(d.bytes_exact::<16>()?))
}
fn read_channel(d: &mut Decoder<'_>) -> Result<ChannelId, CborError> {
    Ok(ChannelId::from_bytes(d.bytes_exact::<16>()?))
}
fn read_user(d: &mut Decoder<'_>) -> Result<UserId, CborError> {
    Ok(UserId::from_bytes(d.bytes_exact::<16>()?))
}
fn read_device(d: &mut Decoder<'_>) -> Result<DeviceId, CborError> {
    Ok(DeviceId::from_bytes(d.bytes_exact::<16>()?))
}
fn check_root_array(bytes: &[u8]) -> Result<(), CodecError> {
    if bytes.first().is_none_or(|b| b >> 5 != 4) {
        return Err(CodecError::Format);
    }
    decode_strict(bytes, |d| {
        d.skip()?;
        Ok(())
    })
    .map_err(Into::into)
}
fn bounded_bytes(
    d: &mut Decoder<'_>,
    min: usize,
    max: usize,
    nested: bool,
) -> Result<Vec<u8>, CborError> {
    let b = d.bytes()?;
    if b.len() < min || b.len() > max {
        return Err(CborError::WrongByteLen {
            expected: max,
            actual: b.len(),
        });
    }
    if nested {
        check_root_array(b).map_err(|_| CborError::TypeMismatch {
            expected: "array bytes",
            offset: d.position(),
        })?;
    }
    Ok(b.to_vec())
}
fn bounded_text(
    d: &mut Decoder<'_>,
    min: usize,
    max: usize,
    clean: bool,
) -> Result<String, CborError> {
    let s = d.text()?;
    if s.len() < min
        || s.len() > max
        || (clean && (s.trim().is_empty() || s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')))
    {
        return Err(CborError::TypeMismatch {
            expected: "bounded text",
            offset: d.position(),
        });
    }
    Ok(s.to_owned())
}
fn check_id16(b: &[u8; 16]) -> Result<(), CodecError> {
    nonzero(*b).map(|_| ())
}

#[derive(Clone, PartialEq, Eq)]
pub enum RequestArgs {
    None,
    Section {
        section: u64,
    },
    SettingsPut {
        section: u64,
        document: Vec<u8>,
    },
    Text(String),
    Number(u64),
    Id(MsgId),
    Move {
        item: MsgId,
        before: Option<MsgId>,
    },
    AnnouncementPut {
        schedule: Option<MsgId>,
        document: Vec<u8>,
    },
    Evidence {
        action: MsgId,
        reason: String,
        excerpt: String,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub struct Request {
    pub request_id: MsgId,
    pub community_id: CommunityId,
    pub channel_id: Option<ChannelId>,
    pub operation: u64,
    pub revision: Option<u64>,
    pub expires: Option<u64>,
    pub args: RequestArgs,
}

impl Request {
    pub fn encode_cbor(&self) -> Result<Vec<u8>, CodecError> {
        self.validate_shape()?;
        let mut e = Encoder::new();
        e.array(8)
            .uint(1)
            .bytes(self.request_id.as_bytes())
            .bytes(self.community_id.as_bytes())
            .opt_bytes(
                self.channel_id
                    .as_ref()
                    .map(ChannelId::as_bytes)
                    .map(|x| x.as_slice()),
            )
            .uint(self.operation)
            .opt_uint(self.revision)
            .opt_uint(self.expires);
        encode_args(&mut e, &self.args);
        bounded_body(e.into_vec())
    }
    pub fn encode_body(&self) -> Result<String, CodecError> {
        let body = format!("{BODY_PREFIX}{}", b64url_encode(&self.encode_cbor()?));
        if body.len() > APP_BODY_MAX {
            Err(CodecError::Limit)
        } else {
            Ok(body)
        }
    }
    pub fn decode_body(body: &[u8]) -> Result<Self, CodecError> {
        if body.len() > APP_BODY_MAX || !body.starts_with(BODY_PREFIX.as_bytes()) {
            return Err(CodecError::Limit);
        }
        let raw = b64url_decode(&body[BODY_PREFIX.len()..])?;
        Self::decode_cbor(&raw)
    }
    pub fn decode_cbor(bytes: &[u8]) -> Result<Self, CodecError> {
        check_body_len(bytes.len())?;
        decode_strict(bytes, |d| {
            d.array(8)?;
            let version = d.uint()?;
            let request_id = read_msg(d)?;
            let community_id = read_comm(d)?;
            let channel_id = d.opt_bytes_exact::<16>()?.map(ChannelId::from_bytes);
            let operation = d.uint()?;
            let revision = d.opt_uint()?;
            let expires = d.opt_uint()?;
            let args = decode_args(d, operation)?;
            if version != 1 {
                return Err(CborError::TypeMismatch {
                    expected: "version",
                    offset: 0,
                });
            }
            Ok(Self {
                request_id,
                community_id,
                channel_id,
                operation,
                revision,
                expires,
                args,
            })
        })
        .map_err(Into::into)
        .and_then(|v| {
            v.validate_shape()?;
            Ok(v)
        })
    }
    pub fn validate_context(
        &self,
        expected_community: CommunityId,
        now: u64,
    ) -> Result<(), CodecError> {
        if self.community_id != expected_community {
            return Err(CodecError::Context);
        }
        if is_mutation(self.operation) {
            let expiry = self.expires.ok_or(CodecError::Value)?;
            let upper = now.checked_add(30).ok_or(CodecError::Expired)?;
            if expiry <= now || expiry > upper {
                return Err(CodecError::Expired);
            }
        }
        Ok(())
    }
    fn validate_shape(&self) -> Result<(), CodecError> {
        check_id16(self.request_id.as_bytes())?;
        check_id16(self.community_id.as_bytes())?;
        if let Some(ch) = self.channel_id {
            check_id16(ch.as_bytes())?;
        }
        let expects_channel = matches!(self.operation, 10..=23);
        if expects_channel != self.channel_id.is_some() {
            return Err(CodecError::Value);
        }
        let mutation = is_mutation(self.operation);
        if mutation != (self.revision.is_some() && self.expires.is_some()) {
            return Err(CodecError::Value);
        }
        if self.revision.is_some() != self.expires.is_some() {
            return Err(CodecError::Value);
        }
        if !matches!(self.operation, 0|1|2|10..=23|30|40|50..=52|60|61) {
            return Err(CodecError::Operation);
        }
        if !args_match(self.operation, &self.args) {
            return Err(CodecError::Value);
        }
        match &self.args {
            RequestArgs::SettingsPut { document, .. } => {
                if document.is_empty() || document.len() > 2400 {
                    return Err(CodecError::Limit);
                }
                check_root_array(document)?;
            }
            RequestArgs::AnnouncementPut { schedule, document } => {
                if document.is_empty() || document.len() > 2200 {
                    return Err(CodecError::Limit);
                }
                check_root_array(document)?;
                if let Some(id) = schedule {
                    check_id16(id.as_bytes())?;
                }
            }
            RequestArgs::Id(id) => check_id16(id.as_bytes())?,
            RequestArgs::Move { item, before } => {
                check_id16(item.as_bytes())?;
                if let Some(id) = before {
                    check_id16(id.as_bytes())?;
                }
            }
            RequestArgs::Evidence { action, .. } => check_id16(action.as_bytes())?,
            _ => {}
        }
        Ok(())
    }
}

fn is_mutation(op: u64) -> bool {
    matches!(op, 2 | 12..=23 | 51 | 52 | 61)
}
fn args_match(op: u64, a: &RequestArgs) -> bool {
    match op {
        0 | 10 | 13..=16 | 19 | 23 => matches!(a, RequestArgs::None),
        1 => matches!(a, RequestArgs::Section { section: 0..=5 }),
        2 => matches!(a, RequestArgs::SettingsPut { section: 0..=5, .. }),
        11 => matches!(a,RequestArgs::Text(s) if text_valid(s,1,200,true)),
        12 => matches!(a,RequestArgs::Text(s) if text_valid(s,1,2048,true)),
        17 => matches!(a, RequestArgs::Number(_)),
        18 => matches!(a, RequestArgs::Number(0..=100)),
        20 => matches!(a, RequestArgs::Number(0..=2)),
        21 => matches!(a, RequestArgs::Id(_)),
        22 => matches!(a, RequestArgs::Move { .. }),
        30 => matches!(a,RequestArgs::Text(s) if text_valid(s,1,2000,false)),
        40 | 50 | 60 => matches!(a, RequestArgs::Number(_)),
        51 => matches!(a, RequestArgs::AnnouncementPut { .. }),
        52 => matches!(a, RequestArgs::Id(_)),
        61 => {
            matches!(a,RequestArgs::Evidence{reason,excerpt,..} if reason.len()<=1024 && excerpt.len()<=512)
        }
        _ => false,
    }
}
fn text_valid(s: &str, min: usize, max: usize, clean: bool) -> bool {
    s.len() >= min
        && s.len() <= max
        && (!clean || (!s.trim().is_empty() && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')))
}
fn encode_args(e: &mut Encoder, a: &RequestArgs) {
    match a {
        RequestArgs::None => {
            e.array(0);
        }
        RequestArgs::Section { section } => {
            e.array(1).uint(*section);
        }
        RequestArgs::SettingsPut { section, document } => {
            e.array(2).uint(*section).bytes(document);
        }
        RequestArgs::Text(s) => {
            e.array(1).text(s);
        }
        RequestArgs::Number(n) => {
            e.array(1).uint(*n);
        }
        RequestArgs::Id(id) => {
            e.array(1).bytes(id.as_bytes());
        }
        RequestArgs::Move { item, before } => {
            e.array(2)
                .bytes(item.as_bytes())
                .opt_bytes(before.as_ref().map(MsgId::as_bytes).map(|x| x.as_slice()));
        }
        RequestArgs::AnnouncementPut { schedule, document } => {
            e.array(2)
                .opt_bytes(schedule.as_ref().map(MsgId::as_bytes).map(|x| x.as_slice()))
                .bytes(document);
        }
        RequestArgs::Evidence {
            action,
            reason,
            excerpt,
        } => {
            e.array(3)
                .bytes(action.as_bytes())
                .text(reason)
                .text(excerpt);
        }
    }
}
fn decode_args(d: &mut Decoder<'_>, op: u64) -> Result<RequestArgs, CborError> {
    let typeerr = || CborError::TypeMismatch {
        expected: "operation args",
        offset: d.position(),
    };
    Ok(match op {
        0 | 10 | 13..=16 | 19 | 23 => {
            d.array(0)?;
            RequestArgs::None
        }
        1 => {
            d.array(1)?;
            RequestArgs::Section { section: d.uint()? }
        }
        2 => {
            d.array(2)?;
            RequestArgs::SettingsPut {
                section: d.uint()?,
                document: bounded_bytes(d, 1, 2400, true)?,
            }
        }
        11 | 12 | 30 => {
            d.array(1)?;
            let (lo, hi, clean) = if op == 11 {
                (1, 200, true)
            } else if op == 12 {
                (1, 2048, true)
            } else {
                (1, 2000, false)
            };
            RequestArgs::Text(bounded_text(d, lo, hi, clean)?)
        }
        17 | 18 | 20 | 40 | 50 | 60 => {
            d.array(1)?;
            RequestArgs::Number(d.uint()?)
        }
        21 | 52 => {
            d.array(1)?;
            RequestArgs::Id(read_msg(d)?)
        }
        22 => {
            d.array(2)?;
            RequestArgs::Move {
                item: read_msg(d)?,
                before: d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes),
            }
        }
        51 => {
            d.array(2)?;
            RequestArgs::AnnouncementPut {
                schedule: d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes),
                document: bounded_bytes(d, 1, 2200, true)?,
            }
        }
        61 => {
            d.array(3)?;
            RequestArgs::Evidence {
                action: read_msg(d)?,
                reason: bounded_text(d, 0, 1024, false)?,
                excerpt: bounded_text(d, 0, 512, false)?,
            }
        }
        _ => return Err(typeerr()),
    })
}
fn check_body_len(len: usize) -> Result<(), CodecError> {
    if len > APP_CBOR_MAX {
        Err(CodecError::Limit)
    } else {
        Ok(())
    }
}
fn bounded_body(b: Vec<u8>) -> Result<Vec<u8>, CodecError> {
    check_body_len(b.len())?;
    Ok(b)
}

#[derive(Clone, PartialEq, Eq)]
pub struct Response {
    pub request_id: MsgId,
    pub community_id: CommunityId,
    pub status: u64,
    pub revision: Option<u64>,
    pub data: Vec<u8>,
}
impl Response {
    pub fn encode_cbor(&self) -> Result<Vec<u8>, CodecError> {
        check_id16(self.request_id.as_bytes())?;
        check_id16(self.community_id.as_bytes())?;
        if self.status > 9 || self.data.len() > 2400 {
            return Err(CodecError::Value);
        };
        if !self.data.is_empty() {
            check_root_array(&self.data)?;
        }
        let mut e = Encoder::new();
        e.array(6)
            .uint(1)
            .bytes(self.request_id.as_bytes())
            .bytes(self.community_id.as_bytes())
            .uint(self.status)
            .opt_uint(self.revision)
            .bytes(&self.data);
        bounded_body(e.into_vec())
    }
    pub fn encode_body(&self) -> Result<String, CodecError> {
        let body = format!("{BODY_PREFIX}{}", b64url_encode(&self.encode_cbor()?));
        if body.len() > APP_BODY_MAX {
            Err(CodecError::Limit)
        } else {
            Ok(body)
        }
    }
    pub fn decode_cbor(b: &[u8]) -> Result<Self, CodecError> {
        check_body_len(b.len())?;
        decode_strict(b, |d| {
            d.array(6)?;
            let version = d.uint()?;
            let request_id = read_msg(d)?;
            let community_id = read_comm(d)?;
            let status = d.uint()?;
            let revision = d.opt_uint()?;
            let data = bounded_bytes(d, 0, 2400, false)?;
            if version != 1 || status > 9 {
                return Err(CborError::TypeMismatch {
                    expected: "response",
                    offset: 0,
                });
            };
            if !data.is_empty() {
                check_root_array(&data).map_err(|_| CborError::TypeMismatch {
                    expected: "array data",
                    offset: 0,
                })?;
            }
            Ok(Self {
                request_id,
                community_id,
                status,
                revision,
                data,
            })
        })
        .map_err(Into::into)
        .and_then(|x| {
            check_id16(x.request_id.as_bytes())?;
            check_id16(x.community_id.as_bytes())?;
            Ok(x)
        })
    }
    pub fn decode_body(b: &[u8]) -> Result<Self, CodecError> {
        if b.len() > APP_BODY_MAX || !b.starts_with(BODY_PREFIX.as_bytes()) {
            return Err(CodecError::Limit);
        };
        Self::decode_cbor(&b64url_decode(&b[BODY_PREFIX.len()..])?)
    }
    pub fn validate_context(&self, expected: CommunityId) -> Result<(), CodecError> {
        if self.community_id == expected {
            Ok(())
        } else {
            Err(CodecError::Context)
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RemovalProof {
    pub request_id: MsgId,
    pub actor_user: UserId,
    pub actor_device: DeviceId,
    pub community_id: CommunityId,
    pub group_id: MsgId,
    pub target_seq: u64,
    pub expires: u64,
}
impl RemovalProof {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        self.validate()?;
        let mut e = Encoder::new();
        e.array(8)
            .uint(1)
            .bytes(self.request_id.as_bytes())
            .bytes(self.actor_user.as_bytes())
            .bytes(self.actor_device.as_bytes())
            .bytes(self.community_id.as_bytes())
            .bytes(self.group_id.as_bytes())
            .uint(self.target_seq)
            .uint(self.expires);
        Ok(e.into_vec())
    }
    pub fn decode(b: &[u8]) -> Result<Self, CodecError> {
        decode_strict(b, |d| {
            d.array(8)?;
            let v = d.uint()?;
            let x = Self {
                request_id: read_msg(d)?,
                actor_user: read_user(d)?,
                actor_device: read_device(d)?,
                community_id: read_comm(d)?,
                group_id: read_msg(d)?,
                target_seq: d.uint()?,
                expires: d.uint()?,
            };
            if v != 1 {
                return Err(CborError::TypeMismatch {
                    expected: "version",
                    offset: 0,
                });
            };
            Ok(x)
        })
        .map_err(Into::into)
        .and_then(|x| {
            x.validate()?;
            Ok(x)
        })
    }
    fn validate(&self) -> Result<(), CodecError> {
        for b in [
            self.request_id.as_bytes(),
            self.actor_user.as_bytes(),
            self.actor_device.as_bytes(),
            self.community_id.as_bytes(),
            self.group_id.as_bytes(),
        ] {
            check_id16(b)?;
        }
        if self.target_seq == 0 || self.expires == 0 {
            return Err(CodecError::Value);
        }
        Ok(())
    }
    pub fn signature_preimage(&self) -> Result<Vec<u8>, CodecError> {
        let mut p = b"dilla moderation removal v1".to_vec();
        p.extend(self.encode()?);
        Ok(p)
    }
    pub fn validate_context(
        &self,
        community: CommunityId,
        group: MsgId,
        actor: UserId,
        device: DeviceId,
        now: u64,
    ) -> Result<(), CodecError> {
        if self.community_id != community
            || self.group_id != group
            || self.actor_user != actor
            || self.actor_device != device
        {
            return Err(CodecError::Context);
        };
        if self.expires <= now || self.expires > now.checked_add(30).ok_or(CodecError::Expired)? {
            return Err(CodecError::Expired);
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum EventData {
    Member {
        user: UserId,
        episode: MsgId,
    },
    Installation {
        id: MsgId,
        state: u64,
        revision: u64,
    },
    Permission {
        target_kind: u64,
        target: MsgId,
        revision: u64,
    },
    Channel {
        id: ChannelId,
        change: u64,
        revision: u64,
    },
    Moderation {
        action_id: MsgId,
        request_id: MsgId,
        actor: UserId,
        device: DeviceId,
        target: Option<UserId>,
        group: Option<MsgId>,
        target_seq: Option<u64>,
        action: u64,
        expires: Option<u64>,
    },
    RolePanel {
        id: MsgId,
        revision: u64,
        active: u64,
    },
}
#[derive(Clone, PartialEq, Eq)]
pub struct Event {
    pub event_id: MsgId,
    pub sequence: u64,
    pub community_id: CommunityId,
    pub timestamp: u64,
    pub kind: u64,
    pub data: EventData,
}
impl Event {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        self.validate()?;
        let mut e = Encoder::new();
        e.array(7)
            .uint(1)
            .bytes(self.event_id.as_bytes())
            .uint(self.sequence)
            .bytes(self.community_id.as_bytes())
            .uint(self.timestamp)
            .uint(self.kind);
        encode_event_data(&mut e, &self.data);
        let b = e.into_vec();
        if b.len() > EVENT_MAX {
            return Err(CodecError::Limit);
        }
        Ok(b)
    }
    pub fn decode(b: &[u8]) -> Result<Self, CodecError> {
        if b.len() > EVENT_MAX {
            return Err(CodecError::Limit);
        };
        decode_strict(b, |d| {
            d.array(7)?;
            let v = d.uint()?;
            let event_id = read_msg(d)?;
            let sequence = d.uint()?;
            let community_id = read_comm(d)?;
            let timestamp = d.uint()?;
            let kind = d.uint()?;
            let data = decode_event_data(d, kind)?;
            if v != 1 {
                return Err(CborError::TypeMismatch {
                    expected: "version",
                    offset: 0,
                });
            };
            Ok(Self {
                event_id,
                sequence,
                community_id,
                timestamp,
                kind,
                data,
            })
        })
        .map_err(Into::into)
        .and_then(|x| {
            x.validate()?;
            Ok(x)
        })
    }
    fn validate(&self) -> Result<(), CodecError> {
        check_id16(self.event_id.as_bytes())?;
        check_id16(self.community_id.as_bytes())?;
        if self.sequence == 0 || !(1..=7).contains(&self.kind) {
            return Err(CodecError::Value);
        };
        if !event_matches(self.kind, &self.data, self.timestamp) {
            return Err(CodecError::Value);
        };
        if let EventData::Moderation { target, group, .. } = &self.data {
            if let Some(id) = target {
                check_id16(id.as_bytes())?;
            }
            if let Some(id) = group {
                check_id16(id.as_bytes())?;
            }
        }
        Ok(())
    }
    pub fn validate_context(&self, community: CommunityId) -> Result<(), CodecError> {
        if self.community_id == community {
            Ok(())
        } else {
            Err(CodecError::Context)
        }
    }
}
fn event_matches(k: u64, d: &EventData, t: u64) -> bool {
    match (k, d) {
        (1, EventData::Member { user, episode }) => {
            nonzero(*user.as_bytes()).is_ok() && nonzero(*episode.as_bytes()).is_ok()
        }
        (2, EventData::Member { user, episode }) => {
            nonzero(*user.as_bytes()).is_ok() && nonzero(*episode.as_bytes()).is_ok()
        }
        (3, EventData::Installation { id, state, .. }) => {
            nonzero(*id.as_bytes()).is_ok() && *state <= 5
        }
        (
            4,
            EventData::Permission {
                target_kind,
                target,
                ..
            },
        ) => *target_kind <= 3 && nonzero(*target.as_bytes()).is_ok(),
        (5, EventData::Channel { id, change, .. }) => {
            *change <= 2 && nonzero(*id.as_bytes()).is_ok()
        }
        (
            6,
            EventData::Moderation {
                action_id,
                request_id,
                actor,
                device,
                target,
                group,
                target_seq,
                action,
                expires,
            },
        ) => {
            let ids = nonzero(*action_id.as_bytes()).is_ok()
                && nonzero(*request_id.as_bytes()).is_ok()
                && nonzero(*actor.as_bytes()).is_ok()
                && nonzero(*device.as_bytes()).is_ok();
            if !ids || *action > 6 {
                return false;
            }
            if *action == 4 {
                group.is_some() && target_seq.is_some_and(|x| x > 0) && expires.is_none()
            } else {
                target.is_some()
                    && group.is_none()
                    && target_seq.is_none()
                    && if *action == 1 {
                        expires.is_some_and(|x| x > t)
                    } else if *action == 3 {
                        expires.is_none_or(|x| x > t)
                    } else {
                        expires.is_none()
                    }
            }
        }
        (7, EventData::RolePanel { id, active, .. }) => {
            nonzero(*id.as_bytes()).is_ok() && *active <= 1
        }
        _ => false,
    }
}
fn encode_event_data(e: &mut Encoder, d: &EventData) {
    match d {
        EventData::Member { user, episode } => {
            e.array(2).bytes(user.as_bytes()).bytes(episode.as_bytes());
        }
        EventData::Installation {
            id,
            state,
            revision,
        } => {
            e.array(3).bytes(id.as_bytes()).uint(*state).uint(*revision);
        }
        EventData::Permission {
            target_kind,
            target,
            revision,
        } => {
            e.array(3)
                .uint(*target_kind)
                .bytes(target.as_bytes())
                .uint(*revision);
        }
        EventData::Channel {
            id,
            change,
            revision,
        } => {
            e.array(3)
                .bytes(id.as_bytes())
                .uint(*change)
                .uint(*revision);
        }
        EventData::Moderation {
            action_id,
            request_id,
            actor,
            device,
            target,
            group,
            target_seq,
            action,
            expires,
        } => {
            e.array(9)
                .bytes(action_id.as_bytes())
                .bytes(request_id.as_bytes())
                .bytes(actor.as_bytes())
                .bytes(device.as_bytes())
                .opt_bytes(target.as_ref().map(UserId::as_bytes).map(|x| x.as_slice()))
                .opt_bytes(group.as_ref().map(MsgId::as_bytes).map(|x| x.as_slice()))
                .opt_uint(*target_seq)
                .uint(*action)
                .opt_uint(*expires);
        }
        EventData::RolePanel {
            id,
            revision,
            active,
        } => {
            e.array(3)
                .bytes(id.as_bytes())
                .uint(*revision)
                .uint(*active);
        }
    }
}
fn decode_event_data(d: &mut Decoder<'_>, k: u64) -> Result<EventData, CborError> {
    Ok(match k {
        1 | 2 => {
            d.array(2)?;
            EventData::Member {
                user: read_user(d)?,
                episode: read_msg(d)?,
            }
        }
        3 => {
            d.array(3)?;
            EventData::Installation {
                id: read_msg(d)?,
                state: d.uint()?,
                revision: d.uint()?,
            }
        }
        4 => {
            d.array(3)?;
            EventData::Permission {
                target_kind: d.uint()?,
                target: read_msg(d)?,
                revision: d.uint()?,
            }
        }
        5 => {
            d.array(3)?;
            EventData::Channel {
                id: read_channel(d)?,
                change: d.uint()?,
                revision: d.uint()?,
            }
        }
        6 => {
            d.array(9)?;
            EventData::Moderation {
                action_id: read_msg(d)?,
                request_id: read_msg(d)?,
                actor: read_user(d)?,
                device: read_device(d)?,
                target: d.opt_bytes_exact::<16>()?.map(UserId::from_bytes),
                group: d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes),
                target_seq: d.opt_uint()?,
                action: d.uint()?,
                expires: d.opt_uint()?,
            }
        }
        7 => {
            d.array(3)?;
            EventData::RolePanel {
                id: read_msg(d)?,
                revision: d.uint()?,
                active: d.uint()?,
            }
        }
        _ => {
            return Err(CborError::TypeMismatch {
                expected: "event kind",
                offset: d.position(),
            });
        }
    })
}

#[derive(Clone, PartialEq, Eq)]
pub struct Receipt {
    pub operation_id: MsgId,
    pub community_id: CommunityId,
    pub group_id: MsgId,
    pub ciphertext_sha256: [u8; 32],
    pub status: u64,
    pub sequence: Option<u64>,
    pub epoch: Option<u64>,
}
impl Receipt {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        self.validate()?;
        let mut e = Encoder::new();
        e.array(8)
            .uint(1)
            .bytes(self.operation_id.as_bytes())
            .bytes(self.community_id.as_bytes())
            .bytes(self.group_id.as_bytes())
            .bytes(&self.ciphertext_sha256)
            .uint(self.status)
            .opt_uint(self.sequence)
            .opt_uint(self.epoch);
        let b = e.into_vec();
        if b.len() > RECEIPT_MAX {
            Err(CodecError::Limit)
        } else {
            Ok(b)
        }
    }
    pub fn decode(b: &[u8]) -> Result<Self, CodecError> {
        if b.len() > RECEIPT_MAX {
            return Err(CodecError::Limit);
        };
        decode_strict(b, |d| {
            d.array(8)?;
            let v = d.uint()?;
            let x = Self {
                operation_id: read_msg(d)?,
                community_id: read_comm(d)?,
                group_id: read_msg(d)?,
                ciphertext_sha256: d.bytes_exact::<32>()?,
                status: d.uint()?,
                sequence: d.opt_uint()?,
                epoch: d.opt_uint()?,
            };
            if v != 1 {
                return Err(CborError::TypeMismatch {
                    expected: "version",
                    offset: 0,
                });
            };
            Ok(x)
        })
        .map_err(Into::into)
        .and_then(|x| {
            x.validate()?;
            Ok(x)
        })
    }
    fn validate(&self) -> Result<(), CodecError> {
        for b in [
            self.operation_id.as_bytes(),
            self.community_id.as_bytes(),
            self.group_id.as_bytes(),
        ] {
            check_id16(b)?;
        }
        if self.status == 0 && self.sequence.is_none() && self.epoch.is_none()
            || self.status == 1 && self.sequence.is_some_and(|s| s > 0) && self.epoch.is_some()
        {
            Ok(())
        } else {
            Err(CodecError::Value)
        }
    }
    pub fn validate_context(&self, c: CommunityId, g: MsgId) -> Result<(), CodecError> {
        if self.community_id == c && self.group_id == g {
            Ok(())
        } else {
            Err(CodecError::Context)
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct HelperRequest {
    pub request_id: MsgId,
    pub operation: u64,
    pub payload: Vec<u8>,
}
#[derive(Clone, PartialEq, Eq)]
pub struct HelperResponse {
    pub request_id: MsgId,
    pub status: u64,
    pub payload: Vec<u8>,
}
impl HelperRequest {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        helper_encode(self.request_id, self.operation, &self.payload, true)
    }
    pub fn decode(b: &[u8]) -> Result<Self, CodecError> {
        let (id, op, payload) = helper_decode(b, true)?;
        Ok(Self {
            request_id: id,
            operation: op,
            payload,
        })
    }
    pub fn encode_frame(&self) -> Result<Vec<u8>, CodecError> {
        frame(&self.encode()?)
    }
    pub fn decode_frame(bytes: &[u8]) -> Result<Self, CodecError> {
        Self::decode(parse_frame(bytes)?)
    }
}
impl HelperResponse {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        helper_encode(self.request_id, self.status, &self.payload, false)
    }
    pub fn decode(b: &[u8]) -> Result<Self, CodecError> {
        let (id, status, payload) = helper_decode(b, false)?;
        Ok(Self {
            request_id: id,
            status,
            payload,
        })
    }
    pub fn encode_frame(&self) -> Result<Vec<u8>, CodecError> {
        frame(&self.encode()?)
    }
    pub fn decode_frame(bytes: &[u8]) -> Result<Self, CodecError> {
        Self::decode(parse_frame(bytes)?)
    }
}
fn helper_encode(id: MsgId, n: u64, p: &[u8], request: bool) -> Result<Vec<u8>, CodecError> {
    check_id16(id.as_bytes())?;
    if p.is_empty()
        || p.len() > HELPER_PAYLOAD_MAX
        || (request && !(1..=16).contains(&n))
        || (!request && n > 9)
    {
        return Err(CodecError::Value);
    };
    check_root_array(p)?;
    let mut e = Encoder::new();
    e.array(4).uint(1).bytes(id.as_bytes()).uint(n).bytes(p);
    let b = e.into_vec();
    if b.len() > HELPER_MAX {
        Err(CodecError::Limit)
    } else {
        Ok(b)
    }
}
fn helper_decode(b: &[u8], request: bool) -> Result<(MsgId, u64, Vec<u8>), CodecError> {
    if b.len() > HELPER_MAX {
        return Err(CodecError::Limit);
    };
    decode_strict(b, |d| {
        d.array(4)?;
        let v = d.uint()?;
        let id = read_msg(d)?;
        let n = d.uint()?;
        let p = bounded_bytes(d, 1, HELPER_PAYLOAD_MAX, false)?;
        if v != 1 || (request && !(1..=16).contains(&n)) || (!request && n > 9) {
            return Err(CborError::TypeMismatch {
                expected: "helper envelope",
                offset: 0,
            });
        };
        check_root_array(&p).map_err(|_| CborError::TypeMismatch {
            expected: "array payload",
            offset: 0,
        })?;
        Ok((id, n, p))
    })
    .map_err(Into::into)
    .and_then(|x| {
        check_id16(x.0.as_bytes())?;
        Ok(x)
    })
}
pub fn frame(body: &[u8]) -> Result<Vec<u8>, CodecError> {
    if body.is_empty() || body.len() > HELPER_MAX {
        return Err(CodecError::Limit);
    };
    let len = u32::try_from(body.len()).map_err(|_| CodecError::Limit)?;
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}
pub fn parse_frame(frame: &[u8]) -> Result<&[u8], CodecError> {
    if frame.len() < 4 {
        return Err(CodecError::Format);
    };
    let n = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if n == 0 || n > HELPER_MAX || frame.len() != n + 4 {
        return Err(CodecError::Limit);
    };
    Ok(&frame[4..])
}

fn b64url_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() * 4).div_ceil(3));
    for c in data.chunks(3) {
        let a = c[0];
        let b = *c.get(1).unwrap_or(&0);
        let d = *c.get(2).unwrap_or(&0);
        out.push(T[(a >> 2) as usize] as char);
        out.push(T[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        if c.len() > 1 {
            out.push(T[(((b & 15) << 2) | (d >> 6)) as usize] as char)
        }
        if c.len() > 2 {
            out.push(T[(d & 63) as usize] as char)
        }
    }
    out
}
fn b64url_decode(s: &[u8]) -> Result<Vec<u8>, CodecError> {
    if s.is_empty()
        || s.iter()
            .any(|b| !matches!(b,b'A'..=b'Z'|b'a'..=b'z'|b'0'..=b'9'|b'-'|b'_'))
        || s.len() % 4 == 1
    {
        return Err(CodecError::Format);
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u8;
    for &b in s {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err(CodecError::Format),
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 || b64url_encode(&out).as_bytes() != s {
        return Err(CodecError::Format);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base64url_rejects_nonzero_unused_bits_and_padding() {
        assert!(b64url_decode(b"Zh").is_err());
        assert!(b64url_decode(b"Zg==").is_err());
        assert_eq!(b64url_decode(b"Zg").unwrap(), b"f");
    }
}
