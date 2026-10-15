// web3.6 C3: the factor management commands. FactorsController over doubled routes (the route calls, the publish-before-
// resolve order, the re-read after a refused step-up) and the same commands through the worker (validators, ACCEPTS).
import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { Factors } from '../http/routes';
import type { FactorsState } from '../state/types';
import { ACCEPTS } from '../worker/controller';
import { toReady, world, type World } from '../worker/world';
import { FACTOR_VALIDATORS, FactorsController, factorsState, normaliseBackupCode, type FactorsRoutes } from './factors';

const CEREMONY = new Uint8Array(16).fill(0xce);
const CEREMONY_HEX = 'ce'.repeat(16);
const CRED = new Uint8Array([0xab, 0xcd, 0xef]);
const CODES = ['AAAAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBBBB'];
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = 'otpauth://totp/dilla:ada?secret=JBSWY3DPEHPK3PXP';

const held: Factors = { owed: false, totp: 1_700_000_000, passkeys: [{ credId: CRED, name: 'Laptop', created: 5, lastUsed: null }],
  backupCodesLeft: 10, hasPassword: true };

function refused(status: number, code: string): DillaHttpError {
  return new DillaHttpError({ status, code, detail: '', retryAfterMs: null, extra: [] });
}

/* eslint-disable @typescript-eslint/no-unused-vars -- the typed parameters give the doubles their call signatures */
function rig() {
  const log: string[] = [];
  const published: FactorsState[] = [];
  const routes = {
    getFactors: vi.fn(() => { log.push('getFactors'); return Promise.resolve(held); }),
    totpEnroll: vi.fn((_s: string | null) => { log.push('totpEnroll'); return Promise.resolve({ secret: SECRET, uri: URI }); }),
    totpConfirm: vi.fn((_c: string) => { log.push('totpConfirm'); return Promise.resolve(CODES); }),
    passkeyRegisterBegin: vi.fn((_s: string | null) => { log.push('passkeyRegisterBegin'); return Promise.resolve({ ceremonyId: CEREMONY, options: '{"publicKey":{}}' }); }),
    passkeyRegisterFinish: vi.fn((_c: Uint8Array, _r: string, _n: string) => { log.push('passkeyRegisterFinish'); return Promise.resolve({ credId: CRED, backupCodes: CODES }); }),
    stepUp: vi.fn((_m: 0 | 1 | 2, _s: string) => { log.push('stepUp'); return Promise.resolve({ token: 'su-1', expires: 9n }); }),
    stepUpPasskeyBegin: vi.fn(() => { log.push('stepUpPasskeyBegin'); return Promise.resolve({ ceremonyId: CEREMONY, options: '{"publicKey":{}}' }); }),
    stepUpPasskeyFinish: vi.fn((_c: Uint8Array, _r: string) => { log.push('stepUpPasskeyFinish'); return Promise.resolve({ token: 'su-2', expires: 9n }); }),
    removeFactor: vi.fn((_s: string, _k: 0 | 1, _c: Uint8Array | null) => { log.push('removeFactor'); return Promise.resolve(); }),
    regenerateBackupCodes: vi.fn((_s: string) => { log.push('regenerateBackupCodes'); return Promise.resolve(CODES); }),
  } satisfies FactorsRoutes;
  const ctl = new FactorsController({ routes, publish: (name, value) => { log.push(`publish:${name}`); published.push(value as FactorsState); } });
  return { ctl, routes, log, published };
}

/* eslint-enable @typescript-eslint/no-unused-vars */

