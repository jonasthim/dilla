#![cfg(not(target_arch = "wasm32"))]

//! Development-only public-CBOR peer fixture consumed by the Go native adapter integration test.
//! MLS signing keys stay in this process; only public group inputs and delivery frames cross files.

#[path = "client_support/mod.rs"]
mod client_support;

use client_support::{GROUP, Instance, OTHER_GROUP, RawPeer, Relay, text_binding};
use dilla_core::cbor::{Encoder, decode_strict};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

fn write(path: &PathBuf, bytes: &[u8]) {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).expect("write fixture output");
    fs::rename(tmp, path).expect("publish fixture output");
}

#[test]
fn bridge_public_cbor_peer() {
    let Ok(root) = std::env::var("DILLA_NATIVE_GROUP_FIXTURE_DIR") else {
        return;
    };
    let root = PathBuf::from(root);
    fs::create_dir_all(&root).expect("fixture directory");
    let mut relay = Relay::new(GROUP);
    let instance = Instance::generate();
    let mut peer = RawPeer::new(0xb2, 0xb3);
    peer.create(&mut relay, &instance);
    let mut welcome_relay = Relay::new(OTHER_GROUP);
    let mut welcome_peer = RawPeer::new(0xc2, 0xc3);
    welcome_peer.create_as(&mut welcome_relay, &instance, &text_binding([0x34; 16]));

    let put = peer.device_list_body();
    let (history, heads) = decode_strict(&put, |d| {
        d.array(4)?;
        let version = d.uint()?;
        let blob = d.bytes()?.to_vec();
        let sig = d.bytes()?.to_vec();
        let prev = d.bytes()?.to_vec();
        let mut e = Encoder::new();
        e.array(1)
            .array(4)
            .uint(version)
            .bytes(&blob)
            .bytes(&sig)
            .bytes(&prev);
        Ok((e.into_vec(), blob))
    })
    .expect("device-list PUT shape");
    let info = relay.info_body();
    let tree = relay.tree_body();
    let mut ready = Encoder::new();
    ready
        .array(5)
        .bytes(&info)
        .bytes(&tree)
        .bytes(&history)
        .bytes(&heads)
        .uint(relay.leaf_of(peer.device) as u64);
    write(&root.join("ready.cbor"), &ready.into_vec());

    let request = root.join("request.cbor");
    let response = root.join("response.cbor");
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if Instant::now() >= deadline {
            panic!("Go peer fixture timed out");
        }
        if !request.exists() {
            thread::sleep(Duration::from_millis(5));
            continue;
        }
        let bytes = fs::read(&request).expect("read fixture request");
        fs::remove_file(&request).expect("consume fixture request");
        let (op, data) = decode_strict(&bytes, |d| {
            d.array(2)?;
            let op = d.uint()?;
            let data = d.bytes()?.to_vec();
            Ok((op, data))
        })
        .expect("fixture request [op, cbor]");
        let result = match op {
            1 => {
                let (commit, group_info) = decode_strict(&data, |d| {
                    d.array(2)?;
                    Ok((d.bytes()?.to_vec(), d.bytes()?.to_vec()))
                })
                .expect("external-join result shape");
                let mut resync = Encoder::new();
                resync.array(2).bytes(&commit).bytes(&group_info);
                let answer = relay
                    .resync(&resync.into_vec())
                    .expect("peer accepts external join");
                let seq = decode_strict(&answer, |d| {
                    d.array(2)?;
                    let seq = d.uint()?;
                    d.uint()?;
                    Ok(seq)
                })
                .expect("resync answer");
                peer.apply_commit(&relay, seq);
                let mut e = Encoder::new();
                e.array(1).uint(seq);
                e.into_vec()
            }
            2 => {
                let from = relay.through() + 1;
                peer.send(&mut relay, "native peer message one");
                peer.send(&mut relay, "native peer message two");
                let mut e = Encoder::new();
                e.array(4)
                    .bytes(&relay.handshakes_from(from))
                    .bytes(&relay.messages_from(from))
                    .uint(relay.through())
                    .uint(relay.leaf_of(peer.device) as u64);
                e.into_vec()
            }
            3 => {
                let key_package = decode_strict(&data, |d| d.bytes().map(|b| b.to_vec()))
                    .expect("public KeyPackage TLS");
                welcome_peer.add(&mut welcome_relay, &[key_package.as_slice()]);
                let welcome = welcome_relay.welcomes.first().expect("one Welcome");
                let mut e = Encoder::new();
                e.array(7)
                    .uint(welcome.welcome_id)
                    .bytes(&welcome_relay.group_id)
                    .uint(welcome.epoch)
                    .uint(welcome.commit_seq)
                    .bytes(&welcome.blob)
                    .bytes(&welcome.ratchet_tree)
                    .bytes(&welcome.tree_hash);
                e.into_vec()
            }
            _ => panic!("unknown fixture operation {op}"),
        };
        write(&response, &result);
        if op == 3 {
            return;
        }
    }
}
