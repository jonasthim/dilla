// The guard's allowance for WebKit's cancelled-fetch line is narrow: this pins its edges (no browser needed).
import { expect, test } from '@playwright/test';
import { isNavigationAbortLine } from './support/abort-line';

const LINE = 'Fetch API cannot load http://127.0.0.1:8615/v1/communities/4e3afcf66bed1f0d6af63d4e443dc4ef/members due to access control checks.';

test('the cancelled-fetch line within 3 s of a navigation is dropped', () => {
  expect(isNavigationAbortLine(LINE, 'webkit-web', 11_000, 10_000)).toBe(true);
  expect(isNavigationAbortLine(LINE, 'webkit-web', 13_000, 10_000)).toBe(true);
});
test('the same line 5 s after it is counted, and so is one with no navigation seen', () => {
  expect(isNavigationAbortLine(LINE, 'webkit-web', 15_000, 10_000)).toBe(false);
  expect(isNavigationAbortLine(LINE, 'webkit-web', 10_000, null)).toBe(false);
});
test('the same line on chromium or firefox is counted', () => {
  expect(isNavigationAbortLine(LINE, 'chromium-web', 10_500, 10_000)).toBe(false);
  expect(isNavigationAbortLine(LINE, 'firefox-web', 10_500, 10_000)).toBe(false);
});
test('a slightly different line inside the window is counted', () => {
  for (const other of [
    LINE.replace(' due to access control checks.', ' due to access control checks'),
    LINE.replace('http://127.0.0.1:8615/v1/', 'http://example.com/v1/'),
    LINE.replace('/v1/', '/other/'),
    LINE.replace('Fetch API', 'XMLHttpRequest'),
    `${LINE} `,
    `Failed to load resource: ${LINE}`,
  ]) expect(isNavigationAbortLine(other, 'webkit-web', 10_500, 10_000), other).toBe(false);
});
