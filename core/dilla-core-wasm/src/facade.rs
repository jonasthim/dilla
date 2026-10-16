//! The wasm-bindgen face of ClientCore. This owns one core; pause drops it and resume rebuilds it.
//! Results cross unchanged as bytes, with no decoding here.

use std::cell::{Cell, RefCell, RefMut};

use dilla_core::client::{ClientCore, ClientError};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::store::{StoreHandle, StoreOpenConfig, store_open};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Open,
    Paused,
    Resuming,
    Detached,
}

const E_PAUSED: &str = "E_STORE_PAUSED: the store is paused";
const E_NOT_OPEN: &str = "E_CORE_STATE: the core is not open";
const E_RESUMING: &str = "E_CORE_STATE: resume in progress";
const E_BUSY: &str = "E_CORE_STATE: the core is busy";

#[doc(hidden)]
pub fn fixed_arg<const N: usize>(name: &'static str, bytes: &[u8]) -> Result<[u8; N], ClientError> {
    <[u8; N]>::try_from(bytes).map_err(|_| ClientError {
        code: "E_CORE_INPUT",
        detail: format!("{name}: expected {N} bytes, got {}", bytes.len()),
    })
}

#[doc(hidden)]
pub fn purpose_arg(n: u32) -> Result<u8, ClientError> {
    match n {
        0 | 1 => Ok(n as u8),
        _ => Err(ClientError {
            code: "E_CORE_INPUT",
            detail: format!("purpose: {n} is not 0 or 1"),
        }),
    }
}

#[doc(hidden)]
pub fn community_arg(bytes: Option<&[u8]>) -> Result<Option<[u8; 16]>, ClientError> {
    bytes
        .map(|b| fixed_arg::<16>("community_id", b))
        .transpose()
}

#[doc(hidden)]
pub fn login_arg(bytes: &[u8]) -> Result<(), ClientError> {
    if (1..=256).contains(&bytes.len()) {
        Ok(())
    } else {
        Err(ClientError {
            code: "E_CORE_INPUT",
            detail: format!("login: expected 1..=256 bytes, got {}", bytes.len()),
        })
    }
}

#[doc(hidden)]
pub fn role_ids_arg(bytes: &[u8]) -> Result<(), ClientError> {
    if bytes.len().is_multiple_of(16) && bytes.len() <= 1024 {
        Ok(())
    } else {
        Err(ClientError {
            code: "E_CORE_INPUT",
            detail: format!(
                "role_ids: expected 0..=64 ids of 16 bytes, got {} bytes",
                bytes.len()
            ),
        })
    }
}

#[doc(hidden)]
pub fn authority_ids_arg(name: &'static str, bytes: &[u8]) -> Result<(), ClientError> {
    if bytes.len().is_multiple_of(16) && bytes.len() <= 4096 * 16 {
        Ok(())
    } else {
        Err(ClientError {
            code: "E_CORE_INPUT",
            detail: format!(
                "{name}: expected 0..=4096 ids of 16 bytes, got {} bytes",
                bytes.len()
            ),
        })
    }
}

#[doc(hidden)]
pub fn client_js_error(e: &ClientError) -> JsError {
    JsError::new(&e.to_string())
}

/// The media epoch's CBOR (it carries the epoch's `base_key`) as a JavaScript-owned copy, made
/// straight from `bytes`, which is then zero-filled in place. A `Box<[u8]>` return would leave
/// wasm-bindgen's copy in freed linear memory un-zeroed; this leaves none (L-WASM-34).
#[doc(hidden)]
pub fn media_epoch_out(bytes: &mut [u8]) -> js_sys::Uint8Array {
    let out = js_sys::Uint8Array::from(&bytes[..]);
    zeroize::Zeroize::zeroize(bytes);
    out
}

/// `fixed_arg` with its refusal mapped by `client_js_error`, out of line so that each export carries
/// one call instead of its own copy of the mapping (wasm size).
#[inline(never)]
fn js_fixed_arg<const N: usize>(name: &'static str, bytes: &[u8]) -> Result<[u8; N], JsError> {
    fixed_arg::<N>(name, bytes).map_err(owned_js_error)
}

