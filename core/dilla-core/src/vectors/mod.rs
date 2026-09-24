//! The cross-target conformance runner.
//!
//! The four vector files are embedded with `include_str!` rather than read from disk: `std::fs`
//! always errors on `wasm32-unknown-unknown`, so this is the only shape that compiles for native,
//! wasm32-unknown-unknown and wasm32-wasip1 alike. The same functions back the wasi
//! `vectors_check` export and the Node test, which is what stops the three builds diverging.

mod report;

pub use report::{CaseReport, SuiteReport, VectorReport};

use crate::cbor::decode_strict;
use crate::envelope::{
    Attachment, Envelope, EnvelopeType, FrankingTagInput, Preview, franking_tag,
};
use crate::identity::{
    CredentialIdentity, Kind, SignerTier, Tier, k_backup, k_header, recovery_key_base32,
    safety_number, sas,
};
use crate::ids::{DeviceId, MsgId, UserId};
use crate::sframe::{Ctr, Kid, NK, derive_keys, encode_header, nonce};
use serde_json::Value;

pub const ENVELOPE_JSON: &str = include_str!("../../../../protocol/vectors/envelope.json");
pub const FRANKING_JSON: &str = include_str!("../../../../protocol/vectors/franking.json");
pub const SFRAME_JSON: &str = include_str!("../../../../protocol/vectors/sframe.json");
pub const IDENTITY_JSON: &str = include_str!("../../../../protocol/vectors/identity.json");

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or(0))
        .collect()
}

fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
    let v = unhex(s);
    let mut out = [0u8; N];
    let n = v.len().min(N);
    out[..n].copy_from_slice(&v[..n]);
    out
}

/// Integers above 2^53 are decimal strings in the vector files; small ones may be either.
fn int(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0),
        other => other.as_u64().unwrap_or(0),
    }
}

/// The **expected** side of a comparison, read out of the vector file.
///
/// A missing or renamed JSON key yields this sentinel rather than `""`, so it can never compare
/// equal to a defaulted actual value: `expected: ""` against an `encode()` that failed and
/// defaulted to an empty vector is two faults reporting `ok: true`. Nothing the runner computes
/// can produce this string, so an absent field is always a failed case. Input-side accessors keep
/// their `unwrap_or("")`: a missing input produces a wrong actual, which then fails against the
/// real expected value.
const MISSING: &str = "<missing field>";

fn expect_str(v: &Value) -> &str {
    v.as_str().unwrap_or(MISSING)
}

/// The expected side of an integer comparison, as a decimal string. Missing is a failure, not 0.
fn expect_int(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => MISSING.to_owned(),
    }
}

/// Ed25519 verification for the two credential signatures, checked one field at a time so a
/// failure names which signature broke (interfaces.md section 2.9). `verify_strict` is the same
/// check `CredentialIdentity::verify_signatures` performs over both at once.
/// Verified against the vendored `ed25519-dalek 2.2.0` and `ed25519 2.2.3` sources:
/// `VerifyingKey::from_bytes(&[u8; 32]) -> Result<VerifyingKey, SignatureError>` and
/// `ed25519::Signature::from_bytes(&SignatureBytes) -> Signature` (`SignatureBytes = [u8; 64]`,
/// infallible), re-exported as `ed25519_dalek::Signature`.
fn ed25519_verifies(public: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    use ed25519_dalek::{Signature, VerifyingKey};
    VerifyingKey::from_bytes(public)
        .map(|k| {
            k.verify_strict(message, &Signature::from_bytes(signature))
                .is_ok()
        })
        .unwrap_or(false)
}

fn opt_msg_id(v: &Value) -> Option<MsgId> {
    v.as_str().map(|s| MsgId::from_bytes(unhex_n::<16>(s)))
}

