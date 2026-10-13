//! `dilla-testkit netprobe`: the real-network voice probe (L-PROBE-1).
//!
//! Two verbs, because a call group does not wait: a device whose leaf is in a live call's group but
//! which stays out of the room past `admissionJoinWindow` (30 s) loses its leaf to the room sweep,
//! and a room nobody joins is reaped after 300 s, which ends the call and closes its group. So
//! `prepare` builds the accounts and the call group once, on the supervisor's machine, and `start`
//! runs on each side's own machine right before its probe page presses Start.
//!
//! - `prepare` signs up two throwaway native accounts through an invite (`netprobe-a-<6 hex>` and
//!   `netprobe-b-<6 hex>`, one random suffix per run: a deleted handle stays reserved), opens a 1:1
//!   DM from A to B, registers the DM's call group as A and joins it by external commit as B, so
//!   both leaves are in one epoch. No call is started. Each side's device state (identity seed,
//!   ids, MLS store) is written to `<out>/side-a/` and `<out>/side-b/`.
//! - `start` loads one side, signs in with a fresh challenge-response session, syncs the call
//!   group, starts (or joins) the DM's call and writes the start JSON the probe page loads.
//!
//! Public routes only: nothing here calls `/debug/*` or a test host's control listener, so the
//! probe runs against a real instance as it runs against `dilla-testhost`. The testkit speaks
//! plain `http://` only; against a TLS instance both verbs go through the probe page's dev server,
//! which proxies `/v1`, `/gateway` and `/rtc` to it (`packages/media/vite.probe.config.ts`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{
    DillaBinding, DillaGroup, DillaProcessed, DillaProvider, GroupKind, RosterEntry,
    external_senders,
};
use openmls::prelude::{GroupId, MlsMessageIn, ProtocolMessage};
use openmls_rust_crypto::RustCrypto;
use openmls_traits::random::OpenMlsRand;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ds::remote::{CallStarted, instance_document};
use crate::{DeliveryService, DsError, Frame, HttpDs, TestClient, TestkitError};

/// The side's MLS store inside its state directory: a SQLite copy of the in-memory store
/// `prepare` built, which `start` opens in place.
const MLS_FILE: &str = "mls.sqlite";
/// The side's identity and ids inside its state directory.
const SIDE_FILE: &str = "side.json";
/// What every refusal of a stale state directory tells the operator.
const PREPARE_AGAIN: &str = "run prepare again";

fn scenario(msg: impl Into<String>) -> TestkitError {
    TestkitError::Scenario(msg.into())
}

/// One side's identity and ids, `side.json`. The seed regenerates every key of the device, so the
/// directory is a throwaway device's secret and is deleted after the session.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SideState {
    pub(crate) v: u32,
    pub(crate) side: String,
    pub(crate) username: String,
    /// Decimal: a u64 does not survive every JSON reader.
    pub(crate) seed: String,
    pub(crate) user_id: String,
    pub(crate) device_id: String,
    /// The DM's channel id: the call group's binding target and the calls route's channel.
    pub(crate) dm: String,
    /// The call group as the instance registered it.
    pub(crate) group_id: String,
}

impl SideState {
    pub(crate) fn write(&self, dir: &Path) -> Result<(), TestkitError> {
        let body = serde_json::to_vec_pretty(self).map_err(|e| scenario(e.to_string()))?;
        write_private(&dir.join(SIDE_FILE), &body)
    }

    fn read(dir: &Path) -> Result<Self, TestkitError> {
        let path = dir.join(SIDE_FILE);
        let body = std::fs::read(&path).map_err(|e| {
            scenario(format!(
                "{}: {e}; is this a side directory netprobe prepare wrote? {PREPARE_AGAIN}",
                path.display()
            ))
        })?;
        let s: Self = serde_json::from_slice(&body)
            .map_err(|e| scenario(format!("{}: {e}", path.display())))?;
        if s.v != 1 {
            return Err(scenario(format!(
                "{}: version {} is not 1; {PREPARE_AGAIN}",
                path.display(),
                s.v
            )));
        }
        Ok(s)
    }

    fn seed(&self) -> Result<u64, TestkitError> {
        self.seed
            .parse()
            .map_err(|e| scenario(format!("side.json seed: {e}")))
    }
}

