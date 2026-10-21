use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

const AUTHORIZE_ENDPOINT: &str = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT: &str = "https://accounts.spotify.com/api/token";
const REDIRECT_URI: &str = "http://127.0.0.1:5588/login";
const STATE_TTL_SECS: u64 = 10 * 60;
const MAX_INPUT_BYTES: usize = 8 * 1024;
const MAX_TOKEN_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_ACCESS_TOKEN_BYTES: usize = 4 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    client_id: String,
    state: String,
    verifier: String,
    created_at: u64,
}

pub fn begin(client_id: &str, now: u64) -> Result<(Pending, String), &'static str> {
    if client_id.is_empty()
        || client_id.len() > MAX_INPUT_BYTES
        || client_id.chars().any(char::is_control)
    {
        return Err("oauth: invalid client id");
    }

    let state = random_urlsafe();
    let verifier = random_urlsafe();
    let pending = Pending {
        client_id: client_id.to_owned(),
        state: state.clone(),
        verifier: verifier.clone(),
        created_at: now,
    };

    let mut url =
        Url::parse(AUTHORIZE_ENDPOINT).map_err(|_| "oauth: authorization URL unavailable")?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", "streaming")
        .append_pair("state", &state)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", &challenge(&verifier));
    let authorization = String::from(url);
    if authorization.len() > MAX_INPUT_BYTES {
        return Err("oauth: authorization URL too large");
    }
    Ok((pending, authorization))
}

pub async fn finish(pending: Pending, redirect: &str, now: u64) -> Result<String, &'static str> {
    let code = validate_callback(&pending, redirect, now)?;
    if code.len() > MAX_INPUT_BYTES {
        return Err("oauth: callback too large");
    }
    let form_body = token_request_body(&pending, &code)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "oauth: token client unavailable")?;
    let response = client
        .post(TOKEN_ENDPOINT)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form_body)
        .send()
        .await
        .map_err(|_| "oauth: token exchange failed")?;

    if !response.status().is_success() {
        return Err("oauth: provider rejected token exchange");
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TOKEN_RESPONSE_BYTES as u64)
    {
        return Err("oauth: token response too large");
    }

    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "oauth: token exchange failed")?
    {
        if body.len().saturating_add(chunk.len()) > MAX_TOKEN_RESPONSE_BYTES {
            return Err("oauth: token response too large");
        }
        body.extend_from_slice(&chunk);
    }
    parse_token_response(200, &body)
}

fn random_urlsafe() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn token_request_body(pending: &Pending, code: &str) -> Result<String, &'static str> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("client_id", &pending.client_id)
        .append_pair("code_verifier", &pending.verifier)
        .finish();
    if body.len() > MAX_INPUT_BYTES {
        return Err("oauth: token request too large");
    }
    Ok(body)
}

fn validate_callback(pending: &Pending, redirect: &str, now: u64) -> Result<String, &'static str> {
    if redirect.len() > MAX_INPUT_BYTES {
        return Err("oauth: callback too large");
    }
    if pending.client_id.is_empty()
        || pending.client_id.len() > MAX_INPUT_BYTES
        || pending.client_id.chars().any(char::is_control)
        || pending.state.len() != 43
        || !pending
            .state
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || pending.verifier.len() != 43
        || !pending
            .verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("oauth: invalid pending authorization");
    }
    if now < pending.created_at || now - pending.created_at > STATE_TTL_SECS {
        return Err("oauth: pending authorization expired");
    }
    if !redirect.starts_with("http://127.0.0.1:5588/login?") {
        return Err("oauth: invalid callback URL");
    }

    let url = Url::parse(redirect).map_err(|_| "oauth: invalid callback URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(5588)
        || url.path() != "/login"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("oauth: invalid callback URL");
    }

    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            "error" => return Err("oauth: authorization denied"),
            _ => return Err("oauth: invalid callback parameters"),
        }
    }
    let code = code
        .filter(|value| !value.is_empty())
        .ok_or("oauth: missing authorization code")?;
    let state = state
        .filter(|value| !value.is_empty())
        .ok_or("oauth: missing callback state")?;
    if code.len() > MAX_INPUT_BYTES || state.len() > MAX_INPUT_BYTES {
        return Err("oauth: callback too large");
    }
    if !code.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("oauth: invalid authorization code");
    }
    if state != pending.state {
        return Err("oauth: callback state mismatch");
    }
    Ok(code)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
}

