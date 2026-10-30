import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  secretReason, validateJudge, planPrepare, withinLimits, boxToCss, regionCrop, buildQuestions, requestGroups, buildBody,
  decidePresence, decideState, decideCopy, decideTone, decideGeometry, classifyDeltas, decide, pairVerdict, parseJudgeArgs,
  pngSize, send, REDACTED_HEADERS, qid, boxQuantum,
} from './judge.mjs';
import { POS_TOL, MODEL, posTol, sizeTol } from './judge-questions.mjs';
import { parseArgs } from './shoot.mjs';

// No test asserts a model probability: the answers below are synthetic, to exercise the code's truth table.

test('presence rows P1-P9', () => {
  assert.equal(decidePresence(0.9, 0.9).row, 'P1');
  assert.deepEqual([decidePresence(0.9, 0.1).facet, decidePresence(0.9, 0.1).reason], ['differs', 'missing_in_app']);
  assert.deepEqual([decidePresence(0.1, 0.9).facet, decidePresence(0.1, 0.9).reason], ['not-judged', 'spec_mismatch_prototype']);
  assert.deepEqual([decidePresence(0.1, 0.1).facet, decidePresence(0.1, 0.1).reason], ['not-judged', 'not_found_either']);
  assert.deepEqual([decidePresence(0.1, 0.1, 'absent').facet, decidePresence(0.1, 0.1, 'absent').row], ['match', 'P5']);
  assert.deepEqual([decidePresence(0.1, 0.9, 'absent').facet, decidePresence(0.1, 0.9, 'absent').reason], ['differs', 'extra_in_app']);
  assert.equal(decidePresence(0.9, 0.5, 'absent').row, 'P7');
  assert.equal(decidePresence(0.5, 0.9).reason, 'presence_unsettled_prototype');
  assert.equal(decidePresence(0.5, 0.9, 'absent').reason, 'presence_unsettled_prototype');
  assert.equal(decidePresence(0.9, 0.5).reason, 'presence_unsettled_app');
  assert.equal(decidePresence(0.1, 0.5, 'absent').reason, 'presence_unsettled_app');
  // The thresholds are inclusive: exactly 0.7 reads yes and exactly 0.3 reads no.
  assert.equal(decidePresence(0.7, 0.7).row, 'P1');
  assert.equal(decidePresence(0.7, 0.3).row, 'P2');
  // A missing answer is never a "no".
  assert.equal(decidePresence(undefined, 0.1).reason, 'no_answer');
});

test('state rows S1-S5 and copy', () => {
  assert.equal(decideState(0.9, 0.8, 'selected').row, 'S1');
  assert.equal(decideState(0.1, 0.2, 'selected').row, 'S2');
  assert.equal(decideState(0.9, 0.1, 'selected').reason, 'state_lost:selected');
  assert.equal(decideState(0.1, 0.9, 'focused').reason, 'state_extra:focused');
  assert.equal(decideState(0.5, 0.9, 'focused').reason, 'state_unsettled:focused');
  assert.equal(decideState(0.9, 0.5, 'focused').facet, 'not-judged');
  assert.equal(decideCopy(0.9, 0.9).facet, 'match');
  assert.equal(decideCopy(0.9, 0.1).reason, 'copy_differs');
  assert.equal(decideCopy(0.1, 0.9).reason, 'spec_mismatch_prototype');
  assert.equal(decideCopy(0.9, 0.5).reason, 'copy_unsettled');
});

test('tone: both sure and equal match, both sure and different differ, else not judged', () => {
  const t = (name, p) => ({ type: 'choice', choice: name, confidence: p, probabilities: { muted_grey_text: name === 'muted_grey_text' ? p : 1 - p, bright_white_text: name === 'bright_white_text' ? p : 1 - p } });
  assert.equal(decideTone(t('muted_grey_text', 0.9), t('muted_grey_text', 0.8)).facet, 'match');
  assert.equal(decideTone(t('muted_grey_text', 0.9), t('bright_white_text', 0.8)).facet, 'differs');
  assert.equal(decideTone(t('muted_grey_text', 0.9), t('bright_white_text', 0.6)).facet, 'not-judged');
});