/// `client_js_error` for an owned error, which it drops: out of line so that each export carries
/// one call instead of its own copy of the drop (wasm size).
#[inline(never)]
fn owned_js_error(e: ClientError) -> JsError {
    client_js_error(&e)
}

/// Opens the store and constructs its sole ClientCore owner.
#[wasm_bindgen]
pub async fn core_open(cfg: StoreOpenConfig) -> Result<CoreHandle, JsValue> {
    let store = store_open(cfg).await?;
    let conn = store.share().map_err(JsValue::from)?;
    match ClientCore::open(conn) {
        Ok(core) => Ok(CoreHandle {
            store,
            core: RefCell::new(Some(core)),
            phase: Cell::new(Phase::Open),
        }),
        Err(e) => {
            store.close().map_err(JsValue::from)?;
            Err(JsValue::from(js_sys::Error::new(&e.to_string())))
        }
    }
}

#[wasm_bindgen]
pub struct CoreHandle {
    store: StoreHandle,
    core: RefCell<Option<ClientCore>>,
    phase: Cell<Phase>,
}

impl CoreHandle {
    fn with_core<T>(
        &self,
        f: impl FnOnce(&mut ClientCore) -> Result<T, ClientError>,
    ) -> Result<T, JsError> {
        let mut core = self.core_mut()?;
        f(&mut core).map_err(owned_js_error)
    }

    /// The phase and borrow checks of `with_core`, out of line so that each export carries one call
    /// instead of its own copy (wasm size).
    #[inline(never)]
    fn core_mut(&self) -> Result<RefMut<'_, ClientCore>, JsError> {
        match self.phase.get() {
            Phase::Paused | Phase::Resuming => return Err(JsError::new(E_PAUSED)),
            Phase::Detached => return Err(JsError::new(E_NOT_OPEN)),
            Phase::Open => {}
        }
        let holder = self
            .core
            .try_borrow_mut()
            .map_err(|_| JsError::new(E_BUSY))?;
        RefMut::filter_map(holder, Option::as_mut).map_err(|_| JsError::new(E_NOT_OPEN))
    }

    fn reopen(&self) -> Result<(), ClientError> {
        let conn = self.store.share().map_err(|_| {
            self.phase.set(Phase::Detached);
            ClientError {
                code: "E_CORE_STATE",
                detail: "the store has no connection".into(),
            }
        })?;
        match ClientCore::open(conn) {
            Ok(core) => {
                *self.core.borrow_mut() = Some(core);
                self.phase.set(Phase::Open);
                Ok(())
            }
            Err(e) => {
                self.phase.set(Phase::Detached);
                Err(e)
            }
        }
    }
}

