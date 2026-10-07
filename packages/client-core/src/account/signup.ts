import { arr, decode, u64 } from '../cbor';
import { CoreError, type CorePort, type Id } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { DeviceListRecord, Routes } from '../http/routes';
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

export const DEVICE_LIST_HISTORY_PAGE = 64;

/** Adopt history after the accepted list up to the newest version served by this instance. */
export async function adoptServedList(core: CorePort, routes: Routes, userId: Id, served: DeviceListRecord | null):
  Promise<{ version: bigint; listed: boolean }> {
  const own = core.ownDeviceList();
  const deviceId = core.identity().deviceId;
  let result = { version: own.version, listed: deviceId !== null && own.entries.some((entry) =>
    toHex(entry.deviceId) === toHex(deviceId) && entry.revokedAt === null) };
  if (served === null || served.version <= own.version) return result;
  let after = own.version;
  for (;;) {
    const page = await routes.getDeviceListHistory(userId, after);
    if (page.count === 0) return result;
    result = core.ownDeviceListUpdate(page.raw);
    if (page.count < DEVICE_LIST_HISTORY_PAGE || result.version >= served.version || result.version <= after) return result;
    after = result.version;
  }
}

export async function publishDeviceList(core: CorePort, routes: Routes): Promise<void> {
  const id = core.identity();
  if (id.listPublished) return;
  if (id.phase !== 2 || id.userId === null) throw new CoreError('E_CORE_NO_IDENTITY', '');
  try { await routes.putDeviceList(id.userId, core.deviceListBody()); }
  catch (err) {
    if (!(err instanceof DillaHttpError) || err.status !== 409) throw err;
    const served = await routes.getDeviceList(id.userId);
    if (served === null) throw err;
    const candidateVersion = u64(arr(decode(core.deviceListBody()), 4)[0] ?? null);
    if (served.version < candidateVersion) throw err;
    const result = await adoptServedList(core, routes, id.userId, served);
    if (!result.listed) throw new Error('E_DEVICE_UNLISTED');
    if (!core.identity().listPublished) core.deviceListPublished();
    return;
  }
  core.deviceListPublished();
}
