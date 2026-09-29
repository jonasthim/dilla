//! Executes a parsed scenario against a delivery service and N `TestClient`s.
//!
//! The delivery service is `DsStub` unless the scenario says `ds <url>` or the runner was built
//! with `with_ds` (the CLI's `--ds`, which wins over the directive, NV-B2). Against the stub every
//! client shares the one in-memory instance and the runner names the acting device before each
//! call; against a real instance every client holds its own `HttpDs` — its own session and its
//! own gateway connection.

use super::{Scenario, Stmt};
use crate::ds::remote::{control_get, control_post, instance_id as remote_instance_id};
use crate::{DeliveryService, DsError, DsStub, HttpDs, InstanceConfig, TestClient, TestkitError};
use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{DillaBinding, MAX_ADDS_PER_COMMIT};
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StepResult {
    pub line: usize,
    pub stmt: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RunReport {
    pub steps: Vec<StepResult>,
}

impl RunReport {
    pub fn is_ok(&self) -> bool {
        self.steps.iter().all(|s| s.ok)
    }

    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for step in &self.steps {
            out.push_str(&format!(
                "{} line {}: {} {}\n",
                if step.ok { "ok  " } else { "FAIL" },
                step.line,
                step.stmt,
                step.detail
            ));
        }
        out
    }
}

struct GroupRef {
    id: Vec<u8>,
    binding: DillaBinding,
    creator: String,
}

/// The delivery service a scenario runs against.
enum Backend {
    Stub(Box<DsStub>),
    /// A running instance at `base`. Each client's own session and gateway connection.
    Remote {
        base: String,
        clients: BTreeMap<String, HttpDs>,
    },
}

/// Where a remote scenario's clients get their accounts: the invite code `dillad init` minted
/// (the harness mints it with `max_uses` at least the number of clients). There is no other way
/// in — the instance is invite-only and the harness has no back door.
const INVITE_ENV: &str = "DILLA_TESTKIT_INVITE";

pub struct Runner {
    seed: u64,
    clients: BTreeMap<String, TestClient>,
    groups: BTreeMap<String, GroupRef>,
    backend: Option<Backend>,
    instance_id: InstanceId,
    /// `--ds`: wins over any `ds` directive.
    ds_override: Option<String>,
    /// The `ds` directive, when there is no override.
    ds_directive: Option<String>,
    /// The client the last client-scoped statement acted as: whose frames `expect_frame` reads.
    last_actor: Option<String>,
    /// Per client, how much of its inbox `expect_decrypts_all` has already vouched for.
    vouched: BTreeMap<String, usize>,
}

impl Runner {
    pub fn new(seed: u64) -> Self {
        Self {
            seed,
            clients: BTreeMap::new(),
            groups: BTreeMap::new(),
            backend: None,
            instance_id: InstanceId::from_bytes([0x11; 16]),
            ds_override: None,
            ds_directive: None,
            last_actor: None,
            vouched: BTreeMap::new(),
        }
    }

    /// Runs every scenario against the instance at `url` (the CLI's `--ds`), whatever `ds`
    /// directive the scenario carries. `None` leaves the choice to the scenario.
    pub fn with_ds(mut self, url: Option<String>) -> Self {
        self.ds_override = url;
        self
    }

    fn ds_url(&self) -> Option<&str> {
        self.ds_override.as_deref().or(self.ds_directive.as_deref())
    }

    fn stub(&mut self) -> Result<&mut DsStub, TestkitError> {
        match self.backend.as_mut() {
            Some(Backend::Stub(stub)) => Ok(stub),
            Some(Backend::Remote { .. }) => Err(TestkitError::Scenario(
                "this statement is the in-memory stub's; the scenario runs against `ds <url>`"
                    .into(),
            )),
            None => Err(no_instance()),
        }
    }

    fn is_remote(&self) -> bool {
        matches!(self.backend, Some(Backend::Remote { .. }))
    }

    /// The delivery service as `client` sees it. The stub is told which device is acting; a
    /// remote client has its own.
    fn ds_for(&mut self, client: &TestClient) -> Result<&mut dyn DeliveryService, TestkitError> {
        match self.backend.as_mut() {
            None => Err(no_instance()),
            Some(Backend::Stub(stub)) => {
                stub.act_as(client.device_id());
                Ok(stub.as_mut())
            }
            Some(Backend::Remote { clients, .. }) => clients
                .get_mut(client.name())
                .map(|ds| ds as &mut dyn DeliveryService)
                .ok_or_else(|| {
                    TestkitError::Scenario(format!("{} holds no session", client.name()))
                }),
        }
    }

