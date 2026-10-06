import '@testing-library/jest-dom/vitest';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { axe } from 'vitest-axe';
expect.extend(axeMatchers);

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
}

afterEach(() => { if (typeof window !== 'undefined') window.history.replaceState(null, '', '/'); });

export async function expectNoAxeViolations(container: Element) {
  const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
}