fn parse_token_response(status: u16, body: &[u8]) -> Result<String, &'static str> {
    if body.len() > MAX_TOKEN_RESPONSE_BYTES {
        return Err("oauth: token response too large");
    }
    if !(200..300).contains(&status) {
        return Err("oauth: provider rejected token exchange");
    }
    let response: TokenResponse =
        serde_json::from_slice(body).map_err(|_| "oauth: invalid token response")?;
    if response.access_token.is_empty()
        || response.access_token.len() > MAX_ACCESS_TOKEN_BYTES
        || response
            .access_token
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || !response.token_type.eq_ignore_ascii_case("bearer")
    {
        return Err("oauth: invalid token response");
    }
    Ok(response.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use url::Url;

    fn pending() -> Pending {
        Pending {
            client_id: "client-id".into(),
            state: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
            created_at: 1_000,
        }
    }

    #[test]
    fn rfc7636_s256_vector_is_exact() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn begin_builds_scoped_authorization_url_and_pkce_material() {
        let (pending, authorization) = begin("client-id", 1_000).unwrap();
        let url = Url::parse(&authorization).unwrap();
        let params = url.query_pairs().collect::<Vec<_>>();
        let get = |key: &str| {
            params
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_ref())
        };

        assert_eq!(url.as_str().split('?').next(), Some(AUTHORIZE_ENDPOINT));
        assert_eq!(get("client_id"), Some("client-id"));
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("redirect_uri"), Some(REDIRECT_URI));
        assert_eq!(get("scope"), Some("streaming"));
        assert_eq!(get("state"), Some(pending.state.as_str()));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(
            get("code_challenge"),
            Some(challenge(&pending.verifier).as_str())
        );
        assert_eq!(pending.state.len(), 43);
        assert_eq!(pending.verifier.len(), 43);
    }

    #[test]
    fn callback_requires_exact_redirect_and_single_code_and_state() {
        let p = pending();
        let code = validate_callback(
            &p,
            "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1_001,
        )
        .unwrap();
        assert_eq!(code, "abc");

        for callback in [
            "http://127.0.0.1:5588/login?code=abc&state=wrong",
            "http://127.0.0.1:5588/login?code=abc",
            "http://127.0.0.1:5588/login?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/login?code=abc&code=def&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/login?error=access_denied&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&extra=x",
            "http://127.0.0.1:5588/login?code=%0A&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(
                validate_callback(&p, callback, 1_001).is_err(),
                "accepted {callback}"
            );
        }
    }

    #[test]
    fn callback_binds_scheme_host_port_path_userinfo_and_fragment() {
        let p = pending();
        for callback in [
            "https://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://localhost:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.2:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5589/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/other?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/a/../login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://user@127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#fragment",
        ] {
            assert!(
                validate_callback(&p, callback, 1_001).is_err(),
                "accepted {callback}"
            );
        }
    }

    #[test]
    fn callback_rejects_expired_and_future_pending_state() {
        let mut p = pending();
        assert!(
            validate_callback(
                &p,
                "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                1_000 + STATE_TTL_SECS
            )
            .is_ok()
        );
        assert!(
            validate_callback(
                &p,
                "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                1_001 + STATE_TTL_SECS
            )
            .is_err()
        );
        p.created_at = 1_001;
        assert!(
            validate_callback(
                &p,
                "http://127.0.0.1:5588/login?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                1_000
            )
            .is_err()
        );
    }

    #[test]
    fn input_and_callback_size_limits_are_enforced() {
        assert!(begin("x".repeat(MAX_INPUT_BYTES + 1).as_str(), 1_000).is_err());
        let p = pending();
        assert!(
            validate_callback(
                &p,
                &format!(
                    "http://127.0.0.1:5588/login?code={}&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "x".repeat(MAX_INPUT_BYTES)
                ),
                1_001
            )
            .is_err()
        );
        assert!(
            validate_callback(
                &p,
                &format!(
                    "http://127.0.0.1:5588/login?code=x&state={}",
                    "x".repeat(MAX_INPUT_BYTES)
                ),
                1_001
            )
            .is_err()
        );
        assert!(token_request_body(&p, &"x".repeat(MAX_INPUT_BYTES)).is_err());
    }

    #[test]
    fn provider_failures_are_sanitized_and_tokens_are_bounded() {
        let hostile = br#"{"error":"access_denied","description":"secret response"}"#;
        assert_eq!(
            parse_token_response(400, hostile),
            Err("oauth: provider rejected token exchange")
        );
        assert_eq!(
            parse_token_response(200, b"not json"),
            Err("oauth: invalid token response")
        );
        assert_eq!(
            parse_token_response(200, br#"{"access_token":"","token_type":"Bearer"}"#),
            Err("oauth: invalid token response")
        );
        assert_eq!(
            parse_token_response(200, br#"{"access_token":"abc","token_type":"MAC"}"#),
            Err("oauth: invalid token response")
        );
        assert_eq!(
            parse_token_response(200, br#"{"access_token":"abc\n","token_type":"Bearer"}"#),
            Err("oauth: invalid token response")
        );
        assert_eq!(
            parse_token_response(200, br#"{"access_token":"abc","token_type":"Bearer"}"#),
            Ok("abc".to_string())
        );
        assert_eq!(
            parse_token_response(200, &vec![b' '; MAX_TOKEN_RESPONSE_BYTES + 1]),
            Err("oauth: token response too large")
        );
        let too_long = format!(
            r#"{{"access_token":"{}","token_type":"Bearer"}}"#,
            "x".repeat(MAX_ACCESS_TOKEN_BYTES + 1)
        );
        assert_eq!(
            parse_token_response(200, too_long.as_bytes()),
            Err("oauth: invalid token response")
        );
    }

    #[test]
    fn pending_json_denies_unknown_fields_and_does_not_require_debug() {
        let serialized = serde_json::to_string(&pending()).unwrap();
        assert!(serde_json::from_str::<Pending>(&serialized).is_ok());
        let with_extra = serialized.trim_end_matches('}').to_owned() + ",\"token\":\"leak\"}";
        assert!(serde_json::from_str::<Pending>(&with_extra).is_err());
    }
}
