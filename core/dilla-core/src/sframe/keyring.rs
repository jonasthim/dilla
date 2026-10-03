//! The receiving side (protocol/05 "Rotation", "Receiver rules").
//!
//! A `KeyRing` holds every epoch superseded less than `OLD_EPOCH_RETENTION_MS` ago, newest first,
//! each with the roster that was current in it. A frame's KID resolves to exactly one held epoch
//! (installing an epoch evicts any held one with the same `epoch mod 256`, RFC 9605 section 5.2),
//! and is then bound, in that epoch, to the device the track belongs to.

use std::collections::HashMap;

use zeroize::Zeroizing;

use super::{
    Codec, Ctr, FrameKey, Kid, NK, OLD_EPOCH_RETENTION_MS, REPLAY_WINDOW, SframeError, Slot,
    open_frame, peek_kid_ctr, unescape_protected,
};

/// Anti-replay per `(leaf, slot, layer)` and epoch: the highest `seq` accepted and a bitmap of the
/// `REPLAY_WINDOW` sequence numbers at and below it (bit `i` = `highest - i`, RFC 3711 section
/// 3.3.2). Checked before the AEAD, committed only after it succeeds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReplayWindow {
    highest: u64,
    bitmap: u128,
}

impl ReplayWindow {
    pub fn check(&self, seq: u64) -> Result<(), SframeError> {
        if self.bitmap == 0 || seq > self.highest {
            return Ok(());
        }
        let behind = self.highest - seq;
        if behind >= REPLAY_WINDOW || self.bitmap & (1u128 << behind) != 0 {
            return Err(SframeError::Replay);
        }
        Ok(())
    }

    pub fn commit(&mut self, seq: u64) {
        if self.bitmap == 0 {
            self.highest = seq;
            self.bitmap = 1;
        } else if seq > self.highest {
            let ahead = seq - self.highest;
            self.bitmap = if ahead >= REPLAY_WINDOW {
                0
            } else {
                self.bitmap << ahead
            };
            self.bitmap |= 1;
            self.highest = seq;
        } else {
            let behind = self.highest - seq;
            if behind < REPLAY_WINDOW {
                self.bitmap |= 1u128 << behind;
            }
        }
    }
}

/// A frame the ring authenticated: who sent it, under which epoch, and `P || plaintext`.
#[derive(Debug, PartialEq, Eq)]
pub struct Decrypted {
    pub kid: Kid,
    pub ctr: Ctr,
    pub epoch: u64,
    pub leaf_index: u16,
    pub frame: Vec<u8>,
}

struct EpochEntry {
    epoch: u64,
    base_key: Zeroizing<[u8; NK]>,
    own_leaf: Option<u16>,
    roster: Vec<(u16, [u8; 16])>,
    superseded_at_ms: Option<u64>,
    /// One key per sending leaf: a canonical KID is `(leaf << 8) | epoch mod 256`, and the epoch
    /// is this entry's, so the leaf names the KID. A key is derived only for a leaf that passed
    /// the roster, sender and own-KID checks, so the cache never outgrows the roster.
    cache: HashMap<u16, FrameKey>,
    /// Committed only after the AEAD, so only authenticated `(leaf, slot, layer)`s get a window.
    replay: HashMap<(u16, u8, u8), ReplayWindow>,
}

#[derive(Default)]
pub struct KeyRing {
    /// Newest first.
    epochs: Vec<EpochEntry>,
    /// Epochs this ring held and dropped, with when: a KID resolving to one of them is
    /// `StaleEpoch` (dropped) rather than `UnknownKid` (held). Remembered for two retention
    /// periods, which no honest sender can wrap 256 epochs inside.
    retired: Vec<(u64, u64)>,
    /// How many frame keys this ring has derived, for the tests that pin when derivation happens.
    #[cfg(test)]
    derived: usize,
}

impl KeyRing {
    pub fn new() -> Self {
        Self::default()
    }