    pub fn run(&mut self, scenario: &Scenario) -> Result<RunReport, TestkitError> {
        let mut steps = Vec::new();
        for (index, stmt) in scenario.stmts.iter().enumerate() {
            // The source line, not the statement's position: the parser drops comments and blank
            // lines, and every committed scenario opens with a comment.
            let line = scenario.lines.get(index).copied().unwrap_or(index + 1);
            let label = format!("{stmt:?}");
            let outcome = self.exec(stmt);
            let (ok, detail) = match (stmt, outcome) {
                (Stmt::ExpectReject { code, .. }, Ok(())) => (
                    false,
                    format!("expected rejection {code}, but it succeeded"),
                ),
                (Stmt::ExpectReject { code, status, .. }, Err(e)) => {
                    let text = e.to_string();
                    // The status is checked only when the statement names one (`expect_425`):
                    // it comes from the refusal itself, so a matching code at the wrong status
                    // is a different refusal.
                    let status_ok = match (status, &e) {
                        (None, _) => true,
                        (Some(want), TestkitError::Ds(ds)) => ds.http_status() == *want,
                        (Some(_), _) => false,
                    };
                    let wanted = match status {
                        Some(s) => format!("{s} {code}"),
                        None => code.clone(),
                    };
                    (
                        text.contains(code.as_str()) && status_ok,
                        format!("got {text}, wanted {wanted}"),
                    )
                }
                (_, Ok(())) => (true, String::new()),
                (_, Err(e)) => (false, e.to_string()),
            };
            steps.push(StepResult {
                line,
                stmt: label,
                ok,
                detail,
            });
            if !ok {
                break;
            }
        }
        Ok(RunReport { steps })
    }

