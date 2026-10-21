import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { GEN, P1, file, image, peerRow } from '../../test/conversation.tsx';
import type { AttachmentSummary } from '@dilla/client-core';
import { AttachmentList, GIF_AUTOPLAY_MAX, GIF_PLAY_MS } from './Attachments.tsx';

// A GIF card plays its full blob for five minutes from the first sighting (flow 04), never fetching before that.
const gif = (over: Partial<AttachmentSummary> = {}) => image({ name: 'dance.gif', mime: 'image/gif', size: 400_000, ...over });
const blobOf = (type: string) => new Blob([new Uint8Array([1, 2, 3])], { type });

interface Watcher { cb: IntersectionObserverCallback; target: Element | null; live: boolean }
let watchers: Watcher[] = [];
let reduced = false;
let seqCounter = 100;
const nextSeq = () => String(seqCounter++);

class FakeObserver {
  readonly w: Watcher;
  constructor(cb: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { this.w = { cb, target: null, live: true }; watchers.push(this.w); }
  observe(el: Element) { this.w.target = el; }
  disconnect() { this.w.live = false; }
  unobserve() { this.w.live = false; }
  takeRecords() { return []; }
}
/** Report the card as at least half visible (or not) to every live observer. */
const see = (visible = true) => act(() => {
  for (const w of watchers.filter(x => x.live)) {
    w.cb([{ isIntersecting: visible, intersectionRatio: visible ? 0.6 : 0, target: w.target as Element } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
});
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setup(attachment: AttachmentSummary, seq: string | null = nextSeq(), opened: 'ok' | 'fail' = 'ok') {
  const fake = new FakeClient();
  fake.handler = c => {
    if (c.m !== 'openAttachment') return Promise.resolve(null);
    if (!c.thumb && opened === 'fail') return Promise.reject(new Error('E_BLOB_OPEN'));
    return Promise.resolve({ blob: blobOf(c.thumb ? 'image/webp' : attachment.mime), name: attachment.name, mime: attachment.mime });
  };
  const view = render(<CoreProvider client={fake}><AttachmentList channelId={GEN}
    item={peerRow(P1, seq ?? '0', 'look', { ...(seq === null ? { seq: null } : {}), attachments: [attachment] })} tabbable
    onOpenImage={() => undefined} onError={() => undefined} /></CoreProvider>);
  return { fake, view };
}
const fulls = (fake: FakeClient) => fake.callsOf('openAttachment').filter(c => !c.thumb);
const pic = (name = 'dance.gif') => screen.getByRole('img', { name });

describe('GIF cards play for five minutes (flow 04)', () => {
  const saved = { io: globalThis.IntersectionObserver, mm: Object.getOwnPropertyDescriptor(window, 'matchMedia'), create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL') };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    watchers = [];
    reduced = false;
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: (b: Blob) => `blob:${b.type}` });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.IntersectionObserver = saved.io;
    if (saved.mm === undefined) delete (window as unknown as Record<string, unknown>).matchMedia;
    else Object.defineProperty(window, 'matchMedia', saved.mm);
    for (const [name, d] of [['createObjectURL', saved.create], ['revokeObjectURL', saved.revoke]] as const) {
      if (d === undefined) delete (URL as unknown as Record<string, unknown>)[name];
      else Object.defineProperty(URL, name, d);
    }
  });

  it('fetches the full blob only once the card is intersecting, then shows it in the same img', async () => {
    const { fake } = setup(gif());
    await tick(0);
    expect(pic()).toHaveAttribute('src', 'blob:image/webp');
    expect(fulls(fake)).toHaveLength(0);
    see(false);
    await tick(0);
    expect(fulls(fake)).toHaveLength(0);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(1);
    expect(fulls(fake)[0]).toMatchObject({ channelId: GEN, index: 0, thumb: false });
    expect(pic()).toHaveAttribute('src', 'blob:image/gif');
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(1);
  });

  it('plays until five minutes, then goes back to the still and never fetches again', async () => {
    const { fake } = setup(gif());
    await tick(0);
    see();
    await tick(GIF_PLAY_MS - 1000);
    expect(pic()).toHaveAttribute('src', 'blob:image/gif');
    await tick(1000);
    expect(pic()).toHaveAttribute('src', 'blob:image/webp');
    see(false);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(1);
    expect(pic()).toHaveAttribute('src', 'blob:image/webp');
  });

  it('keeps the first deadline across a re-mount', async () => {
    const seq = nextSeq();
    const first = setup(gif(), seq);
    await tick(0);
    see();
    await tick(2 * 60_000);
    first.view.unmount();
    const second = setup(gif(), seq);
    await tick(0);
    see();
    await tick(0);
    expect(pic()).toHaveAttribute('src', 'blob:image/gif');
    await tick(3 * 60_000 - 1000);
    expect(pic()).toHaveAttribute('src', 'blob:image/gif');
    await tick(1000);
    expect(pic()).toHaveAttribute('src', 'blob:image/webp');
    expect(fulls(second.fake)).toHaveLength(1);
  });

  it('never fetches on a re-mount after the deadline', async () => {
    const seq = nextSeq();
    const first = setup(gif(), seq);
    await tick(0);
    see();
    await tick(GIF_PLAY_MS + 1000);
    first.view.unmount();
    const second = setup(gif(), seq);
    await tick(0);
    see();
    await tick(0);
    expect(fulls(second.fake)).toHaveLength(0);
    expect(pic()).toHaveAttribute('src', 'blob:image/webp');
  });

  it('plays nothing under reduced motion', async () => {
    reduced = true;
    const { fake } = setup(gif());
    await tick(0);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(0);
    expect(screen.getByText('GIF')).toBeInTheDocument();
  });

  it('never plays a PNG', async () => {
    const { fake } = setup(image());
    await tick(0);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(0);
    expect(watchers).toHaveLength(0);
  });

  it('never plays a GIF over 8 MiB', async () => {
    const { fake } = setup(gif({ size: GIF_AUTOPLAY_MAX + 1 }));
    await tick(0);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(0);
  });

  it('never plays a GIF too large to open, or one not yet sent', async () => {
    const huge = setup(gif({ tooLarge: true, size: 26_214_401 }));
    await tick(0);
    see();
    await tick(0);
    expect(fulls(huge.fake)).toHaveLength(0);
    cleanup();
    const unsent = setup(gif(), null);
    await tick(0);
    see();
    await tick(0);
    expect(fulls(unsent.fake)).toHaveLength(0);
  });

  it('plays a GIF of exactly 8 MiB', async () => {
    const { fake } = setup(gif({ size: GIF_AUTOPLAY_MAX }));
    await tick(0);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(1);
  });

  it('keeps the thumbnail, with no error text, when the full open fails', async () => {
    const { fake } = setup(gif(), nextSeq(), 'fail');
    await tick(0);
    see();
    await tick(0);
    expect(fulls(fake)).toHaveLength(1);
    expect(pic()).toHaveAttribute('src', 'blob:image/webp');
    expect(screen.queryByText(/could not open/)).toBeNull();
    expect(screen.getByRole('button', { name: 'open dance.gif' })).toBeInTheDocument();
  });

  it('marks a still GIF with a badge, hides it while playing and shows it again afterwards, never on a PNG', async () => {
    setup(gif());
    await tick(0);
    expect(screen.getByText('GIF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'open dance.gif' })).toHaveAccessibleName('open dance.gif');
    see();
    await tick(0);
    expect(screen.queryByText('GIF')).toBeNull();
    await tick(GIF_PLAY_MS);
    expect(screen.getByText('GIF')).toBeInTheDocument();
    cleanup();
    setup(image());
    await tick(0);
    expect(screen.queryByText('GIF')).toBeNull();
  });

  it('leaves other files alone', async () => {
    const { fake } = setup(file({ mime: 'image/gif', name: 'x.gif' }));
    await tick(0);
    see();
    expect(fulls(fake)).toHaveLength(0);
    expect(screen.queryByText('GIF')).toBeNull();
  });
});
