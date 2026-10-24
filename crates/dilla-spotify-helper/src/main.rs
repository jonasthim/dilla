use dilla_spotify_helper::{
    Control, ErrorCode, PCM_BYTES_PER_FRAME, PcmFrame, Phase, Status, parse_access_token,
    read_control, read_inherited_credential, write_pcm,
};
use librespot::{
    core::{Session, SpotifyUri, authentication::Credentials, config::SessionConfig},
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
    io::{self, IsTerminal, Write},
    os::fd::{AsRawFd, RawFd},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

struct Volume(Arc<AtomicU8>);
impl VolumeGetter for Volume {
    fn attenuation_factor(&self) -> f64 {
        let v = self.0.load(Ordering::Relaxed) as f64 / 100.0;
        v * v * v
    }
}

struct SessionGuard(Session);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

struct PcmSink {
    bytes: Vec<u8>,
    rate_phase: u32,
    failed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}
impl PcmSink {
    fn emit(&mut self, converter: &mut Converter) -> SinkResult<()> {
        while self.bytes.len() >= PCM_BYTES_PER_FRAME {
            let frame = PcmFrame::new(self.bytes.drain(..PCM_BYTES_PER_FRAME).collect())
                .map_err(|_| SinkError::OnWrite("invalid pcm frame".into()))?;
            let mut encoded = Vec::with_capacity(PCM_BYTES_PER_FRAME + 9);
            let stdout = io::stdout();
            write_pcm(&mut encoded, &frame)
                .and_then(|_| write_fd_deadline(&stdout, &encoded, &self.cancelled))
                .map_err(|_| SinkError::OnWrite("output unavailable".into()))?;
        }
        let _ = converter;
        Ok(())
    }
}

fn write_fd_deadline(
    fd: &impl std::os::fd::AsFd,
    mut bytes: &[u8],
    cancelled: &AtomicBool,
) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !bytes.is_empty() {
        if cancelled.load(Ordering::Acquire) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "output deadline"));
        }
        match nix::unistd::write(fd, bytes) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "output unavailable",
                ));
            }
            Ok(n) => bytes = &bytes[n..],
            Err(nix::errno::Errno::EINTR) => continue,
            Err(nix::errno::Errno::EAGAIN) => std::thread::sleep(Duration::from_millis(2)),
            Err(err) => return Err(io::Error::from(err)),
        }
    }
    Ok(())
}

struct NonblockingGuard {
    fd: RawFd,
    original: nix::fcntl::OFlag,
}
impl NonblockingGuard {
    fn new(fd: RawFd) -> io::Result<Self> {
        use nix::fcntl::{FcntlArg, OFlag, fcntl};
        let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(io::Error::from)?;
        let original = OFlag::from_bits_truncate(flags);
        fcntl(fd, FcntlArg::F_SETFL(original | OFlag::O_NONBLOCK)).map_err(io::Error::from)?;
        Ok(Self { fd, original })
    }
}
impl Drop for NonblockingGuard {
    fn drop(&mut self) {
        let _ = nix::fcntl::fcntl(self.fd, nix::fcntl::FcntlArg::F_SETFL(self.original));
    }
}
impl Sink for PcmSink {
    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let AudioPacket::Samples(samples) = packet else {
            self.failed.store(true, Ordering::Release);
            return Err(SinkError::OnWrite("unsupported audio packet".into()));
        };
        // librespot 0.8 decodes at 44.1 kHz. A phase accumulator performs bounded
        // nearest-sample conversion to the helper's 48 kHz output contract.
        let samples = converter.f64_to_s16(&samples);
        for stereo in samples.as_chunks::<2>().0 {
            self.rate_phase += 48_000;
            while self.rate_phase >= 44_100 {
                self.bytes.extend_from_slice(&stereo[0].to_le_bytes());
                self.bytes.extend_from_slice(&stereo[1].to_le_bytes());
                self.rate_phase -= 44_100;
            }
        }
        if let Err(err) = self.emit(converter) {
            self.failed.store(true, Ordering::Release);
            return Err(err);
        }
        Ok(())
    }
}

fn report(status: Status) {
    if let Ok(frame) = status.encode() {
        let mut stderr = io::stderr().lock();
        let _ = stderr.write_all(&frame);
        let _ = stderr.flush();
    }
}

fn controls() -> mpsc::Receiver<Result<Control, ()>> {
    let (tx, rx) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        loop {
            match read_control(io::stdin().lock()) {
                Ok(bytes) => match dilla_spotify_helper::parse_control(&bytes) {
                    Ok(control) => {
                        if tx.send(Ok(control)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Err(()));
                        break;
                    }
                },
                Err(_) => {
                    let _ = tx.send(Err(()));
                    break;
                }
            }
        }
    });
    rx
}

fn parse_track(s: &str) -> Result<SpotifyUri, ErrorCode> {
    let id = s
        .strip_prefix("spotify:track:")
        .ok_or(ErrorCode::InvalidRequest)?;
    if id.len() != 22 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(ErrorCode::InvalidRequest);
    }
    SpotifyUri::from_uri(s).map_err(|_| ErrorCode::InvalidRequest)
}

