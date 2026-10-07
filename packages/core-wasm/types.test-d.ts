// L-WASM-05 (web-1) and L-WASM-21 (web-2a): the TypeScript face of CoreHandle, pinned against what
// wasm-bindgen generates. Run by `npm run typecheck -w @dilla/core-wasm` after a wasm-pack build into
// ./pkg. A changed name, an argument type, an optional flag or a return type turns one line below red.
import type * as Wasm from './pkg/dilla_core_wasm.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectTrue<T extends true>(): T | undefined {
  return undefined;
}

interface ExpectedCoreHandle {
  free(): void;
  [Symbol.dispose](): void;
  capacity(): number;
  reserve_capacity(n: number): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  close(): void;
  identity(): Uint8Array;
  signup_begin(instance_id: Uint8Array): string;
  signup_request(invite: string, username: string, display: string, password?: string | null): Uint8Array;
  signup_complete(user_id: Uint8Array, username: string, now: bigint): Uint8Array;
  signup_reset(): void;
  device_list_body(): Uint8Array;
  device_list_published(): void;
  device_list_drop(): void;
  session_sign(nonce: Uint8Array, purpose: number): Uint8Array;
  session_store(token: string, expires: bigint, idle_expires: bigint): void;
  session(): Uint8Array;
  session_clear(): void;
  key_packages(count: number, last_resort: boolean): Uint8Array;
  sealed_objects(): Uint8Array;
  groups(): Uint8Array;
  group_create(group_id: Uint8Array, community_id: Uint8Array | null | undefined, channel_id: Uint8Array, policy_version: bigint, external_sender_pub: Uint8Array): Uint8Array;
  group_registered(group_id: Uint8Array, next_seq: bigint): void;
  group_discard(group_id: Uint8Array): void;
  group_join_external(group_id: Uint8Array, community_id: Uint8Array | null | undefined, channel_id: Uint8Array, policy_version: bigint, info_body: Uint8Array, tree_body: Uint8Array): Uint8Array;
  group_joined(group_id: Uint8Array, seq: bigint): void;
  welcomes_apply(welcomes_body: Uint8Array, expected: Uint8Array): Uint8Array;
  group_apply(group_id: Uint8Array, handshakes: Uint8Array, messages: Uint8Array, through: bigint): Uint8Array;
  commit_build(group_id: Uint8Array, proposals_body: Uint8Array): Uint8Array;
  commit_confirm(group_id: Uint8Array): Uint8Array;
  commit_abort(group_id: Uint8Array): void;
  cursor_body(group_id: Uint8Array): Uint8Array;
  cursor_acked(group_id: Uint8Array, last_seq: bigint, last_epoch: bigint): void;
  message_deleted(group_id: Uint8Array, seq: bigint): Uint8Array;
  send_prepare(group_id: Uint8Array, request: Uint8Array, now: bigint): Uint8Array;
  send_encrypt(msg_id: Uint8Array): Uint8Array;
  send_confirm(msg_id: Uint8Array, response: Uint8Array): Uint8Array;
  send_requeue(msg_id: Uint8Array): void;
  send_fail(msg_id: Uint8Array, error: string): void;
  send_retry(msg_id: Uint8Array): void;
  send_discard(msg_id: Uint8Array): void;
  outbox(group_id: Uint8Array): Uint8Array;
  timeline(group_id: Uint8Array, before_seq: bigint, limit: number): Uint8Array;
  group_row(group_id: Uint8Array): Uint8Array;
  mark_read(group_id: Uint8Array, seq: bigint, now: bigint): void;
  activity(): Uint8Array;
  settings(): Uint8Array;
  setting_put(k: string, v: string): void;
  setting_delete(k: string): void;
  enrol_begin(instance_id: Uint8Array): Uint8Array;
  enrol_session_sign(nonce: Uint8Array, login: Uint8Array): Uint8Array;
  enrol_registered(user_id: Uint8Array): void;
  recovery_key_check(recovery_key: string): void;
  enrol_complete(recovery_key: string, root_sealed: Uint8Array, state_sealed: Uint8Array, list_body: Uint8Array, username: string, now: bigint): Uint8Array;
  enrol_reset(): void;
  device_list_revoke(recovery_key: string, root_sealed: Uint8Array, state_sealed: Uint8Array, list_body: Uint8Array, device_ids: Uint8Array, now: bigint): Uint8Array;
  own_device_list_update(history_body: Uint8Array): Uint8Array;
  own_device_list(): Uint8Array;
  state_sealed_uploaded(): void;
  state_sealed_current(): boolean;
  pins(group_id: Uint8Array): Uint8Array;
  attachment_get(group_id: Uint8Array, seq: bigint, index: number): Uint8Array;
  purges(): Uint8Array;
  purge_done(group_id: Uint8Array, seq: bigint): void;
  own_roles_set(community_id: Uint8Array, role_ids: Uint8Array): void;
}

type H = Wasm.CoreHandle;
type E = ExpectedCoreHandle;

// The exact member set: nothing missing, nothing extra.
expectTrue<Equals<keyof H, keyof E>>();

