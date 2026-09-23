//! The message envelope and its franking commitment (protocol/04-envelope-and-franking.md).
//!
//! The envelope is a 9-element fixed-position CBOR array. It travels inside an MLS
//! `PrivateMessage` whose `authenticated_data` is exactly the 32-byte commitment `C`, and whose
//! ciphertext is padded to a multiple of `PADDING_MULTIPLE` bytes.

mod frank;

pub use frank::{FrankingTagInput, franking_tag, verify_franking_tag};

use crate::cbor::{CborError, Decoder, Encoder, decode_strict};
use crate::error::ProtocolError;
use crate::identity::{hmac_sha256, hmac_sha256_verify};
use crate::ids::MsgId;

/// `body` limit in UTF-8 bytes for types 0 and 1.
pub const MAX_BODY_LONG: usize = 4_000;
/// `body` limit in UTF-8 bytes for types 3 and 4 (the emoji).
pub const MAX_BODY_SHORT: usize = 32;
pub const MAX_ATTACHMENTS: usize = 10;
pub const MAX_PREVIEWS: usize = 5;
pub const MAX_PREVIEW_IMAGE: usize = 32_768;
pub const MAX_THUMB: usize = 16_384;
/// The `PrivateMessage` carrying an envelope is padded so its ciphertext length is a multiple of
/// this (RFC 9420 section 6.3.1).
pub const PADDING_MULTIPLE: usize = 256;
/// `C = HMAC-SHA256(k_f, DOMAIN_FRANK || CBOR(envelope with k_f blanked))`
pub const DOMAIN_FRANK: &[u8] = b"dilla frank v1";
/// `T = HMAC-SHA256(K_frank, DOMAIN_FRANK_TAG || ...)`
pub const DOMAIN_FRANK_TAG: &[u8] = b"dilla frank tag v1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum EnvelopeType {
    Message = 0,
    Edit = 1,
    Delete = 2,
    ReactionAdd = 3,
    ReactionRemove = 4,
    Pin = 5,
    Unpin = 6,
}

impl EnvelopeType {
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u64(v: u64) -> Result<Self, ProtocolError> {
        Ok(match v {
            0 => Self::Message,
            1 => Self::Edit,
            2 => Self::Delete,
            3 => Self::ReactionAdd,
            4 => Self::ReactionRemove,
            5 => Self::Pin,
            6 => Self::Unpin,
            _ => return Err(ProtocolError::EnvelopeType),
        })
    }

    /// 4 000 bytes for a message or an edit, 32 for a reaction, 0 for a tombstone or a pin.
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Message | Self::Edit => MAX_BODY_LONG,
            Self::ReactionAdd | Self::ReactionRemove => MAX_BODY_SHORT,
            Self::Delete | Self::Pin | Self::Unpin => 0,
        }
    }
}

/// `blob_id` is the SHA-256 of the **ciphertext**; a receiver that fetches the blob must verify it
/// (`E_BLOB_HASH`). `thumb` uses the same key with the nonce's last byte XORed with 0x01.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Attachment {
    pub blob_id: [u8; 32],
    pub key: [u8; 32],
    pub nonce: [u8; 12],
    /// Plaintext bytes.
    pub size: u64,
    pub mime: String,
    pub w: Option<u64>,
    pub h: Option<u64>,
    pub thumb: Option<Vec<u8>>,
}

/// Sender-generated. A receiver MUST NOT fetch the remote resource.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Preview {
    pub url: String,
    pub title: String,
    pub description: String,
    pub image: Option<Vec<u8>>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Envelope {
    pub v: u64,
    pub msg_id: MsgId,
    pub kind: EnvelopeType,
    pub thread_id: Option<MsgId>,
    pub reply_to: Option<MsgId>,
    pub body: String,
    pub attachments: Vec<Attachment>,
    pub previews: Vec<Preview>,
    /// The franking key, random per envelope and per edit.
    pub k_f: [u8; 32],
}

