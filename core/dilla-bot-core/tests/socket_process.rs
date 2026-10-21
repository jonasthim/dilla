#![cfg(target_os = "linux")]
#![allow(unsafe_code)] // CommandExt::pre_exec is used only to map the test socket onto fd 3.

use dilla_core::{
    bot::{HelperRequest, HelperResponse},
    cbor::Encoder,
    ids::MsgId,
};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{fs::PermissionsExt, net::UnixStream},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
fn temp_dir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "dilla-bot-proc-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
            + std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64
    ));
    fs::create_dir(&p).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
    p
}
fn spawn(path: &PathBuf, stream: &UnixStream) -> std::process::Child {
    let fd = stream.as_raw_fd();
    unsafe {
        use std::os::unix::process::CommandExt;
        let mut c = Command::new(env!("CARGO_BIN_EXE_dilla-bot-core"));
        c.arg("--state-dir")
            .arg(path)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let flags = libc::fcntl(3, libc::F_GETFD);
            if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
        c.spawn().unwrap()
    }
}
fn write_request(stream: &mut UnixStream, id: [u8; 16], op: u64, payload: Vec<u8>) {
    let frame = HelperRequest {
        request_id: MsgId::from_bytes(id),
        operation: op,
        payload,
    }
    .encode_frame()
    .unwrap();
    stream.write_all(&frame).unwrap()
}
fn write_raw(stream: &mut UnixStream, body: Vec<u8>) {
    stream
        .write_all(&(body.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(&body).unwrap();
}
fn read_response(stream: &mut UnixStream, child: &mut std::process::Child) -> HelperResponse {
    let mut p = [0; 4];
    if stream.read_exact(&mut p).is_err() {
        let status = child.wait().unwrap();
        panic!("helper closed before response: {status}");
    }
    let mut body = vec![0; u32::from_be_bytes(p) as usize];
    stream.read_exact(&mut body).unwrap();
    HelperResponse::decode(&body).unwrap()
}

fn staging_fixture(
    path: &Path,
    ids: ([u8; 16], [u8; 16], [u8; 16]),
    key: [u8; 32],
    stage_exists: bool,
    committed: bool,
    published: bool,
) -> (PathBuf, PathBuf) {
    const MAGIC: &[u8] = b"DILLA-BOT-INIT-v1\0";
    let nonce = [0xA7; 16];
    let stage = path.join(format!(
        "state.db.init-{}",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let marker = path.join("state.init");
    assert!(!committed || stage_exists);
    if stage_exists {
        let c = rusqlite::Connection::open(&stage).unwrap();
        let key_hex = key.iter().map(|b| format!("{b:02x}")).collect::<String>();
        c.execute_batch(&format!(
            "PRAGMA key = \"x'{key_hex}'\"; PRAGMA cipher_memory_security=ON; PRAGMA temp_store=MEMORY;"
        ))
            .unwrap();
        if committed {
            c.execute_batch("CREATE TABLE bot_helper_meta (k TEXT PRIMARY KEY, v BLOB NOT NULL); CREATE TABLE bot_state (area INTEGER NOT NULL, key BLOB NOT NULL, revision INTEGER NOT NULL, value BLOB, PRIMARY KEY(area,key)); CREATE TABLE bot_state_receipts (id BLOB PRIMARY KEY, digest BLOB NOT NULL, result BLOB NOT NULL);")
                .unwrap();
            c.execute(
                "INSERT INTO bot_helper_meta(k,v) VALUES('version',?1),('instance',?2),('community',?3),('installation',?4)",
                rusqlite::params![1i64, ids.0.as_slice(), ids.1.as_slice(), ids.2.as_slice()],
            )
            .unwrap();
        }
        drop(c);
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut marker_bytes = Vec::new();
    marker_bytes.extend_from_slice(MAGIC);
    marker_bytes.extend_from_slice(&1i64.to_be_bytes());
    marker_bytes.extend_from_slice(&ids.0);
    marker_bytes.extend_from_slice(&ids.1);
    marker_bytes.extend_from_slice(&ids.2);
    marker_bytes.extend_from_slice(&nonce);
    fs::write(&marker, marker_bytes).unwrap();
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
    if published {
        fs::hard_link(&stage, path.join("state.db")).unwrap();
    }
    (stage, marker)
}

fn open_payload(ids: ([u8; 16], [u8; 16], [u8; 16]), key: [u8; 32]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(4)
        .bytes(&ids.0)
        .bytes(&ids.1)
        .bytes(&ids.2)
        .bytes(&key);
    e.into_vec()
}

#[test]
fn real_binary_opens_keyed_store_over_inherited_socket_and_shuts_down() {
    let path = temp_dir();
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    let sentinel = b"socket-key-secret-not-for-logs";
    let mut key = [0u8; 32];
    key[..sentinel.len()].copy_from_slice(sentinel);
    let mut payload = Encoder::new();
    payload
        .array(4)
        .bytes(&[1; 16])
        .bytes(&[2; 16])
        .bytes(&[3; 16])
        .bytes(&key);
    write_request(&mut client, [9; 16], 1, payload.into_vec());
    let opened = read_response(&mut client, &mut child);
    assert_eq!(opened.status, 0);
    assert_eq!(opened.request_id.as_bytes(), &[9; 16]);
    write_request(&mut client, [10; 16], 15, {
        let mut e = Encoder::new();
        e.array(0);
        e.into_vec()
    });
    let stopped = read_response(&mut client, &mut child);
    assert_eq!(stopped.status, 0);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains(std::str::from_utf8(sentinel).unwrap())
    );
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains(std::str::from_utf8(sentinel).unwrap())
    );
    assert_eq!(
        fs::metadata(path.join("state.db"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.join("state.lock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let _ = fs::remove_dir_all(path);
}

#[test]
fn oversized_prefix_closes_without_reading_an_announced_body() {
    let path = temp_dir();
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    client.write_all(&(1_048_577u32).to_be_bytes()).unwrap();
    let _ = client.shutdown(std::net::Shutdown::Write);
    let mut byte = [0];
    assert_eq!(client.read(&mut byte).unwrap(), 0);
    assert!(child.wait().unwrap().success());
    let _ = fs::remove_dir_all(path);
}

#[test]
fn request_before_open_and_second_open_are_refused() {
    let path = temp_dir();
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    let mut pre = Encoder::new();
    pre.array(3).bytes(&[1; 16]).bytes(&[2; 16]).bytes(&[3; 16]);
    write_request(&mut client, [1; 16], 2, pre.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 1);
    let mut open = Encoder::new();
    open.array(4)
        .bytes(&[1; 16])
        .bytes(&[2; 16])
        .bytes(&[3; 16])
        .bytes(&[4; 32]);
    write_request(&mut client, [2; 16], 1, open.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 0);
    let mut open_again = Encoder::new();
    open_again
        .array(4)
        .bytes(&[9; 16])
        .bytes(&[2; 16])
        .bytes(&[3; 16])
        .bytes(&[4; 32]);
    write_request(&mut client, [3; 16], 1, open_again.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 1);
    let mut shutdown = Encoder::new();
    shutdown.array(0);
    write_request(&mut client, [4; 16], 15, shutdown.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 0);
    assert!(child.wait().unwrap().success());
    let _ = fs::remove_dir_all(path);
}

#[test]
fn separate_helper_processes_cannot_open_the_same_identity() {
    let path = temp_dir();
    let (mut first_client, first_server) = UnixStream::pair().unwrap();
    let mut first = spawn(&path, &first_server);
    drop(first_server);
    let mut open = Encoder::new();
    open.array(4)
        .bytes(&[1; 16])
        .bytes(&[2; 16])
        .bytes(&[3; 16])
        .bytes(&[4; 32]);
    write_request(&mut first_client, [1; 16], 1, open.into_vec());
    assert_eq!(read_response(&mut first_client, &mut first).status, 0);

    let (mut second_client, second_server) = UnixStream::pair().unwrap();
    let mut second = spawn(&path, &second_server);
    drop(second_server);
    let mut open = Encoder::new();
    open.array(4)
        .bytes(&[1; 16])
        .bytes(&[2; 16])
        .bytes(&[3; 16])
        .bytes(&[4; 32]);
    write_request(&mut second_client, [2; 16], 1, open.into_vec());
    assert_eq!(read_response(&mut second_client, &mut second).status, 6);
    drop(second_client);
    assert!(second.wait().unwrap().success());

    let mut shutdown = Encoder::new();
    shutdown.array(0);
    write_request(&mut first_client, [3; 16], 15, shutdown.into_vec());
    assert_eq!(read_response(&mut first_client, &mut first).status, 0);
    assert!(first.wait().unwrap().success());
    let _ = fs::remove_dir_all(path);
}

#[test]
fn staged_first_open_crash_windows_recover_only_marker_owned_state() {
    let ids = ([41; 16], [42; 16], [43; 16]);
    let key = [0x5A; 32];

    for (stage_exists, committed, published) in [
        (false, false, false),
        (true, false, false),
        (true, true, false),
        (true, true, true),
    ] {
        let path = temp_dir();
        let (stage, marker) = staging_fixture(&path, ids, key, stage_exists, committed, published);
        let before_stage = stage_exists.then(|| fs::read(&stage).unwrap());
        let before_marker = fs::read(&marker).unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let mut child = spawn(&path, &server);
        drop(server);

        if committed && !published {
            write_request(
                &mut client,
                [1; 16],
                1,
                open_payload(([99; 16], ids.1, ids.2), key),
            );
            assert_eq!(read_response(&mut client, &mut child).status, 4);
            write_request(&mut client, [2; 16], 1, open_payload(ids, [0x6B; 32]));
            assert_eq!(read_response(&mut client, &mut child).status, 1);
            assert_eq!(
                fs::read(&stage).unwrap(),
                before_stage.as_ref().unwrap().as_slice()
            );
            assert_eq!(fs::read(&marker).unwrap(), before_marker);
        }

        write_request(&mut client, [3; 16], 1, open_payload(ids, key));
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        assert!(path.join("state.db").exists());
        assert!(!stage.exists());
        assert!(!marker.exists());
        let mut shutdown = Encoder::new();
        shutdown.array(0);
        write_request(&mut client, [4; 16], 15, shutdown.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        assert!(child.wait().unwrap().success());
        let _ = fs::remove_dir_all(path);
    }
}

#[test]
fn missing_or_wrong_database_key_is_refused_without_key_logs() {
    let path = temp_dir();
    {
        let (mut client, server) = UnixStream::pair().unwrap();
        let mut child = spawn(&path, &server);
        drop(server);
        let mut missing = Encoder::new();
        missing
            .array(3)
            .bytes(&[1; 16])
            .bytes(&[2; 16])
            .bytes(&[3; 16]);
        write_request(&mut client, [15; 16], 1, missing.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 1);
        let mut zero = Encoder::new();
        zero.array(4)
            .bytes(&[1; 16])
            .bytes(&[2; 16])
            .bytes(&[3; 16])
            .bytes(&[0; 32]);
        write_request(&mut client, [16; 16], 1, zero.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 1);
        let mut open = Encoder::new();
        open.array(4)
            .bytes(&[1; 16])
            .bytes(&[2; 16])
            .bytes(&[3; 16])
            .bytes(&[0x51; 32]);
        write_request(&mut client, [1; 16], 1, open.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        let mut shutdown = Encoder::new();
        shutdown.array(0);
        write_request(&mut client, [2; 16], 15, shutdown.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        assert!(child.wait().unwrap().success());
    }
    let sentinel = b"wrong-key-never-log";
    let mut wrong = [0x66; 32];
    wrong[..sentinel.len()].copy_from_slice(sentinel);
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    let mut open = Encoder::new();
    open.array(4)
        .bytes(&[1; 16])
        .bytes(&[2; 16])
        .bytes(&[3; 16])
        .bytes(&wrong);
    write_request(&mut client, [3; 16], 1, open.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 1);
    drop(client);
    let output = child.wait_with_output().unwrap();
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains(std::str::from_utf8(sentinel).unwrap())
    );
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains(std::str::from_utf8(sentinel).unwrap())
    );
    let _ = fs::remove_dir_all(path);
}

#[test]
fn truncated_frame_and_unsupported_envelopes_close_cleanly() {
    {
        let raw = {
            let mut e = Encoder::new();
            e.array(4).uint(2).bytes(&[1; 16]).uint(1).bytes(&[0x80]);
            e.into_vec()
        };
        let path = temp_dir();
        let (mut client, server) = UnixStream::pair().unwrap();
        let mut child = spawn(&path, &server);
        drop(server);
        write_raw(&mut client, raw);
        let mut byte = [0];
        assert_eq!(client.read(&mut byte).unwrap(), 0);
        assert!(child.wait().unwrap().success());
        let _ = fs::remove_dir_all(path);
    }
    let path = temp_dir();
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    let mut empty = Encoder::new();
    empty.array(0);
    let mut unknown = Encoder::new();
    unknown
        .array(4)
        .uint(1)
        .bytes(&[7; 16])
        .uint(99)
        .bytes(&empty.into_vec());
    write_raw(&mut client, unknown.into_vec());
    let invalid = read_response(&mut client, &mut child);
    assert_eq!(invalid.status, 1);
    assert_eq!(invalid.request_id.as_bytes(), &[7; 16]);
    drop(client);
    assert!(child.wait().unwrap().success());
    let _ = fs::remove_dir_all(path);

    let path = temp_dir();
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    client.write_all(&32u32.to_be_bytes()).unwrap();
    client.write_all(&[0x81; 5]).unwrap();
    let _ = client.shutdown(std::net::Shutdown::Write);
    let mut byte = [0];
    assert_eq!(client.read(&mut byte).unwrap(), 0);
    assert!(child.wait().unwrap().success());
    let _ = fs::remove_dir_all(path);
}

#[test]
fn invalid_socket_fd_is_rejected() {
    use std::os::fd::AsRawFd;
    let path = temp_dir();
    let null = std::fs::File::open("/dev/null").unwrap();
    let fd = null.as_raw_fd();
    let child = unsafe {
        use std::os::unix::process::CommandExt;
        let mut c = Command::new(env!("CARGO_BIN_EXE_dilla-bot-core"));
        c.arg("--state-dir")
            .arg(&path)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
        c.spawn().unwrap()
    };
    assert!(!child.wait_with_output().unwrap().status.success());
    let _ = fs::remove_dir_all(path);
}

#[test]
fn bot_identity_and_key_packages_reopen_across_processes() {
    let path = temp_dir();
    let registration;
    {
        let (mut client, server) = UnixStream::pair().unwrap();
        let mut child = spawn(&path, &server);
        drop(server);
        let mut open = Encoder::new();
        open.array(4)
            .bytes(&[11; 16])
            .bytes(&[12; 16])
            .bytes(&[13; 16])
            .bytes(&[0x73; 32]);
        write_request(&mut client, [1; 16], 1, open.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        let mut bootstrap = Encoder::new();
        bootstrap
            .array(3)
            .bytes(&[11; 16])
            .bytes(&[12; 16])
            .bytes(&[13; 16]);
        write_request(&mut client, [2; 16], 2, bootstrap.into_vec());
        let first = read_response(&mut client, &mut child);
        assert_eq!(first.status, 0);
        registration = first.payload;
        let mut complete = Encoder::new();
        complete
            .array(3)
            .bytes(&[14; 16])
            .text("native-bot")
            .uint(100);
        write_request(&mut client, [3; 16], 3, complete.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        let mut changes = Encoder::new();
        changes
            .array(1)
            .array(4)
            .uint(0)
            .bytes(b"setting")
            .uint(0)
            .bytes(&[0x81, 9]);
        let mut tx = Encoder::new();
        tx.array(2).bytes(&[21; 16]).raw(&changes.into_vec());
        write_request(&mut client, [30; 16], 12, tx.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        let mut shut = Encoder::new();
        shut.array(0);
        write_request(&mut client, [4; 16], 15, shut.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        assert!(child.wait().unwrap().success());
    }
    {
        let (mut client, server) = UnixStream::pair().unwrap();
        let mut child = spawn(&path, &server);
        drop(server);
        let mut open = Encoder::new();
        open.array(4)
            .bytes(&[11; 16])
            .bytes(&[12; 16])
            .bytes(&[13; 16])
            .bytes(&[0x73; 32]);
        write_request(&mut client, [5; 16], 1, open.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        let mut bootstrap = Encoder::new();
        bootstrap
            .array(3)
            .bytes(&[11; 16])
            .bytes(&[12; 16])
            .bytes(&[13; 16]);
        write_request(&mut client, [6; 16], 2, bootstrap.into_vec());
        let reopened = read_response(&mut client, &mut child);
        assert_eq!(reopened.status, 0);
        assert_eq!(reopened.payload, registration);
        let mut kp = Encoder::new();
        kp.array(2).uint(1).uint(0);
        write_request(&mut client, [7; 16], 5, kp.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        let mut get = Encoder::new();
        get.array(3).uint(0).uint(0).bytes(b"setting");
        write_request(&mut client, [70; 16], 11, get.into_vec());
        let saved = read_response(&mut client, &mut child);
        assert_eq!(saved.status, 0);
        let mut expected = Encoder::new();
        expected.array(2).uint(1).bytes(&[0x81, 9]);
        assert_eq!(saved.payload, expected.into_vec());
        let mut shut = Encoder::new();
        shut.array(0);
        write_request(&mut client, [8; 16], 15, shut.into_vec());
        assert_eq!(read_response(&mut client, &mut child).status, 0);
        assert!(child.wait().unwrap().success());
    }
    let _ = fs::remove_dir_all(path);
}

#[test]
fn crash_with_pending_encrypted_wal_keeps_plaintext_reader_out() {
    let path = temp_dir();
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut child = spawn(&path, &server);
    drop(server);
    let mut open = Encoder::new();
    open.array(4)
        .bytes(&[31; 16])
        .bytes(&[32; 16])
        .bytes(&[33; 16])
        .bytes(&[0x44; 32]);
    write_request(&mut client, [1; 16], 1, open.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 0);
    let mut changes = Encoder::new();
    changes
        .array(1)
        .array(4)
        .uint(0)
        .bytes(b"settings")
        .uint(0)
        .bytes(&[0x81, 0x07]);
    let mut tx = Encoder::new();
    tx.array(2).bytes(&[34; 16]).raw(&changes.into_vec());
    write_request(&mut client, [2; 16], 12, tx.into_vec());
    assert_eq!(read_response(&mut client, &mut child).status, 0);
    child.kill().unwrap();
    let _ = child.wait();
    drop(client);
    let plain = rusqlite::Connection::open(path.join("state.db")).unwrap();
    assert!(
        plain
            .query_row("SELECT count(*) FROM sqlite_schema", [], |r| r
                .get::<_, i64>(0))
            .is_err()
    );
    drop(plain);

    let (mut client, server) = UnixStream::pair().unwrap();
    let mut recovered = spawn(&path, &server);
    drop(server);
    let mut open = Encoder::new();
    open.array(4)
        .bytes(&[31; 16])
        .bytes(&[32; 16])
        .bytes(&[33; 16])
        .bytes(&[0x44; 32]);
    write_request(&mut client, [3; 16], 1, open.into_vec());
    assert_eq!(read_response(&mut client, &mut recovered).status, 0);
    let mut get = Encoder::new();
    get.array(3).uint(0).uint(0).bytes(b"settings");
    write_request(&mut client, [4; 16], 11, get.into_vec());
    let saved = read_response(&mut client, &mut recovered);
    assert_eq!(saved.status, 0);
    let mut expected = Encoder::new();
    expected.array(2).uint(1).bytes(&[0x81, 0x07]);
    assert_eq!(saved.payload, expected.into_vec());
    let mut shutdown = Encoder::new();
    shutdown.array(0);
    write_request(&mut client, [5; 16], 15, shutdown.into_vec());
    assert_eq!(read_response(&mut client, &mut recovered).status, 0);
    assert!(recovered.wait().unwrap().success());
    let _ = fs::remove_dir_all(path);
}
