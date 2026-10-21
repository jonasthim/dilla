use crate::{
    control::{self, Control},
    pcm,
    session_lifecycle::ShutdownGuard,
    source,
};
use librespot::{
    core::{Session, SpotifyUri},
    playback::{
        audio_backend::{Sink, SinkError, SinkResult},
        config::PlayerConfig,
        convert::Converter,
        decoder::AudioPacket,
        mixer::VolumeGetter,
        player::{Player, PlayerEvent},
    },
};
use std::{
    io::IsTerminal,
    os::fd::{AsFd, AsRawFd},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU16, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
enum InputEvent {
    Control(Control),
    Eof,
    Error,
}

struct ProbeVolume(Arc<AtomicU16>);
impl VolumeGetter for ProbeVolume {
    fn attenuation_factor(&self) -> f64 {
        let v = self.0.load(Ordering::Relaxed) as f64 / 100.0;
        v * v * v
    }
}

struct PcmSink {
    first_pcm: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

impl Sink for PcmSink {
    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let bytes = match packet {
            AudioPacket::Samples(samples) => pcm::encode_s16_le(&samples, converter),
            AudioPacket::Raw(_) => return self.fail(),
        };
        if bytes.is_empty() {
            return Ok(());
        }
        let stdout = std::io::stdout();
        match pcm::write_fd_deadline(&stdout, &bytes, self.deadline, &|| {
            self.cancelled.load(Ordering::Acquire)
        }) {
            Ok(()) => {
                self.first_pcm.store(true, Ordering::Release);
                Ok(())
            }
            Err(_) => self.fail(),
        }
    }
}

impl PcmSink {
    fn fail<T>(&mut self) -> SinkResult<T> {
        self.failed.store(true, Ordering::Release);
        self.cancelled.store(true, Ordering::Release);
        Err(SinkError::OnWrite("output unavailable".into()))
    }
}

fn enable_nonblocking_stdout() -> Result<pcm::NonblockingGuard, &'static str> {
    pcm::NonblockingGuard::new(std::io::stdout().as_raw_fd()).map_err(|_| "output unavailable")
}

fn control_reader() -> std::sync::mpsc::Receiver<InputEvent> {
    start_control_reader(std::io::stdin())
}

fn start_control_reader<R: AsFd + Send + 'static>(
    reader: R,
) -> std::sync::mpsc::Receiver<InputEvent> {
    let (tx, rx) = std::sync::mpsc::sync_channel(4);
    std::thread::spawn(move || {
        read_control_loop(reader, tx);
    });
    rx
}

fn read_control_loop<R: AsFd>(reader: R, tx: std::sync::mpsc::SyncSender<InputEvent>) {
    let mut line = Vec::with_capacity(128);
    loop {
        let fd = reader.as_fd();
        let mut pollfd = [nix::poll::PollFd::new(fd, nix::poll::PollFlags::POLLIN)];
        match nix::poll::poll(&mut pollfd, nix::poll::PollTimeout::from(100u16)) {
            Ok(0) => continue,
            Err(nix::errno::Errno::EINTR) => continue,
            Err(_) => {
                let _ = tx.send(InputEvent::Error);
                break;
            }
            Ok(_) => {}
        }
        let mut chunk = [0u8; 512];
        match nix::unistd::read(fd.as_raw_fd(), &mut chunk) {
            Ok(0) => {
                let _ = tx.send(if line.is_empty() {
                    InputEvent::Eof
                } else {
                    InputEvent::Error
                });
                break;
            }
            Ok(count) => {
                for byte in &chunk[..count] {
                    if *byte == b'\n' {
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        match control::parse_control(&line) {
                            Ok(command) => {
                                if tx.send(InputEvent::Control(command)).is_err() {
                                    return;
                                }
                            }
                            Err(_) => {
                                let _ = tx.send(InputEvent::Error);
                                return;
                            }
                        }
                        line.clear();
                    } else {
                        if line.len() == 4096 {
                            let _ = tx.send(InputEvent::Error);
                            return;
                        }
                        line.push(*byte);
                    }
                }
            }
            Err(nix::errno::Errno::EINTR) => continue,
            Err(_) => {
                let _ = tx.send(InputEvent::Error);
                return;
            }
        }
    }
}