test('geometry rows G1-G4 with the median offset and an anchor', () => {
  assert.equal(classifyDeltas([{ kind: 'moved', axis: 'y', value: POS_TOL, tol: POS_TOL }]).row, 'G1');
  assert.equal(classifyDeltas([{ kind: 'moved', axis: 'y', value: POS_TOL + 1, tol: POS_TOL }]).row, 'G3');
  assert.equal(classifyDeltas([{ kind: 'moved', axis: 'y', value: -(2 * POS_TOL + 1), tol: POS_TOL }]).row, 'G2');
  const b = (x, y, w, h) => ({ x0: x, y0: y, x1: x + w, y1: y + h });
  const els = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', anchor: 'c' }, { id: 'e', compare: ['presence', 'size'] }];
  // App frame is shifted 17 px down (a phone bezel): a, b, c follow it, d moved 30 px further but its anchor c did not.
  const css = {
    a: { prototype: b(10, 10, 100, 20), app: b(10, 27, 100, 20) },
    b: { prototype: b(10, 50, 100, 20), app: b(10, 67, 100, 20) },
    c: { prototype: b(10, 90, 100, 20), app: b(10, 107, 100, 20) },
    d: { prototype: b(10, 130, 100, 20), app: b(10, 177, 100, 20) },
    e: { prototype: b(10, 200, 100, 20), app: b(300, 400, 100, 60) },
  };
  const g = decideGeometry(els, new Set(['a', 'b', 'c', 'd', 'e']), css);
  assert.equal(g.a.row, 'G1');
  assert.equal(g.a.offset_css.y, 17);
  assert.equal(g.d.facet, 'differs');
  assert.equal(g.d.dy_css, 30);
  assert.equal(g.e.facet, 'differs'); // size only: 40 px taller; its position is not compared
  assert.equal(g.e.dx_css, undefined);
  const lone = decideGeometry([{ id: 'a' }], new Set(['a']), { a: css.a });
  assert.equal(lone.a.row, 'G4');
  assert.equal(lone.a.reason, 'no_alignment');
});

test('decide: element and pair verdicts, speculative answers ignored, accepted deviations', () => {
  const judge = { elements: [
    { id: 'title', name: 'the title', copy: 'Hi', compare: ['presence'] },
    { id: 'row', name: 'the first row', compare: ['presence'], state: { selected: { phrase: 'selected' } }, accepted: [{ facet: 'state', why: 'Jonas, test' }] },
    { id: 'gone', name: 'a loading line', expect: 'absent' },
    { id: 'icon', name: 'the icon', compare: ['presence'], copy: 'x' },
  ] };
  const n = v => ({ type: 'noul', noul: v });
  const answers = {
    prototype: { [qid.present('title')]: n(0.9), [qid.copy('title')]: n(0.9), [qid.present('row')]: n(0.9), [qid.state('row', 'selected')]: n(0.9), [qid.present('gone')]: n(0.05), [qid.present('icon')]: n(0.9), [qid.copy('icon')]: n(0.9) },
    app: { [qid.present('title')]: n(0.9), [qid.copy('title')]: n(0.1), [qid.present('row')]: n(0.9), [qid.state('row', 'selected')]: n(0.1), [qid.present('gone')]: n(0.95), [qid.present('icon')]: n(0.1), [qid.copy('icon')]: n(0.95) },
  };
  const v = decide(judge, answers, {});
  const by = Object.fromEntries(v.elements.map(e => [e.id, e]));
  assert.equal(by.title.verdict, 'differs');
  assert.deepEqual(by.title.reasons, ['copy_differs']);
  assert.equal(by.row.verdict, 'accepted');
  assert.equal(by.gone.reasons[0], 'extra_in_app');
  assert.equal(by.icon.verdict, 'differs');
  assert.equal(by.icon.copy, undefined); // the copy answer is speculative: presence failed, so it is never read
  assert.equal(v.verdict, 'differs');
  assert.deepEqual(v.counts, { match: 0, differs: 3, 'not-judged': 0, accepted: 1 });
});

