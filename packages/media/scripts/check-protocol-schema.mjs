#!/usr/bin/env node
// DEV-66, JS half: the signalling closure of @livekit/protocol 1.50.4 (livekit-client 2.22.3's exact dependency)
// against the Go golden internal/sfu/testdata/livekit-signal-schema.json (task 8). Fails on a field-number
// conflict, on anything livekit-client uses that the Go side lacks, and on a Go-only addition not allowlisted.
import { readFileSync } from 'node:fs';
import * as lk from '@livekit/protocol';

const GOLDEN = new URL('../../../internal/sfu/testdata/livekit-signal-schema.json', import.meta.url);
const ROOTS = ['SignalRequest', 'SignalResponse', 'WrappedJoinRequest', 'JoinRequest', 'DataPacket', 'ClientInfo', 'EncryptedPacket', 'EncryptedPacketPayload'];
// gap G39: the only Go-only additions inside the closure; neither is sent by livekit-client or read by livekit-server v1.13.7.
const GO_ONLY = new Set(['field livekit.SyncState 9 data_subscription', 'enum livekit.ClientInfo.SDK 15 DOTNET']);
const SCALAR = { 1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64' };

function valueType(v) {
  return v.kind === 'scalar' ? SCALAR[v.T] : `${v.kind}:${v.T.typeName}`;
}

function typeOf(f) {
  switch (f.kind) {
    case 'scalar': return SCALAR[f.T];
    case 'enum': return `enum:${f.T.typeName}`;
    case 'message': return `message:${f.T.typeName}`;
    case 'map': return `map<${SCALAR[f.K]},${valueType(f.V)}>`;
    default: throw new Error(`unknown field kind ${f.kind}`);
  }
}

export function jsSchema() {
  const messages = {};
  const enums = {};
  const queue = ROOTS.map((n) => {
    if (lk[n] === undefined) throw new Error(`@livekit/protocol exports no ${n}`);
    return lk[n];
  });
  while (queue.length > 0) {
    const M = queue.shift();
    if (messages[M.typeName] !== undefined) continue;
    const list = M.fields.list();
    messages[M.typeName] = list.map((f) => ({ no: f.no, name: f.name, type: typeOf(f), repeated: Boolean(f.repeated), oneof: f.oneof ? f.oneof.name : '' }));
    for (const f of list) {
      const target = f.kind === 'map' ? f.V : f;
      // Well-known types (google.protobuf.*) are dumped by neither side (gap G39); the field's type string still names them.
      if (target.kind === 'message' && !target.T.typeName.startsWith('google.protobuf.')) queue.push(target.T);
      if (target.kind === 'enum' && enums[target.T.typeName] === undefined) {
        enums[target.T.typeName] = Object.fromEntries(target.T.values.map((v) => [String(v.no), v.name]));
      }
    }
  }
  return { messages, enums };
}

/** Accepts the golden with scalar names or godump's `scalar:<n>`, and `repeated` or godump's `rep`. */
export function normalize(golden) {
  const messages = {};
  for (const [name, fields] of Object.entries(golden.messages ?? {})) {
    messages[name] = (fields ?? []).map((f) => ({
      no: f.no,
      name: f.name,
      type: String(f.type).replace(/scalar:(\d+)/g, (_, n) => SCALAR[n]),
      repeated: Boolean(f.repeated ?? f.rep),
      oneof: f.oneof ?? '',
    }));
  }
  return { messages, enums: golden.enums ?? {} };
}

export function compare(go, js) {
  const problems = [];
  for (const [msg, jfields] of Object.entries(js.messages)) {
    const gfields = go.messages[msg];
    if (gfields === undefined) {
      problems.push(`message ${msg} is used by livekit-client but absent from the Go golden`);
      continue;
    }
    const byNo = new Map(gfields.map((f) => [f.no, f]));
    for (const jf of jfields) {
      const gf = byNo.get(jf.no);
      if (gf === undefined) {
        problems.push(`field ${msg} ${jf.no} ${jf.name} exists only in JS`);
        continue;
      }
      for (const k of ['name', 'type', 'repeated', 'oneof']) {
        if (gf[k] !== jf[k]) problems.push(`field ${msg} ${jf.no}: ${k} go=${JSON.stringify(gf[k])} js=${JSON.stringify(jf[k])}`);
      }
    }
    const jsNos = new Set(jfields.map((f) => f.no));
    for (const gf of gfields) {
      if (!jsNos.has(gf.no) && !GO_ONLY.has(`field ${msg} ${gf.no} ${gf.name}`)) problems.push(`field ${msg} ${gf.no} ${gf.name} exists only in Go and is not allowlisted`);
    }
  }
  for (const [name, jvalues] of Object.entries(js.enums)) {
    const gvalues = go.enums[name];
    if (gvalues === undefined) {
      problems.push(`enum ${name} is used by livekit-client but absent from the Go golden`);
      continue;
    }
    for (const [no, label] of Object.entries(jvalues)) {
      if (gvalues[no] === undefined) problems.push(`enum ${name} ${no} ${label} exists only in JS`);
      else if (gvalues[no] !== label) problems.push(`enum ${name} ${no}: go=${gvalues[no]} js=${label}`);
    }
    for (const [no, label] of Object.entries(gvalues)) {
      if (jvalues[no] === undefined && !GO_ONLY.has(`enum ${name} ${no} ${label}`)) problems.push(`enum ${name} ${no} ${label} exists only in Go and is not allowlisted`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const go = normalize(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  const js = jsSchema();
  const problems = compare(go, js);
  for (const p of problems) console.error(p);
  console.log(`signalling closure: js ${Object.keys(js.messages).length} messages / ${Object.keys(js.enums).length} enums, ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
