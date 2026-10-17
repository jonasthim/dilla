import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCorpus, blindOrder, summarizeRatings, runtimeVerdict, encodeWav, decodeWav } from '../benchmark.mjs';

test('rejects unlicensed clips and unmatched Krisp references instead of qualifying them', () => {
  assert.throws(() => validateCorpus({ clips: [{ id: 'a', file: 'a.wav' }] }), /license|consent/);
  assert.throws(() => validateCorpus({ clips: [{ id: 'a', file: 'a.wav', license: 'CC0', sha256: 'a'.repeat(64), language: 'en', categories: ['clean'], reference: { file: 'k.wav', inputSha256: 'b'.repeat(64) } }] }), /reference/);
});
test('blind order is reproducible, hides engine names and retains the full comparison', () => {
  const order = blindOrder(['a', 'b', 'c', 'd'], 42);
  assert.deepEqual(order, blindOrder(['a', 'b', 'c', 'd'], 42));
  assert.deepEqual(order.map(x => x.engine).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(order.map(x => x.label), ['Sample 1', 'Sample 2', 'Sample 3', 'Sample 4']);
});
test('ratings retain separate categories and paired uncertainty, never imply qualification with few listeners', () => {
  const rows = ['a', 'b'].flatMap(listener => ['krisp', 'deepfilter'].map(engine => ({listener, clip: 'one', engine, naturalness: engine === 'krisp' ? 5 : 3, reduction: 4, overall: 4, missingWords: 0})));
  const report = summarizeRatings(rows, 'deepfilter');
  assert.equal(report.categories.naturalness.meanDifference, -2);
  assert.equal(report.categories.reduction.meanDifference, 0);
  assert.equal(report.qualified, false);
  assert.match(report.reasons.join(' '), /listeners/);
});
test('runtime gate requires real loaded-call evidence for every platform and fails at the hard latency limit', () => {
  assert.equal(runtimeVerdict([]).qualified, false);
  const row = { platform: 'desktop-chrome', durationSeconds: 1800, loadedCall: true, addedDelayMs: 81, underruns: 0, buffers: 180000, p99ProcessingMs: 4, frameMs: 10 };
  const r = runtimeVerdict([row]);
  assert.equal(r.qualified, false);
  assert.match(r.reasons.join(' '), /80/);
});
test('WAV preserves mono 48 kHz float samples; malformed and non-48 kHz inputs are refused', () => {
  const input = new Float32Array([0, 0.25, -0.5, 1]);
  const wav = encodeWav(input);
  assert.deepEqual(decodeWav(wav), input);
  assert.throws(() => decodeWav(new Uint8Array(5)), /WAV/);
  const bad = wav.slice(); new DataView(bad.buffer).setUint32(24, 16000, true);
  assert.throws(() => decodeWav(bad), /48000/);
});
test('sixty copies of one recording do not satisfy corpus coverage',()=>{
  const sha256='a'.repeat(64);
  const clips=Array.from({length:60},(_,i)=>({id:String(i),file:`${i}.wav`,sha256,language:i%2?'sv':'en',license:'CC0',categories:['clean','quiet','onset','keyboard','fan','dog','tv','overlap'],transcript:'one word',reference:{inputSha256:sha256,sha256,file:'reference.wav',version:'fixture',captureSettings:{},lawfulUse:'fixture'}}));
  assert.equal(validateCorpus({clips}).complete,false);
});
