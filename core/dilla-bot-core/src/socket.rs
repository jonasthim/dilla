#![allow(unsafe_code)] // Required only to validate and take ownership of inherited fd 3.

use crate::Helper;
use dilla_core::bot::HELPER_MAX;
use std::{
    io::{Read, Write},
    os::{fd::FromRawFd, unix::net::UnixStream},
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
        match stream.read_exact(&mut prefix) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        }
        let size = u32::from_be_bytes(prefix) as usize;
        if !(1..=HELPER_MAX).contains(&size) {
            return Ok(());
        }
        let mut body = Zeroizing::new(vec![0u8; size]);
        if stream.read_exact(&mut body).is_err() {
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
        stream.write_all(&framed)?;
        if shutdown {
            return Ok(());
        }
    }
}
