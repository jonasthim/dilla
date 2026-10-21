// E8: the GIF picker's two worker commands. The page never holds the session token, so the worker searches and
// fetches through the instance; a GIF crosses back as a Blob and the page sends it with attachFiles, so it is an
// ordinary encrypted attachment.
import { describe, expect, it, vi } from 'vitest';
import { ACCEPTS } from './controller';
import { INSTANCE, toReady, world } from './world';

const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);

async function answered(w: ReturnType<typeof world>, id: number): Promise<unknown> {
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  return w.ret(id);
}

describe('the account slice says whether the instance has GIFs', () => {
  it.each([[true], [false]])('gifs %s on the instance reaches account.instance', async (gifs) => {
    const w = world({});
    w.routes.getInstance.mockResolvedValue({ ...INSTANCE, gifs });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.instance).not.toBeNull());
    expect(w.account()?.instance?.gifs).toBe(gifs);
  });
});

describe('gifSearch', () => {
  it('is a ready command and returns the page as the route read it', async () => {
    expect(ACCEPTS.ready).toContain('gifSearch');
    expect(ACCEPTS['needs-signup']).not.toContain('gifSearch');
    const w = world({});
    await toReady(w);
    w.routes.gifSearch.mockResolvedValue({ items: [{ id: 'abc', title: 'cat', width: 200, height: 100 }], next: 24 });
    w.call(2, { m: 'gifSearch', q: 'cat', offset: 0 });
    expect(await answered(w, 2)).toEqual({ t: 'ret', id: 2, ok: true,
      value: { items: [{ id: 'abc', title: 'cat', width: 200, height: 100 }], next: 24 } });
    expect(w.routes.gifSearch).toHaveBeenCalledWith('cat', 0);
  });

  it('refuses a bad query or offset before any route call', async () => {
    const w = world({});
    await toReady(w);
    w.call(2, { m: 'gifSearch', q: 'a'.repeat(101), offset: 0 });
    w.call(3, { m: 'gifSearch', q: 5, offset: 0 });
    w.call(4, { m: 'gifSearch', q: 'x', offset: -1 });
    w.call(5, { m: 'gifSearch', q: 'x', offset: 5000 });
    w.call(6, { m: 'gifSearch', q: 'x', offset: 'a' });
    for (const id of [2, 3, 4, 5, 6]) expect(await answered(w, id)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.gifSearch).not.toHaveBeenCalled();
  });

  it('carries the instance refusal (404 while the key is off) to the page', async () => {
    const w = world({});
    await toReady(w);
    const { refusal } = await import('./world');
    w.routes.gifSearch.mockRejectedValue(refusal(404, 'E_NOT_FOUND'));
    w.call(2, { m: 'gifSearch', q: 'x', offset: 0 });
    expect(await answered(w, 2)).toMatchObject({ ok: false, error: { code: 'E_NOT_FOUND', status: 404 } });
  });
});

describe('gifFetch', () => {
  it('returns the GIF as a Blob of type image/gif, preview or full', async () => {
    expect(ACCEPTS.ready).toContain('gifFetch');
    const w = world({});
    await toReady(w);
    w.routes.gifMedia.mockResolvedValue(GIF_BYTES);
    w.call(2, { m: 'gifFetch', gifId: 'abc123', variant: 'preview' });
    w.call(3, { m: 'gifFetch', gifId: 'abc123', variant: 'full' });
    for (const id of [2, 3]) {
      const ret = await answered(w, id) as { ok: boolean; value: { blob: Blob } };
      expect(ret.ok).toBe(true);
      expect(ret.value.blob).toBeInstanceOf(Blob);
      expect(ret.value.blob.type).toBe('image/gif');
      expect(new Uint8Array(await ret.value.blob.arrayBuffer())).toEqual(GIF_BYTES);
    }
    expect(w.routes.gifMedia.mock.calls.map((c) => [c[0], c[1]])).toEqual([['abc123', 'preview'], ['abc123', 'full']]);
  });

  it('refuses an id that is not letters and digits, and a variant that is neither, before any route call', async () => {
    const w = world({});
    await toReady(w);
    const bad = [{ gifId: '../x', variant: 'full' }, { gifId: 'a/b', variant: 'full' }, { gifId: '', variant: 'full' },
      { gifId: 'x'.repeat(65), variant: 'full' }, { gifId: 5, variant: 'full' }, { gifId: 'abc', variant: 'original' }];
    bad.forEach((c, i) => w.call(10 + i, { m: 'gifFetch', ...c }));
    for (let i = 0; i < bad.length; i++) expect(await answered(w, 10 + i)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.gifMedia).not.toHaveBeenCalled();
  });
});
