// What a refused factorSetupDone shows, by status and code (never by detail): nothing when the account still owes a
// factor (FactorSetup goes back to the choice, whose own copy says so), the shared rows of FactorSetup (too many
// attempts, a dropped connection), else the generic line with the code.
import type { UiError } from '../../core/errors.ts';
import type { StringKey } from '../../strings/index.ts';
import { sharedRefusal, stillOwed } from './FactorSetup.tsx';

export interface DoneProblem { key: StringKey; vars: Record<string, string | number> }

export function doneProblem(e: UiError): DoneProblem | null {
  if (stillOwed(e)) return null;
  return sharedRefusal(e) ?? { key: 'factor.error.other', vars: { code: e.code } };
}
