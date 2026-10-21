use dilla_core::bot::{Event, HelperRequest, HelperResponse, Receipt, RemovalProof, Response};
use dilla_core::bot::{Request, RequestArgs};
use dilla_core::ids::{CommunityId, DeviceId, MsgId, UserId};
use serde_json::Value;

#[test]
fn overview_request_body_round_trips_canonically() {
    let request = Request {
        request_id: MsgId::from_bytes([1; 16]),
        community_id: CommunityId::from_bytes([2; 16]),
        channel_id: None,
        operation: 0,
        revision: None,
        expires: None,
        args: RequestArgs::None,
    };
    let body = request.encode_body().expect("valid overview request");
    assert!(body.starts_with("dilla.bot/1:"));
    assert!(Request::decode_body(body.as_bytes()).unwrap() == request);
}

#[test]
fn application_context_is_checked_explicitly() {
    let request = Request {
        request_id: MsgId::from_bytes([1; 16]),
        community_id: CommunityId::from_bytes([2; 16]),
        channel_id: None,
        operation: 0,
        revision: None,
        expires: None,
        args: RequestArgs::None,
    };
    assert!(
        request
            .validate_context(CommunityId::from_bytes([2; 16]), 100)
            .is_ok()
    );
    assert!(
        request
            .validate_context(CommunityId::from_bytes([3; 16]), 100)
            .is_err()
    );
}

