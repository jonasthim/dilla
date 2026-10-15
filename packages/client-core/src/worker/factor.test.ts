// web3.6 C2: the second factor before the shell. The factor-setup phase gated in enterReady, factorSetupDone, the global
// E_FACTOR_REQUIRED hook (HttpDeps.onRefusal), and the passkey and backup-code sign-in steps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, Op } from '../gateway/frames';
import { toHex } from '../hex';
import type { AccountState, FactorsState } from '../state/types';
import { ACCEPTS } from './controller';
import { COMMUNITY, DEVICE, INSTANCE_ID, PASSWORD, RECOVERY_KEY, SUBMIT, USER, cbor, refusal, toReady, world, type World } from './world';

afterEach(() => { vi.useRealTimers(); });

const CEREMONY_HEX = 'ce'.repeat(16);
const LOGIN = { m: 'signInLogin', username: ' web ', password: PASSWORD, recoveryKey: RECOVERY_KEY } as const;

async function toKeys(w: World): Promise<void> {
  w.call(1, { m: 'start' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('needs-signup'));
  w.call(2, { m: 'signupBegin' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('signup-keys'));
}

async function toLoginStep(w: World): Promise<void> {
  w.call(1, { m: 'start' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('needs-signup'));
  w.call(2, { m: 'signInBegin' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-login'));
}

async function answered(w: World, id: number): Promise<unknown> {
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  return w.ret(id);
}

const factors = (w: World): FactorsState | undefined => w.last<FactorsState>('factors');

describe('the factor-setup phase (web3.6 C2)', () => {
  it('a signup owing a factor stops at factor-setup; factorSetupDone refuses while owed, then enters ready and joins', async () => {
    const w = world({ phase: 0, owed: true });
    w.routes.getInvite.mockImplementation(() => Promise.resolve({ communityId: COMMUNITY, communityName: 'friends', expires: 0n }));
    await toKeys(w);
    w.call(3, SUBMIT);
    expect(await answered(w, 3)).toEqual({ t: 'ret', id: 3, ok: true, value: { communityId: null, joinError: null, factorOwed: true } });
    expect(w.account()).toMatchObject({ phase: 'factor-setup', factorSetup: { origin: 'signup' }, recoveryKey: null,
      user: { id: toHex(USER) }, deviceId: toHex(DEVICE) });
    expect(factors(w)).toMatchObject({ owed: true, totp: null, passkeys: [], backupCodesLeft: 0, hasPassword: true });
    expect(w.gateway.starts).toBe(0);
    expect(w.routes.joinCommunity).not.toHaveBeenCalled();
    expect(w.routes.postKeyPackages).not.toHaveBeenCalled();
    expect(w.account.ensureBackups).not.toHaveBeenCalled();

    w.call(4, { m: 'factorSetupDone', invite: null });
    expect(await answered(w, 4)).toEqual({ t: 'ret', id: 4, ok: false,
      error: { code: 'E_FACTOR_REQUIRED', detail: '', status: 0, retryAfterMs: null } });
    expect(w.account()).toMatchObject({ phase: 'factor-setup', factorSetup: { origin: 'signup' } });
    expect(w.routes.joinCommunity).not.toHaveBeenCalled();

    w.state.owed = false;
    w.call(5, { m: 'factorSetupDone', invite: null });
    expect(await answered(w, 5)).toEqual({ t: 'ret', id: 5, ok: true, value: { communityId: toHex(COMMUNITY), joinError: null } });
    expect(w.account()).toMatchObject({ phase: 'ready', factorSetup: null });
    expect(factors(w)).toMatchObject({ owed: false, totp: { confirmedAt: 1_700_000_000 } });
    expect(w.routes.joinCommunity).toHaveBeenCalledWith(COMMUNITY, 'friends-code');
    // The KeyPackages (a V route, refused while owed) go up once the debt is paid, before the join.
    expect(w.routes.postKeyPackages).toHaveBeenCalledTimes(1);
    expect(w.routes.postKeyPackages.mock.invocationCallOrder[0]).toBeLessThan(w.routes.joinCommunity.mock.invocationCallOrder[0]);
    expect(w.gateway.starts).toBe(1);
    // A second factorSetupDone is not accepted in ready.
    w.call(6, { m: 'factorSetupDone', invite: null });
    expect(await answered(w, 6)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY' } });
  });

  it('factorSetupDone without a pending join redeems the invite it is given', async () => {
    const w = world({ phase: 2, owed: true });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('factor-setup'));
    w.state.owed = false;
    w.routes.getInvite.mockImplementation(() => Promise.resolve({ communityId: COMMUNITY, communityName: 'friends', expires: 0n }));
    w.call(2, { m: 'factorSetupDone', invite: ' friends-code ' });
    expect(await answered(w, 2)).toEqual({ t: 'ret', id: 2, ok: true, value: { communityId: toHex(COMMUNITY), joinError: null } });
    expect(w.routes.getInvite).toHaveBeenCalledWith('friends-code');
    expect(w.routes.joinCommunity).toHaveBeenCalledWith(COMMUNITY, 'friends-code');
    // Not a fresh signup: the gateway's ready refills the KeyPackages from its count, enterReady does not.
    expect(w.routes.postKeyPackages).not.toHaveBeenCalled();
  });

  it('a reload at factor-setup boots into factor-setup with origin required, before any backup PUT or socket', async () => {
    const w = world({ phase: 2, owed: true });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('factor-setup'));
    expect(w.account()).toMatchObject({ factorSetup: { origin: 'required' }, user: { id: toHex(USER), username: 'web' } });
    expect(w.calls).toContain('publishDeviceList');
    expect(w.account.ensureBackups).not.toHaveBeenCalled();
    expect(w.routes.putBackup).not.toHaveBeenCalled();
    expect(w.account.refreshOwnDeviceList).not.toHaveBeenCalled();
    expect(w.gateway.starts).toBe(0);
    expect(w.sync.start).not.toHaveBeenCalled();
    w.call(2, { m: 'refreshDevices' });
    expect(await answered(w, 2)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY' } });
  });

  it('an account that owes nothing reads its factors and goes on to ready', async () => {
    const w = world();
    await toReady(w);
    expect(w.routes.getFactors).toHaveBeenCalledTimes(1);
    expect(w.account()).toMatchObject({ phase: 'ready', factorSetup: null });
    expect(factors(w)).toEqual({ owed: false, totp: { confirmedAt: 1_700_000_000 }, passkeys: [], backupCodesLeft: 10, hasPassword: true });
    expect(w.account.ensureBackups).toHaveBeenCalled();
  });

  it('factor-setup accepts exactly factorSetupDone and forgetBrowser (C3 adds its five)', () => {
    expect(ACCEPTS['factor-setup']).toEqual(['factorSetupDone', 'forgetBrowser']);
    expect(ACCEPTS['signin-passkey']).toEqual(['signInPasskeyBegin', 'signInPasskey', 'signInBackupCode', 'signInCancel']);
  });
});

/** A WebSocket double: the test opens it, feeds it frames, and closes it from the server side. */
class Sock {
  static all: Sock[] = [];
  readyState = 0;
  binaryType = 'blob';
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string, readonly protocols: string[]) { Sock.all.push(this); }
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(): void {}
  send(): void {}
  close(code?: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: code ?? 1005, reason: '', wasClean: true });
  }
  open(): void { this.readyState = 1; this.emit('open', {}); }
  receive(bytes: Uint8Array): void { this.emit('message', { data: bytes.slice().buffer }); }
  serverClose(code: number): void { this.readyState = 3; this.emit('close', { code, reason: '', wasClean: true }); }
  private emit(type: string, event: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn(event); }
}

const HELLO = encodeFrame(Op.hello, 0, null, [[1], [1], [1], 30_000, 131_584, INSTANCE_ID, 1, 300, 300]);
const READY = encodeFrame(Op.ready, 1, null, [DEVICE, USER, 7, new Uint8Array(32).fill(0x0b), 1, 1, 1, 32, []]);

/** A world on the real Gateway, whose tickets go through the real HttpClient to `ticket` (the n-th request, 1-based). */
function socketWorld(ticket: (n: number) => Promise<Response>) {
  Sock.all = [];
  const tickets = { n: 0 };
  const fetch = ((input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path !== '/v1/gateway/ticket') return Promise.resolve(cbor(['E_NOT_FOUND', 'not modelled', null], 404));
    tickets.n += 1;
    return ticket(tickets.n);
  }) as typeof globalThis.fetch;
  const w = world({ realGateway: true, httpTicket: true, fetch, WebSocket: Sock as unknown as typeof WebSocket });
  return { w, tickets };
}

const minted = (): Promise<Response> => Promise.resolve(cbor([`tkt-${String(Date.now())}`, 1_700_000_030], 201));
const owedTicket = (): Promise<Response> => Promise.resolve(cbor(['E_FACTOR_REQUIRED', '', null], 403));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await vi.advanceTimersByTimeAsync(10);
  expect(check()).toBe(true);
}

