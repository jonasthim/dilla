import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_SHOTS, DOC_VIEWPORTS, shootNamedState } from './shoot-docs.mjs';

test('new guide images have unique state names and the required real viewport sizes', () => {
  assert.deepEqual(DOC_VIEWPORTS, { desktop: { width: 1280, height: 800 }, phone: { width: 360, height: 740 } });
  const names = DOC_SHOTS.map(shot => shot.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    'trust-privacy-desktop', 'trust-privacy-phone', 'trust-changed-desktop', 'trust-changed-phone',
    'search-results-desktop', 'search-results-phone', 'settings-diagnostics-desktop',
    'settings-diagnostics-phone', 'tabs-handover-desktop', 'tabs-handover-phone',
  ]);
  for (const shot of DOC_SHOTS) {
    assert.match(shot.state, /^\[data-doc-state="[a-z-]+"\]$/);
    assert.ok(!/key|token|body|secret/i.test(shot.name));
  }
});

test('waits for the state and closes the owned context after a failed capture', async () => {
  const order = [];
  const context = { close: async () => { order.push('close'); } };
  const page = {
    waitForSelector: async (selector) => { assert.equal(selector, '[data-doc-state="trust-privacy"]'); order.push('wait'); },
    screenshot: async () => { order.push('shot'); throw new Error('capture failed'); },
  };
  await assert.rejects(shootNamedState({ context, page, state: '[data-doc-state="trust-privacy"]', outFile: '/tmp/trust-privacy-desktop.png' }), /capture failed/);
  assert.deepEqual(order, ['wait', 'shot', 'close']);
});
