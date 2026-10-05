//! The sending side (protocol/05 "Counter partition", "Sender uniqueness").
//!
//! N1: a sender created after its device committed epoch `min_epoch` encrypts only in epochs at or
//! above it, so a restarted worker can never reuse a `(KID, CTR)` of a previous worker life.
//! N3: `seq` runs per `(epoch, slot, layer)` for the life of the `SenderCounters` and is never
//! reset by a rekey or by a transform being re-created. Refuse-on-wrap: the counter after
//! `MAX_SEQ` is `CounterExhausted`, and the caller rekeys through an MLS `Update`.

use std::collections::BTreeMap;

use super::h264::{canonicalize_h264, check_prefix_sps};
use super::{Codec, Ctr, FrameKey, Kid, MAX_SEQ, NK, SframeError, Slot, prefix_len, protect};

pub struct SenderCounters {
    min_epoch: u64,
    next: BTreeMap<(u64, u8, u8), u64>,
    exhausted: bool,
}

impl SenderCounters {
    pub fn new(min_epoch: u64) -> Self {
        Self {
            min_epoch,
            next: BTreeMap::new(),
            exhausted: false,
        }
    }

    /// The next counter for `(epoch, slot, layer)`. `StaleEpoch` below `min_epoch`,
    /// `LayerOutOfRange` above layer 15, `CounterExhausted` once `seq` would pass `MAX_SEQ`.
    pub fn next(&mut self, epoch: u64, slot: Slot, layer: u8) -> Result<Ctr, SframeError> {
        if epoch < self.min_epoch {
            return Err(SframeError::StaleEpoch);
        }
        if layer > 0xf {
            return Err(SframeError::LayerOutOfRange);
        }
        let seq = self.next.entry((epoch, slot as u8, layer)).or_insert(0);
        if *seq > MAX_SEQ {
            self.exhausted = true;
            return Err(SframeError::CounterExhausted);
        }
        let ctr = Ctr::new(slot as u8, layer, *seq)?;
        *seq += 1;
        Ok(ctr)
    }

    /// True once any counter has been refused for exhaustion.
    pub fn exhausted(&self) -> bool {
        self.exhausted
    }
}

/// One device's sender for one call: the current epoch's KID and key, and the counters.
pub struct SframeSender {
    epoch: u64,
    kid: Kid,
    key: FrameKey,
    counters: SenderCounters,
}

impl SframeSender {
    /// `StaleEpoch` when `epoch < min_epoch` (N1).
    pub fn new(
        base_key: &[u8; NK],
        leaf_index: u16,
        epoch: u64,
        min_epoch: u64,
    ) -> Result<Self, SframeError> {
        if epoch < min_epoch {
            return Err(SframeError::StaleEpoch);
        }
        let kid = Kid::new(leaf_index, epoch);
        Ok(Self {
            epoch,
            kid,
            key: FrameKey::derive(base_key, kid),
            counters: SenderCounters::new(min_epoch),
        })
    }

    /// Switches to a new epoch's key. The counters carry on; an epoch below `min_epoch` makes
    /// every later `encrypt` fail `StaleEpoch`.
    pub fn rekey(&mut self, base_key: &[u8; NK], leaf_index: u16, epoch: u64) {
        self.epoch = epoch;
        self.kid = Kid::new(leaf_index, epoch);
        self.key = FrameKey::derive(base_key, self.kid);
    }

    /// Checks the frame's codec shape first (so a refused frame spends no counter), takes the
    /// next counter, and runs `protect`. An H.264 frame whose prefix carries an SPS a libwebrtc
    /// receiver would rewrite is `NonCanonicalSps`.
    pub fn encrypt(
        &mut self,
        codec: Codec,
        slot: Slot,
        layer: u8,
        frame: &[u8],
    ) -> Result<Vec<u8>, SframeError> {
        if codec == Codec::H264 {
            let (canonical, prefix) = canonicalize_h264(frame)?;
            check_prefix_sps(&canonical[..prefix])?;
        } else {
            prefix_len(codec, frame)?;
        }
        let ctr = self.counters.next(self.epoch, slot, layer)?;
        protect(&self.key, self.kid, ctr, codec, frame)
    }

