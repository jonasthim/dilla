import { describe, expect, it } from 'vitest';
import { encode } from '../cbor';
import { RecordingClient, bytesReply, cborReply, fakeTransport, refusal } from './fake-fetch';
import { GIF_FULL_MAX_BYTES, GIF_PREVIEW_MAX_BYTES, Routes } from './routes';

const fill = (n: number, b: number): Uint8Array => new Uint8Array(n).fill(b);
const INSTANCE_DOC = [[1], [1], [1], fill(16, 1), 7, 'dilla.test', 0, [0, 3], 2, fill(16, 8), fill(32, 9)];

function setup() {
  const t = fakeTransport({});
  const http = new RecordingClient(t.deps);
  return { t, http, routes: new Routes(http) };
}

describe('GET /v1/instance: the gifs element (E8)', () => {
  it('reads element 11 as on, and an instance from before it (eleven elements) as off', async () => {
    const on = setup();
    on.t.replies.push(cborReply(200, [...INSTANCE_DOC, 1]));
    expect((await on.routes.getInstance()).gifs).toBe(true);
    const zero = setup();
    zero.t.replies.push(cborReply(200, [...INSTANCE_DOC, 0]));
    expect((await zero.routes.getInstance()).gifs).toBe(false);
    const old = setup();
    old.t.replies.push(cborReply(200, INSTANCE_DOC));
    expect((await old.routes.getInstance()).gifs).toBe(false);
  });

  it('refuses a gifs element that is neither 0 nor 1', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, [...INSTANCE_DOC, 2]));
    await expect(routes.getInstance()).rejects.toMatchObject({ code: 'E_CBOR_RANGE' });
  });
});

describe('GET /v1/gifs/search', () => {
  it('sends q and offset, on the read bucket with the session, and reads ids, titles, sizes and the next offset', async () => {
    const { t, http, routes } = setup();
    t.replies.push(cborReply(200, [[['abc123', 'cat typing', 200, 113, '/v1/gifs/media/abc123?r=preview'],
      ['def456', '', 200, 200, '/v1/gifs/media/def456?r=preview']], 48]));
    const page = await routes.gifSearch('cat typing & more', 24);
    expect(page).toEqual({ items: [{ id: 'abc123', title: 'cat typing', width: 200, height: 113 },
      { id: 'def456', title: '', width: 200, height: 200 }], next: 48 });
    expect(t.seen[0].method).toBe('GET');
    expect(t.seen[0].url).toBe('https://dilla.test/v1/gifs/search?q=cat%20typing%20%26%20more&offset=24');
    expect(t.seen[0].headers.get('authorization')).toBe('Bearer tok-1');
    expect(http.requests[0].bucket).toBe('read');
  });

  it('reads a null next offset as the end of the results', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, [[], null]));
    expect(await routes.gifSearch('', 0)).toEqual({ items: [], next: null });
    expect(t.seen[0].url).toBe('https://dilla.test/v1/gifs/search?q=&offset=0');
  });

  it('ignores the server path and never takes a URL from the answer', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, [[['abc123', 't', 1, 1, 'https://media.giphy.com/x.gif']], null]));
    const page = await routes.gifSearch('x', 0);
    expect(JSON.stringify(page)).not.toContain('giphy.com');
  });

  it('drops a result whose id is not letters and digits, rather than building a path from it', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, [[['../x', 't', 1, 1, ''], ['ok1', 't', 1, 1, '']], null]));
    expect((await routes.gifSearch('x', 0)).items.map((i) => i.id)).toEqual(['ok1']);
  });

  it('refuses a query over 100 bytes, a control character and a bad offset before sending', async () => {
    const { t, routes } = setup();
    await expect(routes.gifSearch('a'.repeat(101), 0)).rejects.toThrow('E_ROUTE_INPUT');
    await expect(routes.gifSearch('é'.repeat(51), 0)).rejects.toThrow('E_ROUTE_INPUT');
    await expect(routes.gifSearch('a\u0000b', 0)).rejects.toThrow('E_ROUTE_INPUT');
    await expect(routes.gifSearch('a', -1)).rejects.toThrow('E_ROUTE_INPUT');
    await expect(routes.gifSearch('a', 5000)).rejects.toThrow('E_ROUTE_INPUT');
    await expect(routes.gifSearch('a', 1.5)).rejects.toThrow('E_ROUTE_INPUT');
    expect(t.seen).toHaveLength(0);
  });

  it('carries the instance refusal (the key is off: 404) to the caller', async () => {
    const { t, routes } = setup();
    t.replies.push(refusal(404, 'E_NOT_FOUND', 'no such object'));
    await expect(routes.gifSearch('x', 0)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
  });
});

describe('GET /v1/gifs/media/{id}', () => {
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);

  it('fetches the preview or the full GIF by id and variant and returns the bytes', async () => {
    const { t, http, routes } = setup();
    t.replies.push(bytesReply(200, GIF, { 'Content-Type': 'image/gif' }), bytesReply(200, GIF, { 'Content-Type': 'image/gif' }));
    expect(await routes.gifMedia('abc123', 'preview')).toEqual(GIF);
    expect(await routes.gifMedia('abc123', 'full')).toEqual(GIF);
    expect(t.seen.map((s) => s.url)).toEqual(['https://dilla.test/v1/gifs/media/abc123?r=preview',
      'https://dilla.test/v1/gifs/media/abc123?r=full']);
    expect(t.seen[0].headers.get('authorization')).toBe('Bearer tok-1');
    expect(http.requests[0].bucket).toBe('read');
  });

  it('caps what it reads at 5 MiB for a preview and 25 MiB for a full GIF', async () => {
    const { t, http, routes } = setup();
    t.replies.push(bytesReply(200, GIF), bytesReply(200, GIF));
    await routes.gifMedia('a', 'preview');
    await routes.gifMedia('a', 'full');
    expect(http.requests[0].maxBodyBytes).toBe(GIF_PREVIEW_MAX_BYTES);
    expect(http.requests[1].maxBodyBytes).toBe(GIF_FULL_MAX_BYTES);
    expect(GIF_PREVIEW_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(GIF_FULL_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('refuses a bad id or variant before sending', async () => {
    const { t, routes } = setup();
    for (const bad of ['', '../x', 'a/b', 'a.b', 'a:80', 'a b', 'x'.repeat(65)]) {
      await expect(routes.gifMedia(bad, 'full')).rejects.toThrow('E_ROUTE_INPUT');
    }
    await expect(routes.gifMedia('abc', 'original' as 'full')).rejects.toThrow('E_ROUTE_INPUT');
    expect(t.seen).toHaveLength(0);
  });

  it('refuses a body that does not start with the GIF magic', async () => {
    const { t, routes } = setup();
    t.replies.push(bytesReply(200, encode(['not a gif'])));
    await expect(routes.gifMedia('abc', 'full')).rejects.toMatchObject({ status: 503, code: 'E_UNAVAILABLE' });
  });
});