    /// Installs `epoch` with its base key, its roster `(leaf, device_id)` and this device's own
    /// leaf in it. A no-op when the epoch is already held, so a repeated install never resets a
    /// replay window. Otherwise: drop every epoch superseded `OLD_EPOCH_RETENTION_MS` ago or
    /// more, evict a held epoch with the same `epoch mod 256`, and — when `epoch` is the newest —
    /// mark the previous current epoch superseded at `now_ms`.
    pub fn install_epoch(
        &mut self,
        epoch: u64,
        base_key: [u8; NK],
        roster: &[(u16, [u8; 16])],
        own_leaf: Option<u16>,
        now_ms: u64,
    ) {
        let base_key = Zeroizing::new(base_key);
        if self.epochs.iter().any(|e| e.epoch == epoch) {
            return;
        }
        self.expire(now_ms);
        let low = epoch % 256;
        // RFC 9605 section 5.2: a new epoch evicts any held epoch with the same low byte, and a
        // KID with that byte now names the new epoch, so nothing about the old one is remembered.
        self.epochs.retain(|e| e.epoch % 256 != low);
        self.retired.retain(|(e, _)| e % 256 != low);
        let newest = self.epochs.first().is_none_or(|e| epoch > e.epoch);
        if newest {
            for e in &mut self.epochs {
                e.superseded_at_ms.get_or_insert(now_ms);
            }
        }
        let entry = EpochEntry {
            epoch,
            base_key,
            own_leaf,
            roster: roster.to_vec(),
            superseded_at_ms: if newest { None } else { Some(now_ms) },
            cache: HashMap::new(),
            replay: HashMap::new(),
        };
        let at = self
            .epochs
            .iter()
            .position(|e| e.epoch < epoch)
            .unwrap_or(self.epochs.len());
        self.epochs.insert(at, entry);
    }