// The free functions web-1 added or changed.
expectTrue<Equals<typeof Wasm.core_open, (cfg: Wasm.StoreOpenConfig) => Promise<Wasm.CoreHandle>>>();
expectTrue<Equals<typeof Wasm.abi_version, () => number>>();

// Member by member, so a failure names the method.
expectTrue<Equals<H['free'], E['free']>>();
expectTrue<Equals<H[typeof Symbol.dispose], E[typeof Symbol.dispose]>>();
expectTrue<Equals<H['capacity'], E['capacity']>>();
expectTrue<Equals<H['reserve_capacity'], E['reserve_capacity']>>();
expectTrue<Equals<H['pause'], E['pause']>>();
expectTrue<Equals<H['resume'], E['resume']>>();
expectTrue<Equals<H['close'], E['close']>>();
expectTrue<Equals<H['identity'], E['identity']>>();
expectTrue<Equals<H['signup_begin'], E['signup_begin']>>();
expectTrue<Equals<H['signup_request'], E['signup_request']>>();
expectTrue<Equals<H['signup_complete'], E['signup_complete']>>();
expectTrue<Equals<H['signup_reset'], E['signup_reset']>>();
expectTrue<Equals<H['device_list_body'], E['device_list_body']>>();
expectTrue<Equals<H['device_list_published'], E['device_list_published']>>();
expectTrue<Equals<H['device_list_drop'], E['device_list_drop']>>();
expectTrue<Equals<H['session_sign'], E['session_sign']>>();
expectTrue<Equals<H['session_store'], E['session_store']>>();
expectTrue<Equals<H['session'], E['session']>>();
expectTrue<Equals<H['session_clear'], E['session_clear']>>();
expectTrue<Equals<H['key_packages'], E['key_packages']>>();
expectTrue<Equals<H['sealed_objects'], E['sealed_objects']>>();
expectTrue<Equals<H['groups'], E['groups']>>();
expectTrue<Equals<H['group_create'], E['group_create']>>();
expectTrue<Equals<H['group_registered'], E['group_registered']>>();
expectTrue<Equals<H['group_discard'], E['group_discard']>>();
expectTrue<Equals<H['group_join_external'], E['group_join_external']>>();
expectTrue<Equals<H['group_joined'], E['group_joined']>>();
expectTrue<Equals<H['welcomes_apply'], E['welcomes_apply']>>();
expectTrue<Equals<H['group_apply'], E['group_apply']>>();
expectTrue<Equals<H['commit_build'], E['commit_build']>>();
expectTrue<Equals<H['commit_confirm'], E['commit_confirm']>>();
expectTrue<Equals<H['commit_abort'], E['commit_abort']>>();
expectTrue<Equals<H['cursor_body'], E['cursor_body']>>();
expectTrue<Equals<H['cursor_acked'], E['cursor_acked']>>();
expectTrue<Equals<H['message_deleted'], E['message_deleted']>>();
expectTrue<Equals<H['send_prepare'], E['send_prepare']>>();
expectTrue<Equals<H['send_encrypt'], E['send_encrypt']>>();
expectTrue<Equals<H['send_confirm'], E['send_confirm']>>();
expectTrue<Equals<H['send_requeue'], E['send_requeue']>>();
expectTrue<Equals<H['send_fail'], E['send_fail']>>();
expectTrue<Equals<H['send_retry'], E['send_retry']>>();
expectTrue<Equals<H['send_discard'], E['send_discard']>>();
expectTrue<Equals<H['outbox'], E['outbox']>>();
expectTrue<Equals<H['timeline'], E['timeline']>>();
expectTrue<Equals<H['group_row'], E['group_row']>>();
expectTrue<Equals<H['mark_read'], E['mark_read']>>();
expectTrue<Equals<H['activity'], E['activity']>>();
expectTrue<Equals<H['settings'], E['settings']>>();
expectTrue<Equals<H['setting_put'], E['setting_put']>>();
expectTrue<Equals<H['setting_delete'], E['setting_delete']>>();
expectTrue<Equals<H['enrol_begin'], E['enrol_begin']>>();
expectTrue<Equals<H['enrol_session_sign'], E['enrol_session_sign']>>();
expectTrue<Equals<H['enrol_registered'], E['enrol_registered']>>();
expectTrue<Equals<H['recovery_key_check'], E['recovery_key_check']>>();
expectTrue<Equals<H['enrol_complete'], E['enrol_complete']>>();
expectTrue<Equals<H['enrol_reset'], E['enrol_reset']>>();
expectTrue<Equals<H['device_list_revoke'], E['device_list_revoke']>>();
expectTrue<Equals<H['own_device_list_update'], E['own_device_list_update']>>();
expectTrue<Equals<H['own_device_list'], E['own_device_list']>>();
expectTrue<Equals<H['state_sealed_uploaded'], E['state_sealed_uploaded']>>();
expectTrue<Equals<H['state_sealed_current'], E['state_sealed_current']>>();

expectTrue<Equals<H['pins'], E['pins']>>();
expectTrue<Equals<H['attachment_get'], E['attachment_get']>>();
expectTrue<Equals<H['purges'], E['purges']>>();
expectTrue<Equals<H['purge_done'], E['purge_done']>>();
expectTrue<Equals<H['own_roles_set'], E['own_roles_set']>>();