impl Envelope {
    fn write(&self, e: &mut Encoder, k_f: Option<&[u8; 32]>) {
        e.array(9)
            .uint(self.v)
            .bytes(self.msg_id.as_bytes())
            .uint(u64::from(self.kind.as_u8()))
            .opt_bytes(self.thread_id.as_ref().map(|m| &m.0[..]))
            .opt_bytes(self.reply_to.as_ref().map(|m| &m.0[..]))
            .text(&self.body);
        e.array(self.attachments.len());
        for a in &self.attachments {
            e.array(8)
                .bytes(&a.blob_id)
                .bytes(&a.key)
                .bytes(&a.nonce)
                .uint(a.size)
                .text(&a.mime)
                .opt_uint(a.w)
                .opt_uint(a.h)
                .opt_bytes(a.thumb.as_deref());
        }
        e.array(self.previews.len());
        for p in &self.previews {
            e.array(4)
                .text(&p.url)
                .text(&p.title)
                .text(&p.description)
                .opt_bytes(p.image.as_deref());
        }
        match k_f {
            Some(k) => e.bytes(k),
            None => e.bytes(&[]),
        };
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let mut e = Encoder::with_capacity(256 + self.body.len());
        self.write(&mut e, Some(&self.k_f));
        Ok(e.into_vec())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let env = decode_strict(bytes, Self::read).map_err(map_cbor)?;
        env.validate()?;
        Ok(env)
    }

    fn read(d: &mut Decoder<'_>) -> Result<Self, CborError> {
        d.array(9)?;
        let v = d.uint()?;
        if v != 1 {
            return Err(SHAPE);
        }
        let msg_id = MsgId::from_bytes(d.bytes_exact::<16>()?);
        let kind = EnvelopeType::from_u64(d.uint()?).map_err(|_| TYPE)?;
        let thread_id = d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes);
        let reply_to = d.opt_bytes_exact::<16>()?.map(MsgId::from_bytes);
        let body = d.text()?.to_owned();

        let n = d.array_len()?;
        let mut attachments = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(8)?;
            attachments.push(Attachment {
                blob_id: d.bytes_exact::<32>()?,
                key: d.bytes_exact::<32>()?,
                nonce: d.bytes_exact::<12>()?,
                size: d.uint()?,
                mime: d.text()?.to_owned(),
                w: d.opt_uint()?,
                h: d.opt_uint()?,
                thumb: if d.try_null()? {
                    None
                } else {
                    Some(d.bytes()?.to_vec())
                },
            });
        }

        let n = d.array_len()?;
        let mut previews = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(4)?;
            previews.push(Preview {
                url: d.text()?.to_owned(),
                title: d.text()?.to_owned(),
                description: d.text()?.to_owned(),
                image: if d.try_null()? {
                    None
                } else {
                    Some(d.bytes()?.to_vec())
                },
            });
        }

        let k_f = d.bytes_exact::<32>()?;
        Ok(Self {
            v,
            msg_id,
            kind,
            thread_id,
            reply_to,
            body,
            attachments,
            previews,
            k_f,
        })
    }

    /// The reference decoder's order, reproduced exactly: element count, then `v`, then `type`,
    /// then the two fixed lengths, then every limit.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.v != 1 {
            return Err(ProtocolError::EnvelopeShape);
        }
        if self.body.len() > self.kind.body_limit() {
            return Err(ProtocolError::EnvelopeLimit);
        }
        if self.attachments.len() > MAX_ATTACHMENTS || self.previews.len() > MAX_PREVIEWS {
            return Err(ProtocolError::EnvelopeLimit);
        }
        for a in &self.attachments {
            if a.thumb.as_ref().is_some_and(|t| t.len() > MAX_THUMB) {
                return Err(ProtocolError::EnvelopeLimit);
            }
        }
        for p in &self.previews {
            if p.image
                .as_ref()
                .is_some_and(|i| i.len() > MAX_PREVIEW_IMAGE)
            {
                return Err(ProtocolError::EnvelopeLimit);
            }
        }
        Ok(())
    }

    /// The same 9-element array with element 9 replaced by the empty byte string (`0x40`).
    pub fn commitment_preimage(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let mut e = Encoder::with_capacity(256 + self.body.len());
        self.write(&mut e, None);
        Ok(e.into_vec())
    }

    /// `C = HMAC-SHA256(k_f, DOMAIN_FRANK || commitment_preimage())`
    pub fn commitment(&self) -> Result<[u8; 32], ProtocolError> {
        let pre = self.commitment_preimage()?;
        let mut data = Vec::with_capacity(DOMAIN_FRANK.len() + pre.len());
        data.extend_from_slice(DOMAIN_FRANK);
        data.extend_from_slice(&pre);
        Ok(hmac_sha256(&self.k_f, &data))
    }

    /// Recomputes `C` from the decrypted envelope and compares it, in constant time, with the MLS
    /// `authenticated_data`. Any mismatch is a hard reject (protocol/04).
    pub fn verify_commitment(&self, authenticated_data: &[u8]) -> Result<(), ProtocolError> {
        if authenticated_data.len() != 32 {
            return Err(ProtocolError::FrankMismatch);
        }
        let pre = self.commitment_preimage()?;
        let mut data = Vec::with_capacity(DOMAIN_FRANK.len() + pre.len());
        data.extend_from_slice(DOMAIN_FRANK);
        data.extend_from_slice(&pre);
        let mut tag = [0u8; 32];
        tag.copy_from_slice(authenticated_data);
        if hmac_sha256_verify(&self.k_f, &data, &tag) {
            Ok(())
        } else {
            Err(ProtocolError::FrankMismatch)
        }
    }
}

