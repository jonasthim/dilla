//! Request and response framing for the dilla wasi ABI (interfaces §2.10, R8, gap-16 §5).
//!
//! Every export takes `(ptr, len)` addressing one deterministic-CBOR request and returns
//! `(ptr << 32) | len` addressing one deterministic-CBOR response the caller frees with
//! `dilla_free`. A success response is `[0, …]`; a failure response is `[1, code, detail]`.
//! No panic, no `Result` and no OpenMLS error type crosses the boundary.
//!
//! NV-1/NV-2/NV-3/NV-11 were resolved against the **vendored crate sources** in
//! `~/.cargo/registry/src/index.crates.io-*/` rather than docs.rs (this box has no network);
//! the signatures below are copied from those files verbatim.
//!
//! * NV-1 — `tls_codec-0.5.0/src/lib.rs:311`
//!   `pub trait Deserialize: Size { fn tls_deserialize_exact(bytes: impl AsRef<[u8]>) -> Result<Self, Error> }`,
//!   whose default body returns `Err(Error::TrailingData)` when the input is not fully consumed.
//!   The `DeserializeBytes` sibling is `tls_deserialize_exact_bytes(bytes: &[u8])` (line 345).
//!   `MlsMessageIn` implements **both** by hand (`openmls-0.9.0/src/framing/codec.rs:36` and `:61`);
//!   `RatchetTreeIn` derives `TlsDeserialize, TlsDeserializeBytes`
//!   (`openmls-0.9.0/src/treesync/mod.rs:239-250`). `GroupInfo` derives **neither** outside
//!   `feature = "test-utils"` (`openmls-0.9.0/src/messages/group_info.rs:172-174`), which is why a
//!   GroupInfo only ever crosses this ABI wrapped in an `MLSMessage`.
//! * NV-2 — `protocol/02-delivery-service.md` §API: `POST /v1/groups/{id}/commit` takes
//!   `{epoch, commit, group_info, welcomes}` and `GET /v1/groups/{id}/info` answers
//!   `{epoch, group_info, tree_hash, seq}`. The DS stores what the committer uploaded and serves it
//!   back unchanged, so a GroupInfo leaves this module in the same `MLSMessage` framing it arrives
//!   in — never bare.
//! * NV-3 — `GroupId::from_slice(bytes: &[u8]) -> Self` / `GroupId::as_slice(&self) -> &[u8]`
//!   (`openmls-0.9.0/src/group/mod.rs:82,89`); `impl From<u64> for GroupEpoch`
//!   (`.../src/group/mod.rs:131`); `LeafNodeIndex::new(index: u32) -> Self`
//!   (`.../src/binary_tree/array_representation/treemath.rs:47`);
//!   `KeyPackage::leaf_node(&self) -> &LeafNode`, `KeyPackage::last_resort(&self) -> bool` and
//!   `KeyPackage::life_time(&self) -> &Lifetime` (`.../src/key_packages/mod.rs:477,487,492`) —
//!   note that `LeafNode::life_time()` is `pub(crate)` (`.../src/treesync/node/leaf_node.rs:473`),
//!   so the lifetime is read off the `KeyPackage`, not off the leaf;
//!   `Lifetime::not_after(&self) -> u64` (`.../src/key_packages/lifetime.rs:125`);
//!   `LeafNode::credential(&self) -> &Credential` (`.../src/treesync/node/leaf_node.rs:459`);
//!   `impl TryFrom<Credential> for BasicCredential` (`.../src/credentials/mod.rs:312`) and
//!   `BasicCredential::identity(&self) -> &[u8]` (`.../src/credentials/mod.rs:298`), both in
//!   **`openmls::credentials`** — `openmls_basic_credential 0.6.0` exports only `SignatureKeyPair`.
//! * NV-3b — `ProposalRef` is `pub type ProposalRef = HashReference`
//!   (`.../src/ciphersuite/hash_ref.rs:66`) with `HashReference::as_slice(&self) -> &[u8]`
//!   (`:114`). `QueuedProposal::proposal(&self) -> &Proposal`
//!   (`.../src/group/mls_group/proposal_store.rs:169`) exists, but nothing here calls it: a bare
//!   `Proposal` is never serialised across this ABI (deviation A2-11).
//! * NV-3c — `SignatureKeyPair::from_raw(signature_scheme, private: Vec<u8>, public: Vec<u8>)`
//!   stores `private` verbatim (`openmls_basic_credential-0.6.0/src/lib.rs:203`), and
//!   `OpenMlsCrypto::sign`'s ED25519 arm is
//!   `ed25519_dalek::SigningKey::try_from(key)` (`openmls_rust_crypto-0.6.0/src/provider.rs:472`),
//!   which takes the **32-byte seed**. So `from_raw`'s private half is the seed, not seed‖public.
//! * NV-11 — `impl From<GroupInfo> for MlsMessageOut`
//!   (`openmls-0.9.0/src/framing/message_out.rs:85`) is the public route from a `GroupInfo` to
//!   bytes; `MlsMessageOut` derives `TlsSerialize, TlsSize` (`:24`).
//! * NV-4 — resolved by controller ruling: `DillaPublicGroup::queue_proposal` and
//!   `queued_proposals()` are declared by Plan A task 11 and are in the tree
//!   (`core/dilla-core/src/public_group/state.rs:260,308`).

