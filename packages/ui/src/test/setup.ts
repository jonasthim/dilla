import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { axe } from 'vitest-axe';
expect.extend(axeMatchers);

export async function expectNoAxeViolations(container: Element) {
  const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout; contrast is guarded by design-tokens
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
}