const SHAPE: CborError = CborError::TypeMismatch {
    expected: "envelope shape",
    offset: 0,
};
const TYPE: CborError = CborError::TypeMismatch {
    expected: "envelope type",
    offset: 0,
};

fn map_cbor(e: CborError) -> ProtocolError {
    match e {
        CborError::TypeMismatch {
            expected: "envelope type",
            ..
        } => ProtocolError::EnvelopeType,
        _ => ProtocolError::EnvelopeShape,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::MsgId;

    const ENVELOPE_JSON: &str = include_str!("../../../../protocol/vectors/envelope.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
        let v = unhex(s);
        assert_eq!(v.len(), N, "expected {N} bytes, got {}", v.len());
        let mut out = [0u8; N];
        out.copy_from_slice(&v);
        out
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn opt_msg_id(v: &serde_json::Value) -> Option<MsgId> {
        v.as_str().map(|s| MsgId::from_bytes(unhex_n::<16>(s)))
    }

    fn opt_bytes(v: &serde_json::Value) -> Option<Vec<u8>> {
        v.as_str().map(unhex)
    }

    fn envelope_from_json(j: &serde_json::Value) -> Envelope {
        Envelope {
            v: j["v"].as_u64().expect("v"),
            msg_id: MsgId::from_bytes(unhex_n::<16>(j["msgId"].as_str().expect("msgId"))),
            kind: EnvelopeType::from_u64(j["type"].as_u64().expect("type")).expect("type"),
            thread_id: opt_msg_id(&j["threadId"]),
            reply_to: opt_msg_id(&j["replyTo"]),
            body: j["body"].as_str().expect("body").to_owned(),
            attachments: j["attachments"]
                .as_array()
                .expect("attachments")
                .iter()
                .map(|a| Attachment {
                    blob_id: unhex_n::<32>(a["blobId"].as_str().expect("blobId")),
                    key: unhex_n::<32>(a["key"].as_str().expect("key")),
                    nonce: unhex_n::<12>(a["nonce"].as_str().expect("nonce")),
                    size: a["size"].as_u64().expect("size"),
                    mime: a["mime"].as_str().expect("mime").to_owned(),
                    w: a["w"].as_u64(),
                    h: a["h"].as_u64(),
                    thumb: opt_bytes(&a["thumb"]),
                })
                .collect(),
            previews: j["previews"]
                .as_array()
                .expect("previews")
                .iter()
                .map(|p| Preview {
                    url: p["url"].as_str().expect("url").to_owned(),
                    title: p["title"].as_str().expect("title").to_owned(),
                    description: p["description"].as_str().expect("description").to_owned(),
                    image: opt_bytes(&p["image"]),
                })
                .collect(),
            k_f: unhex_n::<32>(j["kf"].as_str().expect("kf")),
        }
    }

    #[test]
    fn every_envelope_vector_reproduces_cbor_length_and_commitment() {
        let doc: serde_json::Value = serde_json::from_str(ENVELOPE_JSON).expect("envelope.json");
        let cases = doc["cases"].as_array().expect("cases");
        assert_eq!(
            cases.len(),
            4,
            "envelope.json is expected to carry four cases"
        );
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let env = envelope_from_json(&case["envelope"]);
            let bytes = env.encode().unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                hex_of(&bytes),
                case["cbor"].as_str().expect("cbor"),
                "{name}: cbor"
            );
            assert_eq!(
                bytes.len() as u64,
                case["length"].as_u64().expect("length"),
                "{name}: length"
            );
            assert_eq!(
                hex_of(&env.commitment().unwrap()),
                case["commitment"].as_str().expect("commitment"),
                "{name}: commitment"
            );
            assert_eq!(Envelope::decode(&bytes).unwrap(), env, "{name}: round trip");
        }
    }

    #[test]
    fn commitment_preimage_blanks_only_the_ninth_element() {
        let doc: serde_json::Value = serde_json::from_str(ENVELOPE_JSON).expect("envelope.json");
        let env = envelope_from_json(&doc["cases"][0]["envelope"]);
        let full = env.encode().unwrap();
        let pre = env.commitment_preimage().unwrap();
        // the full encoding ends with `58 20` + 32 bytes of k_f; the preimage ends with `40`
        assert_eq!(&pre[..full.len() - 34], &full[..full.len() - 34]);
        assert_eq!(pre[pre.len() - 1], 0x40);
        assert_eq!(pre.len(), full.len() - 33);
    }

    fn base() -> Envelope {
        Envelope {
            v: 1,
            msg_id: MsgId::from_bytes([0x01; 16]),
            kind: EnvelopeType::Message,
            thread_id: None,
            reply_to: None,
            body: String::new(),
            attachments: Vec::new(),
            previews: Vec::new(),
            k_f: [0x06; 32],
        }
    }

    #[test]
    fn decode_rejects_in_the_documented_order() {
        // wrong element count
        let mut bytes = base().encode().unwrap();
        bytes[0] = 0x88; // array of 8
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeShape));

        // v != 1. The bad byte is patched into a valid encoding: `Envelope::encode` begins with
        // `self.validate()?`, which rejects `v != 1`, so `base().v = 2; ...encode().unwrap()`
        // would panic and the decode path under test would never run. Element 2 of the array,
        // `v`, sits at offset 1, straight after the `0x89` array head.
        let mut bytes = base().encode().unwrap();
        assert_eq!(
            bytes[1], 0x01,
            "the v element must be where this test expects it"
        );
        bytes[1] = 0x02;
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeShape));

        // unknown type: element 3 of the array sits at offset 19
        // (1 array head + 1 v + 17 msg_id)
        let mut bytes = base().encode().unwrap();
        assert_eq!(
            bytes[19], 0x00,
            "the type element must be where this test expects it"
        );
        bytes[19] = 0x07;
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeType));

        // trailing bytes
        let mut bytes = base().encode().unwrap();
        bytes.push(0x00);
        assert_eq!(Envelope::decode(&bytes), Err(ProtocolError::EnvelopeShape));
    }

    #[test]
    fn validate_enforces_every_limit() {
        assert_eq!(base().validate(), Ok(()));

        let mut long = base();
        long.body = "a".repeat(MAX_BODY_LONG);
        assert_eq!(long.validate(), Ok(()));
        long.body = "a".repeat(MAX_BODY_LONG + 1);
        assert_eq!(long.validate(), Err(ProtocolError::EnvelopeLimit));

        let mut reaction = base();
        reaction.kind = EnvelopeType::ReactionAdd;
        reaction.body = "a".repeat(MAX_BODY_SHORT);
        assert_eq!(reaction.validate(), Ok(()));
        reaction.body = "a".repeat(MAX_BODY_SHORT + 1);
        assert_eq!(reaction.validate(), Err(ProtocolError::EnvelopeLimit));

        let attachment = Attachment {
            blob_id: [0x03; 32],
            key: [0x04; 32],
            nonce: [0x05; 12],
            size: 1,
            mime: "image/jpeg".to_owned(),
            w: None,
            h: None,
            thumb: None,
        };
        let mut many = base();
        many.attachments = vec![attachment.clone(); MAX_ATTACHMENTS];
        assert_eq!(many.validate(), Ok(()));
        many.attachments.push(attachment.clone());
        assert_eq!(many.validate(), Err(ProtocolError::EnvelopeLimit));

        let mut fat_thumb = base();
        let mut a = attachment.clone();
        a.thumb = Some(vec![0u8; MAX_THUMB]);
        fat_thumb.attachments = vec![a.clone()];
        assert_eq!(fat_thumb.validate(), Ok(()));
        a.thumb = Some(vec![0u8; MAX_THUMB + 1]);
        fat_thumb.attachments = vec![a];
        assert_eq!(fat_thumb.validate(), Err(ProtocolError::EnvelopeLimit));

        let preview = Preview {
            url: "https://example.invalid/".to_owned(),
            title: "t".to_owned(),
            description: "d".to_owned(),
            image: None,
        };
        let mut many = base();
        many.previews = vec![preview.clone(); MAX_PREVIEWS];
        assert_eq!(many.validate(), Ok(()));
        many.previews.push(preview.clone());
        assert_eq!(many.validate(), Err(ProtocolError::EnvelopeLimit));

        let mut fat_image = base();
        let mut p = preview;
        p.image = Some(vec![0u8; MAX_PREVIEW_IMAGE]);
        fat_image.previews = vec![p.clone()];
        assert_eq!(fat_image.validate(), Ok(()));
        p.image = Some(vec![0u8; MAX_PREVIEW_IMAGE + 1]);
        fat_image.previews = vec![p];
        assert_eq!(fat_image.validate(), Err(ProtocolError::EnvelopeLimit));
    }

    #[test]
    fn body_limit_is_per_type() {
        assert_eq!(EnvelopeType::Message.body_limit(), MAX_BODY_LONG);
        assert_eq!(EnvelopeType::Edit.body_limit(), MAX_BODY_LONG);
        assert_eq!(EnvelopeType::ReactionAdd.body_limit(), MAX_BODY_SHORT);
        assert_eq!(EnvelopeType::ReactionRemove.body_limit(), MAX_BODY_SHORT);
        for t in [EnvelopeType::Delete, EnvelopeType::Pin, EnvelopeType::Unpin] {
            assert_eq!(t.body_limit(), 0);
        }
        assert_eq!(EnvelopeType::from_u64(7), Err(ProtocolError::EnvelopeType));
    }

    #[test]
    fn verify_commitment_requires_exactly_thirty_two_authenticated_bytes() {
        let env = base();
        let c = env.commitment().unwrap();
        assert_eq!(env.verify_commitment(&c), Ok(()));
        assert_eq!(
            env.verify_commitment(&c[..31]),
            Err(ProtocolError::FrankMismatch)
        );
        assert_eq!(
            env.verify_commitment(&[]),
            Err(ProtocolError::FrankMismatch)
        );
        let mut wrong = c;
        wrong[0] ^= 0x01;
        assert_eq!(
            env.verify_commitment(&wrong),
            Err(ProtocolError::FrankMismatch)
        );
    }
}
