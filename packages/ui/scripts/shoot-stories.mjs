// Renders Storybook stories to PNGs for review (L-UI-15, F16).
//
//   node packages/ui/scripts/shoot-stories.mjs <port> <out-dir> <story-id-prefix>…
//
// Serves packages/ui/storybook-static on 127.0.0.1:<port>, opens every story of
// index.json whose id starts with one of the prefixes in each theme with
// Playwright Chromium at 1280×800, and writes <out-dir>/<story id>.<theme>.png.
// Exits 1 when a prefix matched no story or a story page logged an error.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEMES = ['mesh', 'light', 'high-contrast'];
export const VIEWPORT = { width: 1280, height: 800 };

/** The story ids (never docs entries) that start with one of the prefixes, and the prefixes that matched none. */
export function selectStories(index, prefixes) {
  const ids = Object.values(index.entries)
    .filter(e => e.type === 'story' && prefixes.some(p => e.id.startsWith(p)))
    .map(e => e.id);
  const sorted = [...ids].sort();
  const unmatched = prefixes.filter(p => !sorted.some(id => id.startsWith(p)));
  return { ids: sorted, unmatched };
}

export function storyUrl(port, id, theme) {
  return `http://127.0.0.1:${port}/iframe.html?id=${encodeURIComponent(id)}&globals=theme:${theme}&viewMode=story`;
}

export function outFile(outDir, id, theme) {
  return path.join(outDir, `${id}.${theme}.png`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export function contentType(urlPath) {
  const ext = path.extname(urlPath).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : 'application/octet-stream';
}

/** The absolute file a request path names under root, or null when it is malformed or leaves root. */
export function resolveInRoot(root, urlPath) {
  const q = urlPath.indexOf('?');
  const raw = q === -1 ? urlPath : urlPath.slice(0, q);
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (e) {
    if (e instanceof URIError) return null;
    throw e;
  }
  if (decoded === '/') return path.join(root, 'index.html');
  const p = path.resolve(root, '.' + decoded);
  if (p === root || p.startsWith(root + path.sep)) return p;
  return null;
}

function notFound(res) {
  res.writeHead(404, { 'content-length': '0' });
  res.end();
}

function startServer(root, port) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-length': '0', allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const file = resolveInRoot(root, req.url ?? '/');
    if (file === null) { notFound(res); return; }
    let body;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) { notFound(res); return; }
      body = await fsp.readFile(file);
    } catch {
      notFound(res);
      return;
    }
    res.writeHead(200, { 'content-type': contentType(file), 'content-length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function shoot({ port, outDir, prefixes, root }) {
  const indexPath = path.join(root, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error('shoot-stories: ' + root + '/index.json is missing: run build-storybook first');
  }
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  const { ids, unmatched } = selectStories(index, prefixes);
  const consoleErrors = [];
  let written = 0;
  const server = await startServer(root, port);
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    try {
      fs.mkdirSync(outDir, { recursive: true });
      for (const id of ids) {
        for (const theme of THEMES) {
          const page = await context.newPage();
          try {
            page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${id} ${theme}: ${m.text()}`); });
            page.on('pageerror', e => consoleErrors.push(`${id} ${theme}: ${e.message}`));
            await page.goto(storyUrl(port, id, theme), { waitUntil: 'load', timeout: 60_000 });
            await page.waitForSelector('#storybook-root > *', { state: 'attached', timeout: 60_000 });
            await page.evaluate(() => document.fonts.ready.then(() => true));
            await page.screenshot({ path: outFile(outDir, id, theme) });
          } finally {
            await page.close();
          }
          written += 1;
        }
      }
    } finally {
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(() => resolve()));
  }
  return { written, consoleErrors, unmatched };
}

async function main(argv) {
  const [portArg, outArg, ...prefixes] = argv;
  const port = /^\d+$/.test(portArg ?? '') ? Number(portArg) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !outArg || prefixes.length === 0) {
    process.stderr.write('usage: shoot-stories.mjs <port> <out-dir> <story-id-prefix>…\n');
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storybook-static');
  const outDir = path.resolve(process.cwd(), outArg);
  const { written, consoleErrors, unmatched } = await shoot({ port, outDir, prefixes, root });
  for (const p of unmatched) process.stderr.write(`shoot-stories: no story matches "${p}"\n`);
  for (const line of consoleErrors) process.stderr.write(line + '\n');
  process.stdout.write(`shoot-stories: wrote ${written} screenshots to ${outDir}\n`);
  return unmatched.length > 0 || consoleErrors.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    err => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; },
  );
}