    fn exec(&mut self, stmt: &Stmt) -> Result<(), TestkitError> {
        if let Some(actor) = actor_of(stmt) {
            self.last_actor = Some(actor.to_owned());
        }
        match stmt {
            Stmt::ExpectReject { inner, .. } => self.exec(inner),
            Stmt::Ds { url } => {
                if self.ds_override.is_none() {
                    self.ds_directive = Some(url.clone());
                    // `instance` may already have chosen the stub; no client exists yet (the
                    // parser refuses `ds` after one), so the choice is still free.
                    if matches!(self.backend, Some(Backend::Stub(_))) {
                        self.select_backend()?;
                    }
                }
                Ok(())
            }
            Stmt::Instance { .. } => self.select_backend(),
            Stmt::Client { name, tier, kind } => self.new_client(name, *tier, *kind, 4),
            Stmt::Group {
                name,
                kind,
                target,
                community,
                creator,
            } => {
                let binding = DillaBinding {
                    v: 1,
                    instance_id: self.instance_id,
                    community_id: *community,
                    target_id: *target,
                    kind: *kind,
                    policy_version: 1,
                    e2ee_version: 1,
                    media_version: kind.media_version(),
                };
                let mut client = self.take(creator)?;
                let result = self
                    .ds_for(&client)
                    .and_then(|ds| client.create_group(ds, binding.clone()));
                self.clients.insert(creator.clone(), client);
                self.groups.insert(
                    name.clone(),
                    GroupRef {
                        id: result?,
                        binding,
                        creator: creator.clone(),
                    },
                );
                Ok(())
            }
            Stmt::Join {
                client,
                group,
                external,
            } => {
                let target = self.group(group)?;
                let (id, binding) = (target.id.clone(), target.binding.clone());
                // `invite` takes the joiner out of the map itself (to read its device id), so it
                // must run **before** the joiner is taken here: taking twice returns
                // `unknown client <joiner>` and every `join … via=welcome` fails.
                if !*external {
                    self.invite(client, group)?;
                }
                self.with_client(client, |actor, ds| {
                    if *external {
                        actor.join_external(ds, &id, &binding)
                    } else {
                        actor.join_welcome(ds, &id, &binding)
                    }
                })
            }
            Stmt::Send {
                client,
                group,
                body,
            } => {
                let id = self.group(group)?.id.clone();
                self.with_client(client, |actor, ds| actor.send(ds, &id, body).map(|_| ()))
            }
            Stmt::ExpectDecrypts {
                client,
                group,
                body,
            } => {
                let id = self.group(group)?.id.clone();
                self.with_client(client, |actor, ds| {
                    let _ = actor.sync(ds)?;
                    let found = actor
                        .inbox()
                        .iter()
                        .any(|r| r.group_id == id && r.envelope.body == *body);
                    if found {
                        Ok(())
                    } else {
                        Err(TestkitError::Assertion(format!(
                            "{client} never decrypted {body:?}"
                        )))
                    }
                })
            }
            Stmt::Sync { client } => {
                self.with_client(client, |actor, ds| actor.sync(ds).map(|_| ()))
            }
            Stmt::Remove {
                actor,
                group,
                target,
            } => {
                let id = self.group(group)?.id.clone();
                let device = self.device_of(target)?;
                self.with_client(actor, |committer, ds| committer.remove(ds, &id, device))
            }
            Stmt::GoOffline { client } | Stmt::GoOnline { client } => {
                let online = matches!(stmt, Stmt::GoOnline { .. });
                self.with_client(client, |_, ds| ds.set_online(online).map_err(Into::into))
            }
            Stmt::Kick { actor, target } => {
                let (actor, target) = (self.device_of(actor)?, self.device_of(target)?);
                if !self.is_remote() {
                    return Err(DsError::Unsupported(
                        "DsStub does not model instance-originated proposals (invariants 5 and \
                         6); use `ds <url>`"
                            .into(),
                    )
                    .into());
                }
                control_post(
                    "/debug/kick",
                    &format!(
                        "{{\"actor\":\"{}\",\"target\":\"{}\"}}",
                        actor.to_hex(),
                        target.to_hex()
                    ),
                )?;
                Ok(())
            }
            Stmt::AdvanceClock { seconds } => {
                if self.is_remote() {
                    control_post("/debug/clock", &format!("{{\"seconds\":{seconds}}}"))?;
                } else {
                    DeliveryService::advance_clock(self.stub()?, *seconds)?;
                }
                Ok(())
            }
            Stmt::ExpectFrame { op, fields } => {
                let actor = self.last_actor.clone().ok_or_else(|| {
                    TestkitError::Scenario("expect_frame before any client acted".into())
                })?;
                self.with_client(&actor, |client, ds| {
                    client.sync(ds)?;
                    let matches = |f: &crate::Frame| {
                        f.label() == op
                            && fields
                                .iter()
                                .all(|(k, v)| f.field(k).as_deref() == Some(v.as_str()))
                    };
                    if client.take_frame(matches).is_some() {
                        return Ok(());
                    }
                    let seen: Vec<&str> = client.frames().iter().map(crate::Frame::label).collect();
                    Err(TestkitError::Assertion(format!(
                        "{actor} received no {op} with {fields:?}; unclaimed frames: {seen:?}"
                    )))
                })
            }
            Stmt::Snapshot { name } | Stmt::RestoreSnapshot { name } => {
                if !self.is_remote() {
                    return Err(DsError::Unsupported(
                        "DsStub has no snapshot; use `ds <url>`".into(),
                    )
                    .into());
                }
                let path = if matches!(stmt, Stmt::Snapshot { .. }) {
                    "/debug/snapshot"
                } else {
                    "/debug/restore"
                };
                control_post(path, &format!("{{\"name\":{}}}", json_string(name)))?;
                Ok(())
            }
            Stmt::Commit { actor } => self.with_client(actor, |committer, ds| {
                let groups = committer.group_ids();
                if groups.is_empty() {
                    return Err(TestkitError::Scenario(format!(
                        "{actor} is in no group to commit to"
                    )));
                }
                for group_id in groups {
                    committer.commit(ds, &group_id)?;
                }
                Ok(())
            }),
            Stmt::JoinMany { group, count } => self.join_many(group, *count),
            Stmt::ExpectDecryptsAll { actor } => {
                let vouched = self.vouched.get(actor).copied().unwrap_or(0);
                let now = self.with_client(actor, |client, ds| {
                    // `sync` applies every drained frame in order and fails on the first one that
                    // does not decrypt, so a clean sync is "all of them decrypted".
                    client.sync(ds)?;
                    Ok(client.inbox().len())
                })?;
                if now <= vouched {
                    return Err(TestkitError::Assertion(format!(
                        "{actor} received no message since its last expect_decrypts_all"
                    )));
                }
                self.vouched.insert(actor.clone(), now);
                Ok(())
            }
            Stmt::ExpectQuarantined { actor } => {
                let device = self.device_of(actor)?.to_hex();
                self.expect_listed("quarantined_devices", &device, actor)
            }
            Stmt::ExpectClosed { group } => {
                let id = hex::encode(&self.group(group)?.id);
                self.expect_listed("closed_groups", &id, group)
            }
        }
    }