describe('the global E_FACTOR_REQUIRED hook (web3.6 C2)', () => {
  it('a ready worker whose ticket is refused E_FACTOR_REQUIRED stops the gateway and enters factor-setup; no ticket follows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let answer: (r: Response) => void = () => {};
    const { w, tickets } = socketWorld(() => new Promise<Response>((resolve) => { answer = resolve; }));
    w.call(1, { m: 'start' });
    await until(() => w.account()?.phase === 'ready');
    expect(tickets.n).toBe(1);
    w.state.owed = true;
    answer(await owedTicket());
    await until(() => w.account()?.phase === 'factor-setup');
    expect(w.account()?.factorSetup).toEqual({ origin: 'required' });
    expect(w.connection()?.status).toBe('offline');
    expect(w.sync.stop).toHaveBeenCalled();
    expect(factors(w)?.owed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickets.n).toBe(1);
    expect(Sock.all).toHaveLength(0);
  });

  it('the reset chain: a socket closed 4003 reconnects once, the ticket answers E_FACTOR_REQUIRED, and the hook fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { w, tickets } = socketWorld((n) => (n === 1 ? minted() : owedTicket()));
    w.call(1, { m: 'start' });
    await until(() => w.account()?.phase === 'ready' && Sock.all.length === 1);
    const socket = Sock.all[0];
    socket.open();
    socket.receive(HELLO);
    socket.receive(READY);
    await until(() => w.connection()?.status === 'online');
    // The operator resets the account's factors (S3): the instance marks it owed and closes its sockets with 4003.
    w.state.owed = true;
    socket.serverClose(4003);
    await until(() => w.account()?.phase === 'factor-setup');
    expect(tickets.n).toBe(2);
    expect(w.account()?.factorSetup).toEqual({ origin: 'required' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickets.n).toBe(2);
    expect(Sock.all).toHaveLength(1);
    // Paying the debt builds a fresh socket and engine.
    w.state.owed = false;
    w.call(2, { m: 'factorSetupDone', invite: null });
    await until(() => w.ret(2) !== undefined);
    expect(w.ret(2)).toMatchObject({ ok: true, value: { communityId: null, joinError: null } });
    expect(w.account()?.phase).toBe('ready');
    expect(tickets.n).toBe(3);
  });
});

