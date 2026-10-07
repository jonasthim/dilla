import type { AccountState } from '@dilla/client-core';

export const INSTANCE: NonNullable<AccountState['instance']> = {
  id: 'aa'.repeat(16), name: 'dilla.test', registrationMode: 0, passwordSignup: false,
};
export const ME = { id: 'bb'.repeat(16), username: 'ada' };

export function account(over: Partial<AccountState> = {}): AccountState {
  return { phase: 'ready', instance: INSTANCE, user: ME, deviceId: 'cc'.repeat(16), recoveryKey: null, error: null, signIn: null, rootMismatch: false, ...over };
}
