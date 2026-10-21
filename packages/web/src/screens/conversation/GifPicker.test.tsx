import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { Command } from '@dilla/client-core';
import { refusal } from '../../test/fake-client.ts';
import { account, INSTANCE } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { GEN, renderConversation, stubBlobUrls } from '../../test/conversation.tsx';

const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const gifBlob = () => new Blob([GIF_BYTES], { type: 'image/gif' });
const page = (ids: string[], next: number | null = null) => ({
  items: ids.map(id => ({ id, title: `title ${id}`, width: 200, height: 113 })), next,
});

let blobs: ReturnType<typeof stubBlobUrls>;
beforeEach(() => { blobs = stubBlobUrls(); });
afterEach(() => { cleanup(); blobs.restore(); });
const bytesOf = (f: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => { resolve(new Uint8Array(r.result as ArrayBuffer)); };
  r.onerror = () => { reject(new Error('read')); };
  r.readAsArrayBuffer(f);
});

function open(over: { gifs?: boolean; handler?: (c: Command) => Promise<unknown> } = {}) {
  const searches: { q: string; offset: number }[] = [];
  const handler = over.handler ?? ((c: Command): Promise<unknown> => {
    if (c.m === 'gifSearch') {
      searches.push({ q: c.q, offset: c.offset });
      return Promise.resolve(page(c.q === 'cat' ? ['c1', 'c2'] : c.offset > 0 ? ['m1', 'm2', 'm3'] : ['t1', 't2', 't3'], c.offset === 0 && c.q === '' ? 3 : null));
    }
    if (c.m === 'gifFetch') return Promise.resolve({ blob: gifBlob() });
    if (c.m === 'attachFiles') return Promise.resolve({ trayIds: ['tray-1'] });
    return Promise.resolve(null);
  });
  const r = renderConversation({
    handler,
    before: fake => fake.set('account', account({ instance: { ...INSTANCE, gifs: over.gifs ?? true } })),
  });
  return { ...r, searches };
}

const button = () => screen.getByRole('button', { name: 'add a gif' });
const dialog = () => screen.getByRole('dialog', { name: 'gifs' });
const cells = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-gif-id]'));

describe('the gif button (E8)', () => {
  it('is absent when the instance has no Giphy key', () => {
    open({ gifs: false });
    expect(screen.queryByRole('button', { name: 'add a gif' })).toBeNull();
    expect(screen.getByRole('button', { name: 'attach files' })).toBeInTheDocument();
  });

  it('is present, closed, when the instance has a key; opening it asks for trending and focuses the search box', async () => {
    const { user, fake, searches } = open();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    await user.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog()).getByRole('searchbox', { name: 'search gifs' })).toHaveFocus();
    await waitFor(() => expect(cells()).toHaveLength(3));
    expect(searches).toEqual([{ q: '', offset: 0 }]);
    expect(fake.callsOf('gifSearch')).toHaveLength(1);
    expect(screen.getByText('Powered by GIPHY')).toBeInTheDocument();
    expect(cells().map(c => c.getAttribute('aria-label'))).toEqual(['title t1', 'title t2', 'title t3']);
  });
});

describe('previews and privacy', () => {
  it('shows every preview from a page-minted blob URL fetched through the worker, and never a giphy.com address', async () => {
    const { user, fake } = open();
    await user.click(button());
    await waitFor(() => expect(document.querySelectorAll('.d-gif-picker img')).toHaveLength(3));
    const srcs = Array.from(document.querySelectorAll('.d-gif-picker img')).map(i => i.getAttribute('src'));
    expect(srcs.every(s => s !== null && s.startsWith('blob:test/'))).toBe(true);
    expect(fake.callsOf('gifFetch').map(c => [c.gifId, c.variant])).toEqual([['t1', 'preview'], ['t2', 'preview'], ['t3', 'preview']]);
    expect(document.body.innerHTML).not.toContain('giphy.com');
  });

  it('revokes the preview URLs when the picker closes', async () => {
    const { user } = open();
    await user.click(button());
    await waitFor(() => expect(blobs.created).toHaveLength(3));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'gifs' })).toBeNull();
    await waitFor(() => expect([...blobs.revoked].sort()).toEqual([...blobs.created].sort()));
  });
});

