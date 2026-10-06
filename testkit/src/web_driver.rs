//! `dilla-testkit web-driver`: the native peer of the browser tests (dilla-web-1, L-E2E-01).

use std::io::{BufRead, Write};

use dilla_core::ids::{CommunityId, InstanceId};
use dilla_core::mls::{DillaBinding, GroupKind};
use serde_json::{Value, json};

use crate::ds::remote::instance_document;
use crate::{DsError, Received, Runner, TestkitError};

const GROUP: &str = "text";
const BODY_MAX_BYTES: usize = 4000;

fn scenario(msg: impl Into<String>) -> TestkitError {
    TestkitError::Scenario(msg.into())
}

struct Peer {
    name: String,
    community: [u8; 16],
    channel: [u8; 16],
}

pub struct WebDriver {
    runner: Runner,
    ds_url: String,
    seed: u64,
    peer: Option<Peer>,
    group: Option<Vec<u8>>,
    pending: Vec<Received>,
}

impl WebDriver {
    pub fn new(ds: String, seed: u64) -> Self {
        Self {
            runner: Runner::new(seed).with_ds(Some(ds.clone())),
            ds_url: ds,
            seed,
            peer: None,
            group: None,
            pending: Vec::new(),
        }
    }

    pub fn username(seed: u64) -> String {
        format!("peer{:06x}", seed & 0xff_ffff)
    }

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

