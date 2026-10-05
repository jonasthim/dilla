//! The unknown-KID hold (protocol/05 "Rotation"): a frame whose KID names an epoch this device
//! has not installed yet is held, in arrival order, for at most `UNKNOWN_KID_BUFFER_MS` and at
//! most `UNKNOWN_KID_BUFFER_FRAMES` frames. No other failure is ever held.
//!
//! One `PendingFrames` per receiving track. The order is strict: once anything is held, every
//! later frame of that track is pushed behind it rather than decrypted directly, because an
//! encoded-transform writer silently drops a frame older than the last one it wrote.

use std::collections::VecDeque;

use super::{Codec, Decrypted, KeyRing, SframeError, Slot};

pub struct PendingFrames {
    max_age_ms: u64,
    max_frames: usize,
    held: VecDeque<(u64, Vec<u8>)>,
    overflowed: u32,
}

impl PendingFrames {
    pub fn new(max_age_ms: u64, max_frames: usize) -> Self {
        Self {
            max_age_ms,
            max_frames,
            held: VecDeque::new(),
            overflowed: 0,
        }
    }

    /// Holds `frame`, received at `now_ms`. A full buffer drops its oldest frame, which the next
    /// `drain` counts.
    pub fn push(&mut self, now_ms: u64, frame: Vec<u8>) {
        if self.max_frames == 0 {
            self.overflowed += 1;
            return;
        }
        if self.held.len() == self.max_frames {
            self.held.pop_front();
            self.overflowed += 1;
        }
        self.held.push_back((now_ms, frame));
    }

