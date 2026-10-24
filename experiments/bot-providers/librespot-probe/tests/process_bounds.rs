use std::{
    io::Read,
    os::fd::AsRawFd,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[test]
fn invalid_source_is_not_echoed() {
    let secret = "https://private.example/track/0123456789012345678901";
    let state =
        std::env::temp_dir().join(format!("dilla-probe-invalid-source-{}", std::process::id()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_dilla-librespot-probe"))
        .args([
            "resolve",
            "--state-dir",
            state.to_str().unwrap(),
            "--input",
            secret,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut stderr)
        .unwrap();
    assert!(stdout.is_empty());
    assert!(!String::from_utf8_lossy(&stderr).contains(secret));
    std::fs::remove_dir_all(state).unwrap();
}

#[test]
fn pcm_smoke_exits_when_pipe_consumer_stalls() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_dilla-librespot-probe"))
        .arg("pcm-smoke")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    nix::fcntl::fcntl(stdout.as_raw_fd(), nix::fcntl::FcntlArg::F_SETPIPE_SZ(4096)).unwrap();

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "stalled output exceeded the process deadline"
        );
        thread::sleep(Duration::from_millis(20));
    };
    assert!(
        !status.success(),
        "smoke unexpectedly fit in an unread pipe"
    );
    let mut rest = Vec::new();
    let _ = child.stdout.take().unwrap().read_to_end(&mut rest);
}
