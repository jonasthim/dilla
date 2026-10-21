//! Typed codecs for managed-bot KeyPackage publication and helper intent payloads.
//! The generic helper envelope remains opaque and performs no semantic dispatch.
use super::CodecError;
use crate::cbor::{CborError, Decoder, Encoder, decode_strict};
use crate::ids::MsgId;

pub const MAX_UPLOAD_BODY: usize = 1_047_296;
pub const HELPER_PAYLOAD_MAX: usize = 1_048_480;
const MAX_I64: u64 = i64::MAX as u64;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Publication {
    pub operation_id: MsgId,
    pub expected_generation: u64,
    pub upload_body: Vec<u8>,
}
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PublicationReceipt {
    pub expected_generation: u64,
    pub upload_sha256: [u8; 32],
    pub count: u64,
}
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Intent {
    pub operation_id: MsgId,
    pub count: u64,
    pub last_resort: u64,
    pub expected_generation: u64,
}
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct IntentResult {
    pub upload_body: Vec<u8>,
    pub package_refs: Vec<[u8; 32]>,
    pub greatest_expiry: u64,
}
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Resolution {
    pub operation_id: MsgId,
    pub package_refs: Vec<[u8; 32]>,
    pub outcome: u64,
    pub now: u64,
    pub current_generation: u64,
}