describe('searching', () => {
  it('searches what is typed after a short pause, and shows only the newest answer', async () => {
    const { user, searches } = open();
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(3));
    await user.type(within(dialog()).getByRole('searchbox'), 'cat');
    await waitFor(() => expect(cells().map(c => c.getAttribute('data-gif-id'))).toEqual(['c1', 'c2']));
    // One search for the whole word, not one per key.
    expect(searches.map(s => s.q)).toEqual(['', 'cat']);
  });

  it('ignores a slow answer to an older search', async () => {
    const pending = new Map<string, (v: unknown) => void>();
    const { user } = open({
      handler: c => {
        if (c.m === 'gifSearch') return new Promise(resolve => { pending.set(c.q, resolve); });
        if (c.m === 'gifFetch') return Promise.resolve({ blob: gifBlob() });
        return Promise.resolve(null);
      },
    });
    await user.click(button());
    await waitFor(() => expect(pending.has('')).toBe(true));
    await user.type(within(dialog()).getByRole('searchbox'), 'cat');
    await waitFor(() => expect(pending.has('cat')).toBe(true));
    await act(async () => { pending.get('cat')?.(page(['c1'])); await Promise.resolve(); });
    await act(async () => { pending.get('')?.(page(['stale'])); await Promise.resolve(); });
    await waitFor(() => expect(cells().map(c => c.getAttribute('data-gif-id'))).toEqual(['c1']));
  });

  it('loads the next page under "more" and appends it', async () => {
    const { user, searches } = open();
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(3));
    await user.click(within(dialog()).getByRole('button', { name: 'more' }));
    await waitFor(() => expect(cells()).toHaveLength(3 + 3));
    expect(searches).toEqual([{ q: '', offset: 0 }, { q: '', offset: 3 }]);
    expect(within(dialog()).queryByRole('button', { name: 'more' })).toBeNull();
  });

  it('says so when nothing matches', async () => {
    const { user } = open({ handler: c => Promise.resolve(c.m === 'gifSearch' ? page([]) : null) });
    await user.click(button());
    await waitFor(() => expect(within(dialog()).getByRole('status')).toHaveTextContent('no gifs for that'));
  });

  it('says so when the instance refuses, and keeps the picker open', async () => {
    const { user } = open({ handler: c => c.m === 'gifSearch' ? Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 })) : Promise.resolve(null) });
    await user.click(button());
    await waitFor(() => expect(within(dialog()).getByText('could not reach the gif service')).toBeInTheDocument());
    expect(dialog()).toBeInTheDocument();
  });
});

describe('picking', () => {
  it('downloads the full GIF through the worker and adds it to the tray as image/gif, without sending anything', async () => {
    const { user, fake } = open();
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(3));
    await user.click(cells()[1]);
    await waitFor(() => expect(fake.callsOf('attachFiles')).toHaveLength(1));
    expect(fake.callsOf('gifFetch').filter(c => c.variant === 'full').map(c => c.gifId)).toEqual(['t2']);
    const [call] = fake.callsOf('attachFiles');
    expect(call).toMatchObject({ m: 'attachFiles', channelId: GEN });
    expect(call?.files).toHaveLength(1);
    const f = call.files[0];
    expect(f).toBeInstanceOf(File);
    expect(f.name).toBe('giphy-t2.gif');
    expect(f.type).toBe('image/gif');
    expect(await bytesOf(f)).toEqual(GIF_BYTES);
    expect(fake.callsOf('send')).toEqual([]);
    // The picker closes and the message box takes focus, so Enter sends the tray.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'gifs' })).toBeNull());
    expect(screen.getByRole('textbox', { name: 'message #general' })).toHaveFocus();
  });

  it('keeps the picker open and says so when the download fails', async () => {
    const { user, fake } = open({
      handler: c => {
        if (c.m === 'gifSearch') return Promise.resolve(page(['t1']));
        if (c.m === 'gifFetch') return c.variant === 'full' ? Promise.reject(refusal({ code: 'E_UNAVAILABLE', status: 503 })) : Promise.resolve({ blob: gifBlob() });
        return Promise.resolve(null);
      },
    });
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(1));
    await user.click(cells()[0]);
    await waitFor(() => expect(within(dialog()).getByText('could not add that gif')).toBeInTheDocument());
    expect(fake.callsOf('attachFiles')).toEqual([]);
  });

  it('ignores a second pick while one is downloading', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { user, fake } = open({
      handler: c => {
        if (c.m === 'gifSearch') return Promise.resolve(page(['t1', 't2']));
        if (c.m === 'gifFetch' && c.variant === 'full') return new Promise(resolve => { release = resolve; });
        if (c.m === 'gifFetch') return Promise.resolve({ blob: gifBlob() });
        if (c.m === 'attachFiles') return Promise.resolve({ trayIds: ['x'] });
        return Promise.resolve(null);
      },
    });
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(2));
    await user.click(cells()[0]);
    await user.click(cells()[1]);
    expect(fake.callsOf('gifFetch').filter(c => c.variant === 'full')).toHaveLength(1);
    await act(async () => { release({ blob: gifBlob() }); await Promise.resolve(); });
    await waitFor(() => expect(fake.callsOf('attachFiles')).toHaveLength(1));
  });
});

describe('keyboard and focus', () => {
  it('Escape closes the picker and returns focus to the gif button', async () => {
    const { user } = open();
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(3));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'gifs' })).toBeNull();
    expect(button()).toHaveFocus();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });

  it('the button toggles: a second activation closes it', async () => {
    const { user } = open();
    await user.click(button());
    expect(dialog()).toBeInTheDocument();
    await user.click(button());
    expect(screen.queryByRole('dialog', { name: 'gifs' })).toBeNull();
  });

  it('has no serious axe violations open', async () => {
    const { user } = open();
    await user.click(button());
    await waitFor(() => expect(cells()).toHaveLength(3));
    await expectNoAxeViolations(document.body);
  });
});
