//! UP6b (R-UP12): the blob of a `withdrawn` handshake row, kind 3 (protocol/02 § Handshake
//! records). Target-agnostic, so the wasi tier's vector runner checks the same decoder the client
//! applies (`protocol/vectors/frames.json` § withdrawn).

use crate::cbor::{Encoder, decode_strict};

/// Handshake kind 3, `withdrawn`: the instance withdrew one of its own absence `Remove`s.
pub const HANDSHAKE_WITHDRAWN: u8 = 3;

/// The proposal reference a `withdrawn` row names: its blob is the deterministic CBOR
/// `[proposal_ref(bstr)]`, a one-element array holding one non-empty byte string. Anything else is
/// refused with a reason.
pub fn decode_withdrawn_blob(blob: &[u8]) -> Result<Vec<u8>, String> {
    let reference = decode_strict(blob, |d| {
        d.array(1)?;
        Ok(d.bytes()?.to_vec())
    })
    .map_err(|e| format!("{e:?}"))?;
    if reference.is_empty() {
        return Err("an empty proposal reference".to_owned());
    }
    Ok(reference)
}

/// The blob of a `withdrawn` row naming `reference`.
pub fn encode_withdrawn_blob(reference: &[u8]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(1).bytes(reference);
    e.into_vec()
}
