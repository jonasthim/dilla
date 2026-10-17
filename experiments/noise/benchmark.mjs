// Offline evaluation utilities. This directory is never imported by the application.
export const CATEGORIES = ['clean', 'quiet', 'onset', 'keyboard', 'fan', 'dog', 'tv', 'overlap'];
export const PLATFORMS = ['desktop-chrome', 'desktop-firefox', 'desktop-safari', 'android-chrome', 'ios-safari'];
const HASH = /^[a-f0-9]{64}$/;
export function validateCorpus(corpus) {
  if (!Array.isArray(corpus.clips) || !corpus.clips.length) throw Error('No clips');
  const ids = new Set();
  for (const c of corpus.clips) {
    if (!c.license && !c.consent) throw Error(`${c.id}: license or consent required`);
    if (!c.id || ids.has(c.id)) throw Error('Duplicate or missing clip id');
    ids.add(c.id);
    if (!HASH.test(c.sha256) || !c.file || !['en', 'sv'].includes(c.language) || !Array.isArray(c.categories) || !c.categories.length || c.categories.some(x => !CATEGORIES.includes(x))) throw Error(`${c.id}: invalid clip metadata`);
    if (c.reference && (c.reference.inputSha256 !== c.sha256 || !HASH.test(c.reference.sha256) || !c.reference.file || !c.reference.version || !c.reference.captureSettings || !c.reference.lawfulUse)) throw Error(`${c.id}: unmatched/incomplete reference`);
  }
  return { clips: corpus.clips.length, distinctRecordings: new Set(corpus.clips.map(c=>c.sha256)).size, complete: new Set(corpus.clips.map(c=>c.sha256)).size >= 60 && ['en', 'sv'].every(l => corpus.clips.some(c => c.language === l)) && CATEGORIES.every(k => corpus.clips.some(c => c.categories.includes(k))) && corpus.clips.every(c => c.reference) };
}
export function blindOrder(engines, seed) {
  const list = [...engines]; let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list.map((engine, i) => ({ label: `Sample ${i + 1}`, engine }));
}
/** A shared code has meaning only within its listener's randomization. */
export function decodeRatings(rows, keys) {
  const listeners = new Set(rows.map(r => r.listener));
  if (!keys.listeners && listeners.size !== 1) throw Error('One blind key cannot decode multiple listeners');
  return rows.map(r => {
    const key = keys.listeners ? keys.listeners[r.listener]?.key : keys.key;
    if (!Array.isArray(key)) throw Error(`Missing listener key: ${r.listener}`);
    const matches = key.filter(k => k.code === r.code);
    if (matches.length !== 1 || !matches[0].clip || !matches[0].engine) throw Error('Unknown or ambiguous blind code');
    return {...r, clip: matches[0].clip, engine: matches[0].engine};
  });
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export function summarizeRatings(rows, candidate) {
  const reasons = [], categories = {};
  const keys = new Set();
  for (const r of rows) {
    const key = JSON.stringify([r.listener, r.clip, r.engine]);
    if (keys.has(key) || !r.listener || !r.clip || !r.engine || !['naturalness', 'reduction', 'overall'].every(k => Number.isFinite(r[k]) && r[k] >= 1 && r[k] <= 5) || !Number.isInteger(r.missingWords) || r.missingWords < 0) throw Error('Invalid or duplicate rating');
    keys.add(key);
  }
  const pairs = rows.filter(r => r.engine === candidate).map(r => [r, rows.find(k => k.engine === 'krisp' && k.listener === r.listener && k.clip === r.clip)]);
  if (!pairs.length || pairs.some(p => !p[1])) reasons.push('Missing matched Krisp ratings');
  const matched = pairs.filter(p => p[1]);
  const listeners = [...new Set(matched.map(p => p[0].listener))];
  if (listeners.length < 5) reasons.push('At least five listeners required');
  const clips = [...new Set(matched.map(p => p[0].clip))];
  if (clips.length < 60) reasons.push('At least 60 matched clips required');
  if (listeners.some(l => matched.filter(p => p[0].listener === l).length !== clips.length)) reasons.push('Each listener must rate all matched clips');
  for (const k of ['naturalness', 'reduction', 'overall']) {
    // Uncertainty across listener means; individual clips are not independent listeners.
    const deltas = listeners.map(l => mean(matched.filter(p => p[0].listener === l).map(([a, b]) => a[k] - b[k])));
    const delta = deltas.length ? mean(deltas) : null;
    const se = deltas.length > 1 ? Math.sqrt(deltas.reduce((s, d) => s + (d - delta) ** 2, 0) / (deltas.length - 1) / deltas.length) : null;
    categories[k] = { meanDifference: delta, listenerStandardError: se, listeners: deltas.length };
    if (delta === null || delta < -0.25) reasons.push(`${k}: below proposed threshold`);
  }
  if (matched.some(([a, b]) => a.missingWords > b.missingWords)) reasons.push('Additional missing words');
  return { qualified: reasons.length === 0, reasons, categories, clips: clips.length, listeners: listeners.length };
}
export function runtimeVerdict(rows) {
  const reasons = [];
  for (const platform of PLATFORMS) {
    const r = rows.find(x => x.platform === platform);
    if (!r || !r.loadedCall || !(r.durationSeconds >= 1800)) { reasons.push(`${platform}: 30-minute loaded call missing`); continue; }
    if (!Number.isFinite(r.addedDelayMs) || r.addedDelayMs < 0 || r.addedDelayMs > 80) reasons.push(`${platform}: delay exceeds 80 ms or unmeasured`);
    if (!(r.buffers > 0) || !Number.isInteger(r.underruns) || r.underruns < 0 || r.underruns / r.buffers >= 0.001) reasons.push(`${platform}: underruns >=0.1% or unmeasured`);
    if (!(r.frameMs > 0) || !(r.p99ProcessingMs >= 0) || !(r.p99ProcessingMs < r.frameMs * 0.8)) reasons.push(`${platform}: less than 20% p99 processing headroom`);
  }
  return { qualified: reasons.length === 0, reasons, targetExceeded: rows.filter(r => r.addedDelayMs > 60).map(r => r.platform) };
}
export function encodeWav(pcm) {
  const bytes = new Uint8Array(44 + pcm.length * 4), v = new DataView(bytes.buffer);
  const tag = (at, s) => [...s].forEach((c, i) => bytes[at + i] = c.charCodeAt(0));
  tag(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); v.setUint16(22, 1, true); v.setUint32(24, 48000, true); v.setUint32(28, 192000, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true);
  tag(36, 'data'); v.setUint32(40, pcm.length * 4, true);
  pcm.forEach((x, i) => v.setFloat32(44 + i * 4, x, true)); return bytes;
}
export function decodeWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw Error('Invalid WAV');
  let fmt, data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = v.getUint32(at + 4, true), start = at + 8;
    if (start + size > bytes.length) throw Error('Truncated WAV');
    if (tag(at) === 'fmt ' && size >= 16) fmt = { code: v.getUint16(start, true), ch: v.getUint16(start + 2, true), rate: v.getUint32(start + 4, true), bits: v.getUint16(start + 14, true) };
    if (tag(at) === 'data') data = { start, size };
    at = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.ch !== 1 || fmt.rate !== 48000) throw Error('WAV must be mono 48000 Hz');
  if (!((fmt.code === 3 && fmt.bits === 32) || (fmt.code === 1 && fmt.bits === 16))) throw Error('WAV must be PCM16 or float32');
  const width = fmt.bits / 8;
  if (data.size % width) throw Error('Invalid WAV data length');
  const pcm = new Float32Array(data.size / width);
  for (let i = 0; i < pcm.length; i++) { const x = fmt.code === 3 ? v.getFloat32(data.start + i * width, true) : v.getInt16(data.start + i * width, true) / 32768; if (!Number.isFinite(x)) throw Error('Non-finite WAV sample'); pcm[i] = x; }
  return pcm;
}
