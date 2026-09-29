// Gateway frame vectors (02-delivery-service.md, "Gateway frames"). One accept case per opcode
// and one reject case per refusal rule, so the Go gateway, a future TypeScript client and the
// Rust testkit all agree byte for byte on the four-element frame.
// Every module in this package imports with the `.ts` extension: `tsconfig.json` sets
// `allowImportingTsExtensions: true` and `npm run vectors` is
// `node --experimental-strip-types src/generate.ts`, so a `.js` specifier resolves to a file that
// does not exist (`generate.ts:4` and `envelope.test.ts:4-7` are the existing examples).
import { encode } from './cbor.ts';
import { hex } from './bytes.ts';

const GROUP = new Uint8Array(16).fill(0x07);
const DEVICE = new Uint8Array(16).fill(0x08);
const USER = new Uint8Array(16).fill(0x09);
const TAG = new Uint8Array(32).fill(0x0a);
const TOKEN = new Uint8Array(32).fill(0x0b);

type Case = { name: string; op: number; n: number; group_id: string; payload: string; frame: string };

function frame(name: string, op: number, n: number, group: Uint8Array | null, payload: unknown[]): Case {
  const payloadBytes = encode(payload as never);
  const frameBytes = encode([op, n, group, payload] as never);
  return {
    name,
    op,
    n,
    group_id: group ? hex(group) : '',
    payload: hex(payloadBytes),
    frame: hex(frameBytes),
  };
}

export function frameVectors() {
  const cases: Case[] = [
    // The last two elements are invariant 7's back-off window, backoff_ms and backoff_jitter_ms.
    frame('hello', 0, 0, null, [[1], [1], [1], 30000, 131584, new Uint8Array(16).fill(0x01), 1, 300, 300]),
    frame('identify', 1, 1, null, ['tok', 1, 1, 1, 0]),
    frame('resume', 2, 2, null, ['tok', TOKEN, 1, 41]),
    frame('ready', 3, 1, null, [DEVICE, USER, 1, TOKEN, 1, 1, 1, 32, [[GROUP, 6, 4127, 0]]]),
    // `resumed` carries the ROTATED resume token as element 2: the instance discards the token the
    // client just spent, so without it on the wire a client could resume exactly once per identify.
    frame('resumed', 4, 2, null, [42, 47, TOKEN]),
    frame('invalid_session', 5, 0, null, [0, 'unknown resume token']),
    frame('heartbeat', 6, 3, null, [47, 1]),
    frame('heartbeat_ack', 7, 0, null, [1758659640]),
    frame('reconnect', 8, 0, null, ['going away', 2500]),
    frame('error', 9, 0, null, [3, 'E_FRAME_SHAPE', 'payload has 2 elements, want 4']),
    frame('subscribe', 10, 4, null, [[GROUP]]),
    frame('unsubscribe', 11, 5, null, [[GROUP]]),
    // The one group-scoped client opcode: invariant 7's acknowledgement.
    frame('commit_ack', 12, 6, GROUP, [1]),
    frame('mls.handshake', 16, 6, GROUP, [4127, 41, 1, 3, new Uint8Array([0xde, 0xad])]),
    frame('mls.handshake from the instance', 16, 7, GROUP, [4128, 41, 0, null, new Uint8Array([0xbe])]),
    frame('mls.commit_needed', 17, 0, GROUP, [41, [new Uint8Array(32).fill(0x0c)], 2000, 1]),
    frame('mls.epoch_changed', 18, 8, GROUP, [42, 4129]),
    frame('message.ct', 19, 9, GROUP, [4130, 42, DEVICE, new Uint8Array([1, 2, 3]), TAG, 1758659700]),
    frame('mls.welcome', 20, 10, GROUP, [7, 42, 4129, new Uint8Array([4, 5]), new Uint8Array([6, 7]), TAG]),
    frame('message.deleted', 21, 11, GROUP, [4130, 1758659800]),
    frame('message.plain', 32, 12, null, [GROUP, 12, USER, new Uint8Array([8]), TAG, 0, 0]),
    frame('interaction', 33, 13, null, [GROUP, USER, 1, new Uint8Array([9])]),
    frame('presence', 48, 0, null, [USER, 1, 1758659000, 'at the forge']),
    frame('typing', 49, 0, null, [USER, DEVICE, 1, 1758659010]),
    frame('voice_state', 50, 0, null, [USER, DEVICE, GROUP, 3]),
  ];

  const rejects = [
    { name: 'three elements', frame: hex(encode([10, 1, null])), code: 'E_FRAME_SHAPE' },
    { name: 'five elements', frame: hex(encode([10, 1, null, [[GROUP]], 0])), code: 'E_FRAME_SHAPE' },
    { name: 'unknown opcode', frame: hex(encode([63, 1, null, []])), code: 'E_FRAME_TYPE' },
    { name: 'server opcode from a client', frame: hex(encode([3, 1, null, []])), code: 'E_FRAME_TYPE' },
    { name: 'payload is not an array', frame: hex(encode([10, 1, null, 'x'])), code: 'E_FRAME_SHAPE' },
    { name: 'subscribe with the wrong element count', frame: hex(encode([10, 1, null, [[GROUP], 1]])), code: 'E_FRAME_SHAPE' },
    { name: 'group_id on a control frame', frame: hex(encode([10, 1, GROUP, [[GROUP]]])), code: 'E_FRAME_SHAPE' },
    // A client opcode, deliberately: op 16 is `mls.handshake`, whose spec has `fromClient: false`,
    // so `Decode` would return E_FRAME_TYPE at the opcode check before it ever looked at
    // element 2. With op 10 the decoder reaches the `group_id` unmarshal, which refuses a
    // 15-byte bstr for a 16-byte id.ID — a different branch from the 'group_id on a control
    // frame' case above, which trips `gid != nil && !spec.grouped`.
    { name: 'group_id of the wrong length', frame: hex(encode([10, 1, new Uint8Array(15), [[GROUP]]])), code: 'E_FRAME_SHAPE' },
    // The mirror rule, reachable because opcode 12 `commit_ack` is the one group-scoped CLIENT
    // opcode: a grouped frame with a null group_id. `Decode`'s `gid == nil && spec.grouped`
    // branch answers it; without that branch the frame would reach `handle` with a nil GroupID
    // and invariant 7's acknowledgement would be silently dropped rather than refused.
    { name: 'commit_ack with no group_id', frame: hex(encode([12, 6, null, [1]])), code: 'E_FRAME_SHAPE' },
    // Deterministic-CBOR failures: a non-minimal integer head and a map where an array belongs.
    { name: 'non-minimal op', frame: '8418' + '0a' + '01f680', code: 'E_FRAME_CBOR' },
    { name: 'map instead of an array', frame: 'a100f6', code: 'E_FRAME_CBOR' },
  ];

  return {
    version: 1,
    description:
      'gateway frames (02-delivery-service.md). frame = deterministic CBOR of [op, n, group_id, payload]; payload is the payload array alone. rejects = byte strings a conforming decoder must refuse with the named code.',
    cases,
    rejects,
  };
}
