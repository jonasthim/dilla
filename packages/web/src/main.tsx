import '@dilla/ui/base.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connectCore, createCoreWorker } from '@dilla/client-core';
import { App } from './App.tsx';
import { CoreProvider } from './core/context.tsx';
import type { UiError } from './core/errors.ts';
import { readTheme } from './prefs.ts';
import { applyPreference } from './theme.ts';

applyPreference(window, await readTheme());
const worker = createCoreWorker();
const client = connectCore(worker);
const element = document.getElementById('root');
if (!element) throw new Error('dilla: #root is missing');
const root = createRoot(element);
const show = (fatal: UiError | null) => root.render(<StrictMode><CoreProvider client={client}><App fatal={fatal} /></CoreProvider></StrictMode>);
show(null);
worker.addEventListener('error', e => {
  e.preventDefault();
  show({ code: 'E_WORKER', detail: '', status: 0, retryAfterMs: null });
}, { once: true });
