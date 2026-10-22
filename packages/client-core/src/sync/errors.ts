export type SyncErrorCode = 'E_SYNC_STOPPED' | 'E_REGISTER_RACE' | 'E_CHANNEL_GONE';

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly detail: string;

  constructor(code: SyncErrorCode, detail = '') {
    super(detail === '' ? code : `${code}: ${detail}`);
    this.name = 'SyncError';
    this.code = code;
    this.detail = detail;
  }
}

/** The core's verdicts on a leaf that failed against its user's cached signed list. A newer list can clear them (a device
 *  that joined before the list naming it was ingested), so a send refused by one refreshes the group's trust once.
 *  E_DEVICE_REVOKED (a device its user removed) is one too: its leaf blocks like an unlisted one, though the messages it
 *  sent stay shut for good (trust.rs apply_verdict). */
export const LEAF_VERDICTS: ReadonlySet<string> = new Set(['E_DEVICE_UNLISTED', 'E_DEVICE_REVOKED', 'E_CREDENTIAL', 'E_TIER_MISMATCH']);

/** Every failed-leaf verdict, a changed key included: a proposed Add refused by one is left out of the commit. */
export const FAILED_LEAF: ReadonlySet<string> = new Set([...LEAF_VERDICTS, 'E_UMK_CHANGED']);
