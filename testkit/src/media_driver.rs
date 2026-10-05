//! `dilla-testkit media-driver`: native MLS clients for the browser media tests (MD-12).
//!
//! No browser MLS client exists before dilla-web, so the Playwright suite drives one native
//! `TestClient` per test actor against the real test host and hands each page what its own client
//! would hold: the call group's media epoch (`DillaGroup::media_epoch`) and the call token dillad's
//! calls route mints for that device. Requests and answers are one JSON object per line; an answer
//! carries the request's `id`, `"ok"`, and either the op's fields or `"error"`.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::{Runner, TestkitError};

/// The scenario name of the one call group a driver session opens.
const CALL: &str = "call";

pub struct MediaDriver {
    runner: Runner,
    ds_url: String,
    seed: u64,
    actors: Vec<String>,
    channel: Option<[u8; 16]>,
}

fn scenario(msg: impl Into<String>) -> TestkitError {
    TestkitError::Scenario(msg.into())
}

impl MediaDriver {
    pub fn new(ds: String, seed: u64) -> Self {
        Self {
            runner: Runner::new(seed).with_ds(Some(ds.clone())),
            ds_url: ds,
            seed,
            actors: Vec::new(),
            channel: None,
        }
    }

    /// Answers every request on `input` until it ends, one line each, flushed per answer.
    pub fn serve(&mut self, input: impl BufRead, mut out: impl Write) -> std::io::Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let answer = match serde_json::from_str::<Value>(&line) {
                Ok(req) => self.handle(&req),
                Err(e) => {
                    json!({"id": Value::Null, "ok": false, "error": format!("not JSON: {e}")})
                }
            };
            writeln!(out, "{answer}")?;
            out.flush()?;
        }
        Ok(())
    }

    pub fn handle(&mut self, req: &Value) -> Value {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let op = req.get("op").and_then(Value::as_str).unwrap_or("");
        match self.dispatch(op, req) {
            Ok(Value::Object(mut fields)) => {
                fields.insert("id".into(), id);
                fields.insert("ok".into(), Value::Bool(true));
                Value::Object(fields)
            }
            Ok(other) => json!({"id": id, "ok": true, "value": other}),
            Err(e) => json!({"id": id, "ok": false, "error": e.to_string()}),
        }
    }

    /// The scenario client name of a test actor: unique per seed, because every spec enrols new
    /// accounts on the same test host and usernames are unique.
    fn client(&self, actor: &str) -> String {
        format!("{actor}{:06x}", self.seed & 0xff_ffff)
    }

    fn actor<'a>(&self, req: &'a Value) -> Result<&'a str, TestkitError> {
        let a = req
            .get("actor")
            .and_then(Value::as_str)
            .ok_or_else(|| scenario("the request names no actor"))?;
        if !self.actors.iter().any(|x| x == a) {
            return Err(scenario(format!("unknown actor {a}")));
        }
        Ok(a)
    }

    fn channel(&self) -> Result<[u8; 16], TestkitError> {
        self.channel.ok_or_else(|| scenario("setup first"))
    }

    fn group(&self) -> Result<Vec<u8>, TestkitError> {
        self.runner
            .group_id(CALL)
            .map_err(|_| scenario("no call group yet: open_call first"))
    }

    fn epoch(&self, actor: &str) -> Result<Value, TestkitError> {
        let e = self.runner.epoch_of(&self.client(actor), CALL)?;
        Ok(json!({"epoch": e.to_string()}))
    }

    fn hex16(req: &Value, key: &str) -> Result<[u8; 16], TestkitError> {
        let s = req
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| scenario(format!("the request carries no {key}")))?;
        let bytes = hex::decode(s).map_err(|e| scenario(format!("{key}: {e}")))?;
        bytes
            .try_into()
            .map_err(|_| scenario(format!("{key} is not 16 bytes")))
    }

    fn dispatch(&mut self, op: &str, req: &Value) -> Result<Value, TestkitError> {
        match op {
            "setup" => self.setup(req),
            "open_call" => {
                let a = self.actor(req)?.to_owned();
                let channel = hex::encode(self.channel()?);
                let creator = self.client(&a);
                self.runner.exec_line(&format!(
                    "group {CALL} kind=call target={channel} community=none creator={creator}"
                ))?;
                let mut v = self.epoch(&a)?;
                v["group"] = json!(hex::encode(self.group()?));
                Ok(v)
            }
            "join" => {
                let a = self.actor(req)?.to_owned();
                self.group()?;
                let c = self.client(&a);
                self.runner
                    .exec_line(&format!("join {c} {CALL} via=external"))?;
                self.epoch(&a)
            }
            "sync" => {
                let a = self.actor(req)?.to_owned();
                let c = self.client(&a);
                self.runner.exec_line(&format!("sync {c}"))?;
                self.epoch(&a)
            }
            "commit" => {
                let a = self.actor(req)?.to_owned();
                let c = self.client(&a);
                self.runner.exec_line(&format!("sync {c}"))?;
                self.runner.exec_line(&format!("commit {c}"))?;
                self.epoch(&a)
            }
            "leave" => {
                let a = self.actor(req)?.to_owned();
                let leaver = self.client(&a);
                let other = self
                    .actors
                    .iter()
                    .filter(|x| **x != a)
                    .map(|x| self.client(x))
                    .find(|c| self.runner.epoch_of(c, CALL).is_ok())
                    .ok_or_else(|| scenario("no other member can see the Remove committed"))?;
                self.runner.exec_line(&format!("kick {other} {leaver}"))?;
                Ok(json!({}))
            }
            "media_key" => {
                let a = self.actor(req)?.to_owned();
                let group = self.group()?;
                let c = self.client(&a);
                let m = self
                    .runner
                    .with_member(&c, |client, _| client.media_epoch(&group))?;
                let roster: Vec<Value> = m
                    .roster
                    .iter()
                    .map(|r| json!({"leaf": r.leaf_index, "deviceId": r.device_id.to_hex()}))
                    .collect();
                Ok(json!({
                    "groupId": hex::encode(&group),
                    "epoch": m.epoch.to_string(),
                    "baseKey": hex::encode(*m.base_key),
                    "selfLeaf": m.own_leaf,
                    "roster": roster,
                }))
            }
            "call_token" => {
                let a = self.actor(req)?.to_owned();
                let vdec = req
                    .get("vdec")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let channel = self.channel()?;
                let c = self.client(&a);
                let s = self
                    .runner
                    .with_session(&c, |_, ds| Ok(ds.start_call(&channel, &vdec)?))?;
                let ice: Vec<Value> = s
                    .ice_servers
                    .iter()
                    .map(|(urls, user, cred)| json!([urls, user, cred]))
                    .collect();
                Ok(json!({
                    "callId": hex::encode(s.call_id),
                    "groupId": hex::encode(s.group_id),
                    // The test host serves plain HTTP on loopback while production calls return
                    // the configured wss://dilla.test origin. Keep the /rtc gate in the path.
                    "livekitUrl": self.ds_url.replacen("http", "ws", 1),
                    "token": s.token,
                    "iceServers": ice,
                    "caps": s.caps,
                }))
            }
            "share" => {
                let a = self.actor(req)?.to_owned();
                let call_id = Self::hex16(req, "callId")?;
                let c = self.client(&a);
                self.runner
                    .with_session(&c, |_, ds| Ok(ds.share_call(&call_id)?))?;
                Ok(json!({}))
            }
            "device" => {
                let a = self.actor(req)?.to_owned();
                let c = self.client(&a);
                Ok(json!({"deviceId": self.runner.device_hex(&c)?}))
            }
            other => Err(scenario(format!("unknown op {other}"))),
        }
    }

    fn setup(&mut self, req: &Value) -> Result<Value, TestkitError> {
        if self.channel.is_some() {
            return Err(scenario("setup runs once per driver"));
        }
        let actors = req
            .get("actors")
            .and_then(Value::as_array)
            .ok_or_else(|| scenario("setup needs actors"))?
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| scenario("actors are strings"))?;
        if actors.is_empty()
            || actors
                .iter()
                .any(|a| a.is_empty() || !a.bytes().all(|b| b.is_ascii_lowercase()))
        {
            return Err(scenario(
                "actor names are lowercase ASCII letters (they become scenario client names)",
            ));
        }
        self.actors = actors;
        self.runner.exec_line("instance media")?;
        for a in self.actors.clone() {
            let c = self.client(&a);
            self.runner
                .exec_line(&format!("client {c} key_packages=none"))?;
        }
        let mut channel = [0u8; 16];
        channel[..8].copy_from_slice(&self.seed.to_be_bytes());
        channel[8..].copy_from_slice(b"dillacal");
        let members = self
            .actors
            .iter()
            .map(|a| self.client(a))
            .collect::<Vec<_>>()
            .join(",");
        // No community: the test host writes a group-DM channel, whose participants hold the fixed
        // DM set (connect, speak, video, screen share) — no roles to seed.
        self.runner.exec_line(&format!(
            "channel {} visibility=private mode=e2ee members={members}",
            hex::encode(channel)
        ))?;
        self.channel = Some(channel);
        Ok(json!({"channel": hex::encode(channel)}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn driver(seed: u64) -> MediaDriver {
        // Port 9 (discard): nothing below may reach the network.
        MediaDriver::new("http://127.0.0.1:9".into(), seed)
    }

    #[test]
    fn an_unknown_op_is_an_error_line_that_carries_the_request_id() {
        let mut d = driver(1);
        assert_eq!(
            d.handle(&json!({"id": 7, "op": "nope"})),
            json!({"id": 7, "ok": false, "error": "scenario: unknown op nope"})
        );
    }

    #[test]
    fn an_actor_nobody_set_up_is_refused_before_any_request_is_made() {
        let mut d = driver(1);
        let v = d.handle(&json!({"id": 2, "op": "media_key", "actor": "alice"}));
        assert_eq!(
            v,
            json!({"id": 2, "ok": false, "error": "scenario: unknown actor alice"})
        );
    }

    #[test]
    fn setup_refuses_an_actor_name_the_scenario_parser_cannot_take() {
        let mut d = driver(1);
        let v = d.handle(&json!({"id": 3, "op": "setup", "actors": ["Al ice"]}));
        assert_eq!(v["ok"], json!(false));
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .contains("actor names are lowercase ASCII letters"),
            "{v}"
        );
    }

    #[test]
    fn serve_answers_one_line_per_request_and_skips_blank_lines() {
        let mut d = driver(1);
        let input = "\n{\"id\":1,\"op\":\"nope\"}\nnot json\n";
        let mut out = Vec::new();
        d.serve(input.as_bytes(), &mut out).unwrap();
        let lines: Vec<serde_json::Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["id"], json!(1));
        assert_eq!(lines[1]["id"], serde_json::Value::Null);
        assert!(
            lines[1]["error"].as_str().unwrap().starts_with("not JSON"),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn client_names_are_unique_per_seed_and_parse_as_scenario_names() {
        assert_eq!(driver(0x5eed).client("alice"), "alice005eed");
        assert_ne!(driver(1).client("alice"), driver(2).client("alice"));
    }
}
