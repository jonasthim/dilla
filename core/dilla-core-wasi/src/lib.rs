//! `dilla-core-wasi` — the wasm32-wasip1 binding of `dilla-core` (interfaces §2.10, R8, R9).
//!
//! **This module exports no `_initialize`, and needs none.** facts-wazero §3.1, gap-19 §0 items 6-8
//! and interfaces §2.10 all say a `cdylib` for `wasm32-wasip1` is linked with `crt1-reactor.o` and
//! therefore exports `_initialize`; measured on rustc 1.98.1 that is false. rustc passes `--no-entry`
//! for a `cdylib` and links no crt object, so the built module's export section holds exactly the
//! dilla exports plus `memory` — 23 + 1 entries at ABI v3 (the 21 `abi_export!` lines plus
//! `dilla_alloc` and `dilla_free`), 17 + 1 when this was first measured at ABI v1 — there is no
//! start section, and `__wasm_call_ctors` does
//! not appear in the module at all. Nothing is lost: `_initialize`'s only job is `__wasm_call_ctors`,
//! and this graph registers no constructors (gap-19 §2.1), so there is no startup hook to run.
//!
//! Reproduce with `wasm-tools objdump --section export target/wasm32-wasip1/release/dilla_core_wasi.wasm`,
//! or on a box with no wasm-tools by reading section id 7 of the file directly; a
//! `strings -a … | grep -cE '^_initialize$'` over the release module answers `0`.
//!
//! Consequences for the host, which Plan B task 3 owns: `WithStartFunctions("_initialize")` names a
//! function that does not exist, and wazero *silently skips* a missing start function, so the call is
//! a no-op rather than an error — harmless here, but gap-19 item 8's "wrong target" guard
//! (`CompiledModule.ExportedFunctions()` must contain `_initialize`) would reject this correct
//! artifact, and an export-section assertion must expect the `abi_export!` names plus `memory` (23
//! plus `memory` at ABI v3; `lint_policy::every_dispatch_arm_is_exported_from_the_module` keeps that
//! list and `exports::dispatch` in step with each other), not plus
//! `_initialize`. Getting a reactor entry back would mean linking `crt1-reactor.o` by hand
//! (`-C link-arg=<sysroot>/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-reactor.o`, verified to
//! work), which needs a toolchain-absolute path in `[target.wasm32-wasip1] rustflags` — exactly what
//! `core/dilla-core/tests/workspace_policy.rs` forbids (D6, R7).
//!
//! `handles` is declared in step 8, `exports` in step 10 and `shims` in step 13 — each alongside the
//! file it names, so the crate compiles after every step except the two deliberate red ones.

pub mod abi;
pub mod exports;
pub mod handles;
mod private_message;

/// The C-shaped exports. Only built for wasm: the ABI's `u32` pointers are the linear-memory
/// addresses of a 32-bit target and have no meaning on a 64-bit host. Native `cargo test` drives
/// the same request and response encoders through [`exports::dispatch`], and Plan B task 3 asserts
/// the built module's export section under wazero.
///
/// Every pointer/integer conversion below goes through `usize`. rustc rejects a direct
/// `*mut u8 as u32` (E0606, "casting `*mut u8` as `u32` is invalid; cast through `usize` first"),
/// and the two-step form is sound here only because `usize == u32` on both wasm32 targets — which is
/// the ABI's premise anyway, since the host addresses this memory with 32-bit offsets.
#[cfg(target_family = "wasm")]
mod shims {
    // The one place in the workspace that may write `unsafe`: the plan's Global Constraints allow
    // `core/dilla-core-wasi` to opt back out of the workspace's `unsafe_code = "warn"` "for its
    // `extern "C"` exports", and this module is those exports. The attribute is deliberately inside
    // the module, not at the crate root, so `abi`, `handles` and `exports` stay covered.
    #![allow(unsafe_code)]

    use core::mem::MaybeUninit;

    use crate::abi::pack;
    use crate::exports::dispatch;

    /// Allocates `size` uninitialised bytes and returns their address (gap-16 §6 item 1).
    #[unsafe(export_name = "dilla_alloc")]
    pub unsafe extern "C" fn dilla_alloc(size: u32) -> u32 {
        let buf: Vec<MaybeUninit<u8>> = vec![MaybeUninit::uninit(); size as usize];
        Box::into_raw(buf.into_boxed_slice()) as *mut u8 as usize as u32
    }

    /// Frees a buffer previously returned by `dilla_alloc` or by any export's response pointer.
    ///
    /// # Safety
    /// `ptr` must be an address this module returned, with the same `size`, freed at most once.
    #[unsafe(export_name = "dilla_free")]
    pub unsafe extern "C" fn dilla_free(ptr: u32, size: u32) {
        if ptr == 0 {
            return;
        }
        unsafe {
            drop(Vec::from_raw_parts(
                ptr as usize as *mut u8,
                0,
                size as usize,
            ))
        }
    }

    /// Moves a response into linear memory and packs its address and length.
    fn emit(bytes: Vec<u8>) -> u64 {
        let len = bytes.len() as u32;
        // into_boxed_slice() makes capacity == len, which is what dilla_free assumes.
        let boxed = bytes.into_boxed_slice();
        let ptr = Box::into_raw(boxed) as *mut u8 as usize as u32;
        pack(ptr, len)
    }

