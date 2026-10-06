/** The second-browser enrolment (L-TS-21): host login, a pending registration, the sealed objects, the recovery key, list v+1; and the upload of sealed objects on every ready. */
import { CoreError, type CorePort, type Id } from '../core-port';
import { DillaHttpError } from '../http/errors';
import type { Routes } from '../http/routes';
import type { Session } from './session';
import { adoptServedList, publishDeviceList } from './signup';

export interface EnrolFetched { root: Uint8Array; state: Uint8Array; listBody: Uint8Array }

export class Enrol {
  private assertion: string | null = null;
  private factorOwed = false;
  constructor(private readonly deps: { core: CorePort; routes: Routes; session: Session; now(): number }) {}

  private take(requireNoFactor: boolean): string {
    if (this.assertion === null || this.factorOwed === requireNoFactor) throw new Error('E_NO_ASSERTION');
    const assertion = this.assertion;
    this.assertion = null;
    this.factorOwed = false;
    return assertion;
  }

  async login(username: string, password: string): Promise<{ needsTotp: boolean }> {
    this.assertion = null;
    this.factorOwed = false;
    const answer = await this.deps.routes.passwordLogin(username, password);
    this.assertion = answer.assertion;
    this.factorOwed = answer.needsTotp;
    return { needsTotp: answer.needsTotp };
  }

  async totp(code: string): Promise<void> {
    const assertion = this.take(false);
    const answer = await this.deps.routes.totpVerify(assertion, code);
    this.assertion = answer.assertion;
    this.factorOwed = false;
  }

  async register(instanceId: Id): Promise<{ userId: Id }> {
    const assertion = this.take(true);
    const { core, routes } = this.deps;
    const id = core.identity();
    let deviceId: Id;
    if (id.phase === 0) deviceId = core.enrolBegin(instanceId).deviceId;
    else if (id.phase === 3 && id.userId === null && id.deviceId !== null) deviceId = id.deviceId;
    else throw new CoreError('E_CORE_STATE', 'register needs phase 0 or an unregistered enrolment');
    const { nonce } = await routes.postChallenge(deviceId);
    const login = new TextEncoder().encode(assertion);
    let body: Uint8Array;
    try { body = core.enrolSessionSign(nonce, login); }
    finally { login.fill(0); }
    const answer = await routes.postSessionPending(deviceId, body);
    if (answer.scope !== 1) throw new Error('E_SESSION_SCOPE');
    core.sessionStore({ token: answer.token, expires: answer.expires, idleExpires: answer.idleExpires });
    core.enrolRegistered(answer.userId);
    return { userId: answer.userId };
  }

  async fetch(userId: Id): Promise<EnrolFetched> {
    const { routes } = this.deps;
    const root = await routes.getBackup(0);
    if (root === null) throw new Error('E_NO_BACKUP');
    const state = await routes.getBackup(1);
    const list = await routes.getDeviceList(userId);
    if (list === null) throw new Error('E_NO_BACKUP');
    return { root: root.object, state: state?.object ?? new Uint8Array(0), listBody: list.raw };
  }

  async complete(recoveryKey: string, fetched: EnrolFetched, username: string): Promise<void> {
    const { core, routes, session } = this.deps;
    const { stateSealed } = core.enrolComplete({ recoveryKey, rootSealed: fetched.root, stateSealed: fetched.state,
      listBody: fetched.listBody, username, now: BigInt(Math.floor(this.deps.now() / 1000)) });
    try { await publishDeviceList(core, routes); }
    catch (err) {
      if (err instanceof Error && err.message === 'E_DEVICE_UNLISTED') throw new Error('E_LIST_RACE');
      throw err;
    }
    if (!(await session.establish())) throw new Error('E_SESSION_SCOPE');
    await routes.putBackup(1, stateSealed);
    core.stateSealedUploaded();
  }

  reset(): void {
    this.assertion = null;
    this.factorOwed = false;
    if (this.deps.core.identity().phase === 3) this.deps.core.enrolReset();
  }
}

export async function refreshOwnDeviceList(core: CorePort, routes: Routes, userId: Id):
  Promise<{ version: bigint; listed: boolean }> {
  return adoptServedList(core, routes, userId, await routes.getDeviceList(userId));
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

export async function ensureBackups(core: CorePort, routes: Routes): Promise<void> {
  const rows = await routes.listBackups();
  const sealed = core.sealedObjects();
  if (!rows.some((row) => row.kind === 0) && sealed.root !== null) {
    try { await routes.putBackup(0, sealed.root); }
    catch (err) {
      if (!(err instanceof DillaHttpError) || err.status !== 409) throw err;
      const stored = await routes.getBackup(0);
      if (stored === null || !same(stored.object, sealed.root)) throw new Error('E_ROOT_MISMATCH');
    }
  }
  if (sealed.state === null) return;
  const listed = rows.some((row) => row.kind === 1);
  const storedState = listed && sealed.stateUploaded ? await routes.getBackup(1) : null;
  if (!listed || !sealed.stateUploaded || storedState === null) {
    await routes.putBackup(1, sealed.state);
    core.stateSealedUploaded();
  }
}
