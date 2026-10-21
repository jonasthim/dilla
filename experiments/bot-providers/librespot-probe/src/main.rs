mod control;
mod oauth;
mod pcm;
mod play;
mod source;
mod storage;

use librespot::{
    core::{Session, authentication::Credentials, config::SessionConfig},
    protocol::authentication::AuthenticationType,
};
use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};

const VERSION: &str = "dilla-librespot-probe 0.1.0 (librespot 0.8.0)";

#[derive(Serialize)]
struct Status<'a> {
    status: &'a str,
    phase: &'a str,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    position_ms: Option<u32>,
}

fn status(status: &str, phase: &str, state: &str) {
    let line = serde_json::to_string(&Status {
        status,
        phase,
        state,
        position_ms: None,
    })
    .unwrap_or_else(|_| {
        "{\"status\":\"error\",\"phase\":\"status\",\"state\":\"unavailable\"}".into()
    });
    crate::pcm::write_stderr(format!("{line}\n").as_bytes());
}

fn status_position(state: &str, position_ms: u32) {
    let line = serde_json::to_string(&Status {
        status: "ok",
        phase: "play",
        state,
        position_ms: Some(position_ms),
    })
    .unwrap_or_else(|_| {
        "{\"status\":\"error\",\"phase\":\"status\",\"state\":\"unavailable\"}".into()
    });
    crate::pcm::write_stderr(format!("{line}\n").as_bytes());
}

fn now() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| "clock unavailable")
}

fn client_id() -> String {
    SessionConfig::default().client_id
}

fn credentials_path(state: &Path) -> PathBuf {
    state.join("credentials.json")
}

fn read_credentials(state: &Path) -> Result<Credentials, &'static str> {
    let data = storage::read_protected(&credentials_path(state), storage::MAX_FILE_BYTES)?;
    serde_json::from_slice(&data).map_err(|_| "credentials unavailable")
}

fn session_config(state: &Path, client_id: String) -> Result<SessionConfig, &'static str> {
    let tmp_dir = storage::initialize_private_tmp(state)?;
    Ok(SessionConfig {
        client_id,
        tmp_dir,
        ..SessionConfig::default()
    })
}

fn unix_now() -> Result<u64, &'static str> {
    now()
}

async fn authorize(state: &Path) -> Result<(), &'static str> {
    storage::ensure_state_dir(state)?;
    let (pending, login_url) = oauth::begin(&client_id(), unix_now()?)?;
    let bytes = serde_json::to_vec(&pending).map_err(|_| "storage unavailable")?;
    storage::write_new(&state.join("pending.json"), &bytes)?;
    crate::pcm::write_stdout(
        format!("{login_url}\n").as_bytes(),
        std::time::Duration::from_secs(5),
    )
    .map_err(|_| "output unavailable")?;
    status("ok", "authorize", "pending");
    Ok(())
}

async fn authorize_complete(state: &Path, redirect_path: &Path) -> Result<(), &'static str> {
    storage::ensure_state_dir(state)?;
    let redirect = storage::read_protected(redirect_path, storage::MAX_FILE_BYTES)?;
    let redirect = std::str::from_utf8(&redirect)
        .map_err(|_| "callback unavailable")?
        .trim_end_matches(['\r', '\n']);
    let pending_bytes = storage::consume(&state.join("pending.json"))?;
    let pending: oauth::Pending =
        serde_json::from_slice(&pending_bytes).map_err(|_| "authorization unavailable")?;
    let token = oauth::finish(pending, redirect, unix_now()?).await?;
    let config = session_config(state, client_id())?;
    let session = Session::new(config, None);
    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.connect(Credentials::with_access_token(token), false),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {
            session.shutdown();
            return Err("session unavailable");
        }
        Err(_) => {
            session.shutdown();
            return Err("session timeout");
        }
    }
    let result: Result<(), &'static str> = {
        let reusable = Credentials {
            username: Some(session.username()),
            auth_type: AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS,
            auth_data: session.auth_data(),
        };
        if reusable.username.as_deref().unwrap_or_default().is_empty()
            || reusable.auth_data.is_empty()
        {
            return Err("credentials unavailable");
        }
        let json = serde_json::to_vec(&reusable).map_err(|_| "credentials unavailable")?;
        storage::atomic_write(&credentials_path(state), &json)?;
        Ok(())
    };
    session.shutdown();
    result?;
    status("ok", "authorize-complete", "credentials-saved");
    Ok(())
}