fn hex16(s: &str, what: &str) -> Result<[u8; 16], TestkitError> {
    let bytes = hex::decode(s).map_err(|e| scenario(format!("{what}: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| scenario(format!("{what} is not 16 bytes")))
}

/// Creates `path` readable by its owner only: a side's files are a device's secrets.
fn write_private(path: &Path, body: &[u8]) -> Result<(), TestkitError> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| scenario(format!("{}: {e}", path.display())))?;
    f.write_all(body)
        .map_err(|e| scenario(format!("{}: {e}", path.display())))
}

fn create_private_dir(path: &Path) -> Result<(), TestkitError> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(path)
        .map_err(|e| scenario(format!("{}: {e}", path.display())))
}

/// The two account names of one run: `netprobe-a-<suffix>` and `netprobe-b-<suffix>`.
pub(crate) fn probe_names(suffix: [u8; 3]) -> (String, String) {
    let s = hex::encode(suffix);
    (format!("netprobe-a-{s}"), format!("netprobe-b-{s}"))
}

/// A fresh suffix from the OS RNG (through the crypto provider the MLS stack already uses).
pub(crate) fn random_suffix() -> Result<[u8; 3], TestkitError> {
    RustCrypto::default()
        .random_array::<3>()
        .map_err(|e| scenario(format!("random suffix: {e:?}")))
}

fn random_seed() -> Result<u64, TestkitError> {
    RustCrypto::default()
        .random_array::<8>()
        .map(u64::from_be_bytes)
        .map_err(|e| scenario(format!("random seed: {e:?}")))
}

/// The LiveKit signalling URL the page dials. A loopback `http://` instance is the automated check
/// against `dilla-testhost`, or the probe page's own dev server proxying a real instance (the
/// session checklist): the instance's own origin with `http` replaced by `ws`, the rule
/// `media_driver.rs` uses, keeps the `/rtc` gate in the path. Anything else is what the calls
/// route answered.
pub(crate) fn livekit_url(instance: &str, started: &CallStarted) -> String {
    let base = instance.trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("http://") {
        let host = rest.split('/').next().unwrap_or(rest);
        let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
        if matches!(name, "127.0.0.1" | "localhost" | "[::1]") {
            return format!("ws://{rest}");
        }
    }
    started.livekit_url.clone()
}

/// What `start` hands the page: the call group's media epoch, read from the merged state.
pub(crate) struct MediaKeys {
    pub(crate) epoch: u64,
    pub(crate) base_key: [u8; 16],
    pub(crate) own_leaf: u32,
    pub(crate) roster: Vec<RosterEntry>,
}

/// The start JSON (L-PROBE-1): `{ v: 1, livekitUrl, token, iceServers, callId, groupId,
/// keys: { epoch, baseKeyHex, selfLeaf, roster: [{ leaf, deviceId }] } }`.
pub(crate) fn start_json(livekit_url: &str, started: &CallStarted, keys: &MediaKeys) -> Value {
    let ice: Vec<Value> = started
        .ice_servers
        .iter()
        .map(|(urls, user, cred)| json!([urls, user, cred]))
        .collect();
    let roster: Vec<Value> = keys
        .roster
        .iter()
        .map(|r| json!({"leaf": r.leaf_index, "deviceId": r.device_id.to_hex()}))
        .collect();
    json!({
        "v": 1,
        "livekitUrl": livekit_url,
        "token": started.token,
        "iceServers": ice,
        "callId": hex::encode(started.call_id),
        "groupId": hex::encode(started.group_id),
        "keys": {
            "epoch": keys.epoch.to_string(),
            "baseKeyHex": hex::encode(keys.base_key),
            "selfLeaf": keys.own_leaf,
            "roster": roster,
        },
    })
}

/// The calls route's answer, judged against the state's call group. A closed group is refused
/// `E_LEAF_NOT_CURRENT`; a channel whose only call group is closed has none (`E_NOT_FOUND`); and a
/// call opened on another, newer group means this one is closed too. None of them can be repaired
/// from this state: the leaves have to be built again.
pub(crate) fn check_started(
    group: &[u8; 16],
    result: Result<CallStarted, DsError>,
) -> Result<CallStarted, TestkitError> {
    match result {
        Ok(s) if &s.group_id == group => Ok(s),
        Ok(s) => Err(scenario(format!(
            "the call opened on call group {}, not this state's {}: its group is closed; {PREPARE_AGAIN}",
            hex::encode(s.group_id),
            hex::encode(group)
        ))),
        Err(e) if matches!(e.code(), "E_LEAF_NOT_CURRENT" | "E_NOT_FOUND") => {
            Err(scenario(format!(
                "the call group {} is closed or this device's leaf left it ({e}); {PREPARE_AGAIN}",
                hex::encode(group)
            )))
        }
        Err(e) => Err(e.into()),
    }
}