    pub fn exhausted(&self) -> bool {
        self.counters.exhausted()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sframe::{FrameKey, open_frame, peek_kid_ctr, unescape_protected};

    const BASE: [u8; NK] = [0x0a; NK];

    #[test]
    fn counters_run_per_epoch_slot_and_layer_and_survive_a_rekey() {
        let mut c = SenderCounters::new(5);
        assert_eq!(c.next(5, Slot::Camera, 0).unwrap().seq(), 0);
        assert_eq!(c.next(5, Slot::Camera, 0).unwrap().seq(), 1);
        assert_eq!(c.next(5, Slot::Camera, 1).unwrap().seq(), 0);
        assert_eq!(c.next(5, Slot::Microphone, 0).unwrap().seq(), 0);
        assert_eq!(c.next(6, Slot::Camera, 0).unwrap().seq(), 0);
        // Back in epoch 5 (a sender that rekeys to 6 and back cannot exist, but the map must
        // never restart a sequence it has handed out).
        assert_eq!(c.next(5, Slot::Camera, 0).unwrap().seq(), 2);
        let ctr = c.next(5, Slot::ScreenVideo, 3).unwrap();
        assert_eq!((ctr.slot(), ctr.layer(), ctr.seq()), (2, 3, 0));
    }

    #[test]
    fn counters_refuse_below_min_epoch_and_above_layer_fifteen() {
        let mut c = SenderCounters::new(5);
        assert_eq!(c.next(4, Slot::Camera, 0), Err(SframeError::StaleEpoch));
        assert_eq!(
            c.next(5, Slot::Camera, 16),
            Err(SframeError::LayerOutOfRange)
        );
        assert!(!c.exhausted());
    }

    #[test]
    fn counters_refuse_at_max_seq_plus_one() {
        let mut c = SenderCounters::new(0);
        c.next.insert((0, Slot::Microphone as u8, 0), MAX_SEQ);
        assert_eq!(c.next(0, Slot::Microphone, 0).unwrap().seq(), MAX_SEQ);
        assert_eq!(
            c.next(0, Slot::Microphone, 0),
            Err(SframeError::CounterExhausted)
        );
        assert!(c.exhausted());
        // Other counters still work; the caller rekeys on `exhausted()`.
        assert_eq!(c.next(0, Slot::Camera, 0).unwrap().seq(), 0);
    }

    #[test]
    fn a_sender_below_its_min_epoch_is_refused() {
        assert!(matches!(
            SframeSender::new(&BASE, 3, 4, 5),
            Err(SframeError::StaleEpoch)
        ));
        let mut s = SframeSender::new(&BASE, 3, 5, 5).expect("sender");
        s.rekey(&BASE, 3, 4);
        assert_eq!(
            s.encrypt(Codec::Opus, Slot::Microphone, 0, &[0xfc, 1]),
            Err(SframeError::StaleEpoch)
        );
    }

    #[test]
    fn the_sender_reproduces_the_vp8_key_vector_and_rekeys() {
        let mut s = SframeSender::new(&BASE, 3, 297, 297).expect("sender");
        s.counters.next.insert((297, Slot::Camera as u8, 2), 1000);
        let input = [
            0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01, 1, 2, 3, 4, 5, 6, 7, 8,
        ];
        let out = s
            .encrypt(Codec::Vp8, Slot::Camera, 2, &input)
            .expect("encrypt");
        let hex: String = out.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5002009d012a8002e0019f032901200000000003e8690e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0ba"
        );
        s.rekey(&BASE, 1, 298);
        let next = s
            .encrypt(Codec::Vp8, Slot::Camera, 2, &input)
            .expect("encrypt");
        let (unescaped, prefix) = unescape_protected(Codec::Vp8, &next).expect("prefix");
        let (kid, ctr, _) = peek_kid_ctr(prefix, &unescaped).expect("header");
        assert_eq!((kid, ctr.seq()), (Kid::new(1, 298), 0));
        let (_, _, plain) =
            open_frame(&FrameKey::derive(&BASE, kid), prefix, &unescaped).expect("open");
        assert_eq!(plain, input);
    }

    #[test]
    fn a_refused_frame_spends_no_counter() {
        let mut s = SframeSender::new(&BASE, 0, 1, 1).expect("sender");
        assert_eq!(
            s.encrypt(Codec::Vp8, Slot::Camera, 0, &[0x50, 0x02]),
            Err(SframeError::MalformedPrefix)
        );
        let ok = s
            .encrypt(Codec::Vp8, Slot::Camera, 0, &[0x31, 1, 2])
            .expect("encrypt");
        let (unescaped, prefix) = unescape_protected(Codec::Vp8, &ok).expect("prefix");
        assert_eq!(peek_kid_ctr(prefix, &unescaped).expect("header").1.seq(), 0);
    }

    #[test]
    fn h264_with_a_receiver_rewritable_sps_is_refused_at_the_source() {
        let mut s = SframeSender::new(&BASE, 0, 1, 1).expect("sender");
        let synthetic = [
            0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0x95, 0xa0, 0x50, 0x1e, 0xc8, 0, 0, 0, 1, 0x65,
            0x88, 0x84, 0x21,
        ];
        assert_eq!(
            s.encrypt(Codec::H264, Slot::Camera, 0, &synthetic),
            Err(SframeError::NonCanonicalSps)
        );
        let stable: Vec<u8> = [0u8, 0, 0, 1]
            .into_iter()
            .chain([
                0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0x80, 0x78, 0x44, 0x23, 0x50,
            ])
            .chain([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21, 0xff])
            .collect();
        assert!(s.encrypt(Codec::H264, Slot::Camera, 0, &stable).is_ok());
    }
}
