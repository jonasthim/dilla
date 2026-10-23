// E8: the GIF picker's worker commands. The page never holds the session token, so the worker searches, fetches and
// saves the server's Giphy key through the instance; a GIF crosses back as a Blob and the page sends it with
// attachFiles, so it is an ordinary attachment, sealed like any file. The key goes up and is never kept or echoed.
import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../hex';
import { ACCEPTS } from './controller';
import { COMMUNITY, refusal, toReady, world } from './world';

const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
const CID = toHex(COMMUNITY);

async function answered(w: ReturnType<typeof world>, id: number): Promise<unknown> {
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  return w.ret(id);
}

describe('every GIF command is a ready command', () => {
  it.each(['gifStatus', 'gifSetKey', 'gifClearKey', 'gifSetRating', 'gifSearch', 'gifFetch'] as const)('%s', (m) => {
    expect(ACCEPTS.ready).toContain(m);
    expect(ACCEPTS['needs-signup']).not.toContain(m);
  });
});

describe('the account slice no longer carries a gifs flag (the key is per server)', () => {
  it('account.instance has no gifs field', async () => {
    const w = world({});
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.instance).not.toBeNull());
    expect(w.account()?.instance).not.toHaveProperty('gifs');
  });
});

describe('gifStatus', () => {
  it('returns whether the server has a key and its rating', async () => {
    const w = world({});
    await toReady(w);
    w.routes.gifStatus.mockResolvedValue({ on: true, rating: 'pg' });
    w.call(2, { m: 'gifStatus', communityId: CID });
    expect(await answered(w, 2)).toEqual({ t: 'ret', id: 2, ok: true, value: { on: true, rating: 'pg' } });
    expect(w.routes.gifStatus).toHaveBeenCalledWith(COMMUNITY);
  });

  it('refuses a community id that is not 32 hex before any route call', async () => {
    const w = world({});
    await toReady(w);
    w.call(2, { m: 'gifStatus', communityId: 'nope' });
    expect(await answered(w, 2)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.gifStatus).not.toHaveBeenCalled();
  });
});

describe('the server key', () => {
  it('goes up through gifSetKey and the ret carries nothing back', async () => {
    const w = world({});
    await toReady(w);
    w.call(2, { m: 'gifSetKey', communityId: CID, key: 'abcdEFGH1234' });
    expect(await answered(w, 2)).toEqual({ t: 'ret', id: 2, ok: true, value: null });
    expect(w.routes.gifSetKey).toHaveBeenCalledWith(COMMUNITY, 'abcdEFGH1234');
  });

  it('refuses a key of the wrong shape before it leaves the worker, and says nothing of it', async () => {
    const w = world({});
    await toReady(w);
    const bad = ['short', 'has space 1234', 'abcdefgh&x=1', 5 as unknown as string];
    bad.forEach((key, i) => w.call(10 + i, { m: 'gifSetKey', communityId: CID, key }));
    for (let i = 0; i < bad.length; i++) {
      const ret = await answered(w, 10 + i);
      expect(ret).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
      expect(JSON.stringify(ret)).not.toContain('has space');
      expect(JSON.stringify(ret)).not.toContain('abcdefgh&x');
    }
    expect(w.routes.gifSetKey).not.toHaveBeenCalled();
  });

  it('a refusal from the instance does not carry the key to the page', async () => {
    const w = world({});
    await toReady(w);
    w.routes.gifSetKey.mockRejectedValue(refusal(403, 'E_FORBIDDEN'));
    w.call(2, { m: 'gifSetKey', communityId: CID, key: 'sekretKEY1234567' });
    const ret = await answered(w, 2);
    expect(ret).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN', status: 403 } });
    expect(JSON.stringify(ret)).not.toContain('sekretKEY');
    // Nothing the worker posted (slices included) holds the key.
    expect(JSON.stringify(w.posted)).not.toContain('sekretKEY');
  });

  it('is removed with gifClearKey, and the rating is set with gifSetRating', async () => {
    const w = world({});
    await toReady(w);
    w.call(2, { m: 'gifClearKey', communityId: CID });
    w.call(3, { m: 'gifSetRating', communityId: CID, rating: 'g' });
    w.call(4, { m: 'gifSetRating', communityId: CID, rating: 'x' });
    expect(await answered(w, 2)).toMatchObject({ ok: true, value: null });
    expect(await answered(w, 3)).toMatchObject({ ok: true, value: null });
    expect(await answered(w, 4)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.gifClearKey).toHaveBeenCalledWith(COMMUNITY);
    expect(w.routes.gifSetRating).toHaveBeenCalledWith(COMMUNITY, 'g');
    expect(w.routes.gifSetRating).toHaveBeenCalledTimes(1);
  });
});

