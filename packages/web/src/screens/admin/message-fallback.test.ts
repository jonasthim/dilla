import { afterEach, describe, expect, it } from 'vitest';
import { messageFallback } from './MemberCardHost.tsx';

afterEach(() => { document.body.replaceChildren(); });

const row = (host: HTMLElement) => {
  const r = document.createElement('article');
  r.className = 'd-message-row';
  r.dataset.msgId = 'm1';
  host.appendChild(r);
  return r;
};

describe('messageFallback (N2)', () => {
  it('picks the row inside the container the card was opened from, not the first row in the document', () => {
    const log = document.createElement('div');
    log.setAttribute('role', 'log');
    const pane = document.createElement('aside');
    document.body.append(log, pane);
    row(log);
    const inPane = row(pane);
    const anchor = document.createElement('button');
    expect(messageFallback({ id: 'u', source: 'author', anchor, rowId: 'm1', scope: pane })()).toBe(inPane);
  });
  it('falls back to the log when the row is gone, and to the first row without a scope', () => {
    const log = document.createElement('div');
    log.setAttribute('role', 'log');
    document.body.append(log);
    const anchor = document.createElement('button');
    expect(messageFallback({ id: 'u', source: 'author', anchor, rowId: 'zz' })()).toBe(log);
    const only = row(log);
    expect(messageFallback({ id: 'u', source: 'author', anchor, rowId: 'm1' })()).toBe(only);
  });
});
