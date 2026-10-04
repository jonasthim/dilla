//! The media worker's cipher: `dilla-sframe/1` sender and receiver over wasm-bindgen.
//!
//! Every `Err` is a `JsError` whose message is a bare code: an `E_SFRAME_*` string from
//! protocol/05 "Errors", or `E_BAD_OPTIONS` when an argument has the wrong shape (a base key that
//! is not 16 bytes, a roster whose device bytes are not 16 per leaf). The worker matches on the
//! string: `E_SFRAME_UNKNOWN_KID` is held for at most 2 s, everything else is dropped and counted.
//! `u64` crosses as `BigInt`; time is the caller's `performance.now()` in milliseconds.
//!
//! A base key crosses as an owned `Vec<u8>`: wasm-bindgen copies the caller's `Uint8Array` into
//! a buffer it allocates in linear memory and hands that buffer over. [`with_key`] lends the
//! core a reference into that buffer, never a copy, and zeroes it before it is freed (task 17
//! review M4). The caller's array is not touched; the media worker zeroes its own copies. What
//! the core does with the key is the core's: `KeyRing` borrows it and copies it once into a
//! zeroize-on-drop heap buffer for the epoch's retention, and key derivation can leave transient
//! copies (the HKDF hasher's working state) in the wasm stack region that later calls overwrite
//! (protocol/08).

use dilla_core::sframe::{Codec, KeyRing, NK, SframeError, SframeSender, Slot};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

fn code(e: SframeError) -> JsError {
    JsError::new(e.code())
}

fn bad_options() -> JsError {
    JsError::new("E_BAD_OPTIONS")
}

/// Runs `f` on the 16-byte key in `bytes` by reference, then zeroes `bytes` in place, also when
/// its length is wrong (`wrong_length`) or `f` fails. The caller drops (frees) the zeroed buffer.
fn with_key<T, E>(
    bytes: &mut [u8],
    wrong_length: impl FnOnce() -> E,
    f: impl FnOnce(&[u8; NK]) -> Result<T, E>,
) -> Result<T, E> {
    let out = match <&[u8; NK]>::try_from(&*bytes) {
        Ok(key) => f(key),
        Err(_) => Err(wrong_length()),
    };
    bytes.zeroize();
    out
}

/// The track's device as `decrypt` requires it: exactly 16 bytes, never "no binding".
fn expected_device_of(bytes: &[u8]) -> Option<[u8; 16]> {
    <[u8; 16]>::try_from(bytes).ok()
}

fn leaf(index: u32) -> Result<u16, JsError> {
    u16::try_from(index).map_err(|_| code(SframeError::LeafOutOfRange))
}

fn ms(now_ms: f64) -> u64 {
    if now_ms.is_finite() && now_ms > 0.0 {
        now_ms as u64
    } else {
        0
    }
}

#[wasm_bindgen]
pub struct MediaSender(SframeSender);

#[wasm_bindgen]
impl MediaSender {
    /// N1: `min_epoch` is the first epoch this device committed after the worker started.
    #[wasm_bindgen(constructor)]
    pub fn new(
        mut base_key: Vec<u8>,
        leaf_index: u32,
        epoch: u64,
        min_epoch: u64,
    ) -> Result<MediaSender, JsError> {
        with_key(&mut base_key, bad_options, |key| {
            SframeSender::new(key, leaf(leaf_index)?, epoch, min_epoch)
                .map(MediaSender)
                .map_err(code)
        })
    }

    pub fn rekey(
        &mut self,
        mut base_key: Vec<u8>,
        leaf_index: u32,
        epoch: u64,
    ) -> Result<(), JsError> {
        with_key(&mut base_key, bad_options, |key| {
            self.0.rekey(key, leaf(leaf_index)?, epoch);
            Ok(())
        })
    }

    /// `codec`: 0 Opus, 1 VP8, 2 VP9, 3 H.264. `slot`: 0 microphone, 1 camera, 2 screen video,
    /// 3 screen audio. `layer`: 0..=15.
    pub fn encrypt(
        &mut self,
        codec: u8,
        slot: u8,
        layer: u8,
        frame: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let codec = Codec::from_u8(codec).map_err(code)?;
        let slot = Slot::from_u8(slot).map_err(code)?;
        self.0
            .encrypt(codec, slot, layer, frame)
            .map(Vec::into_boxed_slice)
            .map_err(code)
    }

    pub fn exhausted(&self) -> bool {
        self.0.exhausted()
    }
}

