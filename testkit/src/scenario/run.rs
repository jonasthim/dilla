//! Executes a parsed scenario against one `DsStub` and N `TestClient`s.

use super::{Scenario, Stmt};
use crate::{DsStub, InstanceConfig, TestClient, TestkitError};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::DillaBinding;
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
}

pub struct Runner {
    seed: u64,
    clients: BTreeMap<String, TestClient>,
    groups: BTreeMap<String, GroupRef>,
    ds: Option<DsStub>,
    instance_id: InstanceId,
}

impl Runner {
    pub fn new(seed: u64) -> Self {
        Self {
            seed,
            clients: BTreeMap::new(),
            groups: BTreeMap::new(),
            ds: None,
            instance_id: InstanceId::from_bytes([0x11; 16]),
        }
    }

    fn ds(&mut self) -> Result<&mut DsStub, TestkitError> {
        self.ds
            .as_mut()
            .ok_or_else(|| TestkitError::Scenario("no `instance` statement yet".into()))
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
                (Stmt::ExpectReject { code, .. }, Err(e)) => {
                    let text = e.to_string();
                    (
                        text.contains(code.as_str()),
                        format!("got {text}, wanted {code}"),
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
        match stmt {
            Stmt::ExpectReject { inner, .. } => return self.exec(inner),
            Stmt::Instance { .. } => {
                self.ds = Some(DsStub::new(InstanceConfig {
                    instance_id: self.instance_id,
                    signing_key: [0x77; 32],
                    policy_version: 1,
                    k_frank: [0x09; 32],
                }));
                return Ok(());
            }
            _ => {}
        }

        match stmt {
            Stmt::Client { name, tier, kind } => {
                let seed = self.seed.wrapping_add(self.clients.len() as u64 + 1);
                let mut user = [0u8; 16];
                user[..8].copy_from_slice(&seed.to_be_bytes());
                let mut client =
                    TestClient::new(name, UserId::from_bytes(user), *tier, *kind, seed)?;
                let ds = self
                    .ds
                    .as_mut()
                    .ok_or_else(|| TestkitError::Scenario("no `instance` statement yet".into()))?;
                client.publish_key_packages(ds, 4)?;
                self.clients.insert(name.clone(), client);
                Ok(())
            }
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
                let ds = self.ds()?;
                let id = client.create_group(ds, binding.clone())?;
                self.clients.insert(creator.clone(), client);
                self.groups.insert(name.clone(), GroupRef { id, binding });
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
                let mut actor = self.take(client)?;
                let result = if *external {
                    let ds = self.ds.as_mut().ok_or_else(|| {
                        TestkitError::Scenario("no `instance` statement yet".into())
                    })?;
                    actor.join_external(ds, &id, &binding)
                } else {
                    let ds = self.ds.as_mut().ok_or_else(|| {
                        TestkitError::Scenario("no `instance` statement yet".into())
                    })?;
                    actor.join_welcome(ds, &id)
                };
                self.clients.insert(client.clone(), actor);
                result
            }
            Stmt::Send {
                client,
                group,
                body,
            } => {
                let id = self.group(group)?.id.clone();
                let mut actor = self.take(client)?;
                let ds = self.ds()?;
                let result = actor.send(ds, &id, body).map(|_| ());
                self.clients.insert(client.clone(), actor);
                result
            }
            Stmt::ExpectDecrypts {
                client,
                group,
                body,
            } => {
                let id = self.group(group)?.id.clone();
                let mut actor = self.take(client)?;
                let ds = self.ds()?;
                let _ = actor.sync(ds)?;
                let found = actor
                    .inbox()
                    .iter()
                    .any(|r| r.group_id == id && r.envelope.body == *body);
                self.clients.insert(client.clone(), actor);
                if found {
                    Ok(())
                } else {
                    Err(TestkitError::Assertion(format!(
                        "{client} never decrypted {body:?}"
                    )))
                }
            }
            Stmt::Sync { client } => {
                let mut actor = self.take(client)?;
                let ds = self.ds()?;
                let result = actor.sync(ds).map(|_| ());
                self.clients.insert(client.clone(), actor);
                result
            }
            Stmt::Remove {
                actor,
                group,
                target,
            } => {
                let id = self.group(group)?.id.clone();
                let victim = self.take(target)?;
                let device = victim.device_id();
                self.clients.insert(target.clone(), victim);
                let mut committer = self.take(actor)?;
                let ds = self.ds()?;
                let result = committer.remove(ds, &id, device);
                self.clients.insert(actor.clone(), committer);
                result
            }
            Stmt::GoOffline { client } | Stmt::GoOnline { client } => {
                let online = matches!(stmt, Stmt::GoOnline { .. });
                let actor = self.take(client)?;
                let device = actor.device_id();
                self.clients.insert(client.clone(), actor);
                self.ds()?.set_online(&device, online);
                Ok(())
            }
            Stmt::Instance { .. } | Stmt::ExpectReject { .. } => Ok(()),
        }
    }

    /// The inviter commits an Add for `joiner`, so a `join ... via=welcome` has a Welcome waiting.
    fn invite(&mut self, joiner: &str, group: &str) -> Result<(), TestkitError> {
        let id = self.group(group)?.id.clone();
        let inviter_name = self
            .clients
            .keys()
            .find(|n| n.as_str() != joiner)
            .cloned()
            .ok_or_else(|| TestkitError::Scenario("no client can invite".into()))?;
        let joiner_client = self.take(joiner)?;
        let device = joiner_client.device_id();
        self.clients.insert(joiner.to_owned(), joiner_client);

        let mut inviter = self.take(&inviter_name)?;
        let ds = self.ds()?;
        let result = inviter.invite(ds, &id, device);
        self.clients.insert(inviter_name, inviter);
        result
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