#[test]
fn shared_bot_corpus_round_trips_and_rejects() {
    let corpus: Value = serde_json::from_str(include_str!("../../../protocol/vectors/bot.json"))
        .expect("shared bot corpus parses");
    let cases = corpus["cases"].as_array().unwrap();
    let rejects = corpus["rejects"].as_array().unwrap();
    assert!(!cases.is_empty());
    assert!(!rejects.is_empty());

    for case in cases {
        let kind = case["kind"].as_str().unwrap();
        let raw = hex::decode(case["hex"].as_str().unwrap()).unwrap();
        match kind {
            "request" => {
                let value = Request::decode_cbor(&raw).unwrap();
                assert_eq!(value.encode_cbor().unwrap(), raw, "{}", case["name"]);
                if let Some(body) = case["body"].as_str() {
                    assert!(Request::decode_body(body.as_bytes()).unwrap() == value);
                    assert_eq!(value.encode_body().unwrap(), body);
                }
                context(case, |c, now, _g, _u, _d| {
                    value.validate_context(c, now).is_ok()
                });
            }
            "response" => {
                let value = Response::decode_cbor(&raw).unwrap();
                assert_eq!(value.encode_cbor().unwrap(), raw, "{}", case["name"]);
                if let Some(body) = case["body"].as_str() {
                    assert_eq!(
                        Response::decode_body(body.as_bytes())
                            .unwrap()
                            .encode_body()
                            .unwrap(),
                        body
                    );
                }
                context(case, |c, _now, _g, _u, _d| {
                    value.validate_context(c).is_ok()
                });
            }
            "removal" => {
                let value = RemovalProof::decode(&raw).unwrap();
                assert_eq!(value.encode().unwrap(), raw, "{}", case["name"]);
                assert_eq!(
                    hex::encode(value.signature_preimage().unwrap()),
                    case["preimage_hex"].as_str().unwrap()
                );
                context(case, |c, now, g, u, d| {
                    value.validate_context(c, g, u, d, now).is_ok()
                });
            }
            "event" => {
                let value = Event::decode(&raw).unwrap();
                assert_eq!(value.encode().unwrap(), raw, "{}", case["name"]);
                context(case, |c, _now, _g, _u, _d| {
                    value.validate_context(c).is_ok()
                });
            }
            "receipt" => {
                let value = Receipt::decode(&raw).unwrap();
                assert_eq!(value.encode().unwrap(), raw, "{}", case["name"]);
                context(case, |c, _now, g, _u, _d| {
                    value.validate_context(c, g).is_ok()
                });
            }
            "helper_request" => {
                let value = HelperRequest::decode(&raw).unwrap();
                assert_eq!(value.encode().unwrap(), raw, "{}", case["name"]);
                let frame = value.encode_frame().unwrap();
                assert_eq!(
                    HelperRequest::decode_frame(&frame)
                        .unwrap()
                        .encode()
                        .unwrap(),
                    raw
                );
            }
            "helper_response" => {
                let value = HelperResponse::decode(&raw).unwrap();
                assert_eq!(value.encode().unwrap(), raw, "{}", case["name"]);
                let frame = value.encode_frame().unwrap();
                assert_eq!(
                    HelperResponse::decode_frame(&frame)
                        .unwrap()
                        .encode()
                        .unwrap(),
                    raw
                );
            }
            other => panic!("unknown bot vector kind: {other}"),
        }
    }

    for case in rejects {
        let kind = case["kind"].as_str().unwrap();
        let raw = case["hex"].as_str().map(hex::decode).transpose().unwrap();
        let body = case["body"].as_str();
        let accepted = match kind {
            "request" => {
                let parsed = body
                    .map(|s| Request::decode_body(s.as_bytes()))
                    .unwrap_or_else(|| Request::decode_cbor(raw.as_ref().unwrap()));
                match parsed {
                    Err(_) => false,
                    Ok(value) => context_result(case, |c, now, _g, _u, _d| {
                        value.validate_context(c, now).is_ok()
                    }),
                }
            }
            "response" => raw
                .as_ref()
                .is_some_and(|r| Response::decode_cbor(r).is_ok()),
            "removal" => raw
                .as_ref()
                .is_some_and(|r| RemovalProof::decode(r).is_ok()),
            "event" => raw.as_ref().is_some_and(|r| Event::decode(r).is_ok()),
            "receipt" => raw.as_ref().is_some_and(|r| Receipt::decode(r).is_ok()),
            "helper_request" if case["name"].as_str() == Some("helper malformed length prefix") => {
                raw.as_ref()
                    .is_some_and(|r| dilla_core::bot::parse_frame(r).is_ok())
            }
            "helper_request" => raw
                .as_ref()
                .is_some_and(|r| HelperRequest::decode(r).is_ok()),
            "helper_response" => raw
                .as_ref()
                .is_some_and(|r| HelperResponse::decode(r).is_ok()),
            other => panic!("unknown bot reject kind: {other}"),
        };
        assert!(!accepted, "reject vector accepted: {}", case["name"]);
    }
}

fn context(case: &Value, check: impl FnOnce(CommunityId, u64, MsgId, UserId, DeviceId) -> bool) {
    if case.get("context").is_some() {
        assert!(
            context_result(case, check),
            "context validation failed: {}",
            case["name"]
        );
    }
}

fn context_result(
    case: &Value,
    check: impl FnOnce(CommunityId, u64, MsgId, UserId, DeviceId) -> bool,
) -> bool {
    let Some(ctx) = case.get("context") else {
        return true;
    };
    let community = CommunityId::from_hex(ctx["community"].as_str().unwrap()).unwrap();
    let now = ctx["now"]
        .as_str()
        .map(str::parse)
        .transpose()
        .unwrap()
        .unwrap_or(0);
    let group = ctx["group"]
        .as_str()
        .map(MsgId::from_hex)
        .transpose()
        .unwrap()
        .unwrap_or(MsgId::from_bytes([1; 16]));
    let user = ctx["actor_user"]
        .as_str()
        .map(UserId::from_hex)
        .transpose()
        .unwrap()
        .unwrap_or(UserId::from_bytes([1; 16]));
    let device = ctx["actor_device"]
        .as_str()
        .map(DeviceId::from_hex)
        .transpose()
        .unwrap()
        .unwrap_or(DeviceId::from_bytes([1; 16]));
    check(community, now, group, user, device)
}
