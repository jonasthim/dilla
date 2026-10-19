import { afterEach, expect, it } from 'vitest';
import { captureViewPlace, restoreViewPlace, validViewPlace } from './update-view.ts';

afterEach(() => { document.body.replaceChildren(); });

function logFixture(busy = false): { log: HTMLDivElement; composer: HTMLTextAreaElement } {
  const main = document.createElement('main');
  main.className = 'd-app-shell__main';
  const log = document.createElement('div');
  log.className = 'd-message-log';
  log.setAttribute('role', 'log');
  if (busy) log.setAttribute('aria-busy', 'true');
  const container = document.createElement('div');
  container.className = 'd-composer';
  const composer = document.createElement('textarea');
  container.append(composer);
  main.append(log, container);
  document.body.append(main);
  return { log, composer };
}

it('restores scroll distance and keyboard focus after the log is ready', () => {
  const { log, composer } = logFixture();
  Object.defineProperties(log, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  log.scrollTop = 650;
  composer.focus();
  const saved = captureViewPlace();
  expect(saved).toEqual({ main: { fromBottom: 150 }, thread: null, focus: 'composer' });
  log.scrollTop = 0;
  expect(restoreViewPlace(saved)).toBe(true);
  expect(log.scrollTop).toBe(650);
  expect(composer).toHaveFocus();
});

it('waits until the log has loaded and rejects malformed places', () => {
  logFixture(true);
  const saved = { main: { fromBottom: 10 }, thread: null, focus: null } as const;
  expect(restoreViewPlace(saved)).toBe(false);
  expect(validViewPlace({ ...saved, main: { fromBottom: -1 } })).toBeNull();
});

it('waits for an older anchor and restores that message once history arrives', () => {
  const { log } = logFixture();
  Object.defineProperties(log, { scrollHeight: { value: 2000 }, clientHeight: { value: 200 } });
  const row = document.createElement('article');
  row.className = 'd-message-row';
  row.dataset.seq = '42';
  row.getBoundingClientRect = () => ({ top: 135, bottom: 175 } as DOMRect);
  log.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  log.append(row);
  log.scrollTop = 500;
  const saved = captureViewPlace();
  expect(saved.main?.anchor).toEqual({ seq: '42', offset: 35 });
  row.remove();
  expect(restoreViewPlace(saved)).toBe(false);
  log.append(row);
  row.getBoundingClientRect = () => ({ top: 160, bottom: 200 } as DOMRect);
  expect(restoreViewPlace(saved)).toBe(true);
  expect(log.scrollTop).toBe(525);
});
