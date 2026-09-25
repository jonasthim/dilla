//! An RFC 9420 §6.3.2 `PrivateMessage` header parse.
//!
//! **Why this is hand-written.** The DS must read the 32-byte franking commitment `C` out of
//! `authenticated_data` (`protocol/04-envelope-and-franking.md`, "Franking") and the message's
//! epoch, without decrypting anything. Controller ruling B2 fixes that as a hand-written TLS
//! decode of the RFC's struct rather than a call into openmls, so the DS owns both the framing
//! it accepts and the detail string it refuses with.
//!
//! **Correction to the brief.** The brief justified the hand-written decode by saying openmls
//! 0.9.0 "exposes `group_id()`, `epoch()` and `content_type()` but **no** `authenticated_data()`
//! accessor (`src/framing/private_message_in.rs:260-275`)". The cited range is real and does hold
//! only those three, but it is the *second* `impl PrivateMessageIn` block in that file: the first
//! one declares `pub fn aad(&self) -> &[u8]` at `:59`, ungated, so the field *is* reachable
//! through the crate's public API. The decode below stands on ruling B2, not on that claim.
//!
//! The struct is fully specified by the RFC, so it is decoded field by field:
//!
//! ```text
//! struct {
//!   opaque group_id<V>;
//!   uint64 epoch;
//!   ContentType content_type;          // uint8: 1 application, 2 proposal, 3 commit
//!   opaque authenticated_data<V>;
//!   opaque encrypted_sender_data<V>;
//!   opaque ciphertext<V>;
//! } PrivateMessage;
//! ```
//!
//! wrapped in an `MLSMessage`: `ProtocolVersion version` (uint16, 1 for MLS 1.0) then
//! `WireFormat wire_format` (uint16, **2** for `PrivateMessage`, `src/framing/mod.rs:138`).
//! `<V>` is the RFC's variable-length header — the QUIC variable-length integer of RFC 9000,
//! which `tls_codec::TlsVarInt` decodes under MLS's minimum-size rule (see [`vl_bytes`] for why
//! it is not `tls_codec::VLBytes`).

use tls_codec::{DeserializeBytes, TlsVarInt};

use crate::abi::AbiError;

/// What `private_message_aad` reports.
///
/// `Debug` is derived because the module's own tests call `Result::unwrap_err`, which requires
/// `T: Debug`. Printing it leaks nothing the DS is not already handing back over the ABI: the
/// `authenticated_data` is the public franking commitment, and there is no key or plaintext here.
#[derive(Debug)]
pub struct PrivateMessageHeader {
    pub authenticated_data: Vec<u8>,
    pub epoch: u64,
    pub content_type: u8,
}

const MLS_PROTOCOL_VERSION_10: u16 = 1;
const WIRE_FORMAT_PRIVATE_MESSAGE: u16 = 2;

fn take<const N: usize>(rest: &[u8], what: &str) -> Result<([u8; N], usize), AbiError> {
    let slice = rest
        .get(..N)
        .ok_or_else(|| AbiError::shape(format!("PrivateMessage: truncated at {what}")))?;
    let mut out = [0u8; N];
    out.copy_from_slice(slice);
    Ok((out, N))
}

/// Decodes one RFC 9420 `opaque<V>` field: the variable-length integer header followed by that
/// many bytes.
///
/// **Deviation from the brief, forced by the vendored source: not `VLBytes`.** The brief's line
/// was `VLBytes::tls_deserialize_bytes(rest)`, and that function carries a `debug_assert_eq!` on
/// exactly the truncated-input path — `tls_codec-0.5.0/src/quic_vec.rs:363-376` reaches
/// `debug_assert_eq!(remaining_len, length, …)` whenever the declared length exceeds the bytes
/// that remain, so it **panics** in any build with debug assertions on and only returns
/// `Error::DecodingError` with them off. Every byte parsed here is remote input the DS has not
/// authenticated, and a panic inside a wasm instance is a trap the host cannot recover the
/// instance from; `a_truncated_message_is_refused_rather_than_panicking` below is what caught it.
///
/// `TlsVarInt` (`tls_codec-0.5.0/src/varint.rs:134-159`) has no assertion on its truncation path —
/// it returns `Error::EndOfStream` — and still enforces MLS's minimum-size encoding rule through
/// `check_min_len` under the `mls` feature this crate enables. So the header is read with it and
/// the body is sliced with a checked `get`.
fn vl_bytes<'a>(rest: &'a [u8], what: &str) -> Result<(Vec<u8>, &'a [u8]), AbiError> {
    let (header, tail) = TlsVarInt::tls_deserialize_bytes(rest)
        .map_err(|e| AbiError::shape(format!("PrivateMessage: {what}: {e}")))?;
    let declared = header.value();
    // `usize` is 32-bit on both wasm32 targets, so a 62-bit length really can be unrepresentable.
    let length = usize::try_from(declared).map_err(|_| {
        AbiError::shape(format!(
            "PrivateMessage: {what}: declared length {declared} is not addressable"
        ))
    })?;
    let value = tail.get(..length).ok_or_else(|| {
        AbiError::shape(format!(
            "PrivateMessage: {what}: {length} bytes declared, {} remain",
            tail.len()
        ))
    })?;
    Ok((value.to_vec(), &tail[length..]))
}

