export interface UiError {
  code: string;
  detail: string;
  status: number;
  retryAfterMs: number | null;
  /** A stable key for a refusal the worker made itself (client-core `WorkerError.reason`); never the instance's detail. */
  reason?: string;
}

export function errorOf(e: unknown): UiError {
  if (typeof e === 'object' && e !== null) {
    const { code, detail, status, retryAfterMs, reason } = e as Record<string, unknown>;
    if (typeof code === 'string') return {
      code,
      detail: typeof detail === 'string' ? detail : '',
      status: typeof status === 'number' ? status : 0,
      retryAfterMs: typeof retryAfterMs === 'number' ? retryAfterMs : null,
      ...(typeof reason === 'string' ? { reason } : {}),
    };
  }
  return { code: 'E_UNKNOWN', detail: '', status: 0, retryAfterMs: null };
}