describe('gifSearch', () => {
  it('returns the page as the route read it, for the community asked', async () => {
    const w = world({});
    await toReady(w);
    w.routes.gifSearch.mockResolvedValue({ items: [{ id: 'abc', title: 'cat', width: 200, height: 100 }], next: 24 });
    w.call(2, { m: 'gifSearch', communityId: CID, q: 'cat', offset: 0 });
    expect(await answered(w, 2)).toEqual({ t: 'ret', id: 2, ok: true,
      value: { items: [{ id: 'abc', title: 'cat', width: 200, height: 100 }], next: 24 } });
    expect(w.routes.gifSearch).toHaveBeenCalledWith(COMMUNITY, 'cat', 0);
  });

  it('refuses a bad query or offset before any route call', async () => {
    const w = world({});
    await toReady(w);
    w.call(2, { m: 'gifSearch', communityId: CID, q: 'a'.repeat(101), offset: 0 });
    w.call(3, { m: 'gifSearch', communityId: CID, q: 5, offset: 0 });
    w.call(4, { m: 'gifSearch', communityId: CID, q: 'x', offset: -1 });
    w.call(5, { m: 'gifSearch', communityId: CID, q: 'x', offset: 5000 });
    w.call(6, { m: 'gifSearch', communityId: CID, q: 'x', offset: 'a' });
    for (const id of [2, 3, 4, 5, 6]) expect(await answered(w, id)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.gifSearch).not.toHaveBeenCalled();
  });

  it('carries the instance refusal (404 while the server has no key) to the page', async () => {
    const w = world({});
    await toReady(w);
    w.routes.gifSearch.mockRejectedValue(refusal(404, 'E_NOT_FOUND'));
    w.call(2, { m: 'gifSearch', communityId: CID, q: 'x', offset: 0 });
    expect(await answered(w, 2)).toMatchObject({ ok: false, error: { code: 'E_NOT_FOUND', status: 404 } });
  });
});

describe('gifFetch', () => {
  it('returns the GIF as a Blob of type image/gif, preview or full', async () => {
    const w = world({});
    await toReady(w);
    w.routes.gifMedia.mockResolvedValue(GIF_BYTES);
    w.call(2, { m: 'gifFetch', communityId: CID, gifId: 'abc123', variant: 'preview' });
    w.call(3, { m: 'gifFetch', communityId: CID, gifId: 'abc123', variant: 'full' });
    for (const id of [2, 3]) {
      const ret = await answered(w, id) as { ok: boolean; value: { blob: Blob } };
      expect(ret.ok).toBe(true);
      expect(ret.value.blob).toBeInstanceOf(Blob);
      expect(ret.value.blob.type).toBe('image/gif');
      expect(new Uint8Array(await ret.value.blob.arrayBuffer())).toEqual(GIF_BYTES);
    }
    expect(w.routes.gifMedia.mock.calls.map(c => [c[0], c[1], c[2]])).toEqual([[COMMUNITY, 'abc123', 'preview'], [COMMUNITY, 'abc123', 'full']]);
  });

  it('refuses an id that is not letters and digits, and a variant that is neither, before any route call', async () => {
    const w = world({});
    await toReady(w);
    const bad = [{ gifId: '../x', variant: 'full' }, { gifId: 'a/b', variant: 'full' }, { gifId: '', variant: 'full' },
      { gifId: 'x'.repeat(65), variant: 'full' }, { gifId: 5, variant: 'full' }, { gifId: 'abc', variant: 'original' }];
    bad.forEach((c, i) => w.call(10 + i, { m: 'gifFetch', communityId: CID, ...c }));
    for (let i = 0; i < bad.length; i++) expect(await answered(w, 10 + i)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.gifMedia).not.toHaveBeenCalled();
  });
});