    fn text<'a>(req: &'a Value, key: &str) -> Result<&'a str, TestkitError> {
        req.get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| scenario(format!("the request carries no {key}")))
    }

    fn hex16(req: &Value, key: &str) -> Result<[u8; 16], TestkitError> {
        let s = Self::text(req, key)?;
        if s.len() != 32
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(scenario(format!("{key} is not 32 lowercase hex")));
        }
        let bytes =
            hex::decode(s).map_err(|_| scenario(format!("{key} is not 32 lowercase hex")))?;
        bytes
            .try_into()
            .map_err(|_| scenario(format!("{key} is not 32 lowercase hex")))
    }

    fn validate(op: &str, req: &Value) -> Result<(), TestkitError> {
        match op {
            "setup" => {
                let community = Self::text(req, "community")?;
                let channel = Self::text(req, "channel")?;
                if !(1..=255).contains(&community.len()) {
                    return Err(scenario("community must be 1..=255 bytes"));
                }
                if !(1..=100).contains(&channel.len()) {
                    return Err(scenario("channel must be 1..=100 bytes"));
                }
            }
            "join" => {
                Self::hex16(req, "community_id")?;
                Self::hex16(req, "channel_id")?;
                Self::hex16(req, "group_id")?;
                Self::text(req, "invite_code")?;
            }
            "send" => {
                let body = Self::text(req, "body")?;
                if !(1..=BODY_MAX_BYTES).contains(&body.len()) {
                    return Err(scenario("body must be 1..=4000 bytes"));
                }
            }
            "register" | "sync" | "members" | "update" => {}
            _ => return Err(scenario(format!("unknown op {op}"))),
        }
        Ok(())
    }

    fn dispatch(&mut self, op: &str, req: &Value) -> Result<Value, TestkitError> {
        Self::validate(op, req)?;
        if op != "setup" && self.peer.is_none() {
            return Err(scenario("setup first"));
        }
        if matches!(op, "send" | "sync" | "members" | "update") && self.group.is_none() {
            return Err(scenario("no group yet: register or join first"));
        }
        if matches!(op, "register" | "join") && self.group.is_some() {
            return Err(scenario("the driver already holds a group"));
        }
        match op {
            "setup" => self.setup(req),
            "register" => self.register(),
            "join" => self.join(req),
            "send" => self.send(req),
            "sync" => self.sync(),
            "members" => self.members(),
            "update" => self.update(),
            _ => unreachable!(),
        }
    }

    fn setup(&mut self, req: &Value) -> Result<Value, TestkitError> {
        if self.peer.is_some() {
            return Err(scenario("setup runs once per driver"));
        }
        let community_name = Self::text(req, "community")?;
        let channel_name = Self::text(req, "channel")?;
        let name = Self::username(self.seed);
        self.runner.exec_line("instance web")?;
        self.runner
            .exec_line(&format!("client {name} key_packages=none"))?;
        self.runner
            .exec_line(&format!("publish_key_packages {name} 32"))?;
        let (user_id, device_id, community, channel, invite_code) = self.runner.with_session(&name, |client, ds| {
            let user_id = client.user_id().to_hex();
            let device_id = client.device_id().to_hex();
            let community = ds.create_community(community_name)?;
            let (channel, mode, visibility) = ds.create_text_channel(&community, channel_name)?;
            if mode != 0 || visibility != 0 {
                return Err(scenario(format!("the instance answered mode {mode} visibility {visibility} for a text channel")));
            }
            let invite_code = ds.create_invite(&community, 100, 3600)?;
            Ok((user_id, device_id, community, channel, invite_code))
        })?;
        self.peer = Some(Peer {
            name: name.clone(),
            community,
            channel,
        });
        Ok(
            json!({"username": name, "display": name, "user_id": user_id, "device_id": device_id,
            "community_id": hex::encode(community), "channel_id": hex::encode(channel), "invite_code": invite_code}),
        )
    }

    fn peer(&self) -> &Peer {
        self.peer.as_ref().expect("dispatch checked setup")
    }
    fn group(&self) -> Vec<u8> {
        self.group.as_ref().expect("dispatch checked group").clone()
    }

    fn register(&mut self) -> Result<Value, TestkitError> {
        let peer = self.peer();
        let name = peer.name.clone();
        let line = format!(
            "group {GROUP} kind=text target={} community={} creator={name}",
            hex::encode(peer.channel),
            hex::encode(peer.community)
        );
        self.runner.exec_line(&line)?;
        let group = self.runner.group_id(GROUP)?;
        let epoch = self.runner.epoch_of(&name, GROUP)?;
        self.group = Some(group.clone());
        Ok(json!({"group_id": hex::encode(group), "epoch": epoch}))
    }

    fn join(&mut self, req: &Value) -> Result<Value, TestkitError> {
        let community = Self::hex16(req, "community_id")?;
        let channel = Self::hex16(req, "channel_id")?;
        let group = Self::hex16(req, "group_id")?;
        let code = Self::text(req, "invite_code")?;
        let name = self.peer().name.clone();
        let doc = instance_document(&self.ds_url)?;
        let binding = DillaBinding {
            v: 1,
            instance_id: InstanceId::from_bytes(doc.instance_id),
            community_id: Some(CommunityId::from_bytes(community)),
            target_id: channel,
            kind: GroupKind::Text,
            policy_version: 1,
            e2ee_version: 1,
            media_version: GroupKind::Text.media_version(),
        };
        self.runner.with_session(&name, |_, ds| {
            ds.join_community(&community, code)?;
            Ok(())
        })?;
        let epoch = self.runner.with_member(&name, |client, ds| {
            client.join_external(ds, &group, &binding)?;
            client
                .epoch_of(&group)
                .ok_or_else(|| scenario("the join left no group state"))
        })?;
        self.group = Some(group.to_vec());
        Ok(json!({"group_id": hex::encode(group), "epoch": epoch}))
    }

    fn send(&mut self, req: &Value) -> Result<Value, TestkitError> {
        let name = self.peer().name.clone();
        let group = self.group();
        let body = Self::text(req, "body")?;
        let seq = self
            .runner
            .with_member(&name, |c, ds| c.send_seq(ds, &group, body))?;
        Ok(json!({"seq": seq}))
    }

    fn received_json(r: &Received) -> Value {
        json!({"seq": r.seq, "body": r.envelope.body, "sender_user": r.sender_user.to_hex(),
            "sender_device": r.sender.to_hex(), "tier": r.tier as u8})
    }

    fn sync(&mut self) -> Result<Value, TestkitError> {
        let name = self.peer().name.clone();
        let group = self.group();
        let (mut got, epoch, members) = self.runner.with_member(&name, |c, ds| {
            let mut got = c.sync(ds)?;
            for attempt in 1..=3 {
                let outstanding = ds.proposals(&group)?.iter().any(|p| !p.void);
                if !outstanding {
                    break;
                }
                match c.commit(ds, &group) {
                    Ok(()) => break,
                    Err(TestkitError::Ds(DsError::CommitConflict { .. })) if attempt < 3 => {
                        got.extend(c.sync(ds)?)
                    }
                    Err(e) => return Err(e),
                }
            }
            got.extend(c.sync(ds)?);
            Ok((got, c.epoch_of(&group), c.member_count(&group)))
        })?;
        let epoch = epoch.ok_or_else(|| scenario("the peer holds no state for its group"))?;
        let members = members.ok_or_else(|| scenario("the peer holds no state for its group"))?;
        let mut received = std::mem::take(&mut self.pending);
        received.append(&mut got);
        let received: Vec<Value> = received
            .iter()
            .filter(|r| r.group_id == group)
            .map(Self::received_json)
            .collect();
        Ok(json!({"epoch": epoch, "members": members, "received": received}))
    }

    fn members(&mut self) -> Result<Value, TestkitError> {
        let name = self.peer().name.clone();
        let group = self.group();
        let (got, roster) = self.runner.with_member(&name, |c, ds| {
            let got = c.sync(ds)?;
            Ok((got, c.roster(&group)))
        })?;
        self.pending.extend(got);
        let roster = roster.ok_or_else(|| scenario("the peer holds no state for its group"))?;
        let devices: Vec<String> = roster.iter().map(|r| r.device_id.to_hex()).collect();
        Ok(json!({"devices": devices}))
    }

    fn update(&mut self) -> Result<Value, TestkitError> {
        let name = self.peer().name.clone();
        let group = self.group();
        let (got, epoch) = self.runner.with_member(&name, |c, ds| {
            let got = c.sync(ds)?;
            c.commit(ds, &group)?;
            Ok((got, c.epoch_of(&group)))
        })?;
        self.pending.extend(got);
        let epoch = epoch.ok_or_else(|| scenario("the peer holds no state for its group"))?;
        Ok(json!({"epoch": epoch}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn driver(seed: u64) -> WebDriver {
        // Port 9 (discard): nothing below may reach the network.
        WebDriver::new("http://127.0.0.1:9".into(), seed)
    }

    fn error_of(answer: &serde_json::Value) -> &str {
        assert_eq!(answer["ok"], json!(false), "{answer}");
        answer["error"].as_str().expect("an error string")
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
    fn every_op_but_setup_is_refused_before_setup() {
        let mut d = driver(1);
        let requests = [
            json!({"id": 1, "op": "register"}),
            json!({"id": 2, "op": "send", "body": "hi"}),
            json!({"id": 3, "op": "sync"}),
            json!({"id": 4, "op": "members"}),
            json!({"id": 5, "op": "update"}),
            json!({"id": 6, "op": "join", "community_id": "11".repeat(16),
                   "channel_id": "22".repeat(16), "group_id": "33".repeat(16), "invite_code": "abc"}),
        ];
        for (i, req) in requests.iter().enumerate() {
            assert_eq!(
                d.handle(req),
                json!({"id": i + 1, "ok": false, "error": "scenario: setup first"}),
                "{req}"
            );
        }
    }

    #[test]
    fn setup_validates_its_names_before_it_touches_the_instance() {
        let mut d = driver(1);
        let cases = [
            (
                json!({"id": 1, "op": "setup", "channel": "general"}),
                "scenario: the request carries no community",
            ),
            (
                json!({"id": 2, "op": "setup", "community": "c"}),
                "scenario: the request carries no channel",
            ),
            (
                json!({"id": 3, "op": "setup", "community": "", "channel": "general"}),
                "scenario: community must be 1..=255 bytes",
            ),
            (
                json!({"id": 4, "op": "setup", "community": "c".repeat(256), "channel": "general"}),
                "scenario: community must be 1..=255 bytes",
            ),
            (
                json!({"id": 5, "op": "setup", "community": "c", "channel": ""}),
                "scenario: channel must be 1..=100 bytes",
            ),
            (
                json!({"id": 6, "op": "setup", "community": "c", "channel": "x".repeat(101)}),
                "scenario: channel must be 1..=100 bytes",
            ),
        ];
        for (req, want) in cases {
            assert_eq!(error_of(&d.handle(&req)), want, "{req}");
        }
    }

    #[test]
    fn join_and_send_validate_their_fields_before_the_setup_check() {
        let mut d = driver(1);
        let good = |k: &str, v: &str| {
            let mut req = json!({"id": 1, "op": "join", "community_id": "11".repeat(16),
                "channel_id": "22".repeat(16), "group_id": "33".repeat(16), "invite_code": "abc"});
            req[k] = json!(v);
            req
        };
        assert_eq!(
            error_of(&d.handle(&good("community_id", "XYZ"))),
            "scenario: community_id is not 32 lowercase hex"
        );
        assert_eq!(
            error_of(&d.handle(&good("channel_id", "AA".repeat(16).as_str()))),
            "scenario: channel_id is not 32 lowercase hex"
        );
        assert_eq!(
            error_of(&d.handle(&good("group_id", "3".repeat(31).as_str()))),
            "scenario: group_id is not 32 lowercase hex"
        );
        let mut no_code = good("invite_code", "x");
        no_code.as_object_mut().unwrap().remove("invite_code");
        assert_eq!(
            error_of(&d.handle(&no_code)),
            "scenario: the request carries no invite_code"
        );
        assert_eq!(
            error_of(&d.handle(&json!({"id": 2, "op": "send", "body": ""}))),
            "scenario: body must be 1..=4000 bytes"
        );
        assert_eq!(
            error_of(&d.handle(&json!({"id": 3, "op": "send", "body": "a".repeat(4001)}))),
            "scenario: body must be 1..=4000 bytes"
        );
        // 2001 two-byte characters: 2001 characters, 4002 bytes. A character count would let it through.
        assert_eq!(
            error_of(&d.handle(&json!({"id": 4, "op": "send", "body": "é".repeat(2001)}))),
            "scenario: body must be 1..=4000 bytes"
        );
        // Exactly 4000 bytes passes validation and reaches the setup check.
        assert_eq!(
            error_of(&d.handle(&json!({"id": 5, "op": "send", "body": "é".repeat(2000)}))),
            "scenario: setup first"
        );
    }

    #[test]
    fn usernames_are_peer_and_six_hex_digits_unique_per_seed() {
        assert_eq!(WebDriver::username(0x5eed), "peer005eed");
        assert_eq!(WebDriver::username(0x0100_0005), "peer000005");
        assert_ne!(WebDriver::username(1), WebDriver::username(2));
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
}