    /// The stub, or the instance at the `ds` URL. A remote instance's own id replaces the stub's
    /// fixed one, because every group's binding names it (invariant 1).
    fn select_backend(&mut self) -> Result<(), TestkitError> {
        let backend = match self.ds_url() {
            Some(url) => {
                let base = url.trim_end_matches('/').to_owned();
                self.instance_id = InstanceId::from_bytes(remote_instance_id(&base)?);
                Backend::Remote {
                    base,
                    clients: BTreeMap::new(),
                }
            }
            None => {
                self.instance_id = InstanceId::from_bytes([0x11; 16]);
                Backend::Stub(Box::new(DsStub::new(InstanceConfig {
                    instance_id: self.instance_id,
                    signing_key: [0x77; 32],
                    policy_version: 1,
                    k_frank: [0x09; 32],
                })))
            }
        };
        self.backend = Some(backend);
        Ok(())
    }

    /// Creates a client, enrols it with the delivery service and publishes `key_packages`
    /// KeyPackages plus a last-resort one.
    fn new_client(
        &mut self,
        name: &str,
        tier: Tier,
        kind: Kind,
        key_packages: usize,
    ) -> Result<(), TestkitError> {
        if self.clients.contains_key(name) {
            return Err(TestkitError::Scenario(format!("client {name} exists")));
        }
        let seed = self.seed.wrapping_add(self.clients.len() as u64 + 1);
        let mut user = [0u8; 16];
        user[..8].copy_from_slice(&seed.to_be_bytes());
        let mut client = TestClient::new(name, UserId::from_bytes(user), tier, kind, seed)?;
        let remote_base = match self.backend.as_ref() {
            None => return Err(no_instance()),
            Some(Backend::Stub(_)) => None,
            Some(Backend::Remote { base, .. }) => Some(base.clone()),
        };
        if let Some(base) = remote_base {
            let code = std::env::var(INVITE_ENV).map_err(|_| {
                TestkitError::Scenario(format!(
                    "{INVITE_ENV} is unset: a remote scenario enrols each client through the \
                     instance's bootstrap invite"
                ))
            })?;
            let enrolled = HttpDs::redeem_invite(&base, &code, client.new_account(name, name))?;
            // The instance mints the user id, and the MLS credential must name it: invariant 4's
            // Add check compares the credential's user with the device's owner. The seed fixes the
            // device and every key, so the client is rebuilt around the minted id unchanged
            // otherwise.
            client = TestClient::new(name, UserId::from_bytes(enrolled.user_id), tier, kind, seed)?;
            if enrolled.device_id != client.device_id() {
                return Err(DsError::Protocol(format!(
                    "registered device {} but the instance answered {}",
                    client.device_id().to_hex(),
                    enrolled.device_id.to_hex()
                ))
                .into());
            }
            let ds = HttpDs::with_session(&base, client.device_id(), enrolled.token)?;
            if let Some(Backend::Remote { clients, .. }) = self.backend.as_mut() {
                clients.insert(name.to_owned(), ds);
            }
        }
        let result = self
            .ds_for(&client)
            .and_then(|ds| client.publish_key_packages(ds, key_packages));
        self.clients.insert(name.to_owned(), client);
        result
    }

    /// `count` new clients join `group`: each publishes one KeyPackage, the group's creator adds
    /// them at most `MAX_ADDS_PER_COMMIT` (256) to a commit, and each joins by its Welcome. A loop
    /// of `join` is not viable for 1,000 devices — each is a full commit — and the point of the
    /// scenario is that the Adds are batched.
    fn join_many(&mut self, group: &str, count: usize) -> Result<(), TestkitError> {
        let (id, binding, creator) = {
            let g = self.group(group)?;
            (g.id.clone(), g.binding.clone(), g.creator.clone())
        };
        let first = self.clients.len();
        let mut names = Vec::with_capacity(count);
        for i in 0..count {
            let name = format!("{group}-{}", first + i + 1);
            self.new_client(&name, Tier::Native, Kind::User, 1)?;
            names.push(name);
        }
        let devices = names
            .iter()
            .map(|n| self.device_of(n))
            .collect::<Result<Vec<_>, _>>()?;
        for batch in devices.chunks(MAX_ADDS_PER_COMMIT) {
            self.with_client(&creator, |inviter, ds| inviter.invite_many(ds, &id, batch))?;
        }
        for name in &names {
            self.with_client(name, |joiner, ds| joiner.join_welcome(ds, &id, &binding))?;
        }
        Ok(())
    }

