// What a refused factorSetupDone shows, by status and code (never by detail): the shared rows of FactorSetup (too many
// attempts, a dropped connection), else the generic line with the code.
import type { UiError } from '../../core/errors.ts';
import type { StringKey } from '../../strings/index.ts';
import { sharedRefusal } from './FactorSetup.tsx';

export interface DoneProblem { key: StringKey; vars: Record<string, string | number> }

export function doneProblem(e: UiError): DoneProblem {
  return sharedRefusal(e) ?? { key: 'factor.error.other', vars: { code: e.code } };
}
