export interface UiError {
  code: string;
  detail: string;
  status: number;
  retryAfterMs: number | null;
}

export function errorOf(e: unknown): UiError {
  if (typeof e === 'object' && e !== null) {
    const { code, detail, status, retryAfterMs } = e as Record<string, unknown>;
    if (typeof code === 'string') return {
      code,
      detail: typeof detail === 'string' ? detail : '',
      status: typeof status === 'number' ? status : 0,
      retryAfterMs: typeof retryAfterMs === 'number' ? retryAfterMs : null,
    };
  }
  return { code: 'E_UNKNOWN', detail: '', status: 0, retryAfterMs: null };
}