    /// Decrypts from the head while it can: a head older than `max_age_ms` is dropped, a head
    /// that is still `UnknownKid` stops the drain (head-of-line, nothing behind it overtakes),
    /// and any other failure drops that frame. Returns the frames released, in order, and how
    /// many were dropped since the last drain.
    pub fn drain(
        &mut self,
        ring: &mut KeyRing,
        codec: Codec,
        expected_device: Option<&[u8; 16]>,
        expected_slot: Slot,
        now_ms: u64,
    ) -> (Vec<Decrypted>, u32) {
        let mut out = Vec::new();
        let mut dropped = std::mem::take(&mut self.overflowed);
        while let Some((at, frame)) = self.held.front() {
            if now_ms.saturating_sub(*at) > self.max_age_ms {
                self.held.pop_front();
                dropped += 1;
                continue;
            }
            match ring.decrypt(codec, frame, expected_device, expected_slot, now_ms) {
                Ok(d) => {
                    self.held.pop_front();
                    out.push(d);
                }
                Err(SframeError::UnknownKid) => break,
                Err(_) => {
                    self.held.pop_front();
                    dropped += 1;
                }
            }
        }
        (out, dropped)
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sframe::{
        Ctr, FrameKey, Kid, NK, UNKNOWN_KID_BUFFER_FRAMES, UNKNOWN_KID_BUFFER_MS, protect,
    };

    const BOB: [u8; 16] = [0xb2; 16];
    const BASE: [u8; NK] = [0x0a; NK];

    fn frame(epoch: u64, seq: u64) -> Vec<u8> {
        let kid = Kid::new(1, epoch);
        let ctr = Ctr::new(0, 0, seq).unwrap();
        protect(
            &FrameKey::derive(&BASE, kid),
            kid,
            ctr,
            Codec::Opus,
            &[0xfc, u8::try_from(seq).unwrap()],
        )
        .unwrap()
    }

    fn drain(p: &mut PendingFrames, r: &mut KeyRing, now_ms: u64) -> (Vec<u64>, u32) {
        let (out, dropped) = p.drain(r, Codec::Opus, Some(&BOB), Slot::Microphone, now_ms);
        (out.iter().map(|d| d.ctr.seq()).collect(), dropped)
    }

    #[test]
    fn held_frames_are_released_in_arrival_order_once_their_epoch_arrives() {
        let mut r = KeyRing::new();
        r.install_epoch(4, &BASE, &[(0, [0xa1; 16]), (1, BOB)], Some(0), 0);
        let mut p = PendingFrames::new(UNKNOWN_KID_BUFFER_MS, UNKNOWN_KID_BUFFER_FRAMES);
        for seq in 0..3 {
            p.push(10, frame(5, seq));
        }
        assert_eq!(
            drain(&mut p, &mut r, 20),
            (vec![], 0),
            "epoch 5 not installed"
        );
        assert_eq!(p.len(), 3);
        r.install_epoch(5, &BASE, &[(0, [0xa1; 16]), (1, BOB)], Some(0), 30);
        assert_eq!(drain(&mut p, &mut r, 40), (vec![0, 1, 2], 0));
        assert!(p.is_empty());
    }

    #[test]
    fn an_unknown_head_blocks_frames_that_could_decrypt() {
        let mut r = KeyRing::new();
        r.install_epoch(4, &BASE, &[(0, [0xa1; 16]), (1, BOB)], Some(0), 0);
        let mut p = PendingFrames::new(UNKNOWN_KID_BUFFER_MS, UNKNOWN_KID_BUFFER_FRAMES);
        p.push(0, frame(5, 0));
        p.push(0, frame(4, 7));
        assert_eq!(drain(&mut p, &mut r, 1), (vec![], 0));
        assert_eq!(p.len(), 2);
    }

    #[test]
    fn frames_older_than_the_hold_and_beyond_the_count_are_dropped_and_counted() {
        let mut r = KeyRing::new();
        r.install_epoch(4, &BASE, &[(0, [0xa1; 16]), (1, BOB)], Some(0), 0);
        let mut p = PendingFrames::new(2_000, 2);
        p.push(0, frame(5, 0));
        p.push(500, frame(5, 1));
        p.push(600, frame(5, 2)); // the buffer holds two: seq 0 is dropped
        assert_eq!(p.len(), 2);
        // At 2_501 seq 1 (held at 500) is past 2 000 ms; seq 2 is still unknown.
        assert_eq!(drain(&mut p, &mut r, 2_501), (vec![], 2));
        assert_eq!(p.len(), 1);
    }

    #[test]
    fn a_failure_other_than_unknown_kid_is_dropped_not_held() {
        let mut r = KeyRing::new();
        r.install_epoch(5, &BASE, &[(0, [0xa1; 16]), (1, BOB)], Some(0), 0);
        let mut p = PendingFrames::new(UNKNOWN_KID_BUFFER_MS, UNKNOWN_KID_BUFFER_FRAMES);
        let mut bad = frame(5, 0);
        let last = bad.len() - 1;
        bad[last] ^= 1;
        p.push(0, bad);
        p.push(0, frame(5, 1));
        assert_eq!(drain(&mut p, &mut r, 1), (vec![1], 1));
    }

    /// A non-canonical KID or a non-minimal header is a hard parse error: dropped and counted,
    /// never held, even while the epoch its low byte names is not installed yet.
    #[test]
    fn a_non_canonical_kid_or_non_minimal_header_is_dropped_not_held() {
        let mut r = KeyRing::new();
        r.install_epoch(4, &BASE, &[(0, [0xa1; 16]), (1, BOB)], Some(0), 0);
        let mut p = PendingFrames::new(UNKNOWN_KID_BUFFER_MS, UNKNOWN_KID_BUFFER_FRAMES);
        // KID (1 << 24) | (1 << 8) | 5: epoch 5 is not installed, yet this is not UnknownKid.
        let kid = Kid::from_raw((1 << 24) | Kid::new(1, 5).value());
        let ctr = Ctr::new(0, 0, 0).unwrap();
        let non_canonical = protect(
            &FrameKey::derive(&BASE, kid),
            kid,
            ctr,
            Codec::Opus,
            &[0xfc],
        )
        .unwrap();
        // KID 0x000105 spelled in three bytes, then a CTR and a tag's worth of bytes.
        let mut non_minimal = vec![0xa0, 0x00, 0x01, 0x05];
        non_minimal.extend_from_slice(&[0u8; 17]);
        p.push(0, non_canonical);
        p.push(0, non_minimal);
        assert_eq!(drain(&mut p, &mut r, 1), (vec![], 2));
        assert!(p.is_empty());
    }
}
