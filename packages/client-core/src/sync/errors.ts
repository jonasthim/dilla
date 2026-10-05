export type SyncErrorCode = 'E_SYNC_STOPPED' | 'E_REGISTER_RACE' | 'E_CHANNEL_GONE' | 'E_NO_COMMUNITY';

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
