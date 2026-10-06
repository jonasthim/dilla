/// <reference lib="webworker" />
import { startCoreWorker } from './runtime';

// lib.webworker types self as WorkerGlobalScope & typeof globalThis, which already satisfies the parameter.
startCoreWorker(self, { testHooks: false });