use dilla_core::cbor::{CborError, Decoder, Encoder};

/// ABI-local error codes. Everything else is a `protocol/*.md` `E_*` string.
pub const E_ABI_VERSION: &str = "E_ABI_VERSION";
pub const E_ABI_SHAPE: &str = "E_ABI_SHAPE";
pub const E_ABI_HANDLE: &str = "E_ABI_HANDLE";
pub const E_ABI_STATE: &str = "E_ABI_STATE";

/// One failure frame's payload. Never carries a Rust type across the boundary.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AbiError {
    pub code: String,
    pub detail: String,
}

impl AbiError {
    pub fn new(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            detail: detail.into(),
        }
    }
    pub fn shape(detail: impl Into<String>) -> Self {
        Self::new(E_ABI_SHAPE, detail)
    }
    pub fn handle(detail: impl Into<String>) -> Self {
        Self::new(E_ABI_HANDLE, detail)
    }
    pub fn state(detail: impl Into<String>) -> Self {
        Self::new(E_ABI_STATE, detail)
    }
}

impl From<CborError> for AbiError {
    fn from(e: CborError) -> Self {
        Self::shape(e.to_string())
    }
}

impl From<dilla_core::ProtocolError> for AbiError {
    fn from(e: dilla_core::ProtocolError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<dilla_core::public_group::PublicStoreError> for AbiError {
    fn from(e: dilla_core::public_group::PublicStoreError) -> Self {
        Self::new(E_ABI_STATE, e.to_string())
    }
}

impl From<dilla_core::public_group::PublicGroupError> for AbiError {
    fn from(e: dilla_core::public_group::PublicGroupError) -> Self {
        use dilla_core::public_group::PublicGroupError as E;
        match e {
            E::Protocol(p) => AbiError::from(p),
            E::Store(s) => AbiError::from(s),
            E::OpenMls(detail) => AbiError::new(E_ABI_STATE, detail),
            E::StateMissing => AbiError::new(E_ABI_STATE, "public group state is absent or torn"),
            // `PublicGroupError` is `#[non_exhaustive]`, so the match needs an arm for whatever a
            // later task adds. It is deliberately the same shape as `OpenMls`: a state-level
            // rejection whose text is the error's own Display.
            other => AbiError::new(E_ABI_STATE, other.to_string()),
        }
    }
}

/// Packs a response into the single WebAssembly 1.0 return value (gap-16 §0 item 5).
pub const fn pack(ptr: u32, len: u32) -> u64 {
    ((ptr as u64) << 32) | (len as u64)
}

/// Inverse of [`pack`]; used by the tests and by any host written in Rust.
pub const fn unpack(v: u64) -> (u32, u32) {
    ((v >> 32) as u32, (v & 0xffff_ffff) as u32)
}

/// Opens a request: asserts the fixed array length and that element 0 is `ABI_VERSION`.
/// Returns a decoder positioned on element 1.
pub fn open(req: &[u8], len: usize) -> Result<Decoder<'_>, AbiError> {
    let mut d = Decoder::new(req);
    d.array(len)?;
    let v = d.uint()?;
    if v != dilla_core::ABI_VERSION {
        return Err(AbiError::new(
            E_ABI_VERSION,
            format!(
                "abi_version {v}, this module speaks {}",
                dilla_core::ABI_VERSION
            ),
        ));
    }
    Ok(d)
}

/// `[1, code, detail]`.
pub fn error_response(err: &AbiError) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(3).uint(1).text(&err.code).text(&err.detail);
    e.into_vec()
}