/// A side as `start` uses it: its ids, its client (for the device keys and the credential), and
/// the provider and call group over the side's own MLS store.
pub(crate) struct LoadedSide {
    state: SideState,
    client: TestClient,
    provider: DillaProvider,
    group: DillaGroup,
}

/// Loads a side directory. The client is rebuilt from the seed around the user id the instance
/// minted, exactly as `prepare` built it; the call group is read from the side's MLS store.
pub(crate) fn load_side(dir: &Path) -> Result<LoadedSide, TestkitError> {
    let state = SideState::read(dir)?;
    let user = UserId::from_bytes(hex16(&state.user_id, "side.json userId")?);
    let client = TestClient::new(
        &state.username,
        user,
        Tier::Native,
        Kind::User,
        state.seed()?,
    )?;
    if client.device_id().to_hex() != state.device_id {
        return Err(scenario(format!(
            "side.json names device {} but its seed yields {}; {PREPARE_AGAIN}",
            state.device_id,
            client.device_id().to_hex()
        )));
    }
    let path = dir.join(MLS_FILE);
    if !path.is_file() {
        return Err(scenario(format!(
            "{} is missing; {PREPARE_AGAIN}",
            path.display()
        )));
    }
    let conn = rusqlite::Connection::open(&path)
        .map_err(|e| scenario(format!("{}: {e}", path.display())))?;
    let provider = DillaProvider::new(Arc::new(Mutex::new(conn)));
    provider.storage().migrate()?;
    let dm = hex16(&state.dm, "side.json dm")?;
    let group = DillaGroup::load(&provider, &GroupId::from_slice(&dm))?.ok_or_else(|| {
        scenario(format!(
            "{} holds no call group for DM {}; {PREPARE_AGAIN}",
            path.display(),
            state.dm
        ))
    })?;
    if group.binding().kind != GroupKind::Call || group.binding().target_id != dm {
        return Err(scenario(format!(
            "{} holds another group under DM {}; {PREPARE_AGAIN}",
            path.display(),
            state.dm
        )));
    }
    Ok(LoadedSide {
        state,
        client,
        provider,
        group,
    })
}

/// Copies a client's in-memory MLS store to `path` (`VACUUM INTO`), owner-only.
fn save_store(client: &TestClient, path: &Path) -> Result<(), TestkitError> {
    let target = path
        .to_str()
        .ok_or_else(|| scenario(format!("{}: not UTF-8", path.display())))?;
    if path.exists() {
        return Err(scenario(format!("{} exists already", path.display())));
    }
    {
        let conn = client
            .provider()
            .storage()
            .conn()
            .lock()
            .map_err(|_| scenario("the MLS store lock is poisoned"))?;
        conn.execute("VACUUM INTO ?1", [target])
            .map_err(|e| scenario(format!("{}: {e}", path.display())))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| scenario(format!("{}: {e}", path.display())))?;
    }
    Ok(())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Signs `name` up through `invite` with a device drawn from a fresh seed, and publishes the