describe('FactorsController', () => {
  it('refreshFactors reads and publishes the factors slice', async () => {
    const r = rig();
    expect(await r.ctl.refresh()).toBeNull();
    expect(r.published).toEqual([factorsState(held)]);
    expect(r.published[0]).toEqual({ owed: false, totp: { confirmedAt: 1_700_000_000 },
      passkeys: [{ id: 'abcdef', name: 'Laptop', created: 5, lastUsed: null }], backupCodesLeft: 10, hasPassword: true });
  });

  it('factorTotpBegin returns the secret and the uri and publishes nothing', async () => {
    const r = rig();
    expect(await r.ctl.totpBegin('su-x')).toEqual({ secret: SECRET, uri: URI });
    expect(r.routes.totpEnroll).toHaveBeenCalledWith('su-x');
    expect(r.log).toEqual(['totpEnroll']);
    await r.ctl.totpBegin(null);
    expect(r.routes.totpEnroll).toHaveBeenLastCalledWith(null);
  });

  it('factorTotpConfirm publishes the factors before it resolves, and returns the codes', async () => {
    const r = rig();
    expect(await r.ctl.totpConfirm('123456')).toEqual({ backupCodes: CODES });
    expect(r.routes.totpConfirm).toHaveBeenCalledWith('123456');
    expect(r.log).toEqual(['totpConfirm', 'getFactors', 'publish:factors']);
  });

  it('the passkey ceremony: begin gives hex ids, finish sends bytes, publishes before it resolves', async () => {
    const r = rig();
    expect(await r.ctl.passkeyBegin('su-x')).toEqual({ ceremonyId: CEREMONY_HEX, options: '{"publicKey":{}}' });
    expect(r.routes.passkeyRegisterBegin).toHaveBeenCalledWith('su-x');
    const done = await r.ctl.passkeyFinish(CEREMONY_HEX, '{"id":"x"}', 'Laptop');
    expect(done).toEqual({ backupCodes: CODES });
    expect(r.routes.passkeyRegisterFinish).toHaveBeenCalledWith(CEREMONY, '{"id":"x"}', 'Laptop');
    expect(r.log.slice(-3)).toEqual(['passkeyRegisterFinish', 'getFactors', 'publish:factors']);
  });

  it('stepUp maps the method, normalises a backup code and returns only the token', async () => {
    const r = rig();
    expect(await r.ctl.stepUp('password', 'pw')).toEqual({ token: 'su-1' });
    expect(r.routes.stepUp).toHaveBeenLastCalledWith(0, 'pw');
    await r.ctl.stepUp('totp', '123456');
    expect(r.routes.stepUp).toHaveBeenLastCalledWith(1, '123456');
    await r.ctl.stepUp('backup', 'aaaaa-aaaaa aaaaaaaaaaaaaaaa');
    expect(r.routes.stepUp).toHaveBeenLastCalledWith(2, CODES[0]);
    expect(r.published).toEqual([]);
  });

  it('the passkey step-up gives hex ids and a token', async () => {
    const r = rig();
    expect(await r.ctl.stepUpPasskeyBegin()).toEqual({ ceremonyId: CEREMONY_HEX, options: '{"publicKey":{}}' });
    expect(await r.ctl.stepUpPasskeyFinish(CEREMONY_HEX, '{}')).toEqual({ token: 'su-2' });
    expect(r.routes.stepUpPasskeyFinish).toHaveBeenCalledWith(CEREMONY, '{}');
  });

  it('removeFactor maps the kind and the credential, and publishes before it resolves', async () => {
    const r = rig();
    expect(await r.ctl.removeFactor('su-1', 'passkey', 'abcdef')).toBeNull();
    expect(r.routes.removeFactor).toHaveBeenLastCalledWith('su-1', 1, CRED);
    expect(r.log).toEqual(['removeFactor', 'getFactors', 'publish:factors']);
    await r.ctl.removeFactor('su-2', 'totp', null);
    expect(r.routes.removeFactor).toHaveBeenLastCalledWith('su-2', 0, null);
  });

  it('regenerateBackupCodes publishes before it resolves and returns the codes', async () => {
    const r = rig();
    expect(await r.ctl.regenerateBackupCodes('su-1')).toEqual({ backupCodes: CODES });
    expect(r.log).toEqual(['regenerateBackupCodes', 'getFactors', 'publish:factors']);
  });

  it.each([
    ['E_STEP_UP', 403], ['E_NOT_FOUND', 404], ['E_INVALID_REQUEST', 409],
  ])('%s (%i) reads the factors again, then rethrows the refusal', async (code, status) => {
    const r = rig();
    const e = refused(status, code);
    r.routes.removeFactor.mockImplementationOnce(() => Promise.reject(e));
    await expect(r.ctl.removeFactor('su-1', 'totp', null)).rejects.toBe(e);
    expect(r.log).toEqual(['getFactors', 'publish:factors']);
    r.routes.regenerateBackupCodes.mockImplementationOnce(() => Promise.reject(e));
    await expect(r.ctl.regenerateBackupCodes('su-1')).rejects.toBe(e);
    expect(r.log).toEqual(['getFactors', 'publish:factors', 'getFactors', 'publish:factors']);
    r.routes.totpEnroll.mockImplementationOnce(() => Promise.reject(e));
    await expect(r.ctl.totpBegin('su-1')).rejects.toBe(e);
    r.routes.passkeyRegisterBegin.mockImplementationOnce(() => Promise.reject(e));
    await expect(r.ctl.passkeyBegin('su-1')).rejects.toBe(e);
    expect(r.routes.getFactors).toHaveBeenCalledTimes(4);
  });

  it('control: other refusals do not read the factors again, and a wrong confirm code keeps the page where it is', async () => {
    const r = rig();
    const e = refused(400, 'E_INVALID_REQUEST');
    r.routes.totpConfirm.mockImplementationOnce(() => Promise.reject(e));
    await expect(r.ctl.totpConfirm('000000')).rejects.toBe(e);
    const f = refused(403, 'E_FORBIDDEN');
    r.routes.removeFactor.mockImplementationOnce(() => Promise.reject(f));
    await expect(r.ctl.removeFactor('su-1', 'totp', null)).rejects.toBe(f);
    expect(r.routes.getFactors).not.toHaveBeenCalled();
    // A wrong step-up secret is the dialog's to show: no re-read.
    const w = refused(403, 'E_STEP_UP');
    r.routes.stepUp.mockImplementationOnce(() => Promise.reject(w));
    await expect(r.ctl.stepUp('password', 'nope')).rejects.toBe(w);
    expect(r.routes.getFactors).not.toHaveBeenCalled();
  });

  it('a failing re-read does not hide the refusal', async () => {
    const r = rig();
    const e = refused(409, 'E_INVALID_REQUEST');
    r.routes.removeFactor.mockImplementationOnce(() => Promise.reject(e));
    r.routes.getFactors.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await expect(r.ctl.removeFactor('su-1', 'totp', null)).rejects.toBe(e);
  });
});