    /// Drops every epoch superseded `OLD_EPOCH_RETENTION_MS` ago or more.
    pub fn expire(&mut self, now_ms: u64) {
        let (keep, gone): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.epochs).into_iter().partition(|e| {
                e.superseded_at_ms
                    .is_none_or(|t| now_ms.saturating_sub(t) < OLD_EPOCH_RETENTION_MS)
            });
        self.epochs = keep;
        self.retired.extend(gone.iter().map(|e| (e.epoch, now_ms)));
        self.retired
            .retain(|(_, at)| now_ms.saturating_sub(*at) < 2 * OLD_EPOCH_RETENTION_MS);
    }

    /// The newest epoch held, which is the current one.
    pub fn current_epoch(&self) -> Option<u64> {
        self.epochs.first().map(|e| e.epoch)
    }

    /// Authenticates one received frame for the track whose participant is `expected_device`
    /// and whose LiveKit source maps to `expected_slot`. The order is protocol/05's: parse
    /// (`TruncatedHeader`, `NonMinimalHeader`, then `NonCanonicalKid` for a KID of 2^24 or more —
    /// all before any key is looked up or derived), resolve the KID to its exact epoch (`UnknownKid` — the only error a caller may hold the
    /// frame for — or `StaleEpoch`), the leaf in that epoch's roster (`LeafNotInEpoch`), the
    /// roster's device for that leaf against the track's (`SenderMismatch`; a device holding two
    /// leaves in one epoch is refused too), own KID (`OwnKid`), replay (`Replay`), AEAD
    /// (`AuthFailed`), the authenticated slot against the track's (`SlotMismatch`), and only then
    /// the replay window is committed.
    pub fn decrypt(
        &mut self,
        codec: Codec,
        frame: &[u8],
        expected_device: Option<&[u8; 16]>,
        expected_slot: Slot,
        now_ms: u64,
    ) -> Result<Decrypted, SframeError> {
        self.expire(now_ms);
        let (unescaped, prefix) = unescape_protected(codec, frame)?;
        let (kid, ctr, _) = peek_kid_ctr(prefix, &unescaped)?;
        let low = u64::from(kid.epoch_low());
        let Some(entry) = self.epochs.iter_mut().find(|e| e.epoch % 256 == low) else {
            return Err(if self.retired.iter().any(|(e, _)| e % 256 == low) {
                SframeError::StaleEpoch
            } else {
                SframeError::UnknownKid
            });
        };
        let leaf = kid.leaf_index();
        let device = entry
            .roster
            .iter()
            .find(|(l, _)| *l == leaf)
            .map(|(_, d)| *d)
            .ok_or(SframeError::LeafNotInEpoch)?;
        if let Some(expected) = expected_device {
            let leaves = entry.roster.iter().filter(|(_, d)| d == expected).count();
            if device != *expected || leaves != 1 {
                return Err(SframeError::SenderMismatch);
            }
        }
        if entry.own_leaf == Some(leaf) {
            return Err(SframeError::OwnKid);
        }
        let window_key = (leaf, ctr.slot(), ctr.layer());
        entry
            .replay
            .get(&window_key)
            .copied()
            .unwrap_or_default()
            .check(ctr.seq())?;
        // `kid` is canonical (the parse refused anything else) and this entry's epoch byte, so it
        // is `Kid::new(leaf, entry.epoch)`: one key per leaf, derived once.
        let key = match entry.cache.entry(leaf) {
            std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => {
                #[cfg(test)]
                {
                    self.derived += 1;
                }
                v.insert(FrameKey::derive(&entry.base_key, kid))
            }
        };
        let (_, _, plain) = open_frame(key, prefix, &unescaped)?;
        if ctr.slot() != expected_slot as u8 {
            return Err(SframeError::SlotMismatch);
        }
        entry
            .replay
            .entry(window_key)
            .or_default()
            .commit(ctr.seq());
        Ok(Decrypted {
            kid,
            ctr,
            epoch: entry.epoch,
            leaf_index: leaf,
            frame: plain,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sframe::protect;

    const OPUS: &[u8] = &[0xfc, 0x01, 0x02, 0x03];
    const ALICE: [u8; 16] = [0xa1; 16];
    const BOB: [u8; 16] = [0xb2; 16];
    const CAROL: [u8; 16] = [0xc3; 16];

    fn base(epoch: u64) -> [u8; NK] {
        [u8::try_from(epoch % 251).unwrap(); NK]
    }

    /// One Opus frame from `leaf` in `epoch` on `slot` with `seq`, under that epoch's base key.
    fn frame(leaf: u16, epoch: u64, slot: Slot, seq: u64) -> Vec<u8> {
        let kid = Kid::new(leaf, epoch);
        let ctr = Ctr::new(slot as u8, 0, seq).unwrap();
        protect(
            &FrameKey::derive(&base(epoch), kid),
            kid,
            ctr,
            Codec::Opus,
            OPUS,
        )
        .unwrap()
    }

    /// Alice (leaf 0, this device), Bob (leaf 1), Carol (leaf 2).
    fn ring_at(epoch: u64, now_ms: u64) -> KeyRing {
        let mut r = KeyRing::new();
        r.install_epoch(
            epoch,
            base(epoch),
            &[(0, ALICE), (1, BOB), (2, CAROL)],
            Some(0),
            now_ms,
        );
        r
    }

    fn from_bob(r: &mut KeyRing, f: &[u8], now_ms: u64) -> Result<Decrypted, SframeError> {
        r.decrypt(Codec::Opus, f, Some(&BOB), Slot::Microphone, now_ms)
    }

    #[test]
    fn an_epoch_superseded_less_than_ten_seconds_ago_still_decrypts_and_then_is_stale() {
        let mut r = ring_at(1, 0);
        r.install_epoch(2, base(2), &[(0, ALICE), (1, BOB)], Some(0), 1_000);
        assert_eq!(r.current_epoch(), Some(2));
        let old = frame(1, 1, Slot::Microphone, 0);
        let d = from_bob(&mut r, &old, 10_999).expect("inside the retention");
        assert_eq!((d.epoch, d.leaf_index, d.frame.as_slice()), (1, 1, OPUS));
        assert_eq!(
            from_bob(&mut r, &frame(1, 1, Slot::Microphone, 1), 11_000),
            Err(SframeError::StaleEpoch)
        );
        assert!(from_bob(&mut r, &frame(1, 2, Slot::Microphone, 0), 11_000).is_ok());
    }

    #[test]
    fn every_epoch_inside_the_window_is_kept_not_just_the_previous_one() {
        let mut r = ring_at(1, 0);
        r.install_epoch(2, base(2), &[(0, ALICE), (1, BOB)], Some(0), 100);
        r.install_epoch(3, base(3), &[(0, ALICE), (1, BOB)], Some(0), 200);
        for e in [1, 2, 3] {
            assert!(
                from_bob(&mut r, &frame(1, e, Slot::Microphone, 0), 300).is_ok(),
                "{e}"
            );
        }
    }

    #[test]
    fn an_epoch_with_the_same_low_byte_evicts_the_held_one() {
        let mut r = ring_at(1, 0);
        r.install_epoch(257, base(257), &[(0, ALICE), (1, BOB)], Some(0), 100);
        assert_eq!(r.epochs.len(), 1);
        // KID (1, 1) now names epoch 257, whose key did not seal this frame.
        assert_eq!(
            from_bob(&mut r, &frame(1, 1, Slot::Microphone, 0), 200),
            Err(SframeError::AuthFailed)
        );
        assert!(from_bob(&mut r, &frame(1, 257, Slot::Microphone, 0), 200).is_ok());
    }

    #[test]
    fn reinstalling_a_held_epoch_keeps_its_replay_window() {
        let mut r = ring_at(5, 0);
        let f = frame(1, 5, Slot::Microphone, 0);
        assert!(from_bob(&mut r, &f, 10).is_ok());
        r.install_epoch(5, base(5), &[(0, ALICE), (1, BOB), (2, CAROL)], Some(0), 20);
        assert_eq!(from_bob(&mut r, &f, 30), Err(SframeError::Replay));
    }

    #[test]
    fn a_replayed_counter_is_refused_and_the_window_slides() {
        let mut r = ring_at(5, 0);
        for seq in [0, 1, 2] {
            assert!(from_bob(&mut r, &frame(1, 5, Slot::Microphone, seq), 0).is_ok());
        }
        assert_eq!(
            from_bob(&mut r, &frame(1, 5, Slot::Microphone, 1), 0),
            Err(SframeError::Replay)
        );
        assert!(from_bob(&mut r, &frame(1, 5, Slot::Microphone, 200), 0).is_ok());
        // 200 - 72 = 128: outside the 128-frame window.
        assert_eq!(
            from_bob(&mut r, &frame(1, 5, Slot::Microphone, 72), 0),
            Err(SframeError::Replay)
        );
        // 200 - 73 = 127: inside, never seen, accepted once.
        assert!(from_bob(&mut r, &frame(1, 5, Slot::Microphone, 73), 0).is_ok());
        assert_eq!(
            from_bob(&mut r, &frame(1, 5, Slot::Microphone, 73), 0),
            Err(SframeError::Replay)
        );
        // Windows are per (leaf, slot, layer): Carol's seq 0 is fresh.
        assert!(
            r.decrypt(
                Codec::Opus,
                &frame(2, 5, Slot::Microphone, 0),
                Some(&CAROL),
                Slot::Microphone,
                0
            )
            .is_ok()
        );
    }

    #[test]
    fn own_kid_slot_sender_and_roster_bindings_are_refused() {
        let mut r = ring_at(5, 0);
        assert_eq!(
            r.decrypt(
                Codec::Opus,
                &frame(0, 5, Slot::Microphone, 0),
                None,
                Slot::Microphone,
                0
            ),
            Err(SframeError::OwnKid)
        );
        assert_eq!(
            from_bob(&mut r, &frame(9, 5, Slot::Microphone, 0), 0),
            Err(SframeError::LeafNotInEpoch)
        );
        // Carol's KID on Bob's track: the SFU relabelled a stream.
        assert_eq!(
            from_bob(&mut r, &frame(2, 5, Slot::Microphone, 0), 0),
            Err(SframeError::SenderMismatch)
        );
        // Bob's camera frame on Bob's microphone track: authenticated, then refused, and the
        // replay window is not committed, so the same frame on the camera track is accepted.
        let cam = frame(1, 5, Slot::Camera, 0);
        assert_eq!(from_bob(&mut r, &cam, 0), Err(SframeError::SlotMismatch));
        assert!(
            r.decrypt(Codec::Opus, &cam, Some(&BOB), Slot::Camera, 0)
                .is_ok()
        );
    }

    #[test]
    fn a_device_holding_two_leaves_in_one_epoch_is_refused() {
        let mut r = KeyRing::new();
        r.install_epoch(5, base(5), &[(0, ALICE), (1, BOB), (3, BOB)], Some(0), 0);
        assert_eq!(
            from_bob(&mut r, &frame(1, 5, Slot::Microphone, 0), 0),
            Err(SframeError::SenderMismatch)
        );
    }

    #[test]
    fn a_resync_that_moves_a_device_keeps_both_kids_valid_inside_the_window() {
        // Bob is leaf 3 in epoch 5 and, after an external-commit resync, leaf 1 in epoch 6.
        let mut r = KeyRing::new();
        r.install_epoch(5, base(5), &[(0, ALICE), (3, BOB)], Some(0), 0);
        r.install_epoch(6, base(6), &[(0, ALICE), (1, BOB)], Some(0), 100);
        assert!(from_bob(&mut r, &frame(3, 5, Slot::Microphone, 0), 200).is_ok());
        assert!(from_bob(&mut r, &frame(1, 6, Slot::Microphone, 0), 200).is_ok());
    }

    #[test]
    fn a_reused_leaf_index_is_bound_to_the_device_of_its_own_epoch() {
        // Carol held leaf 2 in epoch 5 and was removed; Bob took leaf 2 in epoch 6. A frame under
        // Bob's epoch-6 KID that arrives on Carol's track is refused.
        let mut r = KeyRing::new();
        r.install_epoch(5, base(5), &[(0, ALICE), (2, CAROL)], Some(0), 0);
        r.install_epoch(6, base(6), &[(0, ALICE), (2, BOB)], Some(0), 100);
        assert_eq!(
            r.decrypt(
                Codec::Opus,
                &frame(2, 6, Slot::Microphone, 0),
                Some(&CAROL),
                Slot::Microphone,
                200
            ),
            Err(SframeError::SenderMismatch)
        );
        assert!(
            r.decrypt(
                Codec::Opus,
                &frame(2, 5, Slot::Microphone, 0),
                Some(&CAROL),
                Slot::Microphone,
                200
            )
            .is_ok()
        );
    }

    /// Every key the ring holds, over all epochs.
    fn cached_keys(r: &KeyRing) -> usize {
        r.epochs.iter().map(|e| e.cache.len()).sum()
    }

    /// A frame from `leaf` in `epoch` whose KID has `high` set above bit 24, sealed under the key
    /// that KID derives: exactly what a naive receiver would authenticate.
    fn non_canonical_frame(leaf: u16, epoch: u64, high: u64, seq: u64) -> Vec<u8> {
        let kid = Kid::from_raw(Kid::new(leaf, epoch).value() | (high << 24));
        let ctr = Ctr::new(Slot::Microphone as u8, 0, seq).unwrap();
        protect(
            &FrameKey::derive(&base(epoch), kid),
            kid,
            ctr,
            Codec::Opus,
            OPUS,
        )
        .unwrap()
    }

    /// The same leaf and epoch byte with any bit above 24 set is not a second spelling of Bob's
    /// KID: it is refused while parsing, as a hard error the hold never keeps, before the ring
    /// derives or caches a key for it.
    #[test]
    fn a_kid_of_two_to_the_24_or_more_is_refused_before_any_key_is_derived() {
        let mut r = ring_at(5, 0);
        for high in [1u64, 2, 0xff, 0xff_ffff_ffff] {
            assert_eq!(
                from_bob(&mut r, &non_canonical_frame(1, 5, high, high), 0),
                Err(SframeError::NonCanonicalKid),
                "kid with {high:#x} above bit 24"
            );
        }
        assert_eq!(cached_keys(&r), 0, "no key was cached");
        assert_eq!(r.derived, 0, "no key was derived");
        // Bob's canonical KID still works, and costs exactly one key.
        assert!(from_bob(&mut r, &frame(1, 5, Slot::Microphone, 0), 0).is_ok());
        assert_eq!((cached_keys(&r), r.derived), (1, 1));
    }

    /// The cache is bounded by the roster: one key per sending leaf per epoch, however many frames
    /// (and however many KID spellings) arrive.
    #[test]
    fn many_frames_from_n_senders_never_hold_more_than_n_keys() {
        let mut r = ring_at(5, 0);
        for seq in 0..200u64 {
            assert!(from_bob(&mut r, &frame(1, 5, Slot::Microphone, seq), 0).is_ok());
            assert!(
                r.decrypt(
                    Codec::Opus,
                    &frame(2, 5, Slot::Microphone, seq),
                    Some(&CAROL),
                    Slot::Microphone,
                    0
                )
                .is_ok()
            );
            let _ = from_bob(&mut r, &non_canonical_frame(1, 5, seq + 1, 1_000 + seq), 0);
            // A replayed frame reaches the key lookup's neighbourhood too.
            let _ = from_bob(&mut r, &frame(1, 5, Slot::Microphone, seq), 0);
            assert!(cached_keys(&r) <= 2, "after seq {seq}: {}", cached_keys(&r));
        }
        assert_eq!((cached_keys(&r), r.derived), (2, 2));
    }

    #[test]
    fn an_epoch_not_yet_installed_is_unknown_and_a_tampered_frame_fails_auth() {
        let mut r = ring_at(5, 0);
        assert_eq!(
            from_bob(&mut r, &frame(1, 6, Slot::Microphone, 0), 0),
            Err(SframeError::UnknownKid)
        );
        let mut f = frame(1, 5, Slot::Microphone, 0);
        let last = f.len() - 1;
        f[last] ^= 1;
        assert_eq!(from_bob(&mut r, &f, 0), Err(SframeError::AuthFailed));
        assert_eq!(KeyRing::new().current_epoch(), None);
    }
}
