#![allow(unsafe_code)] // Required only to validate and take ownership of inherited fd 3.

use crate::Helper;
use dilla_core::bot::HELPER_MAX;
use std::{
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::net::UnixStream,
    },
};
use zeroize::Zeroizing;

pub fn serve_fd3(mut helper: Helper) -> std::io::Result<()> {
    let mut kind: libc::c_int = 0;
    let mut size = std::mem::size_of_val(&kind) as libc::socklen_t;
    // fd 3 is intentionally inherited from the trusted launcher. Validate it before taking ownership.
    let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    let mut address_len = std::mem::size_of_val(&address) as libc::socklen_t;
    let valid = unsafe {
        libc::getsockopt(
            3,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut kind as *mut libc::c_int).cast(),
            &mut size,
        )
    } == 0
        && kind == libc::SOCK_STREAM
        && unsafe {
            libc::getsockname(
                3,
                (&mut address as *mut libc::sockaddr_storage).cast(),
                &mut address_len,
            )
        } == 0
        && address.ss_family as libc::c_int == libc::AF_UNIX;
    if !valid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid inherited socket",
        ));
    }
    let mut stream = unsafe { UnixStream::from_raw_fd(3) };
    loop {
        let mut prefix = [0u8; 4];
        if !read_exact_poll(&mut stream, &mut helper, &mut prefix)? {
            return Ok(());
        }
        let size = u32::from_be_bytes(prefix) as usize;
        if !(1..=HELPER_MAX).contains(&size) {
            return Ok(());
        }
        let mut body = Zeroizing::new(vec![0u8; size]);
        if !read_exact_poll(&mut stream, &mut helper, &mut body)? {
            return Ok(());
        }
        let (status, response, shutdown) = match helper.dispatch(&body) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let _ = status;
        let mut framed = Zeroizing::new(Vec::with_capacity(response.len() + 4));
        framed.extend_from_slice(
            &(u32::try_from(response.len()).map_err(|_| std::io::Error::other("frame length"))?)
                .to_be_bytes(),
        );
        framed.extend_from_slice(&response);
        if !write_all_poll(&mut stream, &mut helper, &framed)? {
            return Ok(());
        }
        if shutdown {
            return Ok(());
        }
    }
}

/// Reads without losing partial-frame progress while still waking at the active
/// transfer deadline. EOF with no bytes is a clean disconnect; partial EOF is
/// a truncated protocol frame and closes the connection.
fn read_exact_poll(
    stream: &mut UnixStream,
    helper: &mut Helper,
    out: &mut [u8],
) -> std::io::Result<bool> {
    let mut offset = 0;
    while offset < out.len() {
        helper.expire_transfer();
        let timeout = helper
            .transfer_timeout()
            .map(|left| left.max(std::time::Duration::from_millis(1)));
        stream.set_read_timeout(timeout)?;
        match stream.read(&mut out[offset..]) {
            Ok(0) => return Ok(false),
            Ok(n) => offset += n,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::Interrupted) => continue,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                helper.expire_transfer();
            }
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// Write responses under the same transfer deadline as reads. If the peer
/// stops draining a large read chunk, expiration releases transfer buffers
/// and closes this private connection.
fn write_all_poll(
    stream: &mut UnixStream,
    helper: &mut Helper,
    bytes: &[u8],
) -> std::io::Result<bool> {
    stream.set_nonblocking(true)?;
    let deadline = helper
        .transfer_timeout()
        .map(|left| std::time::Instant::now() + left);
    let mut offset = 0;
    while offset < bytes.len() {
        if deadline.is_some_and(|at| std::time::Instant::now() >= at) {
            helper.expire_transfer();
            return Ok(false);
        }
        helper.expire_transfer();
        match stream.write(&bytes[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "helper socket closed",
                ));
            }
            Ok(n) => offset += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                let timeout = deadline.map_or(-1, |at| {
                    at.saturating_duration_since(std::time::Instant::now())
                        .as_millis()
                        .saturating_add(1)
                        .min(i32::MAX as u128) as i32
                });
                let mut fd = libc::pollfd {
                    fd: stream.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let ready = unsafe { libc::poll(&mut fd, 1, timeout) };
                if ready < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                if ready == 0 {
                    helper.expire_transfer();
                    return Ok(false);
                }
            }
            Err(e) => return Err(e),
        }
    }
    if deadline.is_some_and(|at| std::time::Instant::now() >= at) {
        helper.expire_transfer();
        return Ok(false);
    }
    stream.set_nonblocking(false)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn partial_real_socket_read_wakes_at_expiry_then_keeps_frame_progress() {
        let (mut stream, mut peer) = UnixStream::pair().unwrap();
        let mut helper = Helper::new(std::env::temp_dir());
        helper.test_transfer_deadline(std::time::Instant::now() + Duration::from_millis(30));
        peer.write_all(&[0]).unwrap();
        let writer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(70));
            peer.write_all(&[0, 0, 1]).unwrap();
        });
        let mut prefix = [0; 4];
        assert!(read_exact_poll(&mut stream, &mut helper, &mut prefix).unwrap());
        writer.join().unwrap();
        assert_eq!(prefix, [0, 0, 0, 1]);
        assert!(
            helper.transfer_timeout().is_none(),
            "timeout expiration must release the transfer while preserving partial-frame progress"
        );
    }

    #[test]
    fn blocked_real_socket_write_expires_transfer_and_closes_response_path() {
        let (mut stream, _peer) = UnixStream::pair().unwrap();
        let mut helper = Helper::new(std::env::temp_dir());
        helper.test_completed_transfer_deadline(
            std::time::Instant::now() + Duration::from_millis(30),
        );
        let response = Zeroizing::new(vec![0x5a; 8 * 1024 * 1024]);
        let started = std::time::Instant::now();
        assert!(!write_all_poll(&mut stream, &mut helper, &response).unwrap());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(helper.transfer_timeout().is_none());
    }

    #[test]
    fn write_progress_after_expiry_still_uses_captured_deadline() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let mut helper = Helper::new(std::env::temp_dir());
        helper.test_completed_transfer_deadline(
            std::time::Instant::now() + Duration::from_millis(50),
        );
        let response = Zeroizing::new(vec![0x5a; 8 * 1024 * 1024]);
        let (sent, received) = std::sync::mpsc::channel();
        let writer = thread::spawn(move || {
            let mut helper = helper;
            let mut stream = stream;
            let result = write_all_poll(&mut stream, &mut helper, &response).unwrap();
            sent.send(result).unwrap();
        });
        let reader = thread::spawn(move || {
            let until = std::time::Instant::now() + Duration::from_millis(120);
            let mut received = 0;
            let mut buf = [0; 4096];
            while std::time::Instant::now() < until {
                match peer.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => received += n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => panic!("socket reader failed: {e}"),
                }
                thread::sleep(Duration::from_millis(2));
            }
            received
        });
        assert!(
            !received.recv_timeout(Duration::from_millis(300)).unwrap(),
            "the writer must stop at the transfer deadline even after state cleanup"
        );
        writer.join().unwrap();
        assert!(
            reader.join().unwrap() > 0,
            "test must make partial write progress"
        );
    }
}