describe('passkey and backup-code sign-in (web3.6 C2)', () => {
  it('a login owing needs 2 goes to signin-passkey; a passkey that did not verify the user goes on to the code step', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.resolve({ needs: 2 }));
    await toLoginStep(w);
    w.call(3, LOGIN);
    expect(await answered(w, 3)).toEqual({ t: 'ret', id: 3, ok: true, value: { needs: 2 } });
    expect(w.account()).toMatchObject({ phase: 'signin-passkey', signIn: { username: 'web', needsTotp: false, factor: 'passkey' }, error: null });
    expect(w.enrol.register).not.toHaveBeenCalled();
    w.call(4, { m: 'signInPasskeyBegin' });
    expect(await answered(w, 4)).toEqual({ t: 'ret', id: 4, ok: true, value: { ceremonyId: CEREMONY_HEX, options: '{"publicKey":{}}' } });
    w.enrol.passkey.mockImplementationOnce(() => Promise.resolve({ needs: 1 }));
    w.call(5, { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: '{"id":"x"}', recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 5)).toEqual({ t: 'ret', id: 5, ok: true, value: { needs: 1 } });
    expect(w.enrol.passkey).toHaveBeenCalledWith(new Uint8Array(16).fill(0xce), '{"id":"x"}');
    expect(w.account()).toMatchObject({ phase: 'signin-totp', signIn: { needsTotp: false, factor: 'passkey' } });
    w.call(6, { m: 'signInTotp', code: '123456', recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 6)).toEqual({ t: 'ret', id: 6, ok: true, value: null });
    expect(w.account()?.phase).toBe('ready');
  });

  it('a login owing needs 1 goes to signin-totp with factor totp', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.resolve({ needs: 1 }));
    await toLoginStep(w);
    w.call(3, LOGIN);
    expect(await answered(w, 3)).toEqual({ t: 'ret', id: 3, ok: true, value: { needs: 1 } });
    expect(w.account()).toMatchObject({ phase: 'signin-totp', signIn: { username: 'web', needsTotp: true, factor: 'totp' } });
  });

  it('a passkey on its own signs in from the login step', async () => {
    const w = world({ phase: 0 });
    await toLoginStep(w);
    w.call(3, { m: 'signInPasskeyBegin' });
    await answered(w, 3);
    w.call(4, { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: '{"id":"x"}', recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 4)).toEqual({ t: 'ret', id: 4, ok: true, value: { needs: 0 } });
    expect(w.enrol.login).not.toHaveBeenCalled();
    expect(w.calls.filter((c) => c.startsWith('enrol.'))).toEqual(['enrol.passkey', 'enrol.register', 'enrol.fetch', 'enrol.complete']);
    expect(w.account()?.phase).toBe('ready');
  });

  it('a refused passkey stays at its step with the error', async () => {
    const w = world({ phase: 0 });
    await toLoginStep(w);
    w.enrol.passkey.mockImplementationOnce(() => Promise.reject(refusal(401, 'E_PASSKEY_UNKNOWN')));
    w.call(3, { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: 'r', recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 3)).toMatchObject({ ok: false, error: { code: 'E_PASSKEY_UNKNOWN', status: 401 } });
    expect(w.account()).toMatchObject({ phase: 'signin-login', error: { code: 'E_PASSKEY_UNKNOWN' } });
  });

  it('a backup code after needs 2 signs in; it is sent normalised', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.resolve({ needs: 2 }));
    await toLoginStep(w);
    w.call(3, LOGIN);
    await answered(w, 3);
    w.call(4, { m: 'signInBackupCode', code: 'abcde-fghij klmno-pqrst uvwxyz', recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 4)).toEqual({ t: 'ret', id: 4, ok: true, value: null });
    expect(w.enrol.backupCode).toHaveBeenCalledWith('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(w.calls.filter((c) => c.startsWith('enrol.'))).toEqual(['enrol.backupCode', 'enrol.register', 'enrol.fetch', 'enrol.complete']);
    expect(w.account()?.phase).toBe('ready');
  });

  it('a wrong backup code spends the assertion: back to the login step with the error and the username kept', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.resolve({ needs: 2 }));
    w.enrol.backupCode.mockImplementationOnce(() => Promise.reject(refusal(401, 'E_UNAUTHENTICATED')));
    await toLoginStep(w);
    w.call(3, LOGIN);
    await answered(w, 3);
    w.call(4, { m: 'signInBackupCode', code: 'A'.repeat(26), recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 4)).toMatchObject({ ok: false, error: { code: 'E_UNAUTHENTICATED', status: 401 } });
    expect(w.account()).toMatchObject({ phase: 'signin-login', signIn: { username: 'web', needsTotp: false, factor: null },
      error: { code: 'E_UNAUTHENTICATED' } });
    expect(w.enrol.register).not.toHaveBeenCalled();
  });

  it('checks the new commands\' input before anything is sent', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.resolve({ needs: 2 }));
    await toLoginStep(w);
    w.call(3, LOGIN);
    await answered(w, 3);
    const bad = [
      { m: 'signInBackupCode', code: 'A'.repeat(25), recoveryKey: RECOVERY_KEY },
      { m: 'signInBackupCode', code: 'A'.repeat(25) + '1', recoveryKey: RECOVERY_KEY },
      { m: 'signInBackupCode', code: 'A'.repeat(26), recoveryKey: '' },
      { m: 'signInPasskey', ceremonyId: 'CE'.repeat(16), response: 'r', recoveryKey: RECOVERY_KEY },
      { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: '', recoveryKey: RECOVERY_KEY },
      { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: 'x'.repeat(65_537), recoveryKey: RECOVERY_KEY },
      { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: 'r', recoveryKey: ' ' },
      { m: 'factorSetupDone', invite: 7 },
    ];
    bad.forEach((command, i) => w.call(10 + i, command));
    for (let i = 0; i < bad.length; i++) expect(await answered(w, 10 + i)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.enrol.backupCode).not.toHaveBeenCalled();
    expect(w.enrol.passkey).not.toHaveBeenCalled();
    // Control: 64 KiB of response is accepted.
    w.call(30, { m: 'signInPasskey', ceremonyId: CEREMONY_HEX, response: 'x'.repeat(65_536), recoveryKey: RECOVERY_KEY });
    expect(await answered(w, 30)).toMatchObject({ ok: true });
  });

  it('the account slice says which factors the instance offers', async () => {
    const w = world();
    w.routes.getInstance.mockImplementation(() => Promise.resolve({ instanceId: INSTANCE_ID, generation: 7n, name: 'dilla.test',
      registrationMode: 0, authMethods: [0, 2], policyVersion: 1n, externalSenderPub: new Uint8Array(32).fill(2) }));
    await toReady(w);
    expect(w.account()?.instance).toMatchObject({ passwordSignup: true, passkeys: true, totp: false } satisfies Partial<NonNullable<AccountState['instance']>>);
  });
});