async fn run() -> Result<(), (Phase, ErrorCode)> {
    if io::stdout().is_terminal() {
        return Err((Phase::Startup, ErrorCode::InvalidRequest));
    }
    if librespot::playback::SAMPLE_RATE != 44_100 || librespot::playback::NUM_CHANNELS != 2 {
        return Err((Phase::Startup, ErrorCode::Internal));
    }
    let mut args = std::env::args().skip(1);
    let target = args
        .next()
        .ok_or((Phase::Startup, ErrorCode::InvalidRequest))?;
    if args.next().is_some() {
        return Err((Phase::Startup, ErrorCode::InvalidRequest));
    }
    let uri = parse_track(&target).map_err(|e| (Phase::Startup, e))?;
    report(Status::success(Phase::Startup));
    let secret = read_inherited_credential()
        .map_err(|_| (Phase::Authorization, ErrorCode::CredentialUnavailable))?;
    let access_token = parse_access_token(secret.expose())
        .map_err(|_| (Phase::Authorization, ErrorCode::CredentialUnavailable))?;
    let credentials = Credentials::with_access_token(access_token);
    drop(secret);
    let session = SessionGuard(Session::new(SessionConfig::default(), None));
    match tokio::time::timeout(
        Duration::from_secs(30),
        session.0.connect(credentials, false),
    )
    .await
    {
        Ok(Ok(())) => {}
        _ => {
            return Err((Phase::Authorization, ErrorCode::ProviderUnavailable));
        }
    }
    report(Status::success(Phase::Authorization));
    let player_failed = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let failed = player_failed.clone();
    let sink_cancelled = cancelled.clone();
    let volume = Arc::new(AtomicU8::new(100));
    let player_volume = volume.clone();
    let _stdout_nonblocking = NonblockingGuard::new(io::stdout().as_raw_fd())
        .map_err(|_| (Phase::Startup, ErrorCode::Internal))?;
    let player = Player::new(
        PlayerConfig::default(),
        session.0.clone(),
        Box::new(Volume(player_volume)),
        move || {
            Box::new(PcmSink {
                bytes: Vec::with_capacity(PCM_BYTES_PER_FRAME * 2),
                rate_phase: 0,
                failed,
                cancelled: sink_cancelled,
            }) as Box<dyn Sink>
        },
    );
    let mut events = player.get_player_event_channel();
    let input = controls();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| (Phase::Startup, ErrorCode::Internal))?;
    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);
    player.load(uri, true, 0);
    report(Status::success(Phase::Playback));
    let result = loop {
        tokio::select! {
            _ = &mut ctrl_c => break Err((Phase::Shutdown, ErrorCode::Cancelled)),
            _ = terminate.recv() => break Err((Phase::Shutdown, ErrorCode::Cancelled)),
            Some(event) = events.recv() => match event {
                PlayerEvent::EndOfTrack { .. } => break Ok(()),
                PlayerEvent::Unavailable { .. } => break Err((Phase::Playback, ErrorCode::ProviderUnavailable)),
                _ => {}
            },
            _ = tokio::time::sleep(Duration::from_millis(10)) => {
                if player_failed.load(Ordering::Acquire) { break Err((Phase::Playback, ErrorCode::ProviderUnavailable)); }
                match input.try_recv() {
                    Ok(Ok(Control::Pause)) => player.pause(),
                    Ok(Ok(Control::Resume)) => player.play(),
                    Ok(Ok(Control::Seek { position_ms })) => player.seek(position_ms),
                    Ok(Ok(Control::Stop)) => { player.stop(); break Ok(()); },
                    Ok(Ok(Control::Volume { value })) => volume.store(value, Ordering::Relaxed),
                    Ok(Err(())) | Err(mpsc::TryRecvError::Disconnected) => break Err((Phase::Control, ErrorCode::Cancelled)),
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
        }
    };
    cancelled.store(true, Ordering::Release);
    // Invalidate the stream before Player::drop joins its worker thread.
    // The worker may otherwise remain blocked on session-backed reads.
    session.0.shutdown();
    player.stop();
    drop(player);
    drop(session);
    result
}

#[tokio::main]
async fn main() {
    if let Err((phase, code)) = run().await {
        report(Status::failure(phase, code));
        std::process::exit(1);
    }
    report(Status::success(Phase::Shutdown));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_canonical_track_uris_can_start_playback() {
        assert!(parse_track("spotify:track:0123456789012345678901").is_ok());
        for source in [
            "spotify:album:0123456789012345678901",
            "spotify:playlist:0123456789012345678901",
            "https://open.spotify.com/track/0123456789012345678901",
            "spotify:track:0123456789012345678901?x=1",
            "spotify:track:012345678901234567890",
        ] {
            assert!(parse_track(source).is_err(), "accepted {source}");
        }
    }
}