pub async fn play(session: Session, input: &str, max_seconds: u64) -> Result<(), &'static str> {
    let session = ShutdownGuard::new(session);
    if librespot::playback::SAMPLE_RATE != 44_100 || librespot::playback::NUM_CHANNELS != 2 {
        return Err("pcm format unavailable");
    }
    if !(1..=300).contains(&max_seconds) {
        return Err("invalid duration");
    }
    if std::io::stdout().is_terminal() {
        return Err("terminal output refused");
    }
    let parsed = match source::parse_source(input) {
        Ok(parsed) => parsed,
        Err(error) => return Err(error),
    };
    if parsed.kind != source::Kind::Track {
        return Err("track required");
    }
    let uri = SpotifyUri::from_uri(&format!("spotify:track:{}", parsed.id))
        .map_err(|_| "invalid source")?;
    let _stdout_flags = match enable_nonblocking_stdout() {
        Ok(guard) => guard,
        Err(error) => return Err(error),
    };
    let deadline = Instant::now() + Duration::from_secs(max_seconds);
    let first_pcm = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let volume = Arc::new(AtomicU16::new(100));
    let first_for_sink = first_pcm.clone();
    let failed_for_sink = failed.clone();
    let cancel_for_sink = cancelled.clone();
    let player = Player::new(
        PlayerConfig::default(),
        session.session().clone(),
        Box::new(ProbeVolume(volume.clone())),
        move || {
            Box::new(PcmSink {
                first_pcm: first_for_sink,
                failed: failed_for_sink,
                deadline,
                cancelled: cancel_for_sink,
            }) as Box<dyn Sink>
        },
    );
    let mut events = player.get_player_event_channel();
    let input_events = control_reader();
    player.load(uri, true, 0);
    crate::status("ok", "play", "submitted");
    let timer = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
    tokio::pin!(timer);
    let mut first_pcm_reported = false;
    let outcome = loop {
        tokio::select! {
            _ = &mut timer => { break Err("playback deadline"); }
            Some(event) = events.recv() => {
                match event {
                    PlayerEvent::Playing { position_ms, .. } => crate::status_position("playing", position_ms),
                    PlayerEvent::Paused { position_ms, .. } => crate::status_position("paused", position_ms),
                    PlayerEvent::Seeked { position_ms, .. } => { crate::status_position("seeked", position_ms); }
                    PlayerEvent::EndOfTrack { .. } => { crate::status("ok", "play", "end-of-track"); break Ok(()); }
                    PlayerEvent::Unavailable { .. } => { crate::status("error", "play", "unavailable"); break Err("track unavailable"); }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(10)) => {
                match input_events.try_recv() {
                    Ok(InputEvent::Control(control)) => {
                        match control {
                            Control::Pause => player.pause(),
                            Control::Resume => player.play(),
                            Control::Stop => { player.stop(); crate::status("ok", "control", "submitted"); break Ok(()); }
                            Control::Seek { position_ms } => player.seek(position_ms),
                            Control::Volume { value } => { volume.store(value as u16, Ordering::Relaxed); }
                        }
                        crate::status("ok", "control", "submitted");
                    }
                    Ok(InputEvent::Eof) | Ok(InputEvent::Error) => { cancelled.store(true, Ordering::Release); player.stop(); break Err("control input ended"); }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => { cancelled.store(true, Ordering::Release); player.stop(); break Err("control unavailable"); }
                }
            }
        }
        if failed.load(Ordering::Acquire) {
            crate::status("error", "play", "output-unavailable");
            break Err("output unavailable");
        }
        if first_pcm.load(Ordering::Acquire) && !first_pcm_reported {
            first_pcm_reported = true;
            crate::status("ok", "play", "first-pcm-written");
        }
    };
    cancelled.store(true, Ordering::Release);
    drop(session);
    player.stop();
    drop(player);
    outcome
}

pub fn smoke() -> Result<(), &'static str> {
    if std::io::stdout().is_terminal() {
        return Err("terminal output refused");
    }
    let _stdout_flags = enable_nonblocking_stdout()?;
    let deadline = Instant::now() + Duration::from_millis(750);
    let mut samples = Vec::with_capacity(44_100 * 2);
    for frame in 0..44_100u32 {
        let sample = ((frame as f64 * 440.0 * std::f64::consts::TAU / 44_100.0).sin()) * 0.35;
        samples.push(sample);
        samples.push(sample);
    }
    let first_pcm = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut sink = PcmSink {
        first_pcm: first_pcm.clone(),
        failed,
        deadline,
        cancelled,
    };
    let mut converter = Converter::new(None);
    sink.write(AudioPacket::Samples(samples), &mut converter)
        .map_err(|_| "output unavailable")?;
    if !first_pcm.load(Ordering::Acquire) {
        return Err("output unavailable");
    }
    crate::status("ok", "pcm-smoke", "first-pcm-written");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_sample_packet_does_not_claim_first_pcm() {
        let first_pcm = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut sink = PcmSink {
            first_pcm: first_pcm.clone(),
            failed,
            deadline: Instant::now() + Duration::from_secs(1),
            cancelled,
        };
        sink.write(AudioPacket::Samples(Vec::new()), &mut Converter::new(None))
            .unwrap();
        assert!(!first_pcm.load(Ordering::Acquire));
    }

    #[test]
    fn complete_control_line_is_consumed_while_pipe_stays_open() {
        let (reader, writer) = nix::unistd::pipe().unwrap();
        let rx = start_control_reader(reader);
        nix::unistd::write(&writer, b"{\"op\":\"pause\"}\n").unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            InputEvent::Control(Control::Pause)
        );
        drop(writer);
    }
}
