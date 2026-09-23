//! Pairing: the QR payload, the no-camera fingerprint, the TOFU pin record and the one
//! application message a pairing group ever carries (protocol/03-identity.md "Pairing").

use super::recovery::{crockford_decode, crockford_encode};
use super::{CROCKFORD, sha256};
use crate::cbor::{Encoder, decode_strict};
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};

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
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PairingPayload {
    pub v: u64,
    /// The SSK-signed credential identity CBOR of the new device.
    pub credential: Vec<u8>,
    pub ssk_priv: Option<[u8; 32]>,
    pub k_backup: Option<[u8; 32]>,
    pub pins: Option<Vec<Pin>>,
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
                let mut pins = Vec::with_capacity(n);
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