fn read_id(d: &mut Decoder<'_>) -> Result<MsgId, CborError> {
    Ok(MsgId::from_bytes(d.bytes_exact::<16>()?))
}
fn valid_id(v: MsgId) -> bool {
    v.as_bytes().iter().any(|b| *b != 0)
}
fn read_refs(d: &mut Decoder<'_>) -> Result<Vec<[u8; 32]>, CborError> {
    let n = d.array_len()?;
    if !(1..=33).contains(&n) {
        return Err(CborError::WrongArrayLen {
            expected: 33,
            actual: n,
        });
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let r = d.bytes_exact::<32>()?;
        if out.contains(&r) {
            return Err(CborError::TypeMismatch {
                expected: "distinct package refs",
                offset: d.position(),
            });
        }
        out.push(r)
    }
    Ok(out)
}
fn encode_refs(e: &mut Encoder, refs: &[[u8; 32]]) -> Result<(), CodecError> {
    if refs.is_empty() || refs.len() > 33 || (0..refs.len()).any(|i| refs[..i].contains(&refs[i])) {
        return Err(CodecError::Value);
    }
    e.array(refs.len());
    for r in refs {
        e.bytes(r);
    }
    Ok(())
}
fn upload_count(raw: &[u8]) -> Result<usize, CodecError> {
    if raw.len() > MAX_UPLOAD_BODY {
        return Err(CodecError::Limit);
    }
    let n = decode_strict(raw, |d| {
        d.array(2)?;
        let pn = d.array_len()?;
        if !(1..=32).contains(&pn) {
            return Err(CborError::WrongArrayLen {
                expected: 32,
                actual: pn,
            });
        }
        for _ in 0..pn {
            if d.bytes()?.is_empty() {
                return Err(CborError::WrongByteLen {
                    expected: 1,
                    actual: 0,
                });
            }
        }
        let fallback = if d.try_null()? {
            false
        } else {
            if d.bytes()?.is_empty() {
                return Err(CborError::WrongByteLen {
                    expected: 1,
                    actual: 0,
                });
            }
            true
        };
        Ok(pn + usize::from(fallback))
    })
    .map_err(|_| CodecError::Format)?;
    // decode_strict accepts only deterministic encodings; retaining the body preserves exact canonical bytes.
    Ok(n)
}
fn finish<T>(
    raw: &[u8],
    n: usize,
    f: impl FnOnce(&mut Decoder<'_>) -> Result<T, CborError>,
) -> Result<T, CodecError> {
    if raw.len() > HELPER_PAYLOAD_MAX {
        return Err(CodecError::Limit);
    }
    decode_strict(raw, |d| {
        d.array(n)?;
        f(d)
    })
    .map_err(Into::into)
}

impl Publication {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        if raw.len() > MAX_UPLOAD_BODY + 64 {
            return Err(CodecError::Limit);
        }
        let x = finish(raw, 3, |d| {
            let op = read_id(d)?;
            let generation = d.uint()?;
            let body = d.bytes()?;
            Ok((op, generation, body.to_vec()))
        })?;
        if !valid_id(x.0) || x.1 > MAX_I64 {
            return Err(CodecError::Value);
        }
        upload_count(&x.2)?;
        Ok(Self {
            operation_id: x.0,
            expected_generation: x.1,
            upload_body: x.2,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        if !valid_id(self.operation_id) || self.expected_generation > MAX_I64 {
            return Err(CodecError::Value);
        }
        upload_count(&self.upload_body)?;
        let mut e = Encoder::new();
        e.array(3)
            .bytes(self.operation_id.as_bytes())
            .uint(self.expected_generation)
            .bytes(&self.upload_body);
        let b = e.into_vec();
        if b.len() > HELPER_PAYLOAD_MAX {
            return Err(CodecError::Limit);
        }
        Ok(b)
    }
}
impl PublicationReceipt {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        let x = finish(raw, 3, |d| {
            Ok((d.uint()?, d.bytes_exact::<32>()?, d.uint()?))
        })?;
        if x.0 > MAX_I64 || !(1..=33).contains(&x.2) {
            return Err(CodecError::Value);
        }
        Ok(Self {
            expected_generation: x.0,
            upload_sha256: x.1,
            count: x.2,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        if self.expected_generation > MAX_I64 || !(1..=33).contains(&self.count) {
            return Err(CodecError::Value);
        }
        let mut e = Encoder::new();
        e.array(3)
            .uint(self.expected_generation)
            .bytes(&self.upload_sha256)
            .uint(self.count);
        Ok(e.into_vec())
    }
}
impl Intent {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        let x = finish(raw, 4, |d| {
            Ok((read_id(d)?, d.uint()?, d.uint()?, d.uint()?))
        })?;
        if !valid_id(x.0) || !(1..=32).contains(&x.1) || x.2 > 1 || x.3 > MAX_I64 {
            return Err(CodecError::Value);
        }
        Ok(Self {
            operation_id: x.0,
            count: x.1,
            last_resort: x.2,
            expected_generation: x.3,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        if !valid_id(self.operation_id)
            || !(1..=32).contains(&self.count)
            || self.last_resort > 1
            || self.expected_generation > MAX_I64
        {
            return Err(CodecError::Value);
        }
        let mut e = Encoder::new();
        e.array(4)
            .bytes(self.operation_id.as_bytes())
            .uint(self.count)
            .uint(self.last_resort)
            .uint(self.expected_generation);
        Ok(e.into_vec())
    }
}
impl IntentResult {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        let x = finish(raw, 3, |d| {
            Ok((d.bytes()?.to_vec(), read_refs(d)?, d.uint()?))
        })?;
        let count = upload_count(&x.0)?;
        if x.1.len() != count || x.2 > MAX_I64 {
            return Err(CodecError::Value);
        }
        Ok(Self {
            upload_body: x.0,
            package_refs: x.1,
            greatest_expiry: x.2,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        let count = upload_count(&self.upload_body)?;
        if count != self.package_refs.len() || self.greatest_expiry > MAX_I64 {
            return Err(CodecError::Value);
        }
        let mut e = Encoder::new();
        e.array(3).bytes(&self.upload_body);
        encode_refs(&mut e, &self.package_refs)?;
        e.uint(self.greatest_expiry);
        let b = e.into_vec();
        if b.len() > HELPER_PAYLOAD_MAX {
            return Err(CodecError::Limit);
        }
        Ok(b)
    }
}
impl Resolution {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        let x = finish(raw, 5, |d| {
            Ok((read_id(d)?, read_refs(d)?, d.uint()?, d.uint()?, d.uint()?))
        })?;
        if !valid_id(x.0) || x.2 > 1 || x.3 > MAX_I64 || x.4 > MAX_I64 {
            return Err(CodecError::Value);
        }
        Ok(Self {
            operation_id: x.0,
            package_refs: x.1,
            outcome: x.2,
            now: x.3,
            current_generation: x.4,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        if !valid_id(self.operation_id)
            || self.outcome > 1
            || self.now > MAX_I64
            || self.current_generation > MAX_I64
        {
            return Err(CodecError::Value);
        }
        let mut e = Encoder::new();
        e.array(5).bytes(self.operation_id.as_bytes());
        encode_refs(&mut e, &self.package_refs)?;
        e.uint(self.outcome)
            .uint(self.now)
            .uint(self.current_generation);
        Ok(e.into_vec())
    }
}