/// Whether the `(ptr, len)` pair a host handed an export addresses bytes that are actually inside
/// this module's linear memory.
///
/// The exports take the pair on trust and turn it into a `&[u8]`. Two things can go wrong and
/// neither is caught by the type system: `ptr + len` can wrap the 32-bit address space, and the
/// pair can name a region past the end of the memory the module has grown. Either builds a slice
/// over addresses the module does not own, which is undefined behaviour before any dilla code has
/// looked at a single byte.
///
/// Split out of `shims::request` so it is testable natively: `shims` is `cfg(target_family =
/// "wasm")` and its only caller is an `extern "C"` export, so nothing on the host can reach the
/// arithmetic otherwise. `memory_bytes` is the caller's `memory_size(0) * 65536`.
pub fn request_in_range(ptr: u32, len: u32, memory_bytes: u64) -> bool {
    // An empty request never dereferences its pointer, so the pointer is not checked: `request`
    // hands back `&[]` without touching it, and a host that passes a stale `ptr` with `len == 0`
    // is doing nothing wrong.
    if len == 0 {
        return true;
    }
    match ptr.checked_add(len) {
        // Wraps the address space: `ptr as usize + len as usize` would silently produce a shorter
        // region starting at a high address.
        None => false,
        Some(end) => u64::from(end) <= memory_bytes,
    }
}

/// Reads a `u32` handle out of a request, rejecting anything that does not fit.
pub fn read_handle(d: &mut Decoder<'_>) -> Result<u32, AbiError> {
    let v = d.uint()?;
    u32::try_from(v).map_err(|_| AbiError::handle(format!("handle {v} does not fit in u32")))
}

/// TLS-codec conversions between the ABI's byte strings and OpenMLS types.
///
/// The method names below are the ones resolved in step 1 (NV-1); `group_info_out`'s shape is the
/// NV-2 answer and its mechanism the NV-11 answer. Nothing outside this module names a `tls_codec`
/// trait.
pub mod tls {
    use super::AbiError;
    // `GroupInfo` and `VerifiableGroupInfo` are NOT re-exported by `openmls::prelude` in 0.9.0
    // (the prelude re-exports `crate::messages::{external_proposals, proposals, proposals_in}` and
    // `messages`'s own items, but nothing from `messages::group_info`), and neither is
    // `treesync::RatchetTree` — only `RatchetTreeIn`.
    use openmls::messages::group_info::{GroupInfo, VerifiableGroupInfo};
    use openmls::prelude::*;
    use openmls::treesync::RatchetTree;
    use tls_codec::Serialize as _;

    fn bad(what: &str, e: impl core::fmt::Display) -> AbiError {
        AbiError::shape(format!("{what}: {e}"))
    }

    pub fn mls_message_in(bytes: &[u8]) -> Result<MlsMessageIn, AbiError> {
        <MlsMessageIn as tls_codec::Deserialize>::tls_deserialize_exact(bytes)
            .map_err(|e| bad("MLSMessage", e))
    }

    pub fn ratchet_tree_in(bytes: &[u8]) -> Result<RatchetTreeIn, AbiError> {
        <RatchetTreeIn as tls_codec::Deserialize>::tls_deserialize_exact(bytes)
            .map_err(|e| bad("ratchet_tree", e))
    }

    pub fn verifiable_group_info(bytes: &[u8]) -> Result<VerifiableGroupInfo, AbiError> {
        match mls_message_in(bytes)?.extract() {
            MlsMessageBodyIn::GroupInfo(gi) => Ok(gi),
            _ => Err(AbiError::shape(
                "expected an MLSMessage carrying a GroupInfo",
            )),
        }
    }

    pub fn key_package_in(bytes: &[u8]) -> Result<KeyPackageIn, AbiError> {
        match mls_message_in(bytes)?.extract() {
            MlsMessageBodyIn::KeyPackage(kp) => Ok(kp),
            _ => Err(AbiError::shape(
                "expected an MLSMessage carrying a KeyPackage",
            )),
        }
    }

    pub fn protocol_message(bytes: &[u8]) -> Result<ProtocolMessage, AbiError> {
        mls_message_in(bytes)?
            .try_into_protocol_message()
            .map_err(|e| bad("not a handshake or application message", e))
    }

    pub fn message_out(msg: &MlsMessageOut) -> Result<Vec<u8>, AbiError> {
        msg.tls_serialize_detached()
            .map_err(|e| bad("MLSMessage out", e))
    }

