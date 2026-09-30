//! A synchronous HTTP + WebSocket delivery-service client, over the real `/v1` surface.
//!
//! Everything here speaks the wire a real client will speak: deterministic CBOR bodies, 32-hex
//! path identifiers, `Authorization: Bearer`, and the four-element gateway frame. There is no
//! test-only shortcut on the server side — `dillad serve` has no `--insecure-test-bootstrap`
//! flag, and account creation goes through `dillad init`'s bootstrap invite.
//!
//! The only non-`/v1` origin it talks to is the test host's control listener, whose base URL
//! arrives in `DILLA_TESTKIT_CONTROL` and which speaks JSON: see [`control_post`].

use std::collections::BTreeMap;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use dilla_core::cbor::{CborError, Decoder, Encoder, decode_strict};
use dilla_core::identity::DeviceList;
use dilla_core::ids::DeviceId;
use tungstenite::{Message, WebSocket};

use super::{
    CommitRequest, CommitResult, DeliveryService, Device, DsError, ErrorExtras, Frame, GroupId,
    GroupInfoResp, HandshakeItem, HealRequest, KeyPackageResp, MessageItem, ProposalItem,
    RegisterRequest, RegisterResult, ResyncRequest, TreeResp, UploadResult, WelcomeItem,
};

/// The gateway subprotocol `internal/gateway.Handler` negotiates.
const SUBPROTOCOL: &str = "dilla.v1";
/// How long a pump waits on an empty socket before it returns. Short, because `drain` is called
/// once per scenario step and the harness runs every step against loopback.
const PUMP_WAIT: Duration = Duration::from_millis(50);
/// How long the upgrade, `hello`, `identify` and `ready` may take together.
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// Row 4's and row 12's page sizes, the handlers' own defaults.
const HANDSHAKE_PAGE: usize = 256;
const MESSAGE_PAGE: usize = 128;
/// Row 15's page size, the handler's own default.
const WELCOME_PAGE: usize = 64;

pub struct HttpDs {
    base: String,
    token: String,
    device: DeviceId,
    agent: ureq::Agent,
    ws: Option<WebSocket<TcpStream>>,
    pending: Vec<Frame>,
    /// What the scenario asked for with `go_offline` / `go_online`. A socket the instance closed
    /// while this is true is reopened by the next `drain`.
    online: bool,
    /// `hello`'s heartbeat interval; the client beats at half of it.
    heartbeat: Duration,
    last_beat: Instant,
    /// The highest replay `n` received, which every heartbeat acknowledges.
    last_n: u64,
    /// The highest per-group `seq` delivered as a handshake or a message, per group. A reconnect
    /// catches up from here over rows 4 and 12, so a `drain` after a gap returns what the gap
    /// held — the per-group seq cursors and `GET ?from=` are the truth, not the replay ring.
    delivered: BTreeMap<Vec<u8>, u64>,
    connected_before: bool,
    /// The session's hard expiry in the instance's unix seconds, 0 when unknown: what tells a
    /// runner that has moved the instance clock whether this device must sign in again.
    expires: u64,
    /// Diagnostics for a failed `expect_*`: how many times the socket was reopened, why it was
    /// lost (the last few reasons), and how many frames `accept` queued. None of it steers
    /// behaviour; a scenario that fails on a slow runner reports it instead of "never decrypted".
    reconnects: u64,
    lost: Vec<String>,
    accepted: u64,
}

/// What `redeem_invite` returns: the identifiers the instance minted.
#[derive(Clone, Debug)]
pub struct Enrolled {
    pub user_id: [u8; 16],
    pub device_id: DeviceId,
    pub token: String,
    /// The first session's hard expiry, in the instance's unix seconds.
    pub expires: u64,
}

/// The account half and the first device of `POST /v1/accounts`, as protocol/09 fixes them:
/// `[code, username, display, umk_pub, ssk_pub, sig_umk_ssk, password|null, device]` with
/// `device = [device_id, dsk_pub, tier, signer_tier, credential]`.
#[derive(Clone, Debug)]
pub struct NewAccount {
    pub username: String,
    pub display: String,
    pub umk_pub: [u8; 32],
    pub ssk_pub: [u8; 32],
    pub sig_umk_ssk: [u8; 64],
    pub device_id: DeviceId,
    pub dsk_pub: [u8; 32],
    pub tier: u8,
    pub signer_tier: u8,
    /// The `CredentialIdentity` CBOR.
    pub credential: Vec<u8>,
}

fn encode(f: impl FnOnce(&mut Encoder)) -> Vec<u8> {
    let mut e = Encoder::new();
    f(&mut e);
    e.into_vec()
}

fn protocol(e: CborError) -> DsError {
    DsError::Protocol(e.to_string())
}

fn transport(e: impl std::fmt::Display) -> DsError {
    DsError::Transport(e.to_string())
}

/// A `bstr` field the Go encoder may have written as `null`: `fxamacker/cbor`'s core-deterministic
/// mode encodes a nil `[]byte` as `null`, not as an empty string.
fn bytes_or_null(d: &mut Decoder<'_>) -> Result<Vec<u8>, CborError> {
    Ok(d.opt_bytes()?.map(<[u8]>::to_vec).unwrap_or_default())
}

/// An array head the Go encoder may have written as `null`, for the same reason: a nil slice.
fn array_or_null(d: &mut Decoder<'_>) -> Result<usize, CborError> {
    if d.try_null()? { Ok(0) } else { d.array_len() }
}

fn device_id(d: &mut Decoder<'_>) -> Result<DeviceId, CborError> {
    Ok(DeviceId::from_bytes(d.bytes_exact::<16>()?))
}

fn small<T: TryFrom<u64>>(v: u64) -> Result<T, CborError> {
    T::try_from(v).map_err(|_| CborError::IntegerOverflow)
}

/// `[seq, epoch, kind, sender|null, blob]`, row 4's item and op 16's payload alike.
fn handshake_item(d: &mut Decoder<'_>) -> Result<HandshakeItem, CborError> {
    d.array(5)?;
    Ok(HandshakeItem {
        seq: d.uint()?,
        epoch: d.uint()?,
        kind: small(d.uint()?)?,
        sender: d.opt_uint()?.map(small).transpose()?,
        blob: bytes_or_null(d)?,
    })
}

/// `http://host:port` → `host:port`. The harness only ever serves plain HTTP on loopback; an
/// `https://` base is refused rather than silently spoken to in cleartext.
fn host_of(base: &str) -> Result<&str, DsError> {
    let rest = base.strip_prefix("http://").ok_or_else(|| {
        DsError::Protocol(format!(
            "{base}: the testkit speaks plain http:// to a loopback instance only"
        ))
    })?;
    Ok(rest.split('/').next().unwrap_or(rest))
}

fn new_agent() -> ureq::Agent {
    // A non-2xx answer is a protocol/02 error body the scenario matches on, so it must come back
    // as a response, not as ureq's `Error::StatusCode` with the body thrown away.
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .build(),
    )
}

/// One request, answered with its status and body whatever the status is.
fn call(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<(&str, &[u8])>,
) -> Result<(u16, Vec<u8>), DsError> {
    let bearer = token.map(|t| format!("Bearer {t}"));
    let response = match (method, body) {
        ("GET", None) => {
            let mut r = agent.get(url);
            if let Some(b) = &bearer {
                r = r.header("Authorization", b);
            }
            r.call()
        }
        ("DELETE", None) => {
            let mut r = agent.delete(url);
            if let Some(b) = &bearer {
                r = r.header("Authorization", b);
            }
            r.call()
        }
        ("POST", Some((content_type, bytes))) => {
            let mut r = agent.post(url).content_type(content_type);
            if let Some(b) = &bearer {
                r = r.header("Authorization", b);
            }
            r.send(bytes)
        }
        ("PUT", Some((content_type, bytes))) => {
            let mut r = agent.put(url).content_type(content_type);
            if let Some(b) = &bearer {
                r = r.header("Authorization", b);
            }
            r.send(bytes)
        }
        (method, _) => {
            return Err(DsError::Protocol(format!(
                "no {method} request shape in the testkit client"
            )));
        }
    }
    .map_err(transport)?;
    let status = response.status().as_u16();
    let out = response.into_body().read_to_vec().map_err(transport)?;
    Ok((status, out))
}

/// POSTs deterministic CBOR and answers the body of a 2xx, or the `DsError` a non-2xx carries.
fn post_cbor(
    agent: &ureq::Agent,
    url: &str,
    token: Option<&str>,
    body: &[u8],
) -> Result<Vec<u8>, DsError> {
    let (status, out) = call(agent, "POST", url, token, Some(("application/cbor", body)))?;
    check_status(status, &out)?;
    Ok(out)
}

/// What a client reads from `GET /v1/instance` before it holds a session (protocol/09 §
/// Instance): the instance id, bound into every session signature and every group's binding, and
/// the current external-sender key, which every `text` and `call` group's `external_senders`
/// extension must carry for the instance to propose into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstanceDocument {
    pub instance_id: [u8; 16],
    pub external_sender_key_id: [u8; 16],
    pub external_sender_pub: [u8; 32],
}

/// `GET /v1/instance`: elements 3 (instance_id), 9 (external_sender_key_id) and 10
/// (external_sender_pub) of the eleven-element discovery document.
fn instance_document_of(agent: &ureq::Agent, base: &str) -> Result<InstanceDocument, DsError> {
    let (status, out) = call(agent, "GET", &format!("{base}/v1/instance"), None, None)?;
    check_status(status, &out)?;
    decode_instance_document(&out).map_err(protocol)
}

