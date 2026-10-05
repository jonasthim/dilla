// DEV-66: compiled by `npm run typecheck -w @dilla/media` (tsc --noEmit), never run. It stops compiling the day
// DillaE2EEManager no longer satisfies livekit-client 2.22.3's BaseE2EEManager (the monthly-upgrade gate).
import type { BaseE2EEManager } from 'livekit-client';
import { DillaE2EEManager } from '../src/manager';

declare const worker: Worker;
export const manager: BaseE2EEManager = new DillaE2EEManager(worker);