    pub fn ratchet_tree_out(tree: &RatchetTree) -> Result<Vec<u8>, AbiError> {
        tree.tls_serialize_detached()
            .map_err(|e| bad("ratchet_tree out", e))
    }

    /// NV-2 settles the framing: the DS stores what the committer uploaded, so a GroupInfo leaves
    /// this module in the same framing `protocol/02-delivery-service.md` names for
    /// `POST /v1/groups/{id}/commit`.
    ///
    /// NV-11 settles the *mechanism*: `GroupInfo` derives `TlsSize, SerdeSerialize,
    /// SerdeDeserialize` and nothing else, so `gi.tls_serialize_detached()` does not exist; the
    /// public route found in the vendored source is
    /// `impl From<GroupInfo> for MlsMessageOut` (`openmls-0.9.0/src/framing/message_out.rs:85`).
    pub fn group_info_out(gi: &GroupInfo) -> Result<Vec<u8>, AbiError> {
        MlsMessageOut::from(gi.clone())
            .tls_serialize_detached()
            .map_err(|e| bad("GroupInfo out", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_and_unpack_round_trip() {
        assert_eq!(unpack(pack(0x0001_0000, 42)), (0x0001_0000, 42));
        assert_eq!(unpack(pack(u32::MAX, u32::MAX)), (u32::MAX, u32::MAX));
        assert_eq!(pack(1, 2), (1u64 << 32) | 2);
        assert_eq!(unpack(0), (0, 0));
    }

    /// One 64 KiB page is the smallest memory a module can have; the bound is `<=` because a
    /// request may end exactly at the last byte.
    #[test]
    fn a_request_outside_linear_memory_is_refused() {
        const PAGE: u64 = 65536;

        assert!(request_in_range(0, 0, PAGE));
        assert!(request_in_range(0, 65536, PAGE), "may end at the last byte");
        assert!(request_in_range(65535, 1, PAGE));
        assert!(!request_in_range(0, 65537, PAGE), "one byte past the end");
        assert!(!request_in_range(65536, 1, PAGE));
        assert!(!request_in_range(65535, 2, PAGE));

        // Wrap-around: `ptr + len` overflows u32, so the pair names no region at all. Both halves
        // are individually plausible, which is exactly why the addition has to be checked.
        assert!(!request_in_range(u32::MAX, 1, u64::from(u32::MAX) + 1));
        assert!(!request_in_range(0xffff_0000, 0x0001_0001, u64::MAX));

        // A zero-length request is always in range, whatever the pointer: `request` returns the
        // empty slice without dereferencing it.
        assert!(request_in_range(0xdead_beef, 0, 0));
    }

    #[test]
    fn open_rejects_a_wrong_abi_version() {
        // [7]  — one-element array whose version element is 7, not 1.
        let req = [0x81u8, 0x07];
        // `.err().unwrap()`, not `.unwrap_err()`: `Decoder` is deliberately not `Debug` (it would
        // print a request body into a panic message), and `unwrap_err` requires `T: Debug`.
        let err = open(&req, 1).err().unwrap();
        assert_eq!(err.code, E_ABI_VERSION);
        assert!(
            err.detail.contains('7'),
            "detail must name the offending version: {}",
            err.detail
        );
    }

    #[test]
    fn open_rejects_a_wrong_array_length() {
        // [1] offered where a three-element request is required.
        let req = [0x81u8, 0x01];
        assert_eq!(open(&req, 3).err().unwrap().code, E_ABI_SHAPE);
    }

    #[test]
    fn open_accepts_the_current_version_and_leaves_the_cursor_after_it() {
        // [1, 9]
        let req = [0x82u8, 0x01, 0x09];
        let mut d = open(&req, 2).unwrap();
        assert_eq!(d.uint().unwrap(), 9);
        d.finish().unwrap();
    }

    #[test]
    fn error_response_is_the_three_element_failure_frame() {
        let err = AbiError::new(E_ABI_HANDLE, "handle 4");
        // [1, "E_ABI_HANDLE", "handle 4"]
        let expected = {
            let mut e = dilla_core::cbor::Encoder::new();
            e.array(3).uint(1).text("E_ABI_HANDLE").text("handle 4");
            e.into_vec()
        };
        assert_eq!(error_response(&err), expected);
    }

    #[test]
    fn a_protocol_error_keeps_its_stable_code() {
        let err = AbiError::from(dilla_core::ProtocolError::Binding);
        assert_eq!(err.code, "E_BINDING");
    }
}
