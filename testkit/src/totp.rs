//! RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s steps) for the native peers' second factor.
//!
//! Every account owes a second factor (protocol/09 § Second factors), so a peer that registers an
//! account enrols an authenticator-app secret for real and answers the owed code at each new-device
//! login. The instance accepts a code for the counters `c-1 ..= c+1` around its own clock and
//! refuses a counter at or below the last one it accepted (a replay guard), so a peer keeps the last
//! counter it spent beside the secret and picks the next one with [`next_counter`].

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

/// The step length in seconds: the testkit assumes `auth.totp.period = 30`, the default the test host runs with.
pub const PERIOD: u64 = 30;
/// The instance accepts the counters this far either side of its own (`auth.totp.skew`).
pub const SKEW: u64 = 1;

/// What a peer keeps of its enrolled authenticator app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TotpState {
    /// The base32 secret of `POST /v1/auth/totp/enroll`.
    pub secret: String,
    /// The counter of the last code the instance accepted.
    pub last_counter: u64,
}

/// The six-digit code for `counter` under a base32 `secret_b32`.
pub fn code(secret_b32: &str, counter: u64) -> Result<String, String> {
    let key = base32_decode(secret_b32)?;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).map_err(|e| e.to_string())?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[digest.len() - 1] & 0x0f);
    let word = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    Ok(format!("{:06}", word % 1_000_000))
}

/// The counter a peer should spend at host counter `c` when the instance last accepted `last`:
/// `max(c-1, last+1)`, or `None` when that is past `c+1` (the instance would refuse it, so the
/// caller advances the host clock and asks again).
pub fn next_counter(c: u64, last: u64) -> Option<u64> {
    let want = c.saturating_sub(SKEW).max(last + 1);
    (want <= c + SKEW).then_some(want)
}

/// Picks the counter to spend, advancing the host clock by one period at a time until the
/// instance would take one. `now` reads the host's unix seconds; `advance` moves its clock forward
/// by one period.
pub fn pick_counter(
    last: u64,
    mut now: impl FnMut() -> Result<u64, String>,
    mut advance: impl FnMut() -> Result<(), String>,
) -> Result<u64, String> {
    loop {
        if let Some(counter) = next_counter(now()? / PERIOD, last) {
            return Ok(counter);
        }
        advance()?;
    }
}

fn base32_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in s.trim_end_matches('=').bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a',
            b'2'..=b'7' => ch - b'2' + 26,
            _ => return Err("the secret is not base32".into()),
        };
        acc = (acc << 5) | u32::from(v);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B's SHA1 secret, `12345678901234567890`, in base32.
    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn the_rfc_6238_vector() {
        // T = 59 s is counter 1; the RFC lists 94287082 (8 digits), whose low six are 287082.
        assert_eq!(code(RFC_SECRET, 59 / PERIOD).unwrap(), "287082");
    }

    #[test]
    fn the_other_rfc_6238_sha1_rows() {
        // Low six digits of RFC 6238 appendix B: 07081804, 89005924, 69279037.
        for (t, want) in [
            (1_111_111_109u64, "081804"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
        ] {
            assert_eq!(code(RFC_SECRET, t / PERIOD).unwrap(), want, "T = {t}");
        }
    }

    #[test]
    fn base32_decodes_the_rfc_secret_and_refuses_a_stray_character() {
        assert_eq!(base32_decode(RFC_SECRET).unwrap(), b"12345678901234567890");
        assert!(base32_decode("GEZD1").is_err());
        // Lowercase and `=` padding decode to the same bytes.
        assert_eq!(
            base32_decode(&RFC_SECRET.to_lowercase()).unwrap(),
            base32_decode(RFC_SECRET).unwrap()
        );
        assert_eq!(base32_decode("MFRGG===").unwrap(), b"abc");
    }

    #[test]
    fn the_counter_rule() {
        let c = 1000;
        // `last` far behind: c-1, no advance.
        assert_eq!(next_counter(c, c - 5), Some(c - 1));
        // `last = c`: c+1, no advance.
        assert_eq!(next_counter(c, c), Some(c + 1));
        // `last = c+1`: nothing the instance takes.
        assert_eq!(next_counter(c, c + 1), None);
    }

    #[test]
    fn the_clock_advances_one_period_only_when_it_must() {
        let now = std::cell::Cell::new(1000 * PERIOD + 7);
        let advances = std::cell::Cell::new(0);
        let run = |last: u64| {
            pick_counter(
                last,
                || Ok(now.get()),
                || {
                    now.set(now.get() + PERIOD);
                    advances.set(advances.get() + 1);
                    Ok(())
                },
            )
            .unwrap()
        };
        assert_eq!(run(995), 999);
        assert_eq!(advances.get(), 0);
        assert_eq!(run(1000), 1001);
        assert_eq!(advances.get(), 0);
        assert_eq!(run(1001), 1002);
        assert_eq!(advances.get(), 1);
    }
}