describe('the factor validators', () => {
  const v = (m: keyof typeof FACTOR_VALIDATORS, c: Record<string, unknown>): string | null => FACTOR_VALIDATORS[m]?.(c) ?? null;
  const longName = 'x'.repeat(65);

  it('code is six digits', () => {
    expect(v('factorTotpConfirm', { code: '12345' })).toBe('code is not six digits');
    expect(v('factorTotpConfirm', { code: '12345a' })).toBe('code is not six digits');
    expect(v('factorTotpConfirm', { code: '1234567' })).toBe('code is not six digits');
    expect(v('factorTotpConfirm', { code: 123456 })).toBe('code is not six digits');
    expect(v('factorTotpConfirm', { code: '123456' })).toBeNull();
  });

  it('a backup-code secret is normalised before the 26-character check', () => {
    const bad = 'backup code is not 26 letters and digits';
    expect(v('stepUp', { method: 'backup', secret: 'AAAA' })).toBe(bad);
    expect(v('stepUp', { method: 'backup', secret: 'A1AAAAAAAAAAAAAAAAAAAAAAAA' })).toBe(bad);
    expect(v('stepUp', { method: 'backup', secret: 'aaaaa-aaaaa aaaaaaaaaaaaaaaa' })).toBeNull();
    expect(normaliseBackupCode('ab cd-2')).toBe('ABCD2');
  });

  it('stepUp checks the method and a non-empty secret; a totp secret is a code', () => {
    expect(v('stepUp', { method: 'sms', secret: 'x' })).toBe('method is not password, totp or backup');
    expect(v('stepUp', { method: 'password', secret: '' })).toBe('secret is empty');
    expect(v('stepUp', { method: 'password', secret: 'pw' })).toBeNull();
    expect(v('stepUp', { method: 'totp', secret: 'pw' })).toBe('code is not six digits');
    expect(v('stepUp', { method: 'totp', secret: '123456' })).toBeNull();
  });

  it('a passkey name is 1 to 64 characters without control characters', () => {
    const ok = { ceremonyId: CEREMONY_HEX, response: '{}', name: 'Laptop' };
    const bad = 'name must be 1 to 64 characters';
    expect(v('factorPasskeyFinish', ok)).toBeNull();
    expect(v('factorPasskeyFinish', { ...ok, name: '' })).toBe(bad);
    expect(v('factorPasskeyFinish', { ...ok, name: longName })).toBe(bad);
    expect(v('factorPasskeyFinish', { ...ok, name: 'a\nb' })).toBe(bad);
    expect(v('factorPasskeyFinish', { ...ok, name: 'x'.repeat(64) })).toBeNull();
    expect(v('factorPasskeyFinish', { ...ok, name: 7 })).toBe(bad);
    expect(v('factorPasskeyFinish', { ...ok, ceremonyId: 'ce' })).toBe('ceremonyId is not 32 lowercase hex');
    expect(v('factorPasskeyFinish', { ...ok, response: '' })).toBe('response is not a string of 1..65536 bytes');
  });

  it('credId is 2 to 2046 lowercase hex, for a passkey and only for a passkey; stepup is non-empty', () => {
    const bad = 'credId is not 2 to 2046 lowercase hex';
    expect(v('removeFactor', { stepup: 'su-1', kind: 'passkey', credId: 'ab' })).toBeNull();
    expect(v('removeFactor', { stepup: 'su-1', kind: 'passkey', credId: 'ab'.repeat(1023) })).toBeNull();
    expect(v('removeFactor', { stepup: 'su-1', kind: 'passkey', credId: 'ab'.repeat(1024) })).toBe(bad);
    expect(v('removeFactor', { stepup: 'su-1', kind: 'passkey', credId: 'a' })).toBe(bad);
    expect(v('removeFactor', { stepup: 'su-1', kind: 'passkey', credId: 'AB' })).toBe(bad);
    expect(v('removeFactor', { stepup: 'su-1', kind: 'passkey', credId: null })).toBe(bad);
    expect(v('removeFactor', { stepup: 'su-1', kind: 'totp', credId: 'ab' })).toBe('credId is for a passkey');
    expect(v('removeFactor', { stepup: 'su-1', kind: 'totp', credId: null })).toBeNull();
    expect(v('removeFactor', { stepup: 'su-1', kind: 'sms', credId: null })).toBe('kind is not totp or passkey');
    expect(v('removeFactor', { stepup: '', kind: 'totp', credId: null })).toBe('stepup is empty');
    expect(v('regenerateBackupCodes', { stepup: '' })).toBe('stepup is empty');
    expect(v('factorTotpBegin', { stepup: null })).toBeNull();
    expect(v('factorTotpBegin', { stepup: '' })).toBe('stepup is empty');
    expect(v('factorPasskeyBegin', { stepup: 5 })).toBe('stepup is empty');
  });
});

