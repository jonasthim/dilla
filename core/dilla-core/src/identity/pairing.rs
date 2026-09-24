//! Pairing: the QR payload, the no-camera fingerprint, the TOFU pin record and the one
//! application message a pairing group ever carries (protocol/03-identity.md "Pairing").

use super::recovery::{crockford_decode, crockford_encode};
use super::{CROCKFORD, sha256};
use crate::cbor::{Encoder, decode_strict};
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// The 4-element array a new device shows as a QR code.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PairingQr {
    pub v: u64,
    pub device_id: DeviceId,
    pub dsk_pub: [u8; 32],
    pub umk_pub: [u8; 32],
}

impl PairingQr {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(96);
        e.array(4)
            .uint(self.v)
            .bytes(self.device_id.as_bytes())
            .bytes(&self.dsk_pub)
            .bytes(&self.umk_pub);
        e.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(4)?;
            Ok(Self {
                v: d.uint()?,
                device_id: DeviceId::from_bytes(d.bytes_exact::<16>()?),
                dsk_pub: d.bytes_exact::<32>()?,
                umk_pub: d.bytes_exact::<32>()?,
            })
        })
        .map_err(|_| ProtocolError::Credential)
        .and_then(|q| {
            if q.v == 1 {
                Ok(q)
            } else {
                Err(ProtocolError::Credential)
            }
        })
    }

    pub fn to_base32(&self) -> String {
        crockford_encode(&self.encode())
    }

    pub fn from_base32(s: &str) -> Result<Self, ProtocolError> {
        Self::decode(&crockford_decode(s)?)
    }
}

/// The first 12 Crockford base32 characters of `SHA-256(dsk_pub)`, for the no-camera path.
pub fn fingerprint(dsk_pub: &[u8; 32]) -> String {
    let mut s = crockford_encode(&sha256(dsk_pub));
    s.truncate(12);
    debug_assert!(s.bytes().all(|c| CROCKFORD.contains(&c)));
    s
}

/// One row of the trust-on-first-use pin table.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pin {
    pub user_id: UserId,
    pub umk_pub: [u8; 32],
    pub first_seen: u64,
    /// 0 or 1: whether a safety number was compared out of band.
    pub verified: u64,
}

/// The only application message a pairing group carries.
/// For a browser device `ssk_priv` and `pins` are null, and `k_backup` is null unless opted in.
///
/// This is the one structure in the crate that carries `SSK_priv` — the key that signs every
/// device credential and every device list — and `K_backup`, so it does not derive `Debug` (see
/// the hand-written impl below) and it zeroizes both secrets on drop.
///
/// `PartialEq` is the derived, non-constant-time comparison: it exists for the round-trip tests
/// and nothing compares two payloads on a decision path.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct PairingPayload {
    #[zeroize(skip)]
    pub v: u64,
    /// The SSK-signed credential identity CBOR of the new device.
    pub credential: Vec<u8>,
    pub ssk_priv: Option<[u8; 32]>,
    pub k_backup: Option<[u8; 32]>,
    /// Public material: user ids, UMK public keys and a verified flag.
    #[zeroize(skip)]
    pub pins: Option<Vec<Pin>>,
}

/// Hand-written so that no `{:?}`, `dbg!`, `tracing` field, `expect` message or failed
/// `assert_eq!` can print `SSK_priv` or `K_backup`. Whether each secret is present is itself
/// protocol-visible (a browser device gets neither), so presence is shown and the bytes are not.
impl core::fmt::Debug for PairingPayload {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        fn redact(v: &Option<[u8; 32]>) -> &'static str {
            if v.is_some() {
                "Some(<redacted>)"
            } else {
                "None"
            }
        }
        f.debug_struct("PairingPayload")
            .field("v", &self.v)
            .field(
                "credential",
                &format_args!("{} bytes", self.credential.len()),
            )
            .field("ssk_priv", &format_args!("{}", redact(&self.ssk_priv)))
            .field("k_backup", &format_args!("{}", redact(&self.k_backup)))
            .field("pins", &self.pins)
            .finish()
    }
}