test('pairVerdict order: differs, not-judged (incl. a third spec mismatches), match with accepted', () => {
  const r = (verdict, reasons = []) => ({ verdict, reasons });
  assert.equal(pairVerdict([r('match'), r('differs')]).verdict, 'differs');
  assert.equal(pairVerdict([r('match'), r('not-judged')]).verdict, 'not-judged');
  assert.equal(pairVerdict([r('match'), r('accepted')]).verdict, 'match (accepted: 1)');
  assert.equal(pairVerdict([r('match'), r('match')]).verdict, 'match');
});

test('planPrepare: desktop and phone shots scale down to the documented limits', () => {
  const d = planPrepare(2560, 1600);
  assert.deepEqual([d.outW, d.outH, d.padX, d.padY], [1568, 980, 0, 0]);
  assert.ok(Math.abs(d.scaleX - 0.6125) < 1e-9);
  const p = planPrepare(780, 1688);
  assert.deepEqual([p.outW, p.outH], [Math.round(780 * 1568 / 1688), 1568]);
  assert.ok(withinLimits(p.outW, p.outH));
  const ok = planPrepare(1462, 636);
  assert.deepEqual([ok.outW, ok.outH, ok.scaleX], [1462, 636, 1]);
});

test('planPrepare: thin strips are padded, tiny squares scaled up, wide strips scaled then padded', () => {
  const s = planPrepare(1526, 241);
  assert.deepEqual([s.outW, s.outH, s.scaleX, s.padX, s.padY], [1526, 280, 1, 0, 19]);
  const t = planPrepare(132, 132);
  assert.deepEqual([t.outW, t.outH, t.padX, t.padY], [280, 280, 0, 0]);
  assert.ok(Math.abs(t.scaleX - 280 / 132) < 1e-9);
  const w = planPrepare(1976, 144);
  assert.equal(w.contentW, 1568);
  assert.equal(w.outH, 280);
  assert.ok(w.padY > 0);
  for (const [a, b] of [[2560, 1600], [780, 1688], [1526, 192], [1976, 144], [132, 132], [300, 3000], [5000, 5000]]) {
    const q = planPrepare(a, b);
    assert.ok(withinLimits(q.outW, q.outH), `${a}x${b} -> ${q.outW}x${q.outH}`);
  }
});

test('boxToCss maps a Box answer back to CSS px through scale, pad and crop origin', () => {
  const d = planPrepare(2560, 1600); // a whole desktop frame at scale 2
  const css = boxToCss({ left: 0.5, right: 0.75, top: 0.25, bottom: 0.5 }, d);
  assert.deepEqual(Object.values(css).map(v => Math.round(v * 1000) / 1000), [640, 200, 960, 400]);
  const s = planPrepare(1526, 241); // padded strip: the box edge at the pad is the frame's top
  const top = boxToCss({ left: 0, right: 1, top: s.padY / s.outH, bottom: (s.padY + 241) / s.outH }, s);
  assert.ok(Math.abs(top.y0) < 1e-9 && Math.abs(top.y1 - 120.5) < 1e-9);
  const crop = regionCrop({ x: 880, y: 40, width: 380, height: 190 }, 2560, 1600);
  assert.deepEqual(crop, { x: 1760, y: 80, w: 760, h: 380 });
  const r = planPrepare(crop.w, crop.h);
  const inCrop = boxToCss({ left: 0, right: 0.5, top: 0, bottom: 1 }, r, crop);
  assert.deepEqual([inCrop.x0, inCrop.y0, inCrop.x1, inCrop.y1], [880, 40, 1070, 230]);
});