#[wasm_bindgen]
pub struct MediaReceiver {
    ring: KeyRing,
}

impl Default for MediaReceiver {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl MediaReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MediaReceiver {
        MediaReceiver {
            ring: KeyRing::new(),
        }
    }

    /// `roster_leaves[i]` is the leaf of the device in `roster_devices[16*i..16*i+16]`;
    /// `own_leaf` is this device's leaf in `epoch`, or -1 when it holds none.
    pub fn install_epoch(
        &mut self,
        epoch: u64,
        mut base_key: Vec<u8>,
        roster_leaves: &[u32],
        roster_devices: &[u8],
        own_leaf: i32,
        now_ms: f64,
    ) -> Result<(), JsError> {
        with_key(&mut base_key, bad_options, |key| {
            let (devices, rest) = roster_devices.as_chunks::<16>();
            if !rest.is_empty() || devices.len() != roster_leaves.len() {
                return Err(bad_options());
            }
            let mut roster = Vec::with_capacity(roster_leaves.len());
            for (l, d) in roster_leaves.iter().zip(devices) {
                roster.push((leaf(*l)?, *d));
            }
            let own = match own_leaf {
                -1 => None,
                l => Some(leaf(u32::try_from(l).map_err(|_| bad_options())?)?),
            };
            // KeyRing borrows the key and copies it once into a zeroize-on-drop heap buffer of its
            // own for the epoch's retention; `with_key` then zeroes the argument buffer.
            self.ring
                .install_epoch(epoch, key, &roster, own, ms(now_ms));
            Ok(())
        })
    }

    pub fn expire(&mut self, now_ms: f64) {
        self.ring.expire(ms(now_ms));
    }

    /// `expected_device`: the track's participant identity as exactly 16 bytes; anything else,
    /// empty included, is `E_BAD_OPTIONS`. The worker never decrypts a frame without a sender
    /// binding: only the native `KeyRing` API (tests and vectors) can skip it.
    /// Returns `prefix || plaintext`.
    pub fn decrypt(
        &mut self,
        codec: u8,
        frame: &[u8],
        expected_device: &[u8],
        expected_slot: u8,
        now_ms: f64,
    ) -> Result<Box<[u8]>, JsError> {
        let codec = Codec::from_u8(codec).map_err(code)?;
        let slot = Slot::from_u8(expected_slot).map_err(code)?;
        let device = expected_device_of(expected_device).ok_or_else(bad_options)?;
        self.ring
            .decrypt(codec, frame, Some(&device), slot, ms(now_ms))
            .map(|d| d.frame.into_boxed_slice())
            .map_err(code)
    }
}

#[cfg(test)]
mod tests {
    use super::{expected_device_of, with_key};

    /// CRYPTO-10: an empty identity is no longer "no sender binding". `decrypt` maps `None` to
    /// `E_BAD_OPTIONS` (node.rs checks the code under wasm32).
    #[test]
    fn only_a_sixteen_byte_identity_binds_a_track() {
        for len in [0usize, 3, 15, 17, 32] {
            assert_eq!(expected_device_of(&vec![0xb2; len]), None, "len {len}");
        }
        assert_eq!(expected_device_of(&[0xb2; 16]), Some([0xb2; 16]));
    }

    #[test]
    fn the_argument_buffer_is_lent_by_reference_then_zeroed() {
        let mut buf: Vec<u8> = (1..=16).collect();
        let at = buf.as_ptr();
        let seen = with_key(
            &mut buf,
            || "length",
            |key| {
                assert_eq!(key.as_ptr(), at, "the key must not be copied");
                Ok::<_, &str>(*key)
            },
        );
        assert_eq!(seen, Ok(core::array::from_fn(|i| i as u8 + 1)));
        assert_eq!(buf, vec![0u8; 16]);
    }

    #[test]
    fn a_failing_call_and_a_wrong_length_buffer_are_zeroed_too() {
        let mut buf = vec![0x5a; 16];
        assert_eq!(
            with_key(&mut buf, || "length", |_| Err::<(), _>("refused")),
            Err("refused")
        );
        assert_eq!(buf, vec![0u8; 16]);
        for len in [0usize, 15, 17, 32] {
            let mut buf = vec![0x5a; len];
            assert_eq!(with_key(&mut buf, || "length", |_| Ok(())), Err("length"));
            assert!(buf.iter().all(|&b| b == 0), "len {len}");
        }
    }
}
