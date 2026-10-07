import { CoreError, type CorePort, type Id } from '../core-port';
import { DillaHttpError } from '../http/errors';
import type { EstablishedSession, Routes } from '../http/routes';

export const RENEW_MARGIN_S = 3600;
export class Session {
  private inflight: Promise<boolean> | null = null;
  constructor(private readonly deps: { core: CorePort; routes: Routes; now(): number }) {}
  token(): string | null { return this.deps.core.session()?.token ?? null; }
  establish(): Promise<boolean> {
    if (this.inflight !== null) return this.inflight;
    const run = this.establishOnce();
    this.inflight = run;
    void run.finally(() => { this.inflight = null; }).catch(() => undefined);
    return run;
  }
  private async attempt(deviceId: Id): Promise<EstablishedSession | null> {
    const { nonce } = await this.deps.routes.postChallenge(deviceId);
    const body = this.deps.core.sessionSign(nonce, 0);
    try { return await this.deps.routes.postSession(deviceId, body); }
    catch (err) {
      if (err instanceof DillaHttpError && err.status === 401) return null;
      throw err;
    }
  }
  private async establishOnce(): Promise<boolean> {
    const id = this.deps.core.identity();
    if (id.phase === 0 || id.deviceId === null) throw new CoreError('E_CORE_NO_IDENTITY', '');
    let result = await this.attempt(id.deviceId);
    if (result === null) result = await this.attempt(id.deviceId);
    if (result === null) {
      if (this.deps.core.identity().phase === 2) this.deps.core.sessionClear();
      return false;
    }
    // An enrolment (phase 3) holds a pending session. So does phase 2 while the own list is unpublished (fix-wave review
    // NEW-1): the instance enrols the row only once a list names it, so a session cut before that list PUT re-establishes
    // pending, and that is this enrolment's own session, not a revocation. Past the publication only scope 0 is accepted.
    const current = this.deps.core.identity();
    const accepted = id.phase === 3 ? [1] : current.phase === 2 && !current.listPublished ? [0, 1] : [0];
    if (!accepted.includes(result.scope)) throw new Error('E_SESSION_SCOPE');
    this.deps.core.sessionStore({ token: result.token, expires: result.expires, idleExpires: result.idleExpires });
    return true;
  }
  async ensure(): Promise<boolean> {
    const nowS = BigInt(Math.floor(this.deps.now() / 1000));
    const record = this.deps.core.session();
    if (record === null || record.expires - nowS <= BigInt(RENEW_MARGIN_S) ||
      record.idleExpires - nowS <= BigInt(RENEW_MARGIN_S)) return this.establish();
    return true;
  }
}
