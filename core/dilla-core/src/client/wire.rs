//! Deterministic CBOR values returned by the client and sent to the delivery service.

use crate::cbor::Encoder;
use crate::identity::DeviceList;

pub(crate) fn identity_info(
    phase: u64,
    instance: Option<&[u8; 16]>,
    user: Option<&[u8; 16]>,
    device: Option<&[u8; 16]>,
    username: &str,
    published: bool,
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(6)
        .uint(phase)
        .opt_bytes(instance.map(|x| x.as_slice()))
        .opt_bytes(user.map(|x| x.as_slice()))
        .opt_bytes(device.map(|x| x.as_slice()))
        .text(username)
        .uint(u64::from(published));
    e.into_vec()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn account_body(
    invite: &str,
    username: &str,
    display: &str,
    umk_pub: &[u8; 32],
    ssk_pub: &[u8; 32],
    sig: &[u8; 64],
    password: Option<&str>,
    device: &[u8; 16],
    dsk_pub: &[u8; 32],
    credential: &[u8],
) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(8)
        .text(invite)
        .text(username)
        .text(display)
        .bytes(umk_pub)
        .bytes(ssk_pub)
        .bytes(sig);
    match password {
        Some(s) => {
            e.text(s);
        }
        None => {
            e.null();
        }
    }
    e.array(5)
        .bytes(device)
        .bytes(dsk_pub)
        .uint(1)
        .uint(1)
        .bytes(credential);
    e.into_vec()
}

pub(crate) fn device_list_put_body(list: &DeviceList) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(4)
        .uint(list.unsigned.version)
        .bytes(&list.encode())
        .bytes(&list.sig_ssk)
        .bytes(&list.unsigned.prev_hash);
    e.into_vec()
}

pub(crate) fn session_body(nonce: &[u8; 32], purpose: u8, sig: &[u8]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(5)
        .bytes(nonce)
        .uint(u64::from(purpose))
        .bytes(sig)
        .null()
        .null();
    e.into_vec()
}

pub(crate) fn session_value(record: Option<(&str, u64, u64)>) -> Vec<u8> {
    let mut e = Encoder::new();
    match record {
        Some((token, expires, idle)) => {
            e.array(3).text(token).uint(expires).uint(idle);
        }
        None => {
            e.null();
        }
    }
    e.into_vec()
}

pub(crate) fn key_packages_body(packages: &[Vec<u8>], last: Option<&[u8]>) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).array(packages.len());
    for p in packages {
        e.bytes(p);
    }
    e.opt_bytes(last);
    e.into_vec()
}

pub(crate) fn sealed_objects(root: Option<&[u8]>, state: Option<&[u8]>) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(2).opt_bytes(root).opt_bytes(state);
    e.into_vec()
}