fn envelope_from_json(j: &Value) -> Envelope {
    Envelope {
        v: int(&j["v"]),
        msg_id: MsgId::from_bytes(unhex_n::<16>(j["msgId"].as_str().unwrap_or(""))),
        kind: EnvelopeType::from_u64(int(&j["type"])).unwrap_or(EnvelopeType::Message),
        thread_id: opt_msg_id(&j["threadId"]),
        reply_to: opt_msg_id(&j["replyTo"]),
        body: j["body"].as_str().unwrap_or("").to_owned(),
        attachments: j["attachments"]
            .as_array()
            .map(|xs| {
                xs.iter()
                    .map(|a| Attachment {
                        blob_id: unhex_n::<32>(a["blobId"].as_str().unwrap_or("")),
                        key: unhex_n::<32>(a["key"].as_str().unwrap_or("")),
                        nonce: unhex_n::<12>(a["nonce"].as_str().unwrap_or("")),
                        size: int(&a["size"]),
                        mime: a["mime"].as_str().unwrap_or("").to_owned(),
                        w: a["w"].as_u64(),
                        h: a["h"].as_u64(),
                        thumb: a["thumb"].as_str().map(unhex),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        previews: j["previews"]
            .as_array()
            .map(|xs| {
                xs.iter()
                    .map(|p| Preview {
                        url: p["url"].as_str().unwrap_or("").to_owned(),
                        title: p["title"].as_str().unwrap_or("").to_owned(),
                        description: p["description"].as_str().unwrap_or("").to_owned(),
                        image: p["image"].as_str().map(unhex),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        k_f: unhex_n::<32>(j["kf"].as_str().unwrap_or("")),
    }
}

pub fn run_envelope() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(ENVELOPE_JSON).unwrap_or(Value::Null);
    for case in doc["cases"].as_array().unwrap_or(&Vec::new()) {
        let name = case["name"].as_str().unwrap_or("?").to_owned();
        let env = envelope_from_json(&case["envelope"]);
        let bytes = env.encode().unwrap_or_default();
        cases.push(CaseReport::compare(
            name.clone(),
            "cbor",
            expect_str(&case["cbor"]),
            hex(&bytes),
        ));
        cases.push(CaseReport::compare(
            name.clone(),
            "length",
            expect_int(&case["length"]),
            bytes.len().to_string(),
        ));
        cases.push(CaseReport::compare(
            name,
            "commitment",
            expect_str(&case["commitment"]),
            hex(&env.commitment().unwrap_or_default()),
        ));
    }
    SuiteReport {
        name: "envelope",
        cases,
    }
}

pub fn run_franking() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(FRANKING_JSON).unwrap_or(Value::Null);
    let k_frank = unhex_n::<32>(doc["instance_franking_key"].as_str().unwrap_or(""));
    for (i, case) in doc["cases"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .enumerate()
    {
        let input = FrankingTagInput {
            group_id: unhex_n::<16>(case["group_id"].as_str().unwrap_or("")),
            epoch: int(&case["epoch"]),
            seq: int(&case["seq"]),
            uploader_device: DeviceId::from_bytes(unhex_n::<16>(
                case["uploader_device"].as_str().unwrap_or(""),
            )),
            commitment: unhex_n::<32>(case["commitment"].as_str().unwrap_or("")),
            recv_ts: int(&case["recv_ts"]),
        };
        cases.push(CaseReport::compare(
            format!("case {i}"),
            "tag",
            expect_str(&case["tag"]),
            hex(&franking_tag(&k_frank, &input)),
        ));
    }
    SuiteReport {
        name: "franking",
        cases,
    }
}

pub fn run_sframe() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(SFRAME_JSON).unwrap_or(Value::Null);
    let base_key = unhex_n::<NK>(doc["base_key"].as_str().unwrap_or(""));
    for case in doc["cases"].as_array().unwrap_or(&Vec::new()) {
        let leaf = u16::try_from(int(&case["leaf_index"])).unwrap_or(0);
        let epoch = int(&case["epoch"]);
        let name = format!("leaf {leaf} epoch {epoch}");
        let kid = Kid::new(leaf, epoch);
        cases.push(CaseReport::compare(
            name.clone(),
            "kid",
            expect_int(&case["kid"]),
            kid.value().to_string(),
        ));
        let keys = derive_keys(&base_key, kid);
        cases.push(CaseReport::compare(
            name.clone(),
            "key",
            expect_str(&case["key"]),
            hex(&keys.key),
        ));
        cases.push(CaseReport::compare(
            name.clone(),
            "salt",
            expect_str(&case["salt"]),
            hex(&keys.salt),
        ));
        let ctr = Ctr::new(
            u8::try_from(int(&case["slot"])).unwrap_or(0),
            u8::try_from(int(&case["layer"])).unwrap_or(0),
            int(&case["seq"]),
        )
        .unwrap_or(Ctr::from_raw(0));
        cases.push(CaseReport::compare(
            name.clone(),
            "ctr",
            expect_int(&case["ctr"]),
            ctr.value().to_string(),
        ));
        cases.push(CaseReport::compare(
            name.clone(),
            "nonce",
            expect_str(&case["nonce"]),
            hex(&nonce(&keys.salt, ctr)),
        ));
        cases.push(CaseReport::compare(
            name,
            "header",
            expect_str(&case["header"]),
            hex(&encode_header(kid, ctr)),
        ));
    }
    SuiteReport {
        name: "sframe",
        cases,
    }
}

pub fn run_identity() -> SuiteReport {
    let mut cases = Vec::new();
    let doc: Value = serde_json::from_str(IDENTITY_JSON).unwrap_or(Value::Null);

    let sn = &doc["safety_number"];
    cases.push(CaseReport::compare(
        "safety_number",
        "digits",
        expect_str(&sn["digits"]),
        safety_number(
            &unhex_n::<32>(sn["umk_a"].as_str().unwrap_or("")),
            &unhex_n::<32>(sn["umk_b"].as_str().unwrap_or("")),
        ),
    ));

    let s = &doc["sas"];
    cases.push(CaseReport::compare(
        "sas",
        "digits",
        expect_str(&s["digits"]),
        sas(&unhex_n::<32>(
            s["epoch_authenticator"].as_str().unwrap_or(""),
        )),
    ));

    let r = &doc["recovery_key"];
    let rk = unhex_n::<32>(r["rk"].as_str().unwrap_or(""));
    cases.push(CaseReport::compare(
        "recovery_key",
        "base32",
        expect_str(&r["base32"]),
        recovery_key_base32(&rk),
    ));
    cases.push(CaseReport::compare(
        "recovery_key",
        "k_header",
        expect_str(&r["k_header"]),
        hex(&k_header(&rk)),
    ));
    cases.push(CaseReport::compare(
        "recovery_key",
        "k_backup",
        expect_str(&r["k_backup"]),
        hex(&k_backup(&rk)),
    ));

    let ci = &doc["credential_identity"];
    let f = &ci["fields"];
    let credential = CredentialIdentity {
        v: 1,
        umk_pub: unhex_n::<32>(f["umk_pub"].as_str().unwrap_or("")),
        user_id: UserId::from_bytes(unhex_n::<16>(f["user_id"].as_str().unwrap_or(""))),
        device_id: DeviceId::from_bytes(unhex_n::<16>(f["device_id"].as_str().unwrap_or(""))),
        kind: Kind::from_u64(int(&f["kind"])).unwrap_or(Kind::User),
        tier: Tier::from_u64(int(&f["tier"])).unwrap_or(Tier::Native),
        signer_tier: SignerTier::from_u64(int(&f["signer_tier"])).unwrap_or(SignerTier::Native),
        ssk_pub: unhex_n::<32>(f["ssk_pub"].as_str().unwrap_or("")),
        sig_umk_ssk: unhex_n::<64>(f["sig_umk_ssk"].as_str().unwrap_or("")),
        sig_ssk_dev: unhex_n::<64>(f["sig_ssk_dev"].as_str().unwrap_or("")),
    };
    cases.push(CaseReport::compare(
        "credential_identity",
        "cbor",
        expect_str(&ci["cbor"]),
        hex(&credential.encode()),
    ));
    // Task 7 put real signatures and the leaf key in the file, so both are verifiable here.
    // They are two cases, not one: interfaces.md section 2.9 lists `sig_umk_ssk` and `sig_ssk_dev`
    // as separate fields of the identity suite, and a single "signatures" case cannot say which of
    // the two broke.
    let dsk_pub = unhex_n::<32>(ci["dsk_pub"].as_str().unwrap_or(""));
    cases.push(CaseReport::compare(
        "credential_identity",
        "sig_umk_ssk",
        "verified",
        if ed25519_verifies(
            &credential.umk_pub,
            &CredentialIdentity::ssk_message(&credential.ssk_pub),
            &credential.sig_umk_ssk,
        ) {
            "verified"
        } else {
            "rejected"
        },
    ));
    cases.push(CaseReport::compare(
        "credential_identity",
        "sig_ssk_dev",
        "verified",
        if ed25519_verifies(
            &credential.ssk_pub,
            &CredentialIdentity::dsk_message(
                &credential.device_id,
                &dsk_pub,
                credential.kind,
                credential.tier,
                credential.signer_tier,
            ),
            &credential.sig_ssk_dev,
        ) {
            "verified"
        } else {
            "rejected"
        },
    ));
    // The chain as a whole, through the production entry point, must agree with the two field
    // checks above.
    debug_assert_eq!(
        credential.verify_signatures(&dsk_pub).is_ok(),
        cases[cases.len() - 2].ok && cases[cases.len() - 1].ok
    );

    SuiteReport {
        name: "identity",
        cases,
    }
}

/// Every input protocol/04 says a receiver must reject, plus the deterministic-CBOR reject corpus.
/// A case passes when the decoder **refuses** the input.
pub fn run_rejects() -> SuiteReport {
    let mut cases = Vec::new();
    let mut expect_cbor_reject = |name: &str, hex_input: &str| {
        let bytes = unhex(hex_input);
        let refused = decode_strict(&bytes, |d| d.skip().map(|_| ())).is_err();
        cases.push(CaseReport::compare(
            format!("{name} ({hex_input})"),
            "cbor",
            "rejected",
            if refused { "rejected" } else { "accepted" },
        ));
    };

    for (name, input) in [
        ("non-minimal uint", "1801"),
        ("non-minimal uint", "1817"),
        ("non-minimal uint", "190017"),
        ("non-minimal uint", "1a00000017"),
        ("non-minimal uint", "1b0000000000000017"),
        ("non-minimal uint", "1900ff"),
        ("non-minimal length", "5800"),
        ("non-minimal length", "7800"),
        ("non-minimal length", "9800"),
        ("non-minimal length", "990003010203"),
        ("indefinite array", "9f01ff"),
        ("indefinite bstr", "5f41014102ff"),
        ("indefinite text", "7f6161ff"),
        ("indefinite map", "bf0101ff"),
        ("map", "a0"),
        ("map", "a10102"),
        ("tag", "c11a514b67b0"),
        ("tag", "d8ff01"),
        ("tag", "c001"),
        ("float64", "fb3ff0000000000000"),
        ("float16", "f93c00"),
        ("negative", "20"),
        ("undefined", "f7"),
        ("non-minimal null", "f816"),
        ("reserved ai", "1c"),
        ("reserved ai", "1d"),
        ("reserved ai", "1e"),
        ("trailing bytes", "0101"),
        ("trailing bytes", "01a0"),
        ("trailing bytes", "83010203ff"),
        ("trailing bytes", "83010203ffffffff"),
        ("truncated bstr", "5820"),
        ("invalid utf-8", "6263c3"),
    ] {
        expect_cbor_reject(name, input);
    }

    // protocol/04's envelope reject list, exercised through Envelope::decode.
    let doc: Value = serde_json::from_str(ENVELOPE_JSON).unwrap_or(Value::Null);
    let env = envelope_from_json(&doc["cases"][0]["envelope"]);
    let good = env.encode().unwrap_or_default();

    let mut wrong_count = good.clone();
    if !wrong_count.is_empty() {
        wrong_count[0] = 0x88;
    }
    let mut unknown_type = good.clone();
    if unknown_type.len() > 19 {
        unknown_type[19] = 0x07;
    }
    let mut trailing = good.clone();
    trailing.push(0x00);

    for (name, bytes) in [
        ("wrong element count", wrong_count),
        ("unknown type", unknown_type),
        ("trailing bytes", trailing),
    ] {
        let refused = Envelope::decode(&bytes).is_err();
        cases.push(CaseReport::compare(
            format!("envelope {name}"),
            "decode",
            "rejected",
            if refused { "rejected" } else { "accepted" },
        ));
    }

    let mut over_limit = env.clone();
    over_limit.body = "a".repeat(crate::envelope::MAX_BODY_LONG + 1);
    cases.push(CaseReport::compare(
        "envelope body over 4000 bytes",
        "validate",
        "rejected",
        if over_limit.validate().is_err() {
            "rejected"
        } else {
            "accepted"
        },
    ));

    let mut short_body = env.clone();
    short_body.kind = EnvelopeType::ReactionAdd;
    short_body.body = "a".repeat(crate::envelope::MAX_BODY_SHORT + 1);
    cases.push(CaseReport::compare(
        "reaction body over 32 bytes",
        "validate",
        "rejected",
        if short_body.validate().is_err() {
            "rejected"
        } else {
            "accepted"
        },
    ));

    // The reject cases `envelope.json` itself carries (protocol/04 "Vectors"): well-formed
    // deterministic CBOR that a conforming decoder must still refuse, each naming the error code
    // it must refuse it with. Driving them from the file rather than from a literal here is what
    // makes the TypeScript reference and this decoder answer the same question.
    for case in doc["rejects"].as_array().unwrap_or(&Vec::new()) {
        let name = case["name"].as_str().unwrap_or("?").to_owned();
        let bytes = unhex(case["cbor"].as_str().unwrap_or(""));
        let actual = match Envelope::decode(&bytes) {
            Ok(_) => "accepted",
            Err(e) => e.code(),
        };
        cases.push(CaseReport::compare(
            format!("envelope reject: {name}"),
            "decode",
            expect_str(&case["error"]),
            actual,
        ));
    }

    let mut bad_aad = env;
    bad_aad.k_f = [0x00; 32];
    cases.push(CaseReport::compare(
        "authenticated_data not 32 bytes",
        "verify_commitment",
        "rejected",
        if bad_aad.verify_commitment(&[0u8; 31]).is_err() {
            "rejected"
        } else {
            "accepted"
        },
    ));

    SuiteReport {
        name: "rejects",
        cases,
    }
}

pub fn run_all() -> VectorReport {
    VectorReport::from_suites(vec![
        run_envelope(),
        run_franking(),
        run_sframe(),
        run_identity(),
        run_rejects(),
    ])
}