fn decode_instance_document(body: &[u8]) -> Result<InstanceDocument, CborError> {
    decode_strict(body, |d| {
        d.array(11)?;
        for _ in 0..3 {
            d.skip()?;
        }
        let instance_id = d.bytes_exact::<16>()?;
        for _ in 4..9 {
            d.skip()?;
        }
        let external_sender_key_id = d.bytes_exact::<16>()?;
        let external_sender_pub = d.bytes_exact::<32>()?;
        Ok(InstanceDocument {
            instance_id,
            external_sender_key_id,
            external_sender_pub,
        })
    })
}

fn instance_id_of(agent: &ureq::Agent, base: &str) -> Result<[u8; 16], DsError> {
    instance_document_of(agent, base).map(|doc| doc.instance_id)
}

/// A non-2xx answer is decoded as protocol/02's error array, so a scenario's `expect_reject`
/// matches on the same `E_*` code a real client would see.
///
/// `[code, detail, retry_after_ms|null]`, extended for four codes: `E_COMMIT_CONFLICT` appends
/// `[winning_commit, proposals]`, `E_COMMIT_REQUIRED` `[proposals]`, `E_COMMIT_INVALID` `[rule]`
/// and `E_VERSION` three version lists. `decode_strict` refuses trailing bytes, so every declared
/// element is consumed; the ones this client has no use for are skipped.
fn check_status(status: u16, body: &[u8]) -> Result<(), DsError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let (code, detail, extras) = decode_strict(body, |d: &mut Decoder<'_>| {
        let n = d.array_len()?;
        if n < 3 {
            return Err(CborError::WrongArrayLen {
                expected: 3,
                actual: n,
            });
        }
        let code = d.text()?.to_owned();
        let detail = d.text()?.to_owned();
        let mut extras = ErrorExtras {
            retry_after_ms: d.opt_uint()?,
            ..ErrorExtras::default()
        };
        let mut rest = n - 3;
        match (code.as_str(), rest) {
            ("E_COMMIT_CONFLICT", 2..) => {
                extras.winning_commit = bytes_or_null(d)?;
                for _ in 0..array_or_null(d)? {
                    extras.proposals.push(bytes_or_null(d)?);
                }
                rest -= 2;
            }
            ("E_COMMIT_REQUIRED", 1..) => {
                for _ in 0..array_or_null(d)? {
                    extras.proposals.push(bytes_or_null(d)?);
                }
                rest -= 1;
            }
            ("E_COMMIT_INVALID", 1..) => {
                extras.rule = d.text()?.to_owned();
                rest -= 1;
            }
            _ => {}
        }
        for _ in 0..rest {
            d.skip()?;
        }
        Ok((code, detail, extras))
    })
    .map_err(|e| {
        DsError::Protocol(format!(
            "HTTP {status} with an undecodable error body ({e}): {}",
            hex::encode(body)
        ))
    })?;
    Err(DsError::from_code(status, &code, &detail, extras))
}

/// What one inbound gateway frame means to the client.
enum Inbound {
    Hello {
        wire: Vec<u64>,
        e2ee: Vec<u64>,
        media: Vec<u64>,
        heartbeat_ms: u64,
    },
    Ready,
    /// `invalid_session` or `reconnect`: the connection is over and the reason says why.
    Closing(String),
    Frame(Frame),
    /// `heartbeat_ack` (7): the gateway handles one connection's frames in order, so the answer to
    /// a heartbeat proves every frame sent before it has been handled.
    HeartbeatAck,
    /// Control frames the client has no use for (`resumed`) and the ops outside the delivery
    /// service (32 and above).
    Ignored,
}

fn uint_list(d: &mut Decoder<'_>) -> Result<Vec<u64>, CborError> {
    let n = array_or_null(d)?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(d.uint()?);
    }
    Ok(out)
}

/// Decodes `[op, n, group_id|null, payload]`, the four-element frame of protocol/02 § Gateway
/// frames, and returns the replay `n` beside it.
fn decode_frame(bytes: &[u8]) -> Result<(u64, Inbound), DsError> {
    decode_strict(bytes, |d: &mut Decoder<'_>| {
        d.array(4)?;
        let op = d.uint()?;
        let n = d.uint()?;
        let group = d.opt_bytes()?.map(<[u8]>::to_vec);
        let len = d.array_len()?;
        let expect = |want: usize| {
            if len == want {
                Ok(())
            } else {
                Err(CborError::WrongArrayLen {
                    expected: want,
                    actual: len,
                })
            }
        };
        // A delivery-service frame without a group is not a frame this client can route.
        let group_id = || {
            group.clone().ok_or(CborError::TypeMismatch {
                expected: "group_id",
                offset: 0,
            })
        };
        let inbound = match op {
            0 => {
                expect(9)?;
                let (wire, e2ee, media) = (uint_list(d)?, uint_list(d)?, uint_list(d)?);
                let heartbeat_ms = d.uint()?;
                for _ in 4..9 {
                    d.skip()?;
                }
                Inbound::Hello {
                    wire,
                    e2ee,
                    media,
                    heartbeat_ms,
                }
            }
            3 => {
                for _ in 0..len {
                    d.skip()?;
                }
                Inbound::Ready
            }
            5 => {
                expect(2)?;
                let _resumable = d.uint()?;
                Inbound::Closing(format!("invalid_session: {}", d.text()?))
            }
            8 => {
                expect(2)?;
                let reason = d.text()?.to_owned();
                let after_ms = d.uint()?;
                Inbound::Closing(format!("reconnect: {reason} (after {after_ms} ms)"))
            }
            7 => {
                for _ in 0..len {
                    d.skip()?;
                }
                Inbound::HeartbeatAck
            }
            9 => {
                expect(3)?;
                Inbound::Frame(Frame::GatewayError {
                    cid: d.uint()?,
                    code: d.text()?.to_owned(),
                    detail: d.text()?.to_owned(),
                })
            }
            16 => {
                // The same five positions as row 4's item, whose array head `len` already read.
                expect(5)?;
                let item = HandshakeItem {
                    seq: d.uint()?,
                    epoch: d.uint()?,
                    kind: small(d.uint()?)?,
                    sender: d.opt_uint()?.map(small).transpose()?,
                    blob: bytes_or_null(d)?,
                };
                Inbound::Frame(Frame::MlsHandshake {
                    group_id: group_id()?,
                    item,
                })
            }
            17 => {
                expect(4)?;
                let epoch = d.uint()?;
                let mut proposal_refs = Vec::new();
                for _ in 0..array_or_null(d)? {
                    proposal_refs.push(bytes_or_null(d)?);
                }
                Inbound::Frame(Frame::CommitNeeded {
                    group_id: group_id()?,
                    epoch,
                    proposal_refs,
                    deadline_ms: d.uint()?,
                    round: d.uint()?,
                })
            }
            18 => {
                expect(2)?;
                Inbound::Frame(Frame::MlsEpochChanged {
                    group_id: group_id()?,
                    epoch: d.uint()?,
                    seq: d.uint()?,
                })
            }
            19 => {
                expect(6)?;
                let item = MessageItem {
                    seq: d.uint()?,
                    epoch: d.uint()?,
                    uploader_device: device_id(d)?,
                    blob: bytes_or_null(d)?,
                    // Op 19 does not carry the commitment (protocol/02 § Gateway frames); the
                    // recipient verifies `C` against the decrypted envelope, not against this.
                    commitment: [0u8; 32],
                    franking_tag: d.bytes_exact::<32>()?,
                    recv_ts: d.uint()?,
                };
                Inbound::Frame(Frame::MessageCt {
                    group_id: group_id()?,
                    item,
                })
            }
            20 => {
                expect(6)?;
                let (_welcome_id, _epoch, _commit_seq) = (d.uint()?, d.uint()?, d.uint()?);
                let blob = bytes_or_null(d)?;
                // The tree and its hash are row 15's to deliver: `join_welcome` collects the
                // Welcome there, so the frame is only the notice.
                d.skip()?;
                d.skip()?;
                Inbound::Frame(Frame::MlsWelcome {
                    group_id: group_id()?,
                    blob,
                })
            }
            21 => {
                expect(2)?;
                Inbound::Frame(Frame::MessageDeleted {
                    group_id: group_id()?,
                    seq: d.uint()?,
                    deleted_at: d.uint()?,
                })
            }
            _ => {
                for _ in 0..len {
                    d.skip()?;
                }
                Inbound::Ignored
            }
        };
        Ok((n, inbound))
    })
    .map_err(|e| DsError::Protocol(format!("gateway frame: {e}")))
}

fn read_timeout(ws: &mut WebSocket<TcpStream>, wait: Duration) -> Result<(), DsError> {
    ws.get_mut().set_read_timeout(Some(wait)).map_err(transport)
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(
        io.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ))
}

