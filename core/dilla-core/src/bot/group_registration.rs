//! Strict codecs for the managed bot's first MLS group registration.

use super::CodecError;
use crate::cbor::{Decoder, Encoder, decode_strict};
use crate::ids::MsgId;

const MAX_BODY: usize = 65_505;
const MAX_I64: u64 = i64::MAX as u64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub operation_id: MsgId,
    pub expected_generation: u64,
    pub registration_body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub operation_id: MsgId,
    pub group_id: MsgId,
    pub registration_sha256: [u8; 32],
    pub accepted_generation: u64,
    pub initial_epoch: u64,
    pub next_sequence: u64,
}

fn valid_id(id: MsgId) -> bool {
    id.as_bytes().iter().any(|&b| b != 0)
}

fn read_id(d: &mut Decoder<'_>) -> Result<MsgId, crate::cbor::CborError> {
    Ok(MsgId::from_bytes(d.bytes_exact::<16>()?))
}

fn validate_body(raw: &[u8]) -> Result<MsgId, CodecError> {
    if raw.is_empty() || raw.len() > MAX_BODY {
        return Err(CodecError::Limit);
    }
    let group = decode_strict(raw, |d| {
        d.array(4)?;
        let group = read_id(d)?;
        d.bytes()?;
        d.bytes()?;
        d.bytes()?;
        Ok(group)
    })?;
    if !valid_id(group) {
        return Err(CodecError::Value);
    }
    Ok(group)
}

impl Request {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        if raw.len() > MAX_BODY + 64 {
            return Err(CodecError::Limit);
        }
        let (operation_id, expected_generation, registration_body) = decode_strict(raw, |d| {
            d.array(3)?;
            Ok((read_id(d)?, d.uint()?, d.bytes()?.to_vec()))
        })?;
        if !valid_id(operation_id) || expected_generation > MAX_I64 {
            return Err(CodecError::Value);
        }
        validate_body(&registration_body)?;
        Ok(Self {
            operation_id,
            expected_generation,
            registration_body,
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        if !valid_id(self.operation_id) || self.expected_generation > MAX_I64 {
            return Err(CodecError::Value);
        }
        validate_body(&self.registration_body)?;
        let mut e = Encoder::new();
        e.array(3)
            .bytes(self.operation_id.as_bytes())
            .uint(self.expected_generation)
            .bytes(&self.registration_body);
        Ok(e.into_vec())
    }
}

impl Receipt {
    pub fn decode(raw: &[u8]) -> Result<Self, CodecError> {
        let (
            operation_id,
            group_id,
            registration_sha256,
            accepted_generation,
            initial_epoch,
            next_sequence,
        ) = decode_strict(raw, |d| {
            d.array(6)?;
            Ok((
                read_id(d)?,
                read_id(d)?,
                d.bytes_exact::<32>()?,
                d.uint()?,
                d.uint()?,
                d.uint()?,
            ))
        })?;
        let value = Self {
            operation_id,
            group_id,
            registration_sha256,
            accepted_generation,
            initial_epoch,
            next_sequence,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        self.validate()?;
        let mut e = Encoder::new();
        e.array(6)
            .bytes(self.operation_id.as_bytes())
            .bytes(self.group_id.as_bytes())
            .bytes(&self.registration_sha256)
            .uint(self.accepted_generation)
            .uint(self.initial_epoch)
            .uint(self.next_sequence);
        Ok(e.into_vec())
    }

    fn validate(&self) -> Result<(), CodecError> {
        if !valid_id(self.operation_id)
            || !valid_id(self.group_id)
            || self.accepted_generation > MAX_I64
            || self.initial_epoch > MAX_I64
            || self.next_sequence == 0
            || self.next_sequence > MAX_I64
        {
            return Err(CodecError::Value);
        }
        Ok(())
    }
}
