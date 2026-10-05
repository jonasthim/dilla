import type { CorePort } from '../core-port';
import type { Routes } from '../http/routes';

export async function refillKeyPackages(core: CorePort, routes: Routes, remaining: number,
  limits: { perDevice: number; threshold: number }): Promise<number> {
  if (remaining >= limits.threshold) return 0;
  const count = Math.min(limits.perDevice - remaining, 32);
  await routes.postKeyPackages(core.keyPackages(count, remaining === 0));
  return count;
}