/// A challenge-response device session: a nonce, an Ed25519 signature over the 81-byte preimage
/// of `protocol/02`'s "Device sessions", then the session itself. Answers the bearer token and
/// its hard expiry, in the instance's unix seconds.
fn establish(
    agent: &ureq::Agent,
    base: &str,
    device: &Device,
    credential: &[u8],
) -> Result<(String, u64), DsError> {
    let device_hex = hex::encode(device.id().as_bytes());
    let challenge = post_cbor(
        agent,
        &format!("{base}/v1/devices/{device_hex}/sessions/challenge"),
        None,
        &encode(|e| {
            e.array(0);
        }),
    )?;
    let (nonce, _expires) = decode_strict(&challenge, |d: &mut Decoder<'_>| {
        d.array(2)?;
        Ok((d.bytes_exact::<32>()?, d.uint()?))
    })
    .map_err(protocol)?;

    // "dilla session v1" (16) || instance_id (16) || device_id (16) || nonce (32) || purpose (1)
    let instance_id = instance_id_of(agent, base)?;
    let mut preimage = Vec::with_capacity(81);
    preimage.extend_from_slice(b"dilla session v1");
    preimage.extend_from_slice(&instance_id);
    preimage.extend_from_slice(device.id().as_bytes());
    preimage.extend_from_slice(&nonce);
    preimage.push(0); // purpose 0: session
    let sig = device.sign(&preimage);

    let body = encode(|e| {
        e.array(5)
            .bytes(&nonce)
            .uint(0)
            .bytes(&sig)
            .bytes(credential)
            .null();
    });
    let session = post_cbor(
        agent,
        &format!("{base}/v1/devices/{device_hex}/sessions"),
        None,
        &body,
    )?;
    // `[token, scope, user_id, device_id, expires, idle_expires, generation]` (protocol/09).
    decode_strict(&session, |d: &mut Decoder<'_>| {
        d.array(7)?;
        let token = d.text()?.to_owned();
        for _ in 1..4 {
            d.skip()?;
        }
        let expires = d.uint()?;
        d.skip()?;
        d.skip()?;
        Ok((token, expires))
    })
    .map_err(protocol)
}

impl HttpDs {
    /// Establishes a device session over the real endpoints: a challenge, an Ed25519 signature
    /// over the 81-byte preimage of `protocol/02`'s "Device sessions", then the session itself.
    pub fn connect(base: &str, device: &Device, credential: &[u8]) -> Result<Self, DsError> {
        let (token, expires) = establish(&new_agent(), base, device, credential)?;
        let mut ds = Self::with_session(base, device.id(), token)?;
        ds.expires = expires;
        Ok(ds)
    }

    /// Signs in again: a fresh challenge-response session replaces the one this client holds,
    /// and the gateway connection is reopened over it when the device is online. A native
    /// session lasts 30 days (protocol/02 § Device sessions item 5), so a scenario that moves the
    /// instance clock past that is one in which every device has to sign in again — which a real
    /// client does the same way.
    pub fn reauthenticate(&mut self, device: &Device, credential: &[u8]) -> Result<(), DsError> {
        (self.token, self.expires) = establish(&self.agent, &self.base, device, credential)?;
        // What the old connection already holds is read first, as `set_online(false)` does: the
        // reconnect's catch-up starts after `delivered`, which only a pumped frame advances, so
        // closing over them would ask the instance for frames it may since have pruned.
        self.pump()?;
        if let Some(mut ws) = self.ws.take() {
            let _ = ws.close(None);
            let _ = ws.flush();
        }
        if self.online {
            self.open_socket()?;
        }
        Ok(())
    }

    /// A client over a session the caller already holds — the one `POST /v1/accounts` returns
    /// beside the account (protocol/02 § Device sessions item 7), so a freshly registered device
    /// does not spend a challenge it has no need of. Opens the gateway connection.
    pub fn with_session(base: &str, device: DeviceId, token: String) -> Result<Self, DsError> {
        host_of(base)?;
        let mut ds = Self {
            base: base.trim_end_matches('/').to_owned(),
            token,
            device,
            agent: new_agent(),
            ws: None,
            pending: Vec::new(),
            online: true,
            heartbeat: Duration::from_secs(30),
            last_beat: Instant::now(),
            last_n: 0,
            delivered: BTreeMap::new(),
            connected_before: false,
            reconnects: 0,
            lost: Vec::new(),
            accepted: 0,
            expires: 0,
        };
        ds.open_socket()?;
        Ok(ds)
    }

