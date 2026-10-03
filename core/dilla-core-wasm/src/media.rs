//! The media worker's cipher: `dilla-sframe/1` sender and receiver over wasm-bindgen.
//!
//! Every `Err` is a `JsError` whose message is a bare code: an `E_SFRAME_*` string from
//! protocol/05 "Errors", or `E_BAD_OPTIONS` when an argument has the wrong shape (a base key that
//! is not 16 bytes, a roster whose device bytes are not 16 per leaf). The worker matches on the
//! string: `E_SFRAME_UNKNOWN_KID` is held for at most 2 s, everything else is dropped and counted.
//! `u64` crosses as `BigInt`; time is the caller's `performance.now()` in milliseconds.

use dilla_core::sframe::{Codec, KeyRing, NK, SframeError, SframeSender, Slot};
use wasm_bindgen::prelude::*;

fn code(e: SframeError) -> JsError {
    JsError::new(e.code())
}

fn bad_options() -> JsError {
    JsError::new("E_BAD_OPTIONS")
}

fn key16(bytes: &[u8]) -> Result<[u8; NK], JsError> {
    <[u8; NK]>::try_from(bytes).map_err(|_| bad_options())
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
        base_key: &[u8],
        leaf_index: u32,
        epoch: u64,
        min_epoch: u64,
    ) -> Result<MediaSender, JsError> {
        SframeSender::new(&key16(base_key)?, leaf(leaf_index)?, epoch, min_epoch)
            .map(MediaSender)
            .map_err(code)
    }

    pub fn rekey(&mut self, base_key: &[u8], leaf_index: u32, epoch: u64) -> Result<(), JsError> {
        self.0.rekey(&key16(base_key)?, leaf(leaf_index)?, epoch);
        Ok(())
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
        base_key: &[u8],
        roster_leaves: &[u32],
        roster_devices: &[u8],
        own_leaf: i32,
        now_ms: f64,
    ) -> Result<(), JsError> {
        let key = key16(base_key)?;
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
        self.ring
            .install_epoch(epoch, key, &roster, own, ms(now_ms));
        Ok(())
    }

    pub fn expire(&mut self, now_ms: f64) {
        self.ring.expire(ms(now_ms));
    }

    /// `expected_device`: the track's participant identity as 16 bytes, or empty for none.
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
        let device = match expected_device.len() {
            0 => None,
            16 => Some(<[u8; 16]>::try_from(expected_device).map_err(|_| bad_options())?),
            _ => return Err(bad_options()),
        };
        self.ring
            .decrypt(codec, frame, device.as_ref(), slot, ms(now_ms))
            .map(|d| d.frame.into_boxed_slice())
            .map_err(code)
    }
}
