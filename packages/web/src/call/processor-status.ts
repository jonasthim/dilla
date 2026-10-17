import type { ProcessorStatus } from '@dilla/media';
let owner: symbol | null = null;
let status: ProcessorStatus | null = null;
const listeners = new Set<() => void>();
export const getProcessorStatus = (): ProcessorStatus | null => status;
export const subscribeProcessorStatus = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function reportProcessorStatus(id: symbol, value: ProcessorStatus | null): void {
  if (value === null && owner !== id) return;
  owner = value === null ? null : id; status = value;
  for (const listener of listeners) listener();
}
