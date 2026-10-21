/**
 * One download, tried up to `attempts` times (3) with a growing wait (1 s, then 2 s) between tries, so a blip at the
 * server does not fail a build. A response that is not ok counts as a failed try. `fetchImpl` and `wait` are for tests.
 */
export async function fetchWithRetry(url, { attempts = 3, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      if (attempt < attempts) await wait(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${url}: failed after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`);
}
