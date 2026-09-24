//! `dilla-core-wasi` — the wasm32-wasip1 binding of `dilla-core` (interfaces §2.10, R8, R9).
//!
//! `_initialize` is NOT declared here: it comes from `crt1-reactor.o` and traps if called twice
//! (gap-19 §0 items 6-8). The host calls it exactly once through
//! `wazero.NewModuleConfig().WithStartFunctions("_initialize")`.
//!
//! `handles` is declared in step 8, `exports` in step 10 and `shims` in step 13 — each alongside the
//! file it names, so the crate compiles after every step except the two deliberate red ones.

pub mod abi;
pub mod exports;
pub mod handles;

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

    /// # Safety
    /// `ptr`/`len` must address a readable region the host wrote with `dilla_alloc`.
    unsafe fn request<'a>(ptr: u32, len: u32) -> &'a [u8] {
        if len == 0 {
            return &[];
        }
        unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) }
    }

    macro_rules! abi_export {
        ($name:ident) => {
            /// # Safety
            /// See [`request`]; the response must be released with `dilla_free`.
            #[unsafe(export_name = stringify!($name))]
            pub unsafe extern "C" fn $name(ptr: u32, len: u32) -> u64 {
                let req = unsafe { request(ptr, len) };
                emit(dispatch(stringify!($name), req))
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
    abi_export!(public_group_tree);
    abi_export!(public_group_state);
    abi_export!(public_group_proposal_put);
    abi_export!(public_group_proposal_list);
    abi_export!(validate_key_package);
    abi_export!(external_propose_add);
    abi_export!(external_propose_remove);
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
}