/// Parses the header of an `MLSMessage` carrying a `PrivateMessage`.
///
/// The trailing `encrypted_sender_data` and `ciphertext` are decoded too, and the message is
/// refused when bytes remain after them: a trailing-data tolerance here would let a sender append
/// arbitrary bytes to a message the DS has already tagged.
pub fn parse(bytes: &[u8]) -> Result<PrivateMessageHeader, AbiError> {
    let (version, n) = take::<2>(bytes, "protocol_version")?;
    let mut rest = &bytes[n..];
    if u16::from_be_bytes(version) != MLS_PROTOCOL_VERSION_10 {
        return Err(AbiError::shape(format!(
            "PrivateMessage: protocol_version {}, want {MLS_PROTOCOL_VERSION_10}",
            u16::from_be_bytes(version)
        )));
    }
    let (wire_format, n) = take::<2>(rest, "wire_format")?;
    rest = &rest[n..];
    if u16::from_be_bytes(wire_format) != WIRE_FORMAT_PRIVATE_MESSAGE {
        return Err(AbiError::shape(format!(
            "PrivateMessage: wire_format {}, want {WIRE_FORMAT_PRIVATE_MESSAGE}",
            u16::from_be_bytes(wire_format)
        )));
    }
    let (_group_id, tail) = vl_bytes(rest, "group_id")?;
    rest = tail;
    let (epoch, n) = take::<8>(rest, "epoch")?;
    rest = &rest[n..];
    let (content_type, n) = take::<1>(rest, "content_type")?;
    rest = &rest[n..];
    let (authenticated_data, tail) = vl_bytes(rest, "authenticated_data")?;
    rest = tail;
    let (_sender_data, tail) = vl_bytes(rest, "encrypted_sender_data")?;
    rest = tail;
    let (_ciphertext, tail) = vl_bytes(rest, "ciphertext")?;
    if !tail.is_empty() {
        return Err(AbiError::shape(format!(
            "PrivateMessage: {} trailing bytes",
            tail.len()
        )));
    }
    Ok(PrivateMessageHeader {
        authenticated_data,
        epoch: u64::from_be_bytes(epoch),
        content_type: content_type[0],
    })
}

/// The framing builder, shared with `exports`' test module so the export test does not duplicate
/// it. It is declared **here, in the failing-test step**, because `exports.rs`'s
/// `private_message_aad_reports_thirty_two_bytes_and_refuses_anything_else` names it: were it added
/// only at implementation time, the export step's stated failure would be an unrelated resolution
/// error.
#[cfg(test)]
pub mod tests_support {
    use super::*;
    use tls_codec::{Serialize as _, VLBytes};

    /// Builds the MLSMessage framing by hand so the test does not depend on a committed fixture:
    /// `aad` is what the DS will read back.
    pub fn message(aad: &[u8], epoch: u64, content_type: u8) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&MLS_PROTOCOL_VERSION_10.to_be_bytes());
        out.extend_from_slice(&WIRE_FORMAT_PRIVATE_MESSAGE.to_be_bytes());
        out.extend_from_slice(
            &VLBytes::new(b"group-id".to_vec())
                .tls_serialize_detached()
                .unwrap(),
        );
        out.extend_from_slice(&epoch.to_be_bytes());
        out.push(content_type);
        out.extend_from_slice(&VLBytes::new(aad.to_vec()).tls_serialize_detached().unwrap());
        out.extend_from_slice(
            &VLBytes::new(vec![7u8; 16])
                .tls_serialize_detached()
                .unwrap(),
        );
        out.extend_from_slice(
            &VLBytes::new(vec![9u8; 64])
                .tls_serialize_detached()
                .unwrap(),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::message;
    use super::*;

    #[test]
    fn a_conforming_message_yields_its_aad_epoch_and_content_type() {
        let aad = [3u8; 32];
        let header = parse(&message(&aad, 41, 1)).unwrap();
        assert_eq!(header.authenticated_data, aad);
        assert_eq!(header.epoch, 41);
        assert_eq!(header.content_type, 1);
    }

    #[test]
    fn a_wrong_wire_format_is_refused() {
        let mut bytes = message(&[0u8; 32], 1, 1);
        bytes[3] = 1; // PublicMessage
        assert_eq!(parse(&bytes).unwrap_err().code, crate::abi::E_ABI_SHAPE);
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let mut bytes = message(&[0u8; 32], 1, 1);
        bytes.push(0);
        let err = parse(&bytes).unwrap_err();
        assert_eq!(err.code, crate::abi::E_ABI_SHAPE);
        assert!(err.detail.contains("trailing"), "{}", err.detail);
    }

    #[test]
    fn a_truncated_message_is_refused_rather_than_panicking() {
        let bytes = message(&[0u8; 32], 1, 1);
        for cut in 0..bytes.len() {
            assert_eq!(
                parse(&bytes[..cut]).unwrap_err().code,
                crate::abi::E_ABI_SHAPE,
                "prefix of {cut} bytes must be a shape failure"
            );
        }
    }
}
