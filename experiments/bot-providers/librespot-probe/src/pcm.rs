#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn writes_interleaved_stereo_signed_16_little_endian_and_clamps() {
        let mut converter = librespot::playback::convert::Converter::new(None);
        let bytes = encode_s16_le(&[0.1422, -0.00006103515625, 2.0, -2.0], &mut converter);
        assert_eq!(bytes, [0x34, 0x12, 0xfe, 0xff, 0xff, 0x7f, 0x00, 0x80]);
    }

    #[test]
    fn nonblocking_mode_is_restored_for_shared_pipe_descriptors() {
        use std::os::fd::AsRawFd;
        let (_reader, writer) = nix::unistd::pipe().unwrap();
        let duplicate = nix::unistd::dup(writer.as_raw_fd()).unwrap();
        let fd = duplicate;
        let before = nix::fcntl::fcntl(fd, nix::fcntl::FcntlArg::F_GETFL).unwrap();
        {
            let _guard = NonblockingGuard::new(fd).unwrap();
            let during = nix::fcntl::fcntl(fd, nix::fcntl::FcntlArg::F_GETFL).unwrap();
            assert_ne!(during & nix::libc::O_NONBLOCK, 0);
        }
        let after = nix::fcntl::fcntl(fd, nix::fcntl::FcntlArg::F_GETFL).unwrap();
        assert_eq!(after, before);
        nix::unistd::close(duplicate).unwrap();
    }
}

use std::io;

pub fn encode_s16_le(
    samples: &[f64],
    converter: &mut librespot::playback::convert::Converter,
) -> Vec<u8> {
    let samples = converter.f64_to_s16(samples);
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

pub fn write_stdout(bytes: &[u8], timeout: std::time::Duration) -> io::Result<()> {
    let stdout = std::io::stdout();
    let _guard = NonblockingGuard::new(stdout.as_raw_fd())?;
    write_fd_deadline(&stdout, bytes, std::time::Instant::now() + timeout, &|| {
        false
    })
}

pub fn write_stderr(bytes: &[u8]) {
    let stderr = std::io::stderr();
    let Ok(_guard) = NonblockingGuard::new(stderr.as_raw_fd()) else {
        return;
    };
    let _ = write_fd_deadline(
        &stderr,
        bytes,
        std::time::Instant::now() + std::time::Duration::from_millis(100),
        &|| false,
    );
}

pub fn write_fd_deadline(
    fd: &impl std::os::fd::AsFd,
    mut bytes: &[u8],
    deadline: std::time::Instant,
    cancelled: &dyn Fn() -> bool,
) -> io::Result<()> {
    while !bytes.is_empty() {
        if cancelled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        if std::time::Instant::now() >= deadline {
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
            Err(nix::errno::Errno::EAGAIN) => {
                std::thread::sleep(std::time::Duration::from_millis(2))
            }
            Err(error) => return Err(io::Error::from(error)),
        }
    }
    Ok(())
}

pub struct NonblockingGuard {
    fd: std::os::fd::RawFd,
    original: nix::fcntl::OFlag,
}

impl NonblockingGuard {
    pub fn new(fd: std::os::fd::RawFd) -> io::Result<Self> {
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

use std::os::fd::AsRawFd;