/// user's signed device list (invariant 4 refuses any leaf whose DSK no list names).
fn enrol(base: &str, invite: &str, name: &str) -> Result<(TestClient, HttpDs, u64), TestkitError> {
    let seed = random_seed()?;
    let draft = TestClient::new(
        name,
        UserId::from_bytes([0; 16]),
        Tier::Native,
        Kind::User,
        seed,
    )?;
    // One code, or several separated by commas as `dilla-testhost`'s banner prints them: a spent
    // code answers E_INVITE_INVALID and the next one is tried.
    let mut codes = invite.split(',').filter(|c| !c.is_empty()).peekable();
    let enrolled = loop {
        let code = codes
            .next()
            .ok_or_else(|| scenario("the invite names no code"))?;
        match HttpDs::redeem_invite(base, code, draft.new_account(name, name)) {
            Err(e) if e.code() == "E_INVITE_INVALID" && codes.peek().is_some() => {}
            other => break other?,
        }
    };
    // The instance mints the user id and the MLS credential must name it; the seed fixes the
    // device and every key, so the client is rebuilt around the minted id unchanged otherwise.
    let client = TestClient::new(
        name,
        UserId::from_bytes(enrolled.user_id),
        Tier::Native,
        Kind::User,
        seed,
    )?;
    if enrolled.device_id != client.device_id() {
        return Err(DsError::Protocol(format!(
            "registered device {} but the instance answered {}",
            client.device_id().to_hex(),
            enrolled.device_id.to_hex()
        ))
        .into());
    }
    let mut ds = HttpDs::with_session(base, client.device_id(), enrolled.token)?;
    ds.set_session_expires(enrolled.expires);
    ds.put_device_list(&enrolled.user_id, &client.signed_device_list(now_unix()))?;
    Ok((client, ds, seed))
}

/// What `prepare` made: the account names, the call group and where the two sides were written.
pub struct Prepared {
    pub names: (String, String),
    pub side_a: PathBuf,
    pub side_b: PathBuf,
    pub group_id: String,
    pub epoch: u64,
}

/// `dilla-testkit netprobe prepare --instance <url> --invite <code> --out <dir>`.
pub fn prepare(instance: &str, invite: &str, out: &Path) -> Result<Prepared, TestkitError> {
    let base = instance.trim_end_matches('/');
    let side_a = out.join("side-a");
    let side_b = out.join("side-b");
    for dir in [&side_a, &side_b] {
        if dir.exists() {
            return Err(scenario(format!(
                "{} exists: a side directory is written once (delete it, or choose another --out)",
                dir.display()
            )));
        }
    }
    let (name_a, name_b) = probe_names(random_suffix()?);
    let (mut a, mut ds_a, seed_a) = enrol(base, invite, &name_a)?;
    let (mut b, mut ds_b, seed_b) = enrol(base, invite, &name_b)?;

    let (dm, _) = ds_a.post_dm(&[*b.user_id().as_bytes()])?;
    let doc = instance_document(base)?;
    let instance_id = InstanceId::from_bytes(doc.instance_id);
    let binding = DillaBinding {
        v: 1,
        instance_id,
        community_id: None,
        target_id: dm,
        kind: GroupKind::Call,
        policy_version: 1,
        e2ee_version: 1,
        media_version: GroupKind::Call.media_version(),
    };
    // protocol/01: every call group carries the instance as its external sender, so the instance
    // can propose the leaf removals the room sweep and a leave make.
    let senders = external_senders(doc.external_sender_pub.to_vec().into(), &instance_id);
    let group = a.create_group_with(&mut ds_a, binding.clone(), Some(senders))?;
    b.join_external(&mut ds_b, &group, &binding)?;
    // A processes B's external commit, so both sides hold the same epoch.
    a.sync(&mut ds_a)?;
    b.sync(&mut ds_b)?;
    let (ea, eb) = (a.epoch_of(&group), b.epoch_of(&group));
    let epoch = match (ea, eb) {
        (Some(x), Some(y)) if x == y => x,
        _ => {
            return Err(scenario(format!(
                "the two sides disagree on the call group's epoch ({ea:?} and {eb:?})"
            )));
        }
    };
    let group_hex = hex::encode(&group);

    for (dir, side, client, seed) in [(&side_a, "a", &a, seed_a), (&side_b, "b", &b, seed_b)] {
        create_private_dir(dir)?;
        SideState {
            v: 1,
            side: side.into(),
            username: client.name().to_owned(),
            seed: seed.to_string(),
            user_id: hex::encode(client.user_id().as_bytes()),
            device_id: client.device_id().to_hex(),
            dm: hex::encode(dm),
            group_id: group_hex.clone(),
        }
        .write(dir)?;
        save_store(client, &dir.join(MLS_FILE))?;
    }
    Ok(Prepared {
        names: (name_a, name_b),
        side_a,
        side_b,
        group_id: group_hex,
        epoch,
    })
}

fn deserialize_protocol(bytes: &[u8]) -> Result<ProtocolMessage, TestkitError> {
    use tls_codec::Deserialize as _;
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|e| scenario(format!("{e:?}")))?
        .try_into_protocol_message()
        .map_err(|e| scenario(format!("{e:?}")))
}