    /// Borrows the host's request bytes, or `None` if `(ptr, len)` does not name a region inside
    /// this module's linear memory.
    ///
    /// The bound is not decoration. `ptr + len` can wrap the 32-bit address space, and the pair
    /// can name bytes past the end of the memory the module has grown; either one builds a slice
    /// over addresses the module does not own, which is undefined behaviour before any dilla code
    /// has read a byte. `memory_size(0)` is the current size in 64 KiB pages, so the limit is
    /// computed in `u64` — a 65 536-page (4 GiB) memory would overflow the `usize` the pages are
    /// counted in.
    ///
    /// # Safety
    /// `ptr`/`len` must address a readable region the host wrote with `dilla_alloc`. This function
    /// checks that the region is inside linear memory; it cannot check that the host initialised
    /// it or that it is not concurrently freed.
    unsafe fn request<'a>(ptr: u32, len: u32) -> Option<&'a [u8]> {
        if len == 0 {
            return Some(&[]);
        }
        let memory_bytes = core::arch::wasm32::memory_size(0) as u64 * 65536;
        if !crate::abi::request_in_range(ptr, len, memory_bytes) {
            return None;
        }
        Some(unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) })
    }

    macro_rules! abi_export {
        ($name:ident) => {
            /// # Safety
            /// See [`request`]; the response must be released with `dilla_free`.
            #[unsafe(export_name = stringify!($name))]
            pub unsafe extern "C" fn $name(ptr: u32, len: u32) -> u64 {
                match unsafe { request(ptr, len) } {
                    Some(req) => emit(dispatch(stringify!($name), req)),
                    // An ordinary failure frame, not a trap: a host that miscomputed a pointer
                    // gets an answer it can log and recover from, and the module stays usable.
                    // The detail names the pair, which is host-supplied and not a secret.
                    None => emit(crate::abi::error_response(&crate::abi::AbiError::shape(
                        format!("request ({ptr}, {len}) is outside linear memory"),
                    ))),
                }
            }
        };
    }

    abi_export!(dilla_abi);
    abi_export!(vectors_check);
    abi_export!(public_group_create);
    abi_export!(public_group_import_state);
    abi_export!(public_group_export_state);
    abi_export!(public_group_close);
    abi_export!(public_group_process);
    abi_export!(public_group_merge);
    abi_export!(public_group_staged_discard);
    abi_export!(public_group_tree);
    abi_export!(public_group_state);
    abi_export!(public_group_proposal_put);
    abi_export!(public_group_proposal_list);
    abi_export!(public_group_group_info_validate);
    abi_export!(public_group_staged_group_info_validate);
    abi_export!(public_group_proposal_inspect);
    abi_export!(private_message_aad);
    abi_export!(validate_key_package);
    abi_export!(external_propose_add);
    abi_export!(external_propose_remove);
    abi_export!(device_list_entries);
}

/// The plan's Global Constraints say `dilla-core` is `#![forbid(unsafe_code)]` and that "only
/// `core/dilla-core-wasi` opts back in, for its `extern "C"` exports". Both halves of that are
/// manifest-and-source policy no compiler states on its own: the workspace's
/// `unsafe_code = "warn"` only reaches this crate if the manifest joins `[lints] workspace = true`,
/// and the opt-out is only *confined* if it sits inside `shims` rather than at the crate root.
#[cfg(test)]
mod lint_policy {
    const MANIFEST: &str = include_str!("../Cargo.toml");
    const SOURCE: &str = include_str!("lib.rs");

    #[test]
    fn the_manifest_joins_the_workspace_lint_table() {
        let code: Vec<&str> = MANIFEST
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect();
        assert!(
            code.windows(2)
                .any(|pair| pair[0] == "[lints]" && pair[1] == "workspace = true"),
            "core/dilla-core-wasi/Cargo.toml must carry `[lints]` + `workspace = true`: without it \
             the workspace's `unsafe_code = \"warn\"` is inert in the one crate that writes `unsafe`"
        );
    }

    #[test]
    fn the_unsafe_opt_in_is_confined_to_the_shims_module() {
        // Spelled in two pieces so the needle never matches this test's own source text.
        let opt_in = concat!("#!", "[allow(unsafe_code)]");
        assert_eq!(
            SOURCE.matches(opt_in).count(),
            1,
            "exactly one `unsafe_code` opt-in belongs in this crate"
        );
        let shims = SOURCE.find("mod shims {").expect("the shims module");
        let allow = SOURCE
            .find(opt_in)
            .expect("`mod shims` must opt back into unsafe_code explicitly");
        assert!(
            allow > shims,
            "the opt-in must sit inside `mod shims`, not at the crate root"
        );
    }

    /// Every arm of `exports::dispatch` must also be an `abi_export!` line here. `dispatch` is an
    /// internal router the native test build calls directly; the *wasm export section* is what the
    /// host calls by name, and only `abi_export!` writes to it. A name added to one and not the
    /// other is invisible in `cargo test` and missing from the shipped module —
    /// `public_group_staged_discard` shipped exactly that way once, so this test exists.
    #[test]
    fn every_dispatch_arm_is_exported_from_the_module() {
        const EXPORTS: &str = include_str!("exports.rs");
        let router = EXPORTS
            .split_once("pub fn dispatch(")
            .expect("exports.rs must declare `pub fn dispatch`")
            .1
            .split_once("other =>")
            .expect("the dispatch match must end in a catch-all arm")
            .0;
        let names: Vec<&str> = router
            .lines()
            .filter_map(|line| {
                let (name, tail) = line.trim().strip_prefix('"')?.split_once('"')?;
                tail.trim_start().starts_with("=>").then_some(name)
            })
            .collect();
        assert!(
            names.len() >= 16,
            "the dispatch match parsed as {names:?}, which cannot be right"
        );
        for name in names {
            assert!(
                SOURCE.contains(&format!("abi_export!({name});")),
                "`{name}` is a `dispatch` arm with no `abi_export!({name});` in lib.rs: the \
                 compiled module would not export it and no host could ever call it"
            );
        }
    }
}