    /// Reads the test host's `GET /debug/state` and requires `value` in the JSON array `key`.
    fn expect_listed(&mut self, key: &str, value: &str, what: &str) -> Result<(), TestkitError> {
        if !self.is_remote() {
            return Err(
                DsError::Unsupported(format!("DsStub keeps no {key}; use `ds <url>`")).into(),
            );
        }
        let body = control_get("/debug/state")?;
        let state: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|e| DsError::Protocol(format!("GET /debug/state: {e}")))?;
        let listed = state
            .get(key)
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| DsError::Protocol(format!("GET /debug/state carries no {key} array")))?
            .iter()
            .any(|v| v.as_str() == Some(value));
        if listed {
            Ok(())
        } else {
            Err(TestkitError::Assertion(format!(
                "{what} ({value}) is not in the instance's {key}"
            )))
        }
    }

    /// Takes `name` out of the map, runs `f` with it and its view of the delivery service, and
    /// puts it back whatever `f` answered.
    fn with_client<T>(
        &mut self,
        name: &str,
        f: impl FnOnce(&mut TestClient, &mut dyn DeliveryService) -> Result<T, TestkitError>,
    ) -> Result<T, TestkitError> {
        let mut client = self.take(name)?;
        let result = self.ds_for(&client).and_then(|ds| f(&mut client, ds));
        self.clients.insert(name.to_owned(), client);
        result
    }

    /// The inviter commits an Add for `joiner`, so a `join ... via=welcome` has a Welcome waiting.
    /// The inviter is the first other client, in name order, that is a member of the group.
    fn invite(&mut self, joiner: &str, group: &str) -> Result<(), TestkitError> {
        let id = self.group(group)?.id.clone();
        let device = self.device_of(joiner)?;
        let inviter_name = self
            .clients
            .iter()
            .find(|(n, c)| n.as_str() != joiner && c.is_member(&id))
            .map(|(n, _)| n.clone())
            .ok_or_else(|| TestkitError::Scenario("no client can invite".into()))?;
        self.with_client(&inviter_name, |inviter, ds| inviter.invite(ds, &id, device))
    }

    fn device_of(&self, name: &str) -> Result<dilla_core::ids::DeviceId, TestkitError> {
        self.clients
            .get(name)
            .map(TestClient::device_id)
            .ok_or_else(|| TestkitError::Scenario(format!("unknown client {name}")))
    }

    fn take(&mut self, name: &str) -> Result<TestClient, TestkitError> {
        self.clients
            .remove(name)
            .ok_or_else(|| TestkitError::Scenario(format!("unknown client {name}")))
    }

    fn group(&self, name: &str) -> Result<&GroupRef, TestkitError> {
        self.groups
            .get(name)
            .ok_or_else(|| TestkitError::Scenario(format!("unknown group {name}")))
    }
}

fn no_instance() -> TestkitError {
    TestkitError::Scenario("no `instance` statement yet".into())
}

/// The client a statement acts as, which is whose frames a following `expect_frame` reads.
fn actor_of(stmt: &Stmt) -> Option<&str> {
    match stmt {
        Stmt::Client { name, .. } => Some(name),
        Stmt::Group { creator, .. } => Some(creator),
        Stmt::Join { client, .. }
        | Stmt::Send { client, .. }
        | Stmt::ExpectDecrypts { client, .. }
        | Stmt::Sync { client }
        | Stmt::GoOffline { client }
        | Stmt::GoOnline { client } => Some(client),
        Stmt::Remove { actor, .. }
        | Stmt::Kick { actor, .. }
        | Stmt::Commit { actor }
        | Stmt::ExpectDecryptsAll { actor } => Some(actor),
        Stmt::ExpectReject { inner, .. } => actor_of(inner),
        _ => None,
    }
}

/// A JSON string literal, for the one free-text value the control bodies carry.
fn json_string(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}