#[wasm_bindgen]
impl CoreHandle {
    /// Returns the store's capacity.
    pub fn capacity(&self) -> u32 {
        self.store.capacity()
    }
    /// Test build only: leave a real encrypted v3 store for the next open.
    #[cfg(feature = "test-hooks")]
    pub fn test_downgrade_to_v3_and_force_no_fts(&self) -> Result<(), JsError> {
        self.store.test_downgrade_v3()?;
        dilla_core::client::test_force_missing_fts5(true);
        Ok(())
    }
    /// Test build only: [schema, FTS5 capability].
    #[cfg(feature = "test-hooks")]
    pub fn test_schema_capability(&self) -> Result<Box<[u8]>, JsError> {
        self.store.test_schema_capability()
    }
    #[cfg(feature = "test-hooks")]
    pub fn test_schema_inventory(&self) -> Result<Box<[u8]>, JsError> {
        self.store.test_schema_inventory()
    }
    /// Reserves capacity in the store.
    pub async fn reserve_capacity(&self, n: u32) -> Result<(), JsError> {
        self.store.reserve_capacity(n).await
    }
    /// Drops the core before pausing the store.
    pub fn pause(&self) -> Result<(), JsError> {
        match self.phase.get() {
            Phase::Paused => Ok(()),
            Phase::Resuming => Err(JsError::new(E_RESUMING)),
            Phase::Open => {
                drop(self.core.borrow_mut().take());
                match self.store.pause() {
                    Ok(()) => {
                        self.phase.set(Phase::Paused);
                        Ok(())
                    }
                    Err(e) => {
                        if self.store.share().is_ok() {
                            let _ = self.reopen();
                        } else {
                            self.phase.set(Phase::Paused);
                        }
                        Err(e)
                    }
                }
            }
            Phase::Detached => match self.store.pause() {
                Ok(()) => {
                    self.phase.set(Phase::Paused);
                    Ok(())
                }
                Err(e) => Err(e),
            },
        }
    }
    /// Resumes the store and rebuilds the core.
    pub async fn resume(&self) -> Result<(), JsError> {
        match self.phase.get() {
            Phase::Open => Ok(()),
            Phase::Resuming => Err(JsError::new(E_RESUMING)),
            Phase::Detached => self.reopen().map_err(owned_js_error),
            Phase::Paused => {
                self.phase.set(Phase::Resuming);
                if let Err(e) = self.store.resume().await {
                    self.phase.set(Phase::Paused);
                    return Err(e);
                }
                self.reopen().map_err(owned_js_error)
            }
        }
    }
    /// Drops the core, then closes the store.
    pub fn close(self) -> Result<(), JsError> {
        let CoreHandle {
            store,
            core,
            phase: _,
        } = self;
        drop(core);
        store.close()
    }
    /// Calls ClientCore::identity; CBOR [phase, instance_id, user_id, device_id, username, list_published].
    pub fn identity(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.identity()).map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::signup_begin.
    pub fn signup_begin(&self, instance_id: &[u8]) -> Result<String, JsError> {
        let instance_id = js_fixed_arg::<16>("instance_id", instance_id)?;
        self.with_core(|c| c.signup_begin(&instance_id))
    }
    /// Calls ClientCore::signup_request; CBOR [invite, username, display, umk_pub, ssk_pub, sig_umk_ssk, password, device].
    pub fn signup_request(
        &self,
        invite: &str,
        username: &str,
        display: &str,
        password: Option<String>,
    ) -> Result<Box<[u8]>, JsError> {
        let password = password.map(Zeroizing::new);
        self.with_core(|c| {
            c.signup_request(
                invite,
                username,
                display,
                password.as_ref().map(|p| p.as_str()),
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::signup_complete; CBOR [1, blob, ssk_signature, prev_hash].
    pub fn signup_complete(
        &self,
        user_id: &[u8],
        username: &str,
        now: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let user_id = js_fixed_arg::<16>("user_id", user_id)?;
        self.with_core(|c| c.signup_complete(&user_id, username, now))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::signup_reset.
    pub fn signup_reset(&self) -> Result<(), JsError> {
        self.with_core(|c| c.signup_reset())
    }
    /// Calls ClientCore::device_list_body; CBOR [1, blob, ssk_signature, prev_hash].
    pub fn device_list_body(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.device_list_body())
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::device_list_published.
    pub fn device_list_published(&self) -> Result<(), JsError> {
        self.with_core(|c| c.device_list_published())
    }
    /// Calls ClientCore::device_list_drop.
    pub fn device_list_drop(&self) -> Result<(), JsError> {
        self.with_core(|c| c.device_list_drop())
    }
    /// Calls ClientCore::session_sign; CBOR [nonce, purpose, sig, null, null].
    pub fn session_sign(&self, nonce: &[u8], purpose: u32) -> Result<Box<[u8]>, JsError> {
        let nonce = js_fixed_arg::<32>("nonce", nonce)?;
        let purpose = purpose_arg(purpose).map_err(owned_js_error)?;
        self.with_core(|c| c.session_sign(&nonce, purpose))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::session_store.
    pub fn session_store(
        &self,
        token: &str,
        expires: u64,
        idle_expires: u64,
    ) -> Result<(), JsError> {
        self.with_core(|c| c.session_store(token, expires, idle_expires))
    }
    /// Calls ClientCore::session; CBOR null or [token, expires, idle_expires].
    pub fn session(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.session()).map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::session_clear.
    pub fn session_clear(&self) -> Result<(), JsError> {
        self.with_core(|c| c.session_clear())
    }
    /// Calls ClientCore::key_packages; CBOR [packages, last_resort].
    pub fn key_packages(&self, count: u32, last_resort: bool) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.key_packages(count, last_resort))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::sealed_objects; CBOR [root_sealed, state_sealed, state_uploaded].
    pub fn sealed_objects(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.sealed_objects())
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::groups; CBOR [[group_id, kind, community_id, target_id, state, epoch, next_seq, proposals_pending, pending_commit]].
    pub fn groups(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.groups()).map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::group_create; CBOR [group_id, binding, group_info, ratchet_tree]; community_id null for a DM.
    pub fn group_create(
        &self,
        group_id: &[u8],
        community_id: Option<Vec<u8>>,
        channel_id: &[u8],
        policy_version: u64,
        external_sender_pub: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let community_id = community_arg(community_id.as_deref()).map_err(owned_js_error)?;
        let channel_id = js_fixed_arg::<16>("channel_id", channel_id)?;
        let external_sender_pub = js_fixed_arg::<32>("external_sender_pub", external_sender_pub)?;
        self.with_core(|c| {
            c.group_create(
                &group_id,
                community_id.as_ref(),
                &channel_id,
                policy_version,
                &external_sender_pub,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::group_registered.
    pub fn group_registered(&self, group_id: &[u8], next_seq: u64) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.group_registered(&group_id, next_seq))
    }
    /// Calls ClientCore::group_discard.
    pub fn group_discard(&self, group_id: &[u8]) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.group_discard(&group_id))
    }
    /// Calls ClientCore::group_join_external; CBOR [external_commit, group_info]; community_id null for a DM.
    pub fn group_join_external(
        &self,
        group_id: &[u8],
        community_id: Option<Vec<u8>>,
        channel_id: &[u8],
        policy_version: u64,
        info_body: &[u8],
        tree_body: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let community_id = community_arg(community_id.as_deref()).map_err(owned_js_error)?;
        let channel_id = js_fixed_arg::<16>("channel_id", channel_id)?;
        self.with_core(|c| {
            c.group_join_external(
                &group_id,
                community_id.as_ref(),
                &channel_id,
                policy_version,
                info_body,
                tree_body,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::call_group_create; CBOR [group_id, binding, group_info, ratchet_tree]; community_id null for a DM.
    pub fn call_group_create(
        &self,
        group_id: &[u8],
        community_id: Option<Vec<u8>>,
        channel_id: &[u8],
        policy_version: u64,
        external_sender_pub: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let community_id = community_arg(community_id.as_deref()).map_err(owned_js_error)?;
        let channel_id = js_fixed_arg::<16>("channel_id", channel_id)?;
        let external_sender_pub = js_fixed_arg::<32>("external_sender_pub", external_sender_pub)?;
        self.with_core(|c| {
            c.call_group_create(
                &group_id,
                community_id.as_ref(),
                &channel_id,
                policy_version,
                &external_sender_pub,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::call_group_join_external; CBOR [external_commit, group_info], unposted
    /// until call_join_check passes; community_id null for a DM.
    pub fn call_group_join_external(
        &self,
        group_id: &[u8],
        community_id: Option<Vec<u8>>,
        channel_id: &[u8],
        policy_version: u64,
        info_body: &[u8],
        tree_body: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let community_id = community_arg(community_id.as_deref()).map_err(owned_js_error)?;
        let channel_id = js_fixed_arg::<16>("channel_id", channel_id)?;
        self.with_core(|c| {
            c.call_group_join_external(
                &group_id,
                community_id.as_ref(),
                &channel_id,
                policy_version,
                info_body,
                tree_body,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::call_media_epoch; CBOR [epoch, base_key, own_leaf, [[leaf, device_id,
    /// user_id]], code]. The core's buffer is zero-filled once copied out (`media_epoch_out`).
    pub fn call_media_epoch(&self, group_id: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let mut epoch = Zeroizing::new(self.with_core(|c| c.call_media_epoch(&group_id))?);
        Ok(media_epoch_out(&mut epoch))
    }
    /// Calls ClientCore::call_join_check: the full call gate on a staged call group.
    pub fn call_join_check(&self, group_id: &[u8]) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.call_join_check(&group_id))
    }
    /// Calls ClientCore::call_leave_proposal; CBOR [epoch, proposal].
    pub fn call_leave_proposal(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.call_leave_proposal(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::call_rotate; CBOR [epoch, commit, group_info, welcomes, null].
    pub fn call_rotate(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.call_rotate(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::call_group_forget.
    pub fn call_group_forget(&self, group_id: &[u8]) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.call_group_forget(&group_id))
    }
    /// Calls ClientCore::group_joined.
    pub fn group_joined(&self, group_id: &[u8], seq: u64) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.group_joined(&group_id, seq))
    }
    /// Calls ClientCore::welcomes_apply; CBOR [[welcome_id, group_id, outcome, reason]].
    pub fn welcomes_apply(
        &self,
        welcomes_body: &[u8],
        expected: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.welcomes_apply(welcomes_body, expected))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::group_apply; CBOR [state, epoch, next_seq, new_seqs, proposals_pending, flags].
    pub fn group_apply(
        &self,
        group_id: &[u8],
        handshakes: &[u8],
        messages: &[u8],
        through: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.group_apply(&group_id, handshakes, messages, through))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::commit_build; CBOR [epoch, commit, group_info, welcomes, null].
    pub fn commit_build(
        &self,
        group_id: &[u8],
        proposals_body: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.commit_build(&group_id, proposals_body))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::commit_confirm; CBOR [state, epoch, next_seq, new_seqs, proposals_pending, flags].
    pub fn commit_confirm(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.commit_confirm(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::commit_abort.
    pub fn commit_abort(&self, group_id: &[u8]) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.commit_abort(&group_id))
    }
    /// Calls ClientCore::cursor_body; CBOR null or [last_seq, last_epoch].
    pub fn cursor_body(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.cursor_body(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::cursor_acked.
    pub fn cursor_acked(
        &self,
        group_id: &[u8],
        last_seq: u64,
        last_epoch: u64,
    ) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.cursor_acked(&group_id, last_seq, last_epoch))
    }
    /// Calls ClientCore::message_deleted; CBOR [state, epoch, next_seq, new_seqs, proposals_pending, flags].
    pub fn message_deleted(&self, group_id: &[u8], seq: u64) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.message_deleted(&group_id, seq))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::send_prepare with the L-CORE-36 request bytes, unparsed; CBOR [msg_id].
    pub fn send_prepare(
        &self,
        group_id: &[u8],
        request: &[u8],
        now: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.send_prepare(&group_id, request, now))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::send_encrypt; CBOR [group_id, message_body].
    pub fn send_encrypt(&self, msg_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let msg_id = js_fixed_arg::<16>("msg_id", msg_id)?;
        self.with_core(|c| c.send_encrypt(&msg_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::send_confirm; CBOR [group_id, seq].
    pub fn send_confirm(&self, msg_id: &[u8], response: &[u8]) -> Result<Box<[u8]>, JsError> {
        let msg_id = js_fixed_arg::<16>("msg_id", msg_id)?;
        self.with_core(|c| c.send_confirm(&msg_id, response))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::send_requeue.
    pub fn send_requeue(&self, msg_id: &[u8]) -> Result<(), JsError> {
        let msg_id = js_fixed_arg::<16>("msg_id", msg_id)?;
        self.with_core(|c| c.send_requeue(&msg_id))
    }
    /// Calls ClientCore::send_fail.
    pub fn send_fail(&self, msg_id: &[u8], error: &str) -> Result<(), JsError> {
        let msg_id = js_fixed_arg::<16>("msg_id", msg_id)?;
        self.with_core(|c| c.send_fail(&msg_id, error))
    }
    /// Calls ClientCore::send_retry.
    pub fn send_retry(&self, msg_id: &[u8]) -> Result<(), JsError> {
        let msg_id = js_fixed_arg::<16>("msg_id", msg_id)?;
        self.with_core(|c| c.send_retry(&msg_id))
    }
    /// Calls ClientCore::send_discard.
    pub fn send_discard(&self, msg_id: &[u8]) -> Result<(), JsError> {
        let msg_id = js_fixed_arg::<16>("msg_id", msg_id)?;
        self.with_core(|c| c.send_discard(&msg_id))
    }
    /// Calls ClientCore::outbox; CBOR [[msg_id, state, error, created, body, type, reply_to, [[blob_id, size, mime, name]]]].
    pub fn outbox(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.outbox(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::timeline; CBOR [[seq, epoch, recv_ts, status, reason, sender_user, sender_device, sender_kind, sender_tier, msg_id, type, body]].
    pub fn timeline(
        &self,
        group_id: &[u8],
        before_seq: u64,
        limit: u32,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.timeline(&group_id, before_seq, limit))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::thread_timeline (web3.7); CBOR [root_row|null, [row]], each a 19-element timeline row.
    pub fn thread_timeline(
        &self,
        group_id: &[u8],
        root_msg_id: &[u8],
        before_seq: u64,
        limit: u32,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let root_msg_id = js_fixed_arg::<16>("root_msg_id", root_msg_id)?;
        self.with_core(|c| c.thread_timeline(&group_id, &root_msg_id, before_seq, limit))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::threads (web3.7); CBOR [[root_msg_id, root_seq|null, count, last_ts, excerpt]].
    pub fn threads(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.threads(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::pins; CBOR [[target_seq, msg_id, pinned_seq, by_user, author, excerpt, target_ts]].
    pub fn pins(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.pins(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::attachment_get; CBOR [blob_id, key, nonce, size, mime, w, h, thumb, name].
    pub fn attachment_get(
        &self,
        group_id: &[u8],
        seq: u64,
        index: u32,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.attachment_get(&group_id, seq, index))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::purges; CBOR [[group_id, seq, channel_id, [blob_id]]].
    pub fn purges(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.purges()).map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::purge_done; removes one purge row.
    pub fn purge_done(&self, group_id: &[u8], seq: u64) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.purge_done(&group_id, seq))
    }
    /// Calls ClientCore::own_roles_set; role_ids is 0..=64 concatenated 16-byte ids.
    pub fn own_roles_set(&self, community_id: &[u8], role_ids: &[u8]) -> Result<(), JsError> {
        let community_id = js_fixed_arg::<16>("community_id", community_id)?;
        role_ids_arg(role_ids).map_err(owned_js_error)?;
        self.with_core(|c| c.own_roles_set(&community_id, role_ids))
    }
    /// Calls ClientCore::authority_set; pinners and broadcasters are each 0..=4096 concatenated
    /// 16-byte user ids (web3.5 R1); mentionable is 0..=4096 concatenated 16-byte role ids, the
    /// server's roles marked "anyone can mention" (ABI 10).
    pub fn authority_set(
        &self,
        group_id: &[u8],
        pinners: &[u8],
        broadcasters: &[u8],
        mentionable: &[u8],
    ) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        authority_ids_arg("pinners", pinners).map_err(owned_js_error)?;
        authority_ids_arg("broadcasters", broadcasters).map_err(owned_js_error)?;
        authority_ids_arg("mentionable", mentionable).map_err(owned_js_error)?;
        self.with_core(|c| c.authority_set(&group_id, pinners, broadcasters, mentionable))
    }
    /// Calls ClientCore::group_row; CBOR null or [group_id, kind, community_id, target_id, state, epoch, next_seq, proposals_pending, pending_commit].
    pub fn group_row(&self, group_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.group_row(&group_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::mark_read.
    pub fn mark_read(&self, group_id: &[u8], seq: u64, now: u64) -> Result<(), JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.mark_read(&group_id, seq, now))
    }
    /// Calls ClientCore::activity; CBOR [[group_id, unread, mentions, last_seq, last_ts, last_read_seq]].
    pub fn activity(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.activity()).map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::settings; CBOR [[k, v]].
    pub fn settings(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.settings()).map(Vec::into_boxed_slice)
    }
    /// Authenticated current tree leaves needing a signed-list refresh.
    pub fn pending_leaves(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.pending_leaves())
            .map(Vec::into_boxed_slice)
    }
    pub fn proposed_adds(
        &self,
        group_id: &[u8],
        proposals_body: &[u8],
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.proposed_adds(&group_id, proposals_body))
            .map(Vec::into_boxed_slice)
    }
    #[allow(clippy::too_many_arguments)] // The wasm ABI mirrors the validated signed-history arguments.
    pub fn device_list_ingest_add(
        &self,
        group_id: &[u8],
        proposals_body: &[u8],
        index: u64,
        requested_user: &[u8],
        history_body: &[u8],
        head_list: &[u8],
        now: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let requested_user = js_fixed_arg::<16>("requested_user", requested_user)?;
        self.with_core(|c| {
            c.device_list_ingest_add(
                &group_id,
                proposals_body,
                index,
                &requested_user,
                history_body,
                head_list,
                now,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Validate a paged signed list against one current MLS leaf.
    pub fn device_list_ingest(
        &self,
        group_id: &[u8],
        leaf_index: u32,
        requested_user: &[u8],
        history_body: &[u8],
        head_list: &[u8],
        now: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        let requested_user = js_fixed_arg::<16>("requested_user", requested_user)?;
        self.with_core(|c| {
            c.device_list_ingest(
                &group_id,
                leaf_index,
                &requested_user,
                history_body,
                head_list,
                now,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Re-evaluate bounded MLS-authenticated pending rows after list ingestion.
    pub fn revalidate_pending(
        &self,
        group_id: &[u8],
        leaf_index: u32,
        limit: u32,
    ) -> Result<u32, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.revalidate_pending(&group_id, leaf_index, limit))
    }
    /// Public-key-only local contact trust state.
    pub fn trust_state(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.trust_state())
            .map(Vec::into_boxed_slice)
    }
    pub fn trust_generation(&self) -> Result<u64, JsError> {
        self.with_core(|c| c.trust_generation())
    }
    /// The leaf verdict that blocks sending in this group (the code `send_prepare` and
    /// `send_encrypt` refuse with), or undefined.
    pub fn send_block_code(&self, group_id: &[u8]) -> Result<Option<String>, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.send_block_code(&group_id))
            .map(|code| code.map(str::to_owned))
    }
    /// Whether that block is held only by leaves of the own user (the page names the own account).
    pub fn send_block_own(&self, group_id: &[u8]) -> Result<bool, JsError> {
        let group_id = js_fixed_arg::<16>("group_id", group_id)?;
        self.with_core(|c| c.send_block_own(&group_id))
    }
    /// Approve the exact pending validated contact key.
    pub fn trust_verify(&self, user_id: &[u8], expected_umk: &[u8]) -> Result<(), JsError> {
        let user_id = js_fixed_arg::<16>("user_id", user_id)?;
        let expected_umk = js_fixed_arg::<32>("expected_umk", expected_umk)?;
        self.with_core(|c| c.trust_verify(&user_id, &expected_umk))
    }
    /// Pairwise twelve-group decimal comparison number for exactly the key `trust_verify` will be
    /// given (`E_DEVICE_LIST_STALE` when it is not the current comparison key).
    pub fn safety_number_for(
        &self,
        user_id: &[u8],
        expected_umk: &[u8],
    ) -> Result<String, JsError> {
        let user_id = js_fixed_arg::<16>("user_id", user_id)?;
        let expected_umk = js_fixed_arg::<32>("expected_umk", expected_umk)?;
        self.with_core(|c| c.safety_number_for(&user_id, &expected_umk))
    }
    /// Bounded search of displayable local folded text.
    pub fn search(
        &self,
        scope_kind: u32,
        scope_id: Option<Vec<u8>>,
        query: &str,
        before: Option<Vec<u8>>,
        limit: u32,
    ) -> Result<Box<[u8]>, JsError> {
        let scope_kind = u8::try_from(scope_kind).map_err(|_| JsError::new("E_CORE_INPUT"))?;
        let scope_id = scope_id
            .as_deref()
            .map(|v| js_fixed_arg::<16>("scope_id", v))
            .transpose()?;
        let before = before
            .as_deref()
            .map(|raw| {
                dilla_core::cbor::decode_strict(raw, |d| {
                    d.array(3)?;
                    Ok((d.uint()?, d.bytes_exact::<16>()?, d.uint()?))
                })
                .map_err(|_| JsError::new("E_CORE_INPUT"))
            })
            .transpose()?;
        self.with_core(|c| c.search(scope_kind, scope_id.as_ref(), query, before, limit))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::setting_put.
    pub fn setting_put(&self, k: &str, v: &str) -> Result<(), JsError> {
        self.with_core(|c| c.setting_put(k, v))
    }
    /// Calls ClientCore::setting_delete.
    pub fn setting_delete(&self, k: &str) -> Result<(), JsError> {
        self.with_core(|c| c.setting_delete(k))
    }
    /// Calls ClientCore::enrol_begin; CBOR [device_id, dsk_pub].
    pub fn enrol_begin(&self, instance_id: &[u8]) -> Result<Box<[u8]>, JsError> {
        let instance_id = js_fixed_arg::<16>("instance_id", instance_id)?;
        self.with_core(|c| c.enrol_begin(&instance_id))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::enrol_session_sign; CBOR [nonce, 0, sig, [device_id, dsk_pub, 1, 1, credential], login].
    pub fn enrol_session_sign(&self, nonce: &[u8], login: Vec<u8>) -> Result<Box<[u8]>, JsError> {
        let login = Zeroizing::new(login);
        let nonce = js_fixed_arg::<32>("nonce", nonce)?;
        login_arg(&login).map_err(owned_js_error)?;
        self.with_core(|c| c.enrol_session_sign(&nonce, &login))
            .map(Vec::into_boxed_slice)
    }
    /// Calls dilla_core::client::recovery_key_check: the typed key's form, before a registration.
    pub fn recovery_key_check(&self, recovery_key: String) -> Result<(), JsError> {
        let recovery_key = Zeroizing::new(recovery_key);
        dilla_core::client::recovery_key_check(recovery_key.as_str()).map_err(owned_js_error)
    }
    /// Calls ClientCore::enrol_registered.
    pub fn enrol_registered(&self, user_id: &[u8]) -> Result<(), JsError> {
        let user_id = js_fixed_arg::<16>("user_id", user_id)?;
        self.with_core(|c| c.enrol_registered(&user_id))
    }
    /// Calls ClientCore::enrol_complete; CBOR [device_list_put_body, state_sealed, interrupted_put_body|null].
    pub fn enrol_complete(
        &self,
        recovery_key: String,
        root_sealed: &[u8],
        state_sealed: &[u8],
        list_body: &[u8],
        username: &str,
        now: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let recovery_key = Zeroizing::new(recovery_key);
        self.with_core(|c| {
            c.enrol_complete(
                recovery_key.as_str(),
                root_sealed,
                state_sealed,
                list_body,
                username,
                now,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::enrol_reset.
    pub fn enrol_reset(&self) -> Result<(), JsError> {
        self.with_core(|c| c.enrol_reset())
    }
    /// Calls ClientCore::device_list_revoke; CBOR [device_list_put_body, state_sealed, interrupted_put_body|null].
    pub fn device_list_revoke(
        &self,
        recovery_key: String,
        root_sealed: &[u8],
        state_sealed: &[u8],
        list_body: &[u8],
        device_ids: &[u8],
        now: u64,
    ) -> Result<Box<[u8]>, JsError> {
        let recovery_key = Zeroizing::new(recovery_key);
        self.with_core(|c| {
            c.device_list_revoke(
                recovery_key.as_str(),
                root_sealed,
                state_sealed,
                list_body,
                device_ids,
                now,
            )
        })
        .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::own_device_list_update; CBOR [version, listed].
    pub fn own_device_list_update(&self, history_body: &[u8]) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.own_device_list_update(history_body))
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::own_device_list; CBOR [version, published, [[device_id, dsk_pub, tier, added_at, revoked_at]]].
    pub fn own_device_list(&self) -> Result<Box<[u8]>, JsError> {
        self.with_core(|c| c.own_device_list())
            .map(Vec::into_boxed_slice)
    }
    /// Calls ClientCore::state_sealed_current.
    pub fn state_sealed_current(&self) -> Result<bool, JsError> {
        self.with_core(|c| c.state_sealed_current())
    }
    /// Calls ClientCore::state_sealed_uploaded.
    pub fn state_sealed_uploaded(&self) -> Result<(), JsError> {
        self.with_core(|c| c.state_sealed_uploaded())
    }
}