test('secretReason excludes passwords, recovery keys, one-time codes and the recovery-key screen', () => {
  const pair = steps => ({ name: 'p', prototype: {}, app: { who: 'fresh', steps } });
  assert.match(secretReason(pair([{ type: ['#signin-password', '{password:mira}'] }])), /secret/);
  assert.match(secretReason(pair([{ type: ['input[name=key]', '{recoveryKey:bjorn}'] }])), /secret/);
  assert.match(secretReason(pair([{ totp: ['input', 'mira'] }])), /secret/);
  assert.match(secretReason(pair([{ waitFor: 'text=Your recovery key' }])), /secret/);
  assert.match(secretReason(pair([{ type: ['#signin-password', 'literal'] }])), /secret/);
  assert.equal(secretReason(pair([{ type: ['#signin-username', 'mira'] }, { click: 'x' }])), null);
  assert.equal(secretReason({ name: 's', prototype: {}, story: { id: 'a--b' } }), null);
});

test('the secret rule matches the three excluded wave A pairs and not their empty-form sibling', async () => {
  const fs = await import('node:fs');
  const spec = JSON.parse(fs.readFileSync(new URL('./app/wave-a-gaps.json', import.meta.url), 'utf8'));
  const hit = spec.filter(p => secretReason(p)).map(p => p.name).sort();
  assert.deepEqual(hit, ['gap03-signin-recover-desktop', 'gap04-signin-done-desktop', 'gap11-auth-phone-code']);
});

test('validateJudge rejects unknown keys, bad anchors and "the X or the Y" names', () => {
  const p = judge => ({ name: 'p', judge });
  validateJudge(p({ elements: [{ id: 'a', name: 'the send button' }, { id: 'b', name: 'the field', anchor: 'a' }] }));
  validateJudge(p({ exclude: 'secret' }));
  assert.throws(() => validateJudge(p({ elements: [{ id: 'a', name: 'x', colour: 'red' }] })), /unknown key colour/);
  assert.throws(() => validateJudge(p({ elements: [{ id: 'a', name: 'x', anchor: 'zz' }] })), /anchor/);
  assert.throws(() => validateJudge(p({ elements: [{ id: 'a', name: 'the bell or the gear' }] })), /one thing/);
  assert.throws(() => validateJudge(p({ elements: [{ id: 'a', name: 'x', copy: 3 }] })), /copy/);
  assert.throws(() => validateJudge(p({ mask: [] })), /unknown key mask/);
});

test('questions: identical for both sides, absent elements ask presence only, no side names', () => {
  const els = [{ id: 'a', name: 'the send button', copy: 'Send', tone: true, state: { focused: { phrase: 'focused', true: 't', false: 'f' } } }, { id: 'b', name: 'a loading line', expect: 'absent' }];
  const qs = buildQuestions(els);
  assert.deepEqual(Object.keys(qs).sort(), ['a__box', 'a__copy', 'a__present', 'a__state__focused', 'a__tone', 'b__present']);
  assert.ok(!/prototype|app\b|story/i.test(JSON.stringify(qs)));
  const pair = { name: 'p', viewport: { width: 390, height: 844 }, prototype: {}, app: { who: 'phone' } };
  const body = buildBody(pair, requestGroups(els)[0], 'ab'.repeat(32));
  assert.equal(body.model, MODEL);
  assert.equal(body.state.view, 'A phone screen of a dark-themed chat app.');
  assert.equal(body.assets[body.state.screen].part, 'screen-image');
  const g = requestGroups([{ id: 'x', name: 'x' }, { id: 'y', name: 'y', region: { x: 0, y: 0, width: 200, height: 200 } }]);
  assert.deepEqual(g.map(x => x.elements.map(e => e.id)), [['x'], ['y']]);
});

