//! Workspace-level policy that the compiler cannot enforce on its own.

const CARGO_CONFIG: &str = include_str!("../../../.cargo/config.toml");

#[test]
fn cargo_config_sets_no_rustflags() {
    for (n, line) in CARGO_CONFIG.lines().enumerate() {
        let code = line.split('#').next().unwrap_or("").trim();
        assert!(
            !code.starts_with("rustflags"),
            ".cargo/config.toml line {} sets rustflags; \
             getrandom >= 0.3.4 selects its backend from the `wasm_js` crate feature and a \
             workflow-level RUSTFLAGS would override this table outright",
            n + 1
        );
    }
}

#[test]
fn cargo_config_pins_the_node_runner_for_wasm32_unknown_unknown() {
    assert!(CARGO_CONFIG.contains("[target.wasm32-unknown-unknown]"));
    assert!(CARGO_CONFIG.contains("runner = \"wasm-bindgen-test-runner\""));
}

#[test]
fn cargo_config_pins_no_wasip1_runner() {
    // The wasip1 vector check runs under wazero from Go, not under wasmtime (D6, R7).
    assert!(!CARGO_CONFIG.contains("[target.wasm32-wasip1]"));
}

#[test]
fn version_constants_are_the_wire_values() {
    assert_eq!(dilla_core::E2EE_VERSION, 1);
    assert_eq!(dilla_core::MEDIA_VERSION, 1);
    assert_eq!(dilla_core::WIRE_VERSION, 1);
    // 2 since 2026-09-24: `public_group_process` grew the applied-proposal list and
    // `committer_updated`, and `validate_key_package` grows `kp_ref`. The wasi ABI is internal to
    // dillad's host, so it moves on a response-shape change while the wire versions stay at 1.
    assert_eq!(dilla_core::ABI_VERSION, 2);
    assert_eq!(dilla_core::CORE_VERSION, "0.1.0");
}