const answered = async (w: World, id: number): Promise<unknown> => { await vi.waitFor(() => expect(w.ret(id)).toBeDefined()); return w.ret(id); };

describe('the factor commands through the worker', () => {
  const FACTOR_COMMANDS = ['refreshFactors', 'factorTotpBegin', 'factorTotpConfirm', 'factorPasskeyBegin', 'factorPasskeyFinish'] as const;
  const READY_ONLY = ['stepUp', 'stepUpPasskeyBegin', 'stepUpPasskeyFinish', 'removeFactor', 'regenerateBackupCodes'] as const;

  it('ready accepts all ten; factor-setup accepts the five that enrol and read', () => {
    for (const m of [...FACTOR_COMMANDS, ...READY_ONLY]) expect(ACCEPTS.ready).toContain(m);
    for (const m of FACTOR_COMMANDS) expect(ACCEPTS['factor-setup']).toContain(m);
    for (const m of READY_ONLY) expect(ACCEPTS['factor-setup']).not.toContain(m);
    expect(ACCEPTS['factor-setup']).toEqual(expect.arrayContaining(['factorSetupDone', 'forgetBrowser']));
    expect(ACCEPTS['signin-login']).not.toContain('refreshFactors');
  });

  it('a malformed command is E_BAD_INPUT with its reason; the route is not called', async () => {
    const w = world();
    await toReady(w);
    const routes = Object.assign(w.routes, { totpConfirm: vi.fn(() => Promise.resolve(CODES)) });
    w.call(10, { m: 'factorTotpConfirm', code: '12' });
    expect(await answered(w, 10)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    w.call(11, { m: 'removeFactor', stepup: 'su-1', kind: 'passkey', credId: 'zz' });
    expect(await answered(w, 11)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(routes.totpConfirm).not.toHaveBeenCalled();
    w.call(12, { m: 'factorTotpConfirm', code: '123456' });
    expect(await answered(w, 12)).toEqual({ t: 'ret', id: 12, ok: true, value: { backupCodes: CODES } });
  });

  it('in ready, a command publishes the factors slice before its answer, and the answer holds the codes only', async () => {
    const w = world();
    await toReady(w);
    Object.assign(w.routes, { regenerateBackupCodes: vi.fn(() => Promise.resolve(CODES)) });
    w.routes.getFactors.mockImplementationOnce(() => Promise.resolve({ ...held, passkeys: [], backupCodesLeft: 12 }));
    const before = w.posted.length;
    w.call(20, { m: 'regenerateBackupCodes', stepup: 'su-1' });
    expect(await answered(w, 20)).toEqual({ t: 'ret', id: 20, ok: true, value: { backupCodes: CODES } });
    const mine = w.posted.slice(before);
    const slice = mine.findIndex((p) => p.t === 'slice' && p.name === 'factors');
    const ret = mine.findIndex((p) => p.t === 'ret' && p.id === 20);
    expect(slice).toBeGreaterThanOrEqual(0);
    expect(slice).toBeLessThan(ret);
    // Nothing secret is in any slice the worker published.
    expect(JSON.stringify(mine.filter((p) => p.t === 'slice'))).not.toContain(CODES[0]);
  });

  it('in factor-setup the enrol commands run, a step-up command is not accepted', async () => {
    const w = world({ phase: 2, owed: true });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('factor-setup'));
    Object.assign(w.routes, { totpEnroll: vi.fn(() => Promise.resolve({ secret: SECRET, uri: URI })) });
    w.call(2, { m: 'factorTotpBegin', stepup: null });
    expect(await answered(w, 2)).toEqual({ t: 'ret', id: 2, ok: true, value: { secret: SECRET, uri: URI } });
    w.call(3, { m: 'stepUp', method: 'password', secret: 'pw' });
    expect(await answered(w, 3)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY' } });
    w.call(4, { m: 'refreshFactors' });
    expect(await answered(w, 4)).toEqual({ t: 'ret', id: 4, ok: true, value: null });
  });

  it('a refused step-up reads the factors again before the refusal reaches the page', async () => {
    const w = world();
    await toReady(w);
    Object.assign(w.routes, { removeFactor: vi.fn(() => Promise.reject(refused(403, 'E_STEP_UP'))) });
    const reads = w.routes.getFactors.mock.calls.length;
    w.call(30, { m: 'removeFactor', stepup: 'su-1', kind: 'passkey', credId: toHex(CRED) });
    expect(await answered(w, 30)).toMatchObject({ ok: false, error: { code: 'E_STEP_UP' } });
    expect(w.routes.getFactors.mock.calls.length).toBe(reads + 1);
  });
});