test('send: the key goes only in the Authorization header; logs use the redacted headers; 429 is retried', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push(init);
    return calls.length === 1 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { a: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
  };
  const res = await send({ model: 'm', state: {}, questions: {} }, Buffer.from([1, 2, 3]), 'sk-test-secret', { fetchImpl: fake, tries: 2 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, 'Bearer sk-test-secret');
  assert.ok(!JSON.stringify(res).includes('sk-test-secret'));
  assert.equal(REDACTED_HEADERS.Authorization, 'Bearer [REDACTED]');
});

test('boxQuantum: one Box step in CSS px per axis sets the geometry tolerance', () => {
  const desk = planPrepare(2560, 1600), phone = planPrepare(780, 1688);
  const qd = boxQuantum(desk, desk), qp = boxQuantum(phone, phone);
  assert.ok(Math.abs(qd.x - 12.8) < 1e-9 && Math.abs(qd.y - 8) < 1e-9);
  assert.ok(Math.abs(qp.x - 3.9) < 0.01 && Math.abs(qp.y - 8.44) < 0.01);
  assert.ok(Math.abs(posTol(qd.x) - 25.6) < 1e-9);
  assert.ok(Math.abs(posTol(qp.x) - 7.8) < 0.01);
  assert.equal(posTol(0), 6);
  assert.ok(Math.abs(sizeTol(400, qd.y) - 32) < 1e-9); // 8 % of 400 beats two 8 px steps
  const b = (x, y, w, h) => ({ x0: x, y0: y, x1: x + w, y1: y + h });
  // A one-step difference on a desktop frame is noise (G1); the old 6 px tolerance would have called it G3.
  const css = { a: { prototype: b(0, 0, 100, 20), app: b(12.8, 0, 100, 20), quantum: qd }, b: { prototype: b(0, 50, 100, 20), app: b(0, 50, 100, 20), quantum: qd }, c: { prototype: b(0, 90, 100, 20), app: b(0, 90, 100, 20), quantum: qd } };
  const g = decideGeometry([{ id: 'a' }, { id: 'b' }, { id: 'c' }], new Set(['a', 'b', 'c']), css);
  assert.equal(g.a.row, 'G1');
  assert.deepEqual(g.a.pos_tol_css, { x: 25.6, y: 16 });
});

test('shoot.mjs --judge: parseArgs strips the flag and reports it', () => {
  assert.deepEqual(parseArgs(['s.json', 'out', '--judge', '--app']), { specFile: 's.json', outDir: 'out', storybook: 'http://127.0.0.1:6006', app: 'target/ui-screens/signal-b/state.json', judge: true });
  assert.equal(parseArgs(['s.json', 'out']).judge, undefined);
});

test('the probe judge blocks in the committed specs are valid', async () => {
  const fs = await import('node:fs');
  for (const f of ['./app/wave-a-gaps.json', './app/task-2.json']) {
    const spec = JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    spec.forEach(validateJudge);
    assert.ok(spec.some(p => p.judge?.elements?.length > 0), f);
  }
});

test('pngSize reads IHDR; parseJudgeArgs reads the flags', () => {
  assert.deepEqual(parseJudgeArgs(['--dry-run', 's.json', '--reuse', 'shots']), { replay: undefined, specFile: 's.json', shotDir: 'shots', outDir: undefined, only: undefined, budget: undefined, dry: true, reuse: true });
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(1568, 16); b.writeUInt32BE(980, 20);
  assert.deepEqual(pngSize(b), { w: 1568, h: 980 });
  assert.deepEqual(parseJudgeArgs(['s.json', 'shots', '--only', 'a,b', '--budget', '0.2', '--out', 'o']), { replay: undefined, specFile: 's.json', shotDir: 'shots', outDir: 'o', only: ['a', 'b'], budget: 0.2 });
  assert.equal(parseJudgeArgs(['--replay', 'x.request.app.json']).replay, 'x.request.app.json');
});
