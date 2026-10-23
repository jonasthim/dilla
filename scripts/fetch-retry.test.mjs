import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry } from './fetch-retry.mjs';

const ok = (text) => ({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer) });
const bad = (status) => ({ ok: false, status, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });

test('a download that fails twice and then works is returned, after waiting 1 s and 2 s', async () => {
  const waits = [];
  const replies = [() => Promise.reject(new Error('network down')), () => Promise.resolve(bad(503)), () => Promise.resolve(ok('data'))];
  let calls = 0;
  const body = await fetchWithRetry('https://example.test/x', { fetchImpl: () => replies[calls++](), wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
  assert.equal(body.toString(), 'data');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('a download that fails 3 times is an error naming the URL and the last failure', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry('https://example.test/x', { fetchImpl: () => { calls++; return Promise.resolve(bad(500)); }, wait: () => Promise.resolve() }),
    /https:\/\/example\.test\/x: failed after 3 attempts: https:\/\/example\.test\/x: 500/,
  );
  assert.equal(calls, 3);
});

test('a download that works at once is not retried and not waited for', async () => {
  let waited = false;
  await fetchWithRetry('https://example.test/x', { fetchImpl: () => Promise.resolve(ok('x')), wait: () => { waited = true; return Promise.resolve(); } });
  assert.equal(waited, false);
});