    /// Creates an account against `dillad init`'s bootstrap invite. There is no other way in: the
    /// instance is invite-only and the harness has no back door.
    pub fn redeem_invite(base: &str, code: &str, account: NewAccount) -> Result<Enrolled, DsError> {
        let agent = new_agent();
        let body = encode(|e| {
            e.array(8)
                .text(code)
                .text(&account.username)
                .text(&account.display)
                .bytes(&account.umk_pub)
                .bytes(&account.ssk_pub)
                .bytes(&account.sig_umk_ssk)
                .null();
            e.array(5)
                .bytes(account.device_id.as_bytes())
                .bytes(&account.dsk_pub)
                .uint(u64::from(account.tier))
                .uint(u64::from(account.signer_tier))
                .bytes(&account.credential);
        });
        let out = post_cbor(&agent, &format!("{base}/v1/accounts"), None, &body)?;
        decode_strict(&out, |d: &mut Decoder<'_>| {
            d.array(4)?;
            let user_id = d.bytes_exact::<16>()?;
            let device_id = device_id(d)?;
            let token = d.text()?.to_owned();
            let expires = d.uint()?;
            Ok(Enrolled {
                user_id,
                device_id,
                token,
                expires,
            })
        })
        .map_err(protocol)
    }

    pub fn device(&self) -> DeviceId {
        self.device
    }

    /// Reads what the gateway has already written into `pending`, as `set_online(false)` does.
    /// A clock jump longer than the heartbeat grace makes the instance close every connection
    /// 4009 on its next maintenance tick, and the reconnect's catch-up resumes after `delivered`,
    /// which only a pumped frame advances: frames left unread in the dead socket would be asked
    /// for again after the jump, when retention may already have taken them.
    pub fn settle(&mut self) -> Result<(), DsError> {
        if !self.online {
            return Ok(());
        }
        self.pump()
    }

    /// The session's hard expiry in the instance's unix seconds; 0 when unknown.
    pub fn session_expires(&self) -> u64 {
        self.expires
    }

    /// Records the hard expiry of the session `with_session` was handed (the one `POST
    /// /v1/accounts` answers with).
    pub fn set_session_expires(&mut self, expires: u64) {
        self.expires = expires;
    }

    /// `PUT /v1/users/{user_id}/device-list`: `[version, blob, ssk_signature, prev_hash]`, where
    /// `blob` is protocol/03's full six-element signed list — the form the instance hands to the
    /// guest's `device_list_entries` when invariant 4 checks an Add's DSK against it.
    pub fn put_device_list(&self, user_id: &[u8; 16], list: &DeviceList) -> Result<(), DsError> {
        let body = encode(|e| {
            e.array(4)
                .uint(list.unsigned.version)
                .bytes(&list.encode())
                .bytes(&list.sig_ssk)
                .bytes(&list.unsigned.prev_hash);
        });
        let path = format!("/v1/users/{}/device-list", hex::encode(user_id));
        let (status, out) = call(
            &self.agent,
            "PUT",
            &self.url(&path),
            Some(&self.token),
            Some(("application/cbor", &body)),
        )?;
        check_status(status, &out)
    }

    /// Opens the gateway: the upgrade with the bearer on the `Authorization` header, `hello`,
    /// `identify` at the highest versions both sides share, and `ready`.
    fn open_socket(&mut self) -> Result<(), DsError> {
        let host = host_of(&self.base)?.to_owned();
        let url = format!("ws://{host}/gateway");
        let request = tungstenite::http::Request::builder()
            .uri(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Sec-WebSocket-Protocol", SUBPROTOCOL)
            .header("Host", host.as_str())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tungstenite::handshake::client::generate_key(),
            )
            .body(())
            .map_err(|e| DsError::Protocol(e.to_string()))?;
        // The stream is built here so its read timeout is set before the handshake: see `pump`'s
        // comment for why a timeout, not a non-blocking toggle, is how a pump returns promptly.
        let stream = TcpStream::connect(&host).map_err(transport)?;
        stream.set_nodelay(true).map_err(transport)?;
        stream
            .set_read_timeout(Some(HANDSHAKE_WAIT))
            .map_err(transport)?;
        let (mut socket, _response) = tungstenite::client(request, stream).map_err(transport)?;

        let (wire, e2ee, media, heartbeat_ms) = match Self::read_one(&mut socket)? {
            (
                _,
                Inbound::Hello {
                    wire,
                    e2ee,
                    media,
                    heartbeat_ms,
                },
            ) => (wire, e2ee, media, heartbeat_ms),
            _ => {
                return Err(DsError::Protocol(
                    "the gateway's first frame was not hello".into(),
                ));
            }
        };
        // protocol/07 "Negotiation": the client takes the highest version it shares with the
        // instance. This client speaks version 1 of all three.
        for (name, offered) in [("wire", &wire), ("e2ee", &e2ee), ("media", &media)] {
            if !offered.contains(&1) {
                return Err(DsError::Protocol(format!(
                    "the instance offers {name} versions {offered:?}; this client speaks 1"
                )));
            }
        }
        let identify = encode(|e| {
            e.array(4).uint(1).uint(1).null();
            e.array(5).text(&self.token).uint(1).uint(1).uint(1).uint(0);
        });
        socket
            .send(Message::Binary(identify.into()))
            .map_err(transport)?;
        loop {
            match Self::read_one(&mut socket)? {
                (_, Inbound::Ready) => break,
                (_, Inbound::Frame(Frame::GatewayError { code, detail, .. })) => {
                    return Err(DsError::Protocol(format!(
                        "identify refused: {code}: {detail}"
                    )));
                }
                (_, Inbound::Closing(reason)) => return Err(DsError::Protocol(reason)),
                // Nothing else can precede `ready` on a fresh identify.
                _ => {}
            }
        }
        read_timeout(&mut socket, PUMP_WAIT)?;
        self.heartbeat = Duration::from_millis(heartbeat_ms.max(1_000));
        self.last_beat = Instant::now();
        self.last_n = 0;
        self.ws = Some(socket);
        // A reconnect is a fresh identify with an empty replay ring, so what arrived while the
        // socket was closed is fetched over rows 4 and 12 before any live frame is returned.
        if self.connected_before {
            self.reconnects += 1;
            self.catch_up()?;
        }
        self.connected_before = true;
        Ok(())
    }

    /// One binary frame, blocking up to the socket's current read timeout.
    fn read_one(socket: &mut WebSocket<TcpStream>) -> Result<(u64, Inbound), DsError> {
        loop {
            match socket.read().map_err(transport)? {
                Message::Binary(bytes) => return decode_frame(&bytes),
                Message::Close(frame) => {
                    return Err(DsError::Transport(format!(
                        "the gateway closed the connection: {frame:?}"
                    )));
                }
                _ => {}
            }
        }
    }

    /// Everything each known group accumulated past `delivered` while the socket was closed, in
    /// seq order, as the frames a live connection would have carried.
    ///
    /// A group the instance answers `E_NOT_FOUND` for is one this device is no longer a member
    /// of (a non-member is E_NOT_FOUND, never E_FORBIDDEN — `internal/ds/sequencer.go`): it is
    /// forgotten rather than failing the reconnect, which is what a live socket does too, since
    /// the gateway stops fanning that group out to the device.
    fn catch_up(&mut self) -> Result<(), DsError> {
        let groups: Vec<(Vec<u8>, u64)> = self
            .delivered
            .iter()
            .map(|(g, s)| (g.clone(), *s))
            .collect();
        for (group_id, after) in groups {
            let mut frames: Vec<(u64, Frame)> = Vec::new();
            let handshakes = match self.handshakes(&group_id, after + 1) {
                Err(e) if e.code() == "E_NOT_FOUND" => {
                    self.delivered.remove(&group_id);
                    continue;
                }
                other => other?,
            };
            for item in handshakes {
                frames.push((
                    item.seq,
                    Frame::MlsHandshake {
                        group_id: group_id.clone(),
                        item,
                    },
                ));
            }
            for item in self.messages(&group_id, after + 1)? {
                frames.push((
                    item.seq,
                    Frame::MessageCt {
                        group_id: group_id.clone(),
                        item,
                    },
                ));
            }
            frames.sort_by_key(|(seq, _)| *seq);
            for (_, frame) in frames {
                self.accept(frame);
            }
        }
        Ok(())
    }

    /// Drops the socket and remembers why, for `diagnostics`. The next `drain` reopens it.
    fn socket_lost(&mut self, why: String) {
        self.ws = None;
        if self.lost.len() >= 4 {
            self.lost.remove(0);
        }
        self.lost.push(why);
    }

    /// Queues one frame for the next `drain`, dropping a handshake or a message whose seq was
    /// already delivered — the catch-up and the live socket can overlap by a frame or two.
    fn accept(&mut self, frame: Frame) {
        let seq_of = |f: &Frame| match f {
            Frame::MlsHandshake { group_id, item } => Some((group_id.clone(), item.seq)),
            Frame::MessageCt { group_id, item } => Some((group_id.clone(), item.seq)),
            _ => None,
        };
        if let Some((group_id, seq)) = seq_of(&frame) {
            let high = self.delivered.entry(group_id).or_insert(0);
            if seq <= *high {
                return;
            }
            *high = seq;
        }
        self.accepted += 1;
        self.pending.push(frame);
    }

    /// Records that this device takes part in `group_id` from `seq` onward, for a group it learned
    /// of without a frame — its own registration, a Welcome row, its own external commit. Without
    /// this the reconnect's catch-up, which walks `delivered`, never visits the group: a Welcome
    /// joiner that went offline before its first `drain` would miss every message sent meanwhile.
    ///
    /// Only ever raises the high-water mark: what was already delivered is never fetched twice.
    fn learn(&mut self, group_id: &[u8], seq: u64) {
        let high = self.delivered.entry(group_id.to_vec()).or_insert(0);
        *high = (*high).max(seq.saturating_sub(1));
    }

    fn send_heartbeat(&mut self) -> Result<(), DsError> {
        let beat = encode(|e| {
            e.array(4).uint(6).uint(0).null();
            e.array(2).uint(self.last_n).uint(1);
        });
        if let Some(ws) = self.ws.as_mut() {
            ws.send(Message::Binary(beat.into())).map_err(transport)?;
        }
        self.last_beat = Instant::now();
        Ok(())
    }

    /// Reads every frame that is already buffered, without blocking on an empty socket.
    ///
    /// The socket carries a short `SO_RCVTIMEO` (set once the handshake is done) rather than a
    /// non-blocking toggle per pump: a short read timeout gives the same "return promptly when
    /// there is nothing to read" behaviour, surfaces as `WouldBlock`/`TimedOut`, and leaves any
    /// partially read frame in tungstenite's own buffer for the next pump.
    ///
    /// A connection the instance closes (`invalid_session`, `reconnect`, a close frame, a reset)
    /// is dropped here; the next `drain` reopens it while the scenario has the device online.
    fn pump(&mut self) -> Result<(), DsError> {
        if self.ws.is_none() {
            return Ok(());
        }
        if self.last_beat.elapsed() >= self.heartbeat / 2 {
            self.send_heartbeat()?;
        }
        loop {
            let Some(ws) = self.ws.as_mut() else {
                return Ok(());
            };
            match ws.read() {
                Ok(Message::Binary(bytes)) => {
                    let (n, inbound) = decode_frame(&bytes)?;
                    self.last_n = self.last_n.max(n);
                    match inbound {
                        Inbound::Frame(frame) => self.accept(frame),
                        Inbound::Closing(reason) => self.socket_lost(format!("closing: {reason}")),
                        Inbound::Hello { .. }
                        | Inbound::Ready
                        | Inbound::HeartbeatAck
                        | Inbound::Ignored => {}
                    }
                }
                Ok(Message::Close(frame)) => self.socket_lost(format!("close frame: {frame:?}")),
                Ok(_) => {}
                Err(e) if is_timeout(&e) => return Ok(()),
                Err(
                    e @ (tungstenite::Error::ConnectionClosed
                    | tungstenite::Error::AlreadyClosed
                    | tungstenite::Error::Protocol(_)
                    | tungstenite::Error::Io(_)),
                ) => self.socket_lost(format!("read error: {e}")),
                Err(e) => return Err(transport(e)),
            }
        }
    }

    /// Sends a heartbeat and reads until its `heartbeat_ack`, keeping every frame that arrives
    /// meanwhile. The gateway handles one connection's frames in order, so on return every frame
    /// this client sent before the heartbeat has been handled — which is what makes a following
    /// control-listener call (an `advance_clock` that runs the watchdog) see a `commit_ack`.
    fn barrier(&mut self) -> Result<(), DsError> {
        self.send_heartbeat()?;
        let deadline = Instant::now() + HANDSHAKE_WAIT;
        loop {
            let Some(ws) = self.ws.as_mut() else {
                return Err(DsError::Transport(
                    "the gateway closed the connection before answering the heartbeat".into(),
                ));
            };
            match ws.read() {
                Ok(Message::Binary(bytes)) => {
                    let (n, inbound) = decode_frame(&bytes)?;
                    self.last_n = self.last_n.max(n);
                    match inbound {
                        Inbound::HeartbeatAck => return Ok(()),
                        Inbound::Frame(frame) => self.accept(frame),
                        Inbound::Closing(reason) => {
                            self.ws = None;
                            return Err(DsError::Transport(reason));
                        }
                        Inbound::Hello { .. } | Inbound::Ready | Inbound::Ignored => {}
                    }
                }
                Ok(Message::Close(_)) => {
                    self.ws = None;
                    return Err(DsError::Transport(
                        "the gateway closed the connection".into(),
                    ));
                }
                Ok(_) => {}
                Err(e) if is_timeout(&e) => {
                    if Instant::now() >= deadline {
                        return Err(DsError::Transport("no heartbeat_ack".into()));
                    }
                }
                Err(e) => return Err(transport(e)),
            }
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn get_decoded<T>(
        &self,
        path: &str,
        f: impl FnOnce(&mut Decoder<'_>) -> Result<T, CborError>,
    ) -> Result<T, DsError> {
        let (status, out) = call(&self.agent, "GET", &self.url(path), Some(&self.token), None)?;
        check_status(status, &out)?;
        decode_strict(&out, f).map_err(|e| DsError::Protocol(format!("GET {path}: {e}")))
    }

    fn post_decoded<T>(
        &self,
        path: &str,
        body: &[u8],
        f: impl FnOnce(&mut Decoder<'_>) -> Result<T, CborError>,
    ) -> Result<T, DsError> {
        let out = post_cbor(&self.agent, &self.url(path), Some(&self.token), body)?;
        decode_strict(&out, f).map_err(|e| DsError::Protocol(format!("POST {path}: {e}")))
    }

    /// A POST whose success is a status and no body the client reads (`204`, or row 9's
    /// `202 []`).
    fn post_status(&self, path: &str, body: &[u8]) -> Result<(), DsError> {
        post_cbor(&self.agent, &self.url(path), Some(&self.token), body).map(|_| ())
    }

    fn group_path(g: &GroupId, tail: &str) -> String {
        format!("/v1/groups/{}{tail}", hex::encode(g))
    }

    /// POSTs JSON to the test host's control listener. See [`control_post`].
    fn post_control(&self, path: &str, body: &str) -> Result<Vec<u8>, DsError> {
        control(&self.agent, "POST", path, Some(body))
    }
}

/// The test host's control listener, whose base URL arrives in `DILLA_TESTKIT_CONTROL`. It is a
/// separate origin from the instance on purpose: the control routes are never mounted on the
/// public mux, so a scenario cannot reach them by accident and no production build can serve
/// them. `/debug` is not a `/v1` route and speaks JSON, not deterministic CBOR — the Go handler
/// decodes `{"seconds": n}`, and a CBOR body there is a 400.
fn control(
    agent: &ureq::Agent,
    method: &str,
    path: &str,
    json: Option<&str>,
) -> Result<Vec<u8>, DsError> {
    let base = std::env::var("DILLA_TESTKIT_CONTROL").map_err(|_| {
        DsError::Protocol(
            "DILLA_TESTKIT_CONTROL is unset: this scenario needs the test host's control \
             listener (advance_clock, kick, snapshot, restore_snapshot, expect_quarantined, \
             expect_closed)"
                .into(),
        )
    })?;
    let url = format!("{}{path}", base.trim_end_matches('/'));
    let (status, out) = call(
        agent,
        method,
        &url,
        None,
        json.map(|j| ("application/json", j.as_bytes())),
    )?;
    if !(200..300).contains(&status) {
        return Err(DsError::Protocol(format!(
            "control {method} {path}: {status} {}",
            String::from_utf8_lossy(&out)
        )));
    }
    Ok(out)
}

/// The discovery document of the instance at `base`: its id, which a remote scenario binds its
/// groups to (invariant 1 refuses a binding that names another instance), and its current
/// external-sender key.
pub fn instance_document(base: &str) -> Result<InstanceDocument, DsError> {
    host_of(base)?;
    instance_document_of(&new_agent(), base.trim_end_matches('/'))
}

/// `POST <control><path>` with a JSON body, for the runner's control-listener verbs.
pub fn control_post(path: &str, json: &str) -> Result<Vec<u8>, DsError> {
    control(&new_agent(), "POST", path, Some(json))
}

/// `GET <control><path>`, answered as the JSON body's bytes.
pub fn control_get(path: &str) -> Result<Vec<u8>, DsError> {
    control(&new_agent(), "GET", path, None)
}

impl DeliveryService for HttpDs {
    /// Row 10: `[packages([bstr]), last_resort(bstr|null)]` -> `201 [count]`. The session names
    /// the device; `d` must be the device this client holds a session for.
    fn publish_key_packages(
        &mut self,
        d: &Device,
        kps: Vec<Vec<u8>>,
        last_resort: Option<Vec<u8>>,
    ) -> Result<usize, DsError> {
        if d.id() != self.device {
            return Err(DsError::Protocol(format!(
                "this client holds a session for {}, not {}",
                self.device.to_hex(),
                d.id().to_hex()
            )));
        }
        let body = encode(|e| {
            e.array(2).array(kps.len());
            for kp in &kps {
                e.bytes(kp);
            }
            e.opt_bytes(last_resort.as_deref());
        });
        self.post_decoded("/v1/keypackages", &body, |d| {
            d.array(1)?;
            small(d.uint()?)
        })
    }

    /// Row 1: `[group_id, binding, group_info, ratchet_tree]` -> `201 [group_id, next_seq]`. The
    /// group id is the binding's `target_id` (invariant 1), which the instance checks.
    ///
    /// The answer's `next_seq` is the first seq the group's log will hold, so the creator catches
    /// up from there on a reconnect.
    fn register_group(&mut self, r: RegisterRequest) -> Result<RegisterResult, DsError> {
        let binding = dilla_core::mls::DillaBinding::decode(&r.binding)
            .map_err(|_| DsError::BindingInvalid)?;
        let body = encode(|e| {
            e.array(4)
                .bytes(&binding.target_id)
                .bytes(&r.binding)
                .bytes(&r.group_info)
                .bytes(&r.ratchet_tree);
        });
        let registered = self.post_decoded("/v1/groups", &body, |d| {
            d.array(2)?;
            Ok(RegisterResult {
                group_id: d.bytes()?.to_vec(),
                seq: d.uint()?,
            })
        })?;
        self.learn(&registered.group_id, registered.seq);
        Ok(registered)
    }

    /// Row 2: `[epoch, group_info, tree_hash, next_seq]`.
    fn group_info(&mut self, g: &GroupId) -> Result<GroupInfoResp, DsError> {
        self.get_decoded(&Self::group_path(g, "/info"), |d| {
            d.array(4)?;
            Ok(GroupInfoResp {
                epoch: d.uint()?,
                group_info: bytes_or_null(d)?,
                tree_hash: bytes_or_null(d)?,
                seq: d.uint()?,
            })
        })
    }

    /// Row 3: `[epoch, ratchet_tree, tree_hash]`.
    fn ratchet_tree(&mut self, g: &GroupId) -> Result<TreeResp, DsError> {
        self.get_decoded(&Self::group_path(g, "/tree"), |d| {
            d.array(3)?;
            Ok(TreeResp {
                epoch: d.uint()?,
                ratchet_tree: bytes_or_null(d)?,
                tree_hash: bytes_or_null(d)?,
            })
        })
    }

    /// Row 4, paged until a short page: `[[seq, epoch, kind, sender, blob]]`.
    fn handshakes(&mut self, g: &GroupId, from: u64) -> Result<Vec<HandshakeItem>, DsError> {
        let mut out: Vec<HandshakeItem> = Vec::new();
        let mut next = from;
        loop {
            let path = Self::group_path(
                g,
                &format!("/handshakes?from={next}&limit={HANDSHAKE_PAGE}"),
            );
            let page = self.get_decoded(&path, |d| {
                let n = array_or_null(d)?;
                (0..n)
                    .map(|_| handshake_item(d))
                    .collect::<Result<Vec<_>, _>>()
            })?;
            let short = page.len() < HANDSHAKE_PAGE;
            if let Some(last) = page.last() {
                next = last.seq + 1;
            }
            out.extend(page);
            if short {
                return Ok(out);
            }
        }
    }

    /// Row 11: `[blob, last_resort(uint), kp_ref]`.
    fn take_key_package(&mut self, target: &DeviceId) -> Result<KeyPackageResp, DsError> {
        let path = format!("/v1/devices/{}/keypackage", hex::encode(target.as_bytes()));
        self.get_decoded(&path, |d| {
            d.array(3)?;
            Ok(KeyPackageResp {
                blob: bytes_or_null(d)?,
                last_resort: d.uint()? != 0,
                kp_ref: bytes_or_null(d)?,
            })
        })
    }

    /// Row 5: `[epoch, commit, group_info, welcomes([[device_id, blob]]), ratchet_tree|null]` ->
    /// `[seq, epoch]`.
    fn post_commit(&mut self, g: &GroupId, c: CommitRequest) -> Result<CommitResult, DsError> {
        let body = encode(|e| {
            e.array(5)
                .uint(c.epoch)
                .bytes(&c.commit)
                .bytes(&c.group_info);
            e.array(c.welcomes.len());
            for (device, blob) in &c.welcomes {
                e.array(2).bytes(device.as_bytes()).bytes(blob);
            }
            e.null();
        });
        self.post_decoded(&Self::group_path(g, "/commit"), &body, |d| {
            d.array(2)?;
            Ok(CommitResult {
                seq: d.uint()?,
                epoch: d.uint()?,
            })
        })
    }

    /// Row 8: `[external_commit, group_info]` -> `[seq, epoch]`.
    ///
    /// The joiner is a member from its own commit on, and the gateway fans that commit out to it
    /// like to any member, so a reconnect catches up from the commit's own seq.
    fn post_external_commit(
        &mut self,
        g: &GroupId,
        c: ResyncRequest,
    ) -> Result<CommitResult, DsError> {
        let body = encode(|e| {
            e.array(2).bytes(&c.external_commit).bytes(&c.group_info);
        });
        let committed = self.post_decoded(&Self::group_path(g, "/resync"), &body, |d| {
            d.array(2)?;
            Ok(CommitResult {
                seq: d.uint()?,
                epoch: d.uint()?,
            })
        })?;
        self.learn(g, committed.seq);
        Ok(committed)
    }

    /// Row 6: `[epoch, proposal]` -> `[seq]`.
    fn post_proposal(
        &mut self,
        g: &GroupId,
        epoch: u64,
        proposal: Vec<u8>,
    ) -> Result<u64, DsError> {
        let body = encode(|e| {
            e.array(2).uint(epoch).bytes(&proposal);
        });
        self.post_decoded(&Self::group_path(g, "/proposal"), &body, |d| {
            d.array(1)?;
            d.uint()
        })
    }

    /// Row 7: `[epoch, private_message]` -> `[seq, franking_tag, recv_ts]`. The instance reads the
    /// commitment out of the message's own `authenticated_data`.
    fn post_message_from(
        &mut self,
        g: &GroupId,
        epoch: u64,
        pm: Vec<u8>,
    ) -> Result<UploadResult, DsError> {
        let body = encode(|e| {
            e.array(2).uint(epoch).bytes(&pm);
        });
        self.post_decoded(&Self::group_path(g, "/message"), &body, |d| {
            d.array(3)?;
            Ok(UploadResult {
                seq: d.uint()?,
                franking_tag: bytes_or_null(d)?,
                recv_ts: d.uint()?,
            })
        })
    }

    /// Row 12, paged until a short page:
    /// `[[seq, epoch, uploader_device, blob|null, commitment|null, franking_tag, recv_ts, deleted]]`.
    /// A deleted message comes back with an empty blob and an all-zero commitment: `MessageItem`
    /// has no `deleted` flag, and the stub never deletes.
    fn messages(&mut self, g: &GroupId, from: u64) -> Result<Vec<MessageItem>, DsError> {
        let mut out: Vec<MessageItem> = Vec::new();
        let mut next = from;
        loop {
            let path = Self::group_path(g, &format!("/messages?from={next}&limit={MESSAGE_PAGE}"));
            let page = self.get_decoded(&path, |d| {
                let n = array_or_null(d)?;
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    d.array(8)?;
                    let seq = d.uint()?;
                    let epoch = d.uint()?;
                    let uploader_device = device_id(d)?;
                    let blob = bytes_or_null(d)?;
                    let commitment = d.opt_bytes_exact::<32>()?.unwrap_or([0u8; 32]);
                    let franking_tag = d.bytes_exact::<32>()?;
                    let recv_ts = d.uint()?;
                    let _deleted = d.uint()?;
                    items.push(MessageItem {
                        seq,
                        epoch,
                        uploader_device,
                        blob,
                        commitment,
                        franking_tag,
                        recv_ts,
                    });
                }
                Ok(items)
            })?;
            let short = page.len() < MESSAGE_PAGE;
            if let Some(last) = page.last() {
                next = last.seq + 1;
            }
            out.extend(page);
            if short {
                return Ok(out);
            }
        }
    }

    /// Row 15, looped on `after` until a short page, because the endpoint pages and the trait's
    /// signature does not (interface deviation B7):
    /// `[[welcome_id, group_id, epoch, commit_seq, blob, ratchet_tree, tree_hash]]`.
    fn welcomes(&mut self) -> Result<Vec<WelcomeItem>, DsError> {
        let mut out: Vec<WelcomeItem> = Vec::new();
        let mut after = 0u64;
        loop {
            let path = format!("/v1/welcomes?after={after}&limit={WELCOME_PAGE}");
            let page = self.get_decoded(&path, |d| {
                let n = array_or_null(d)?;
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    d.array(7)?;
                    items.push(WelcomeItem {
                        welcome_id: d.uint()?,
                        group_id: d.bytes()?.to_vec(),
                        epoch: d.uint()?,
                        commit_seq: d.uint()?,
                        blob: bytes_or_null(d)?,
                        ratchet_tree: bytes_or_null(d)?,
                        tree_hash: bytes_or_null(d)?,
                    });
                }
                Ok(items)
            })?;
            let short = page.len() < WELCOME_PAGE;
            if let Some(last) = page.last() {
                after = last.welcome_id;
            }
            out.extend(page);
            if short {
                // The commit that added this device replaced the member list before its fan-out,
                // so the device is sent that Add handshake and everything after it: a reconnect
                // catches up from `commit_seq`, whether or not a frame was drained meanwhile.
                for item in &out {
                    self.learn(&item.group_id, item.commit_seq);
                }
                return Ok(out);
            }
        }
    }

    /// Row 16: `DELETE /v1/welcomes/{welcome_id}` -> `204`. The id is the table's decimal
    /// surrogate key, the one protocol identifier that is not 16 random bytes.
    fn ack_welcome(&mut self, welcome_id: u64) -> Result<(), DsError> {
        let (status, out) = call(
            &self.agent,
            "DELETE",
            &self.url(&format!("/v1/welcomes/{welcome_id}")),
            Some(&self.token),
            None,
        )?;
        check_status(status, &out)
    }

    /// Row 9: `[epoch, seq, reason]` -> `202 []`.
    fn fork_report(
        &mut self,
        g: &GroupId,
        epoch: u64,
        seq: u64,
        reason: &str,
    ) -> Result<(), DsError> {
        let body = encode(|e| {
            e.array(3).uint(epoch).uint(seq).text(reason);
        });
        self.post_status(&Self::group_path(g, "/fork-report"), &body)
    }

    /// Row 14: `[group_info, tail([[seq, epoch, kind, sender, blob]]), ratchet_tree|null]` ->
    /// `[epoch, next_seq]`. The answer is NOT row 5's `[seq, epoch]`: protocol/02 spells the two
    /// rows differently and a client decodes by position, so `seq` here is `next_seq - 1`, the
    /// last seq the heal wrote.
    fn heal(&mut self, g: &GroupId, h: HealRequest) -> Result<CommitResult, DsError> {
        let body = encode(|e| {
            e.array(3).bytes(&h.group_info).array(h.tail.len());
            for item in &h.tail {
                e.array(5)
                    .uint(item.seq)
                    .uint(item.epoch)
                    .uint(u64::from(item.kind))
                    .opt_uint(item.sender.map(u64::from))
                    .bytes(&item.blob);
            }
            e.opt_bytes(h.ratchet_tree.as_deref());
        });
        self.post_decoded(&Self::group_path(g, "/heal"), &body, |d| {
            d.array(2)?;
            let epoch = d.uint()?;
            let next_seq = d.uint()?;
            Ok(CommitResult {
                seq: next_seq.saturating_sub(1),
                epoch,
            })
        })
    }

    /// Row 18: `[last_seq, last_epoch]` -> `204`.
    fn advance_cursor(&mut self, g: &GroupId, seq: u64, epoch: u64) -> Result<(), DsError> {
        let body = encode(|e| {
            e.array(2).uint(seq).uint(epoch);
        });
        self.post_status(&Self::group_path(g, "/cursor"), &body)
    }

    /// Frames received since the last drain. Offline, nothing is read and nothing is returned —
    /// what the socket held when the device went offline stays queued, and what the instance
    /// sends meanwhile is fetched by the catch-up when the device comes back, which is
    /// `DsStub::drain`'s "an offline device's queue is left untouched".
    /// The client's side, then the instance's (`GET /debug/conn` on the test host's control
    /// listener): the device's live connections with their writers' enqueued and written counts,
    /// its place in the group's fan-out list, and the group's epoch and seq. A failed
    /// `expect_decrypts` prints both, so a device that stopped receiving says which side stopped.
    /// Without a control listener the instance's side is the reason it is missing.
    fn diagnostics(&self, g: &GroupId) -> String {
        let server = control_get(&format!(
            "/debug/conn?device={}&group={}",
            self.device.to_hex(),
            hex::encode(g)
        ))
        .map_or_else(
            |e| format!("unavailable: {e}"),
            |body| String::from_utf8_lossy(&body).trim().to_owned(),
        );
        format!(
            "socket {}, reconnects {}, lost {:?}, frames accepted {}, delivered seq for the group {:?}, last n {}; server {server}",
            if self.ws.is_some() { "open" } else { "closed" },
            self.reconnects,
            self.lost,
            self.accepted,
            self.delivered.get(g),
            self.last_n,
        )
    }

    fn drain(&mut self) -> Result<Vec<Frame>, DsError> {
        if !self.online {
            return Ok(Vec::new());
        }
        if self.ws.is_none() {
            self.open_socket()?;
        }
        self.pump()?;
        // A connection the instance closed under this drain (a restart, a restore, an expired
        // session) is reopened now rather than on the next drain: the reconnect's catch-up is what
        // brings in what the dead connection would have carried, and a drain that returned empty
        // here would tell the scenario there was nothing to read.
        if self.ws.is_none() {
            self.open_socket()?;
            self.pump()?;
        }
        Ok(std::mem::take(&mut self.pending))
    }

    fn set_online(&mut self, online: bool) -> Result<(), DsError> {
        if !online {
            // The gateway may already have written frames the device has not drained. Closing
            // over them would lose them for good: the catch-up resumes after `delivered`, which
            // only a pumped frame advances, and the stub keeps an offline device's queue. So they
            // are read into `pending` first and wait there for the next online `drain`.
            self.pump()?;
        }
        self.online = online;
        match (online, self.ws.take()) {
            (false, Some(mut ws)) => {
                // A courtesy close; the instance's online predicate turns on the connection
                // being gone, which dropping the socket guarantees either way.
                let _ = ws.close(None);
                let _ = ws.flush();
                Ok(())
            }
            (true, None) => self.open_socket(),
            (_, ws) => {
                self.ws = ws;
                Ok(())
            }
        }
    }

    /// The instance's clock lives behind the test host's `/debug` listener, never the public mux:
    /// no `dillad` build carries that route.
    ///
    /// `/debug` speaks JSON, not deterministic CBOR — it is not a `/v1` route, and the Go handler
    /// decodes `{"seconds": n}`. Posting CBOR here is a 400 on every advance_clock.
    fn advance_clock(&mut self, secs: u64) -> Result<(), DsError> {
        let body = format!("{{\"seconds\":{secs}}}");
        self.post_control("/debug/clock", &body).map(|_| ())
    }

    /// Row 19: `[[ref, kind, target_leaf|null, blob, void(uint)]]`.
    fn proposals(&mut self, g: &GroupId) -> Result<Vec<ProposalItem>, DsError> {
        self.get_decoded(&Self::group_path(g, "/proposals"), |d| {
            let n = array_or_null(d)?;
            (0..n)
                .map(|_| {
                    d.array(5)?;
                    Ok(ProposalItem {
                        proposal_ref: bytes_or_null(d)?,
                        kind: small(d.uint()?)?,
                        target_leaf: d.opt_uint()?.map(small).transpose()?,
                        blob: bytes_or_null(d)?,
                        void: d.uint()? != 0,
                    })
                })
                .collect::<Result<Vec<_>, CborError>>()
        })
    }

    /// Opcode 12, `[round]`, group-scoped: the one client frame that carries a `group_id`
    /// (protocol/02 § Gateway frames). An offline device has no connection to send it on.
    fn ack_commit(&mut self, g: &GroupId, round: u64) -> Result<(), DsError> {
        if !self.online {
            return Err(DsError::Protocol(
                "an offline device cannot acknowledge an election".into(),
            ));
        }
        if self.ws.is_none() {
            self.open_socket()?;
        }
        let frame = encode(|e| {
            e.array(4).uint(12).uint(0).bytes(g);
            e.array(1).uint(round);
        });
        let ws = self
            .ws
            .as_mut()
            .ok_or_else(|| DsError::Transport("no gateway connection".into()))?;
        ws.send(Message::Binary(frame.into())).map_err(transport)?;
        self.barrier()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cbor(f: impl FnOnce(&mut Encoder)) -> Vec<u8> {
        encode(f)
    }

    /// protocol/09's eleven-element discovery document: the instance id is element 3 and the
    /// external-sender key id and public key are elements 9 and 10, which a remote scenario puts
    /// in every text group's external_senders extension instead of asking the test host.
    #[test]
    fn the_discovery_document_carries_the_external_sender_key() {
        let doc = cbor(|e| {
            e.array(11);
            e.array(1).uint(1);
            e.array(1).uint(1);
            e.array(1).uint(1);
            e.bytes(&[0x11; 16]).uint(1).text("dilla.test").uint(0);
            e.array(2).uint(0).uint(1);
            e.uint(1).bytes(&[0x22; 16]).bytes(&[0x33; 32]);
        });
        let got = decode_instance_document(&doc).unwrap();
        assert_eq!(
            got,
            InstanceDocument {
                instance_id: [0x11; 16],
                external_sender_key_id: [0x22; 16],
                external_sender_pub: [0x33; 32],
            }
        );
        // The nine-element document of before the key was published is refused, not misread.
        let old = cbor(|e| {
            e.array(9);
            e.array(1).uint(1);
            e.array(1).uint(1);
            e.array(1).uint(1);
            e.bytes(&[0x11; 16]).uint(1).text("dilla.test").uint(0);
            e.array(2).uint(0).uint(1);
            e.uint(1);
        });
        assert!(decode_instance_document(&old).is_err());
    }

    /// protocol/02's error array: the code, the detail and every extended position, whatever the
    /// status, so `expect_reject` sees the same thing against either delivery service.
    #[test]
    fn a_non_2xx_answer_is_the_protocol_02_error_it_carries() {
        let conflict = cbor(|e| {
            e.array(5)
                .text("E_COMMIT_CONFLICT")
                .text("another commit won this epoch")
                .null()
                .bytes(&[7, 7])
                .array(1)
                .bytes(&[8]);
        });
        match check_status(409, &conflict) {
            Err(DsError::CommitConflict {
                winning_commit,
                proposals,
            }) => {
                assert_eq!(winning_commit, vec![7, 7]);
                assert_eq!(proposals, vec![vec![8]]);
            }
            other => panic!("{other:?}"),
        }

        let required = cbor(|e| {
            e.array(4)
                .text("E_COMMIT_REQUIRED")
                .text("outstanding proposals must be committed first")
                .uint(1500)
                .null();
        });
        let err = check_status(425, &required).unwrap_err();
        assert_eq!(err.code(), "E_COMMIT_REQUIRED");
        assert_eq!(err.http_status(), 425);

        let invalid = cbor(|e| {
            e.array(4)
                .text("E_COMMIT_INVALID")
                .text("commit refused by rule group_info_epoch")
                .null()
                .text("group_info_epoch");
        });
        match check_status(422, &invalid) {
            Err(DsError::CommitInvalid { reason }) => assert_eq!(reason, "group_info_epoch"),
            other => panic!("{other:?}"),
        }

        // A code the stub never raises keeps its code and its real status.
        let forbidden = cbor(|e| {
            e.array(3).text("E_FORBIDDEN").text("not a member").null();
        });
        let err = check_status(403, &forbidden).unwrap_err();
        assert_eq!(err.code(), "E_FORBIDDEN");
        assert_eq!(err.http_status(), 403);
        assert!(err.to_string().contains("E_FORBIDDEN"), "{err}");

        // The one status override protocol/02 permits: the code keeps the status it came with.
        let duplicate = cbor(|e| {
            e.array(3).text("E_NOT_FOUND").text("gone").null();
        });
        assert_eq!(
            check_status(410, &duplicate).unwrap_err().http_status(),
            410
        );

        assert!(check_status(204, &[]).is_ok());
        assert!(matches!(
            check_status(500, b"not cbor"),
            Err(DsError::Protocol(_))
        ));
        let unknown = cbor(|e| {
            e.array(3).text("E_MADE_UP").text("").null();
        });
        assert!(matches!(
            check_status(400, &unknown),
            Err(DsError::Protocol(_))
        ));
    }

    /// Every delivery-service opcode decodes into the frame the stub would have queued, and the
    /// replay `n` comes back beside it.
    #[test]
    fn gateway_frames_decode_into_the_stubs_frame_shapes() {
        let group = [0x33u8; 16];
        let handshake = cbor(|e| {
            e.array(4).uint(16).uint(7).bytes(&group);
            e.array(5).uint(4).uint(2).uint(1).uint(0).bytes(&[1, 2, 3]);
        });
        match decode_frame(&handshake).unwrap() {
            (7, Inbound::Frame(Frame::MlsHandshake { group_id, item })) => {
                assert_eq!(group_id, group.to_vec());
                assert_eq!(
                    (item.seq, item.epoch, item.kind, item.sender),
                    (4, 2, 1, Some(0))
                );
                assert_eq!(item.blob, vec![1, 2, 3]);
            }
            _ => panic!("handshake"),
        }

        let external = cbor(|e| {
            e.array(4).uint(16).uint(8).bytes(&group);
            e.array(5).uint(5).uint(2).uint(2).null().bytes(&[9]);
        });
        match decode_frame(&external).unwrap() {
            (_, Inbound::Frame(Frame::MlsHandshake { item, .. })) => {
                assert_eq!(item.sender, None)
            }
            _ => panic!("external commit"),
        }

        let message = cbor(|e| {
            e.array(4).uint(19).uint(9).bytes(&group);
            e.array(6)
                .uint(5)
                .uint(3)
                .bytes(&[0xaa; 16])
                .bytes(&[4])
                .bytes(&[0xbb; 32])
                .uint(1_758_659_640);
        });
        match decode_frame(&message).unwrap() {
            (9, Inbound::Frame(Frame::MessageCt { item, .. })) => {
                assert_eq!(item.seq, 5);
                assert_eq!(item.uploader_device, DeviceId::from_bytes([0xaa; 16]));
                assert_eq!(item.franking_tag, [0xbb; 32]);
                assert_eq!(item.recv_ts, 1_758_659_640);
            }
            _ => panic!("message.ct"),
        }

        let needed = cbor(|e| {
            e.array(4).uint(17).uint(0).bytes(&group);
            e.array(4).uint(3).null().uint(5000).uint(2);
        });
        match decode_frame(&needed).unwrap() {
            (0, Inbound::Frame(frame @ Frame::CommitNeeded { .. })) => {
                assert_eq!(frame.label(), "mls.commit_needed");
                assert_eq!(frame.field("epoch").as_deref(), Some("3"));
                assert_eq!(frame.field("round").as_deref(), Some("2"));
                assert_eq!(frame.field("proposals").as_deref(), Some("0"));
            }
            _ => panic!("commit_needed"),
        }

        let welcome = cbor(|e| {
            e.array(4).uint(20).uint(10).bytes(&group);
            e.array(6)
                .uint(1)
                .uint(1)
                .uint(3)
                .bytes(&[5])
                .bytes(&[6])
                .bytes(&[0xcc; 32]);
        });
        assert!(matches!(
            decode_frame(&welcome).unwrap(),
            (10, Inbound::Frame(Frame::MlsWelcome { .. }))
        ));

        let epoch = cbor(|e| {
            e.array(4).uint(18).uint(11).bytes(&group);
            e.array(2).uint(3).uint(4);
        });
        assert!(matches!(
            decode_frame(&epoch).unwrap(),
            (
                11,
                Inbound::Frame(Frame::MlsEpochChanged {
                    epoch: 3,
                    seq: 4,
                    ..
                })
            )
        ));

        let hello = cbor(|e| {
            e.array(4).uint(0).uint(0).null();
            e.array(9)
                .array(1)
                .uint(1)
                .array(1)
                .uint(1)
                .array(1)
                .uint(1)
                .uint(30_000)
                .uint(131_584)
                .bytes(&[0x11; 16])
                .uint(1)
                .uint(2_000)
                .uint(500);
        });
        assert!(matches!(
            decode_frame(&hello).unwrap(),
            (
                0,
                Inbound::Hello {
                    heartbeat_ms: 30_000,
                    ..
                }
            )
        ));

        // A group frame without its group is not routable, and a truncated frame is refused.
        let orphan = cbor(|e| {
            e.array(4).uint(18).uint(1).null();
            e.array(2).uint(3).uint(4);
        });
        assert!(decode_frame(&orphan).is_err());
        assert!(decode_frame(&handshake[..handshake.len() - 1]).is_err());
        // An opcode outside the delivery service is read past, not refused.
        let presence = cbor(|e| {
            e.array(4).uint(48).uint(0).null();
            e.array(4).bytes(&[1; 16]).uint(1).uint(2).text("");
        });
        assert!(matches!(
            decode_frame(&presence).unwrap(),
            (0, Inbound::Ignored)
        ));
    }

    #[test]
    fn only_a_plain_http_base_is_spoken_to() {
        assert_eq!(host_of("http://127.0.0.1:4567").unwrap(), "127.0.0.1:4567");
        assert_eq!(host_of("http://127.0.0.1:4567/").unwrap(), "127.0.0.1:4567");
        assert!(host_of("https://dilla.example").is_err());
    }

    /// A client in the state `open_socket` leaves after a first connection, over a socket the test
    /// already holds (or none), so the offline and catch-up paths run without a gateway.
    fn connected(base: &str, ws: Option<WebSocket<TcpStream>>) -> HttpDs {
        HttpDs {
            base: base.to_owned(),
            token: "token".into(),
            device: DeviceId::from_bytes([0xdd; 16]),
            agent: new_agent(),
            ws,
            pending: Vec::new(),
            online: true,
            heartbeat: Duration::from_secs(30),
            last_beat: Instant::now(),
            last_n: 0,
            delivered: BTreeMap::new(),
            connected_before: true,
            reconnects: 0,
            lost: Vec::new(),
            accepted: 0,
            expires: 0,
        }
    }

    fn seq_of(frame: &Frame) -> Option<u64> {
        match frame {
            Frame::MlsHandshake { item, .. } => Some(item.seq),
            Frame::MessageCt { item, .. } => Some(item.seq),
            _ => None,
        }
    }

    /// `go_offline` must not throw away what the gateway already wrote to the socket: the stub
    /// keeps an offline device's queue, and a frame lost here is also a group the reconnect's
    /// catch-up never learns of.
    #[test]
    fn going_offline_keeps_the_frames_the_socket_already_holds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let group = [0x44u8; 16];
        let (sent, written) = std::sync::mpsc::channel();
        let gateway = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let handshake = encode(|e| {
                e.array(4).uint(16).uint(1).bytes(&group);
                e.array(5).uint(4).uint(2).uint(1).uint(0).bytes(&[1]);
            });
            let message = encode(|e| {
                e.array(4).uint(19).uint(2).bytes(&group);
                e.array(6)
                    .uint(5)
                    .uint(3)
                    .bytes(&[0xaa; 16])
                    .bytes(&[4])
                    .bytes(&[0xbb; 32])
                    .uint(1_758_659_640);
            });
            ws.send(Message::Binary(handshake.into())).unwrap();
            ws.send(Message::Binary(message.into())).unwrap();
            sent.send(()).unwrap();
            // Hold the connection until the client lets it go.
            while ws.read().is_ok() {}
        });

        let stream = TcpStream::connect(addr).unwrap();
        let (mut socket, _) = tungstenite::client(format!("ws://{addr}/gateway"), stream).unwrap();
        read_timeout(&mut socket, PUMP_WAIT).unwrap();
        written.recv().unwrap();
        let mut ds = connected(&format!("http://{addr}"), Some(socket));

        ds.set_online(false).unwrap();
        assert!(ds.ws.is_none(), "offline means no socket");
        assert!(
            ds.drain().unwrap().is_empty(),
            "an offline drain returns nothing"
        );
        let held: Vec<u64> = ds.pending.iter().filter_map(seq_of).collect();
        assert_eq!(
            held,
            vec![4, 5],
            "the buffered frames wait for the next online drain"
        );
        assert_eq!(ds.delivered.get(group.as_slice()), Some(&5));
        gateway.join().unwrap();
    }

    const REGISTERED: [u8; 16] = [0x01; 16];
    const WELCOMED: [u8; 16] = [0x02; 16];
    const RESYNCED: [u8; 16] = [0x03; 16];
    /// Welcomed, then removed: the instance answers a non-member E_NOT_FOUND (sequencer.go).
    const LEFT: [u8; 16] = [0x04; 16];

    /// The instance side of `a_group_learned_without_a_frame_is_caught_up_on_reconnect`.
    fn instance(method: &str, path: &str) -> (u16, Vec<u8>) {
        let reads = |g: &[u8; 16]| {
            let at = format!("/v1/groups/{}/", hex::encode(g));
            path.starts_with(&format!("{at}handshakes?"))
                || path.starts_with(&format!("{at}messages?"))
        };
        let resync = format!("/v1/groups/{}/resync", hex::encode(RESYNCED));
        match (method, path) {
            ("POST", "/v1/groups") => (
                201,
                encode(|e| {
                    e.array(2).bytes(&REGISTERED).uint(1);
                }),
            ),
            ("GET", "/v1/welcomes?after=0&limit=64") => (
                200,
                encode(|e| {
                    e.array(2);
                    e.array(7)
                        .uint(1)
                        .bytes(&WELCOMED)
                        .uint(2)
                        .uint(3)
                        .bytes(&[5])
                        .bytes(&[6])
                        .bytes(&[0xcc; 32]);
                    e.array(7)
                        .uint(2)
                        .bytes(&LEFT)
                        .uint(4)
                        .uint(9)
                        .bytes(&[5])
                        .bytes(&[6])
                        .bytes(&[0xcc; 32]);
                }),
            ),
            ("POST", p) if p == resync => (
                200,
                encode(|e| {
                    e.array(2).uint(7).uint(3);
                }),
            ),
            ("GET", _) if reads(&LEFT) => (
                404,
                encode(|e| {
                    e.array(3).text("E_NOT_FOUND").text("group").null();
                }),
            ),
            ("GET", _) if reads(&REGISTERED) || reads(&WELCOMED) || reads(&RESYNCED) => (
                200,
                encode(|e| {
                    e.array(0);
                }),
            ),
            _ => (500, Vec::new()),
        }
    }

    type Seen = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    /// A throwaway HTTP/1.1 origin, one request per connection, answering from `route` and
    /// recording every `METHOD path` it served.
    fn origin(route: fn(&str, &str) -> (u16, Vec<u8>)) -> (String, Seen) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Default::default();
        let log = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut length = 0usize;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_owned();
                let path = parts.next().unwrap_or_default().to_owned();
                log.lock().unwrap().push(format!("{method} {path}"));
                let (status, out) = route(&method, &path);
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/cbor\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    out.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&out).unwrap();
            }
        });
        (base, seen)
    }

    /// A device learns of a group from `register_group`, a Welcome row or its own external commit
    /// without a single frame for it having been pumped. The reconnect's catch-up must still walk
    /// that group from where the device came in — otherwise `go_offline bob; send alice …;
    /// go_online bob` delivers nothing to a Welcome joiner, where the stub delivers everything.
    #[test]
    fn a_group_learned_without_a_frame_is_caught_up_on_reconnect() {
        use dilla_core::ids::InstanceId;
        use dilla_core::mls::{DillaBinding, GroupKind};

        let (base, seen) = origin(instance);
        let mut ds = connected(&base, None);
        let binding = DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            community_id: None,
            target_id: REGISTERED,
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: 0,
        };
        ds.register_group(RegisterRequest {
            binding: binding.encode(),
            group_info: vec![1],
            ratchet_tree: vec![2],
        })
        .unwrap();
        assert_eq!(ds.welcomes().unwrap().len(), 2);
        ds.post_external_commit(
            &RESYNCED,
            ResyncRequest {
                external_commit: vec![3],
                group_info: vec![4],
            },
        )
        .unwrap();
        seen.lock().unwrap().clear();

        ds.catch_up().unwrap();

        let served = seen.lock().unwrap().clone();
        for (group, from) in [(REGISTERED, 1), (WELCOMED, 3), (RESYNCED, 7)] {
            let g = hex::encode(group);
            for want in [
                format!("GET /v1/groups/{g}/handshakes?from={from}&limit={HANDSHAKE_PAGE}"),
                format!("GET /v1/groups/{g}/messages?from={from}&limit={MESSAGE_PAGE}"),
            ] {
                assert!(served.contains(&want), "{want} not in {served:#?}");
            }
        }
        // A group the device can no longer read is dropped, not a failed reconnect.
        let left = format!(
            "GET /v1/groups/{}/handshakes?from=9&limit={HANDSHAKE_PAGE}",
            hex::encode(LEFT)
        );
        assert!(served.contains(&left), "{left} not in {served:#?}");
        assert!(!ds.delivered.contains_key(LEFT.as_slice()));

        // Learning of a group again never rewinds past what was already delivered.
        ds.accept(Frame::MessageCt {
            group_id: WELCOMED.to_vec(),
            item: MessageItem {
                seq: 8,
                epoch: 2,
                uploader_device: DeviceId::from_bytes([0xaa; 16]),
                blob: vec![1],
                commitment: [0; 32],
                franking_tag: [0; 32],
                recv_ts: 0,
            },
        });
        ds.welcomes().unwrap();
        assert_eq!(ds.delivered.get(WELCOMED.as_slice()), Some(&8));
    }
}