async fn authenticated_session(state: &Path) -> Result<Session, &'static str> {
    storage::ensure_state_dir(state)?;
    let credentials = read_credentials(state)?;
    let config = session_config(state, client_id())?;
    let session = Session::new(config, None);
    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.connect(credentials, false),
    )
    .await
    {
        Ok(Ok(())) => Ok(session),
        Ok(Err(_)) => {
            session.shutdown();
            Err("session unavailable")
        }
        Err(_) => {
            session.shutdown();
            Err("session timeout")
        }
    }
}

async fn resolve(state: &Path, input: &str) -> Result<(), &'static str> {
    storage::ensure_state_dir(state)?;
    let source = source::parse_source(input)?;
    let session = authenticated_session(state).await?;
    let result = source::resolve(&session, source).await;
    session.shutdown();
    let tracks = result?;
    let json = serde_json::to_vec(&tracks).map_err(|_| "metadata unavailable")?;
    let mut output = json;
    output.push(b'\n');
    crate::pcm::write_stdout(&output, std::time::Duration::from_secs(5))
        .map_err(|_| "output unavailable")?;
    status("ok", "resolve", "complete");
    Ok(())
}

fn parse_args() -> Result<(String, Vec<String>), &'static str> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("invalid command")?;
    Ok((command, args.collect()))
}

fn option(args: &[String], name: &str) -> Result<String, &'static str> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            if found.is_some() || i + 1 >= args.len() {
                return Err("invalid arguments");
            }
            found = Some(args[i + 1].clone());
            i += 2;
        } else {
            i += 1;
        }
    }
    found.ok_or("invalid arguments")
}

fn valid_options(args: &[String], allowed: &[&str]) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut i = 0;
    while i < args.len() {
        if !allowed.contains(&args[i].as_str())
            || !seen.insert(args[i].as_str())
            || i + 1 >= args.len()
            || args[i + 1].starts_with("--")
        {
            return false;
        }
        i += 2;
    }
    seen.len() == allowed.len()
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            status("error", "command", "unavailable");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), &'static str> {
    let (command, args) = parse_args()?;
    if command == "--version" && args.is_empty() {
        crate::pcm::write_stdout(
            format!("{VERSION}\n").as_bytes(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|_| "output unavailable")?;
        return Ok(());
    }
    match command.as_str() {
        "authorize" if valid_options(&args, &["--state-dir"]) => {
            authorize(Path::new(&option(&args, "--state-dir")?)).await
        }
        "authorize-complete" if valid_options(&args, &["--state-dir", "--redirect-file"]) => {
            authorize_complete(
                Path::new(&option(&args, "--state-dir")?),
                Path::new(&option(&args, "--redirect-file")?),
            )
            .await
        }
        "resolve" if valid_options(&args, &["--state-dir", "--input"]) => {
            resolve(
                Path::new(&option(&args, "--state-dir")?),
                &option(&args, "--input")?,
            )
            .await
        }
        "play" => {
            if !valid_options(&args, &["--state-dir", "--input", "--max-seconds"]) {
                return Err("invalid arguments");
            }
            use std::io::IsTerminal;
            if std::io::stdout().is_terminal() {
                return Err("terminal output refused");
            }
            let state_dir = option(&args, "--state-dir")?;
            let state = Path::new(&state_dir);
            let input = option(&args, "--input")?;
            let max_seconds = option(&args, "--max-seconds")?
                .parse::<u64>()
                .map_err(|_| "invalid duration")?;
            let session = authenticated_session(state).await?;
            play::play(session, &input, max_seconds).await
        }
        "pcm-smoke" if args.is_empty() => play::smoke(),
        "pcm-smoke" => Err("invalid arguments"),
        _ => Err("invalid command"),
    }
}