impl PairingPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(256 + self.credential.len());
        e.array(5)
            .uint(self.v)
            .bytes(&self.credential)
            .opt_bytes(self.ssk_priv.as_ref().map(|k| &k[..]))
            .opt_bytes(self.k_backup.as_ref().map(|k| &k[..]));
        match &self.pins {
            None => {
                e.null();
            }
            Some(pins) => {
                e.array(pins.len());
                for p in pins {
                    e.array(4)
                        .bytes(p.user_id.as_bytes())
                        .bytes(&p.umk_pub)
                        .uint(p.first_seen)
                        .uint(p.verified);
                }
            }
        }
        e.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(5)?;
            let v = d.uint()?;
            let credential = d.bytes()?.to_vec();
            let ssk_priv = d.opt_bytes_exact::<32>()?;
            let k_backup = d.opt_bytes_exact::<32>()?;
            let pins = if d.try_null()? {
                None
            } else {
                let n = d.array_len()?;
                // Not `Vec::with_capacity(n)`: `array_len` bounds `n` by the bytes that remain,
                // and a `Pin` in memory is wider than the 53 bytes its shortest encoding costs, so
                // reserving one per claimed element would scale an untrusted blob into a multiple
                // of its own size. See the same note in `device_list::read_entries`.
                let mut pins = Vec::new();
                for _ in 0..n {
                    d.array(4)?;
                    pins.push(Pin {
                        user_id: UserId::from_bytes(d.bytes_exact::<16>()?),
                        umk_pub: d.bytes_exact::<32>()?,
                        first_seen: d.uint()?,
                        verified: d.uint()?,
                    });
                }
                Some(pins)
            };
            Ok(Self {
                v,
                credential,
                ssk_priv,
                k_backup,
                pins,
            })
        })
        .map_err(|_| ProtocolError::Credential)
        // protocol/03-identity.md writes `v ; uint, = 1` here too. This payload hands the new
        // device the SSK, the archive key and the pin table, so decoding an unknown version as if
        // it were version 1 installs long-term secrets from a structure this build cannot read.
        // `E_UNSUPPORTED_VERSION` is not in protocol/03-identity.md's "Error codes" list, so an
        // unknown version answers with `E_CREDENTIAL`, the same as the sibling decoders.
        .and_then(|p| {
            if p.v == 1 {
                Ok(p)
            } else {
                Err(ProtocolError::Credential)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{DeviceId, UserId};

    fn qr() -> PairingQr {
        PairingQr {
            v: 1,
            device_id: DeviceId::from_bytes([0xe5; 16]),
            dsk_pub: [0x5a; 32],
            umk_pub: [0xa1; 32],
        }
    }

    #[test]
    fn pairing_qr_round_trips_through_cbor_and_base32() {
        let q = qr();
        assert_eq!(PairingQr::decode(&q.encode()).unwrap(), q);
        let s = q.to_base32();
        assert!(s.chars().all(|c| CROCKFORD.contains(&(c as u8))), "{s}");
        assert_eq!(PairingQr::from_base32(&s).unwrap(), q);
    }

    #[test]
    fn pairing_qr_decode_rejects_trailing_bytes_and_wrong_lengths() {
        let mut bytes = qr().encode();
        bytes.push(0x00);
        assert_eq!(PairingQr::decode(&bytes), Err(ProtocolError::Credential));
        assert_eq!(
            PairingQr::from_base32("NOTVALID"),
            Err(ProtocolError::Credential)
        );
    }

    #[test]
    fn fingerprint_is_twelve_crockford_characters_of_the_key_digest() {
        let f = fingerprint(&[0x5a; 32]);
        assert_eq!(f.len(), 12);
        assert!(f.chars().all(|c| CROCKFORD.contains(&(c as u8))), "{f}");
        assert_ne!(f, fingerprint(&[0x5b; 32]));
    }

    fn full_payload() -> PairingPayload {
        PairingPayload {
            v: 1,
            credential: vec![0x8a, 0x01, 0x02],
            ssk_priv: Some([0x32; 32]),
            k_backup: Some([0x28; 32]),
            pins: Some(vec![Pin {
                user_id: UserId::from_bytes([0xd4; 16]),
                umk_pub: [0xa1; 32],
                first_seen: 1_758_659_640,
                verified: 1,
            }]),
        }
    }

    /// A derived `Debug` prints `[50, 50, 50, ...]` for `ssk_priv: Some([0x32; 32])`, which is the
    /// whole long-term signing key in any log line or panic message.
    #[test]
    fn pairing_payload_debug_never_prints_the_secrets() {
        let p = full_payload();
        let s = format!("{p:?}");
        assert!(s.contains("ssk_priv: Some(<redacted>)"), "{s}");
        assert!(s.contains("k_backup: Some(<redacted>)"), "{s}");
        assert!(
            !s.contains("50, 50"),
            "the SSK bytes leaked into Debug: {s}"
        );
        assert!(!s.contains("40, 40"), "K_backup leaked into Debug: {s}");

        let browser = PairingPayload {
            v: 1,
            credential: Vec::new(),
            ssk_priv: None,
            k_backup: None,
            pins: None,
        };
        let s = format!("{browser:?}");
        assert!(s.contains("ssk_priv: None"), "{s}");
        assert!(s.contains("k_backup: None"), "{s}");
    }

    #[test]
    fn pairing_payload_zeroizes_its_secrets() {
        let mut p = full_payload();
        p.zeroize();
        assert_eq!(p.ssk_priv, None);
        assert_eq!(p.k_backup, None);
        assert!(p.credential.is_empty());
    }

    /// `array_len` bounds the claimed count by the bytes that remain, never by the size of what
    /// those bytes decode into: the shortest `Pin` encoding is 53 bytes, so a head claiming one pin
    /// per remaining byte must not buy one `Pin` of heap per remaining byte.
    #[test]
    fn decode_rejects_a_pin_array_head_that_overclaims() {
        let mut e = Encoder::with_capacity(256);
        e.array(5)
            .uint(1)
            .bytes(&[0x8a, 0x01, 0x02])
            .opt_bytes(Some(&[0x32; 32][..]))
            .opt_bytes(Some(&[0x28; 32][..]));
        e.array(50); // claims 50 pins ...
        e.array(4) // ... and supplies one
            .bytes(&[0xd4; 16])
            .bytes(&[0xa1; 32])
            .uint(1_758_659_640)
            .uint(1);
        let bytes = e.into_vec();
        assert_eq!(
            PairingPayload::decode(&bytes),
            Err(ProtocolError::Credential)
        );
    }

    /// protocol/03-identity.md writes `v ; uint, = 1` for the pairing payload as it does for the
    /// credential, the QR payload and the device list. Without the guard a `v = 2` blob decoded
    /// as if it were version 1 and the caller installed the SSK and pin table it carried.
    #[test]
    fn pairing_payload_decode_rejects_an_unknown_version() {
        let mut future = full_payload();
        future.v = 2;
        assert_eq!(
            PairingPayload::decode(&future.encode()),
            Err(ProtocolError::Credential)
        );
        assert!(PairingPayload::decode(&full_payload().encode()).is_ok());
    }

    #[test]
    fn pairing_payload_round_trips_with_and_without_its_optional_fields() {
        let full = PairingPayload {
            v: 1,
            credential: vec![0x8a, 0x01, 0x02],
            ssk_priv: Some([0x32; 32]),
            k_backup: Some([0x28; 32]),
            pins: Some(vec![Pin {
                user_id: UserId::from_bytes([0xd4; 16]),
                umk_pub: [0xa1; 32],
                first_seen: 1_758_659_640,
                verified: 1,
            }]),
        };
        assert_eq!(PairingPayload::decode(&full.encode()).unwrap(), full);

        // a browser device carries neither the SSK nor the pin table
        let browser = PairingPayload {
            v: 1,
            credential: vec![0x8a, 0x01, 0x02],
            ssk_priv: None,
            k_backup: None,
            pins: None,
        };
        assert_eq!(PairingPayload::decode(&browser.encode()).unwrap(), browser);
    }
}