/// Applies what the gateway delivers for the call group: commits are merged, proposals queued.
/// Nothing is committed: the probe never moves the epoch itself.
fn sync_group(side: &mut LoadedSide, ds: &mut HttpDs) -> Result<(), TestkitError> {
    let group_id = hex16(&side.state.group_id, "side.json groupId")?;
    for frame in ds.drain()? {
        let Frame::MlsHandshake { group_id: g, item } = frame else {
            continue;
        };
        if g.as_slice() != group_id {
            continue;
        }
        let message = deserialize_protocol(&item.blob)?;
        if message.epoch().as_u64() < side.group.epoch() {
            continue;
        }
        match side.group.process_message(&side.provider, message)? {
            DillaProcessed::StagedCommit(staged, _) => {
                side.group.merge_staged_commit(&side.provider, *staged)?;
            }
            DillaProcessed::Proposal(p) | DillaProcessed::ExternalJoinProposal(p) => {
                side.group.store_pending_proposal(&side.provider, *p)?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// `dilla-testkit netprobe start --instance <url> --state <dir>/side-<x> --out <file>`: writes the
/// start JSON to `out` and answers it.
pub fn start(instance: &str, state: &Path, out: &Path) -> Result<Value, TestkitError> {
    let base = instance.trim_end_matches('/');
    let mut side = load_side(state)?;
    let group = hex16(&side.state.group_id, "side.json groupId")?;
    let dm = hex16(&side.state.dm, "side.json dm")?;
    let mut ds = HttpDs::connect(base, &side.client.device(), &side.client.credential_blob())?;
    sync_group(&mut side, &mut ds)?;
    let started = check_started(&group, ds.start_call(&dm, ""))?;
    let m = side.group.media_epoch(&side.provider)?;
    let keys = MediaKeys {
        epoch: m.epoch,
        base_key: *m.base_key,
        own_leaf: m.own_leaf,
        roster: m.roster.clone(),
    };
    let v = start_json(&livekit_url(base, &started), &started, &keys);
    let body = serde_json::to_vec_pretty(&v).map_err(|e| scenario(e.to_string()))?;
    write_private(out, &body)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ds::remote::CallStarted;
    use dilla_core::ids::{DeviceId, UserId};
    use dilla_core::mls::RosterEntry;

    fn started(group: [u8; 16]) -> CallStarted {
        CallStarted {
            call_id: [0xca; 16],
            group_id: group,
            livekit_url: "wss://dilla.test".into(),
            token: "jwt".into(),
            ice_servers: vec![(
                vec!["turn:dilla.test:3478?transport=udp".into()],
                "user".into(),
                "cred".into(),
            )],
            caps: [64_000, 2_500_000, 0],
        }
    }

    fn media(epoch: u64) -> MediaKeys {
        MediaKeys {
            epoch,
            base_key: [0xab; 16],
            own_leaf: 1,
            roster: vec![
                RosterEntry {
                    leaf_index: 0,
                    device_id: DeviceId::from_bytes([0x0a; 16]),
                    user_id: UserId::from_bytes([0x01; 16]),
                },
                RosterEntry {
                    leaf_index: 1,
                    device_id: DeviceId::from_bytes([0x0b; 16]),
                    user_id: UserId::from_bytes([0x02; 16]),
                },
            ],
        }
    }

    #[test]
    fn netprobe_start_json_carries_the_pinned_field_names_a_32_hex_key_and_the_roster() {
        let v = start_json("ws://127.0.0.1:8485", &started([7; 16]), &media(3));
        let mut top: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        top.sort_unstable();
        assert_eq!(
            top,
            [
                "callId",
                "groupId",
                "iceServers",
                "keys",
                "livekitUrl",
                "token",
                "v"
            ]
        );
        assert_eq!(v["v"], 1);
        assert_eq!(v["livekitUrl"], "ws://127.0.0.1:8485");
        assert_eq!(v["token"], "jwt");
        assert_eq!(v["callId"], hex::encode([0xca; 16]));
        assert_eq!(v["groupId"], hex::encode([7; 16]));
        assert_eq!(
            v["iceServers"],
            serde_json::json!([[["turn:dilla.test:3478?transport=udp"], "user", "cred"]])
        );
        let mut keys: Vec<&str> = v["keys"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["baseKeyHex", "epoch", "roster", "selfLeaf"]);
        // A decimal string, as the page's BigInt wants it (MD-20).
        assert_eq!(v["keys"]["epoch"], "3");
        let key = v["keys"]["baseKeyHex"].as_str().unwrap();
        assert_eq!(key.len(), 32);
        assert!(
            key.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert_eq!(v["keys"]["selfLeaf"], 1);
        assert_eq!(
            v["keys"]["roster"],
            serde_json::json!([
                {"leaf": 0, "deviceId": hex::encode([0x0a; 16])},
                {"leaf": 1, "deviceId": hex::encode([0x0b; 16])},
            ])
        );
    }

    #[test]
    fn netprobe_livekit_url_is_the_ws_instance_only_on_loopback_http() {
        let s = started([1; 16]);
        assert_eq!(
            livekit_url("http://127.0.0.1:8485", &s),
            "ws://127.0.0.1:8485"
        );
        assert_eq!(
            livekit_url("http://localhost:5191/", &s),
            "ws://localhost:5191"
        );
        assert_eq!(livekit_url("http://192.0.2.7:8080", &s), "wss://dilla.test");
    }

    #[test]
    fn netprobe_prepare_names_share_one_six_hex_suffix() {
        let (a, b) = probe_names([0x0f, 0xa0, 0x3c]);
        assert_eq!(a, "netprobe-a-0fa03c");
        assert_eq!(b, "netprobe-b-0fa03c");
        for name in [&a, &b] {
            let (head, suffix) = name.split_at("netprobe-a-".len());
            assert!(head == "netprobe-a-" || head == "netprobe-b-", "{name}");
            assert_eq!(suffix.len(), 6);
            assert!(
                suffix
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            );
        }
        let (c, _) = probe_names(random_suffix().unwrap());
        assert!(
            c.starts_with("netprobe-a-") && c.len() == "netprobe-a-".len() + 6,
            "{c}"
        );
    }

    #[test]
    fn netprobe_start_refuses_a_closed_call_group_and_says_run_prepare_again() {
        let mine = [9; 16];
        let closed = DsError::Remote {
            status: 409,
            code: "E_LEAF_NOT_CURRENT",
            detail: "the call group is closed".into(),
        };
        let e = check_started(&mine, Err(closed)).unwrap_err().to_string();
        assert!(e.contains("run prepare again"), "{e}");
        let gone = DsError::NotFound;
        let e = check_started(&mine, Err(gone)).unwrap_err().to_string();
        assert!(e.contains("run prepare again"), "{e}");
        // The channel's newest open call group is another one: this state's group was closed.
        let e = check_started(&mine, Ok(started([8; 16])))
            .unwrap_err()
            .to_string();
        assert!(e.contains("run prepare again"), "{e}");
        // Anything else is reported as it is, without the hint.
        let other = DsError::RateLimited { retry_after_ms: 5 };
        let e = check_started(&mine, Err(other)).unwrap_err().to_string();
        assert!(!e.contains("run prepare again"), "{e}");
        assert!(check_started(&mine, Ok(started(mine))).is_ok());
    }

    #[test]
    fn netprobe_start_refuses_a_state_directory_without_its_call_group() {
        let dir = std::env::temp_dir().join(format!("netprobe-test-{}", std::process::id()));
        let side = dir.join("side-a");
        std::fs::create_dir_all(&side).unwrap();
        let state = SideState {
            v: 1,
            side: "a".into(),
            username: "netprobe-a-000000".into(),
            seed: "1".into(),
            user_id: hex::encode([1; 16]),
            device_id: hex::encode(
                crate::TestClient::new(
                    "x",
                    UserId::from_bytes([1; 16]),
                    dilla_core::identity::Tier::Native,
                    dilla_core::identity::Kind::User,
                    1,
                )
                .unwrap()
                .device_id()
                .as_bytes(),
            ),
            dm: hex::encode([2; 16]),
            group_id: hex::encode([3; 16]),
        };
        state.write(&side).unwrap();
        // An empty MLS store: the group this state names is not in it.
        let store = rusqlite::Connection::open(side.join(MLS_FILE)).unwrap();
        drop(store);
        let e = load_side(&side).err().unwrap().to_string();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(e.contains("run prepare again"), "{e}");
    }
}
