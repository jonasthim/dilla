import { CoreError, type CorePort, type Id } from '../core-port';
import { DillaHttpError } from '../http/errors';
import type { Routes } from '../http/routes';
import { refillKeyPackages } from './keypackages';
import type { Session } from './session';

export class Signup {
  constructor(private readonly deps: { core: CorePort; routes: Routes; session: Session; now(): number }) {}
  begin(instanceId: Id): string[] {
    const rk = this.deps.core.signupBegin(instanceId);
    if (rk.length !== 52) throw new CoreError('E_CORE_DECODE', 'recovery key length');
    return Array.from({ length: 13 }, (_, i) => rk.slice(i * 4, i * 4 + 4));
  }
  async submit(input: { invite: string; username: string; display: string; password: string | null }): Promise<void> {
    const { core, routes } = this.deps;
    const body = core.signupRequest(input.invite, input.username, input.display, input.password);
    const acc = await routes.postAccount(body);
    core.sessionStore({ token: acc.token, expires: acc.expires, idleExpires: acc.expires });
    core.signupComplete(acc.userId, input.username, this.nowS());
    await publishDeviceList(core, routes);
    const limits = await routes.getLimits();
    await refillKeyPackages(core, routes, 0, { perDevice: limits.keypackagesPerDevice, threshold: limits.keypackageRefillThreshold });
  }
  async resume(): Promise<0 | 2 | 'revoked'> {
    const { core, routes, session } = this.deps;
    const phase = core.identity().phase;
    if (phase === 0 || phase === 2) return phase;
    if (!(await session.establish())) {
      if (core.session() !== null) return 'revoked';
      core.signupReset();
      return 0;
    }
    const me = await routes.getAccountMe();
    core.signupComplete(me.userId, me.username, this.nowS());
    await publishDeviceList(core, routes);
    const limits = await routes.getLimits();
    await refillKeyPackages(core, routes, 0, { perDevice: limits.keypackagesPerDevice, threshold: limits.keypackageRefillThreshold });
    return 2;
  }
  private nowS(): bigint { return BigInt(Math.floor(this.deps.now() / 1000)); }
}

export async function publishDeviceList(core: CorePort, routes: Routes): Promise<void> {
  const id = core.identity();
  if (id.listPublished) return;
  if (id.phase !== 2 || id.userId === null) throw new CoreError('E_CORE_NO_IDENTITY', '');
  try { await routes.putDeviceList(id.userId, core.deviceListBody()); }
  catch (err) {
    if (!(err instanceof DillaHttpError) || err.status !== 409) throw err;
    const current = await routes.getDeviceList(id.userId);
    if (current === null || current.version < 1n) throw err;
  }
  core.deviceListPublished();
}
