//! The CTR partition and the nonce (protocol/05-media-frames.md "Counter partition").

use super::NN;
use crate::error::ProtocolError;

/// `seq` must stay below 2^52. On exhaustion the sender rekeys through an MLS `Update` rather
/// than wrapping.
pub const MAX_SEQ: u64 = (1u64 << 52) - 1;

/// Which source a frame came from. `seq` restarts at 0 per `(KID, slot, layer)`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Slot {
    Microphone = 0,
    Camera = 1,
    ScreenVideo = 2,
    ScreenAudio = 3,
}

/// `slot(8) || layer(4) || seq(52)`, packed into one 64-bit counter.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ctr(u64);

impl Ctr {
    /// `E_UNSUPPORTED_VERSION` on `layer > 0xf` or `seq > MAX_SEQ`: both mean the sender is
    /// speaking a media version this one does not implement, or has exhausted its counter and
    /// must rekey. protocol/05 names no dedicated code, so the media-version code carries it.
    pub fn new(slot: u8, layer: u8, seq: u64) -> Result<Self, ProtocolError> {
        if layer > 0xf || seq > MAX_SEQ {
            return Err(ProtocolError::UnsupportedVersion);
        }
        Ok(Self(
            (u64::from(slot) << 56) | (u64::from(layer) << 52) | seq,
        ))
    }

    pub const fn from_raw(v: u64) -> Self {
        Self(v)
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub const fn slot(self) -> u8 {
        (self.0 >> 56) as u8
    }

    pub const fn layer(self) -> u8 {
        ((self.0 >> 52) & 0xf) as u8
    }

    pub const fn seq(self) -> u64 {
        self.0 & MAX_SEQ
    }
}

/// `salt XOR CTR`, with CTR big-endian left-padded to 12 bytes (so it XORs into the low 8).
pub fn nonce(salt: &[u8; NN], ctr: Ctr) -> [u8; NN] {
    let mut out = *salt;
    let c = ctr.value().to_be_bytes();
    for (o, b) in out[NN - 8..].iter_mut().zip(c) {
        *o ^= b;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctr_packs_slot_layer_and_seq() {
        let c = Ctr::new(1, 2, 1000).unwrap();
        assert_eq!(c.value(), 81_064_793_292_669_928);
        assert_eq!(c.slot(), 1);
        assert_eq!(c.layer(), 2);
        assert_eq!(c.seq(), 1000);

        let c = Ctr::new(3, 15, 1_073_741_824).unwrap();
        assert_eq!(c.value(), 283_726_777_598_083_072);
        assert_eq!(Ctr::from_raw(c.value()), c);
        assert_eq!(Ctr::new(0, 0, 0).unwrap().value(), 0);
    }

    #[test]
    fn ctr_refuses_an_out_of_range_layer_or_a_wrapped_sequence() {
        assert_eq!(Ctr::new(0, 16, 0), Err(ProtocolError::UnsupportedVersion));
        assert!(Ctr::new(0, 15, MAX_SEQ).is_ok());
        assert_eq!(
            Ctr::new(0, 0, MAX_SEQ + 1),
            Err(ProtocolError::UnsupportedVersion)
        );
        assert_eq!(MAX_SEQ, (1u64 << 52) - 1);
    }

    #[test]
    fn slots_are_the_four_documented_sources() {
        assert_eq!(Slot::Microphone as u8, 0);
        assert_eq!(Slot::Camera as u8, 1);
        assert_eq!(Slot::ScreenVideo as u8, 2);
        assert_eq!(Slot::ScreenAudio as u8, 3);
    }

    #[test]
    fn nonce_is_the_salt_xor_the_counter_left_padded_to_twelve_bytes() {
        let salt = [0x11u8; 12];
        let ctr = Ctr::from_raw(0x0102_0304_0506_0708);
        let n = nonce(&salt, ctr);
        assert_eq!(&n[..4], &[0x11, 0x11, 0x11, 0x11]);
        assert_eq!(&n[4..], &[0x10, 0x13, 0x12, 0x15, 0x14, 0x17, 0x16, 0x19]);
        assert_eq!(nonce(&salt, Ctr::from_raw(0)), salt);
    }
}
