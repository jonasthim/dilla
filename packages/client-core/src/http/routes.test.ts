import { describe, expect, it } from 'vitest';
import { encode } from '../cbor';
import { toHex } from '../hex';
import { type Bucket } from './client';
import { DillaHttpError } from './errors';
import {
  RecordingClient, bytesReply, cborReply, fakeTransport, noContent, refusal, textReply, type FakeOptions,
} from './fake-fetch';
import { HANDSHAKES_MAX, MEMBERS_PAGE, MESSAGES_MAX, Routes, WELCOMES_PAGE } from './routes';

const fill = (n: number, b: number): Uint8Array => new Uint8Array(n).fill(b);
const INSTANCE = fill(16, 0x01);
const USER = fill(16, 0x02);
const DEVICE = fill(16, 0x03);
const COMMUNITY = fill(16, 0x04);
const CHANNEL = fill(16, 0x05);
const CATEGORY = fill(16, 0x06);
const GROUP = fill(16, 0x07);
const KEY_ID = fill(16, 0x08);
const BOT = fill(16, 0x13);
const ROLE = fill(16, 0x14);
const PUB = fill(32, 0x09);
const NONCE = fill(32, 0x0a);
const BLOB = fill(40, 0x0b);
const SIG = fill(64, 0x0c);
const ZERO32 = fill(32, 0x00);
const TAG = fill(32, 0x0d);
const COMMITMENT = fill(32, 0x0e);
const TREE = fill(24, 0x0f);
const HASH = fill(32, 0x10);
const REF = fill(32, 0x11);
const WIN = fill(48, 0x12);

const BODY = encode(['request body built by the core', 1]);
const EMPTY_ARRAY = encode([]);
const INFO = encode([3, BLOB, HASH, 12]);
const TREE_BODY = encode([3, TREE, HASH]);
const HANDSHAKES = encode([[1, 0, 1, null, BLOB], [2, 1, 0, 0, BLOB]]);
const MESSAGES = encode([[3, 1, DEVICE, BLOB, COMMITMENT, TAG, 1_800_000_000, 0]]);
const PROPOSALS = encode([[REF, 1, 2, BLOB, 0]]);
const UPLOADED = encode([10, TAG, 1_800_000_001]);
const WELCOMES = encode([[5, GROUP, 1, 4, BLOB, TREE, HASH]]);
const INSTANCE_DOC = [[1], [1], [1], INSTANCE, 7, 'dilla.test', 0, [0, 3], 2, KEY_ID, PUB];

const hex = toHex;

function setup(opts: FakeOptions = {}) {
  const t = fakeTransport(opts);
  const http = new RecordingClient(t.deps);
  return { t, http, routes: new Routes(http) };
}

function member(i: number): Uint8Array {
  const id = new Uint8Array(16);
  id[15] = i;
  return id;
}

interface Case {
  name: string;
  call(r: Routes): Promise<unknown>;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  bucket: Bucket;
  idempotent: boolean;
  auth: boolean;
  accept?: string;
  sent: Uint8Array | null;
  reply(): Response;
  expected: unknown;
}

const CASES: Case[] = [
  {
    name: 'getInstance reads elements 3 to 8 and 10', call: (r) => r.getInstance(),
    method: 'GET', path: '/v1/instance', bucket: 'read', idempotent: true, auth: false, sent: null,
    reply: () => cborReply(200, INSTANCE_DOC),
    expected: { instanceId: INSTANCE, generation: 7n, name: 'dilla.test', registrationMode: 0, authMethods: [0, 3], policyVersion: 2n, externalSenderPub: PUB },
  },
  {
    name: 'getInvite asks for CBOR and escapes the code', call: (r) => r.getInvite('AB/CD EF'),
    method: 'GET', path: '/i/AB%2FCD%20EF', bucket: 'none', idempotent: true, auth: false, accept: 'application/cbor', sent: null,
    reply: () => cborReply(200, ['dilla.test', COMMUNITY, 1_900_000_000, 'loot']),
    expected: { communityId: COMMUNITY, communityName: 'loot', expires: 1_900_000_000n },
  },
  {
    name: 'getInvite of an instance invite', call: (r) => r.getInvite('ABCD'),
    method: 'GET', path: '/i/ABCD', bucket: 'none', idempotent: true, auth: false, accept: 'application/cbor', sent: null,
    reply: () => cborReply(200, ['dilla.test', null, 1_900_000_000, null]),
    expected: { communityId: null, communityName: null, expires: 1_900_000_000n },
  },
  {
    name: 'postAccount sends the core body unchanged', call: (r) => r.postAccount(BODY),
    method: 'POST', path: '/v1/accounts', bucket: 'none', idempotent: false, auth: false, sent: BODY,
    reply: () => cborReply(200, [USER, DEVICE, 'tok-new', 1_900_000_000]),
    expected: { userId: USER, deviceId: DEVICE, token: 'tok-new', expires: 1_900_000_000n },
  },
  {
    name: 'postChallenge sends an empty array', call: (r) => r.postChallenge(DEVICE),
    method: 'POST', path: `/v1/devices/${hex(DEVICE)}/sessions/challenge`, bucket: 'none', idempotent: true, auth: false, sent: EMPTY_ARRAY,
    reply: () => cborReply(201, [NONCE, 1_800_000_060]),
    expected: { nonce: NONCE, expires: 1_800_000_060n },
  },
  {
    name: 'postSession reads all seven elements', call: (r) => r.postSession(DEVICE, BODY),
    method: 'POST', path: `/v1/devices/${hex(DEVICE)}/sessions`, bucket: 'none', idempotent: false, auth: false, sent: BODY,
    reply: () => cborReply(201, ['tok-2', 0, USER, DEVICE, 1_800_604_800, 1_800_043_200, 7]),
    expected: { token: 'tok-2', scope: 0, userId: USER, deviceId: DEVICE, expires: 1_800_604_800n, idleExpires: 1_800_043_200n, generation: 7n },
  },
  {
    name: 'putDeviceList', call: (r) => r.putDeviceList(USER, BODY),
    method: 'PUT', path: `/v1/users/${hex(USER)}/device-list`, bucket: 'write', idempotent: true, auth: true, sent: BODY,
    reply: () => noContent(), expected: undefined,
  },
  {
    name: 'getDeviceList', call: (r) => r.getDeviceList(USER),
    method: 'GET', path: `/v1/users/${hex(USER)}/device-list`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [1, BLOB, SIG, ZERO32]), expected: { version: 1n, blob: BLOB },
  },
  {
    name: 'getDeviceList answers null for a 404', call: (r) => r.getDeviceList(USER),
    method: 'GET', path: `/v1/users/${hex(USER)}/device-list`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => refusal(404, 'E_NOT_FOUND', 'not found'), expected: null,
  },
  {
    name: 'postKeyPackages', call: (r) => r.postKeyPackages(BODY),
    method: 'POST', path: '/v1/keypackages', bucket: 'write', idempotent: false, auth: true, sent: BODY,
    reply: () => cborReply(201, [32]), expected: 32,
  },
  {
    name: 'postTicket', call: (r) => r.postTicket(),
    method: 'POST', path: '/v1/gateway/ticket', bucket: 'write', idempotent: false, auth: true, sent: EMPTY_ARRAY,
    reply: () => cborReply(201, ['tkt-1', 1_800_000_030]), expected: { ticket: 'tkt-1', expires: 1_800_000_030n },
  },
  {
    name: 'listCommunities', call: (r) => r.listCommunities(),
    method: 'GET', path: '/v1/communities', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [[COMMUNITY, 'loot', USER, 1]]),
    expected: [{ id: COMMUNITY, name: 'loot', owner: USER, policyVersion: 1n }],
  },
  {
    name: 'joinCommunity with an invite', call: (r) => r.joinCommunity(COMMUNITY, 'AB12'),
    method: 'POST', path: `/v1/communities/${hex(COMMUNITY)}/join`, bucket: 'none', idempotent: true, auth: true, sent: encode(['AB12']),
    reply: () => cborReply(200, [COMMUNITY]), expected: undefined,
  },
  {
    name: 'joinCommunity without an invite', call: (r) => r.joinCommunity(COMMUNITY, null),
    method: 'POST', path: `/v1/communities/${hex(COMMUNITY)}/join`, bucket: 'none', idempotent: true, auth: true, sent: encode([null]),
    reply: () => cborReply(200, [COMMUNITY]), expected: undefined,
  },
  {
    name: 'listChannels reads text_group_id', call: (r) => r.listChannels(COMMUNITY),
    method: 'GET', path: `/v1/communities/${hex(COMMUNITY)}/channels`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [
      [CATEGORY, 2, 0, 0, null, 'text', '', 0, 0, 0, null],
      [CHANNEL, 0, 0, 0, CATEGORY, 'general', 'say hi', 1, 30, 5, GROUP],
    ]),
    expected: [
      { id: CATEGORY, kind: 2, mode: 0, visibility: 0, parentId: null, name: 'text', topic: '', position: 0, seq: 0n, textGroupId: null },
      { id: CHANNEL, kind: 0, mode: 0, visibility: 0, parentId: CATEGORY, name: 'general', topic: 'say hi', position: 1, seq: 5n, textGroupId: GROUP },
    ],
  },
  {
    name: 'listMembers reads names and kind', call: (r) => r.listMembers(COMMUNITY),
    method: 'GET', path: `/v1/communities/${hex(COMMUNITY)}/members`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [
      [USER, 1_700_000_000, '', [], 'jonas', 'Jonas', 0],
      [BOT, 1_700_000_100, 'helper', [ROLE], 'bot1', 'Bot One', 1],
    ]),
    expected: [
      { userId: USER, username: 'jonas', display: 'Jonas', kind: 0, nick: '' },
      { userId: BOT, username: 'bot1', display: 'Bot One', kind: 1, nick: 'helper' },
    ],
  },
  {
    name: 'postGroup', call: (r) => r.postGroup(BODY),
    method: 'POST', path: '/v1/groups', bucket: 'write', idempotent: false, auth: true, sent: BODY,
    reply: () => cborReply(201, [GROUP, 1]), expected: { nextSeq: 1n },
  },
  {
    name: 'getGroupInfo returns the body unchanged', call: (r) => r.getGroupInfo(GROUP),
    method: 'GET', path: `/v1/groups/${hex(GROUP)}/info`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, INFO), expected: INFO,
  },
  {
    name: 'getGroupTree returns the body unchanged', call: (r) => r.getGroupTree(GROUP),
    method: 'GET', path: `/v1/groups/${hex(GROUP)}/tree`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, TREE_BODY), expected: TREE_BODY,
  },
  {
    name: 'getHandshakes counts rows and reads the last seq', call: (r) => r.getHandshakes(GROUP, 1n, 512),
    method: 'GET', path: `/v1/groups/${hex(GROUP)}/handshakes?from=1&limit=512`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, HANDSHAKES), expected: { raw: HANDSHAKES, count: 2, lastSeq: 2n },
  },
  {
    name: 'getHandshakes of an empty page', call: (r) => r.getHandshakes(GROUP, 9n, 512),
    method: 'GET', path: `/v1/groups/${hex(GROUP)}/handshakes?from=9&limit=512`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, EMPTY_ARRAY), expected: { raw: EMPTY_ARRAY, count: 0, lastSeq: null },
  },
  {
    name: 'getMessages counts rows and reads the last seq', call: (r) => r.getMessages(GROUP, 3n, 256),
    method: 'GET', path: `/v1/groups/${hex(GROUP)}/messages?from=3&limit=256`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, MESSAGES), expected: { raw: MESSAGES, count: 1, lastSeq: 3n },
  },
  {
    name: 'getProposals returns the body unchanged', call: (r) => r.getProposals(GROUP),
    method: 'GET', path: `/v1/groups/${hex(GROUP)}/proposals`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, PROPOSALS), expected: PROPOSALS,
  },
  {
    name: 'postCommit', call: (r) => r.postCommit(GROUP, BODY),
    method: 'POST', path: `/v1/groups/${hex(GROUP)}/commit`, bucket: 'commit', idempotent: false, auth: true, sent: BODY,
    reply: () => cborReply(200, [9, 2]), expected: { seq: 9n, epoch: 2n },
  },
  {
    name: 'postMessage returns the body for the core and its seq', call: (r) => r.postMessage(GROUP, BODY),
    method: 'POST', path: `/v1/groups/${hex(GROUP)}/message`, bucket: 'message', idempotent: false, auth: true, sent: BODY,
    reply: () => bytesReply(200, UPLOADED), expected: { raw: UPLOADED, seq: 10n },
  },
  {
    name: 'postCursor', call: (r) => r.postCursor(GROUP, BODY),
    method: 'POST', path: `/v1/groups/${hex(GROUP)}/cursor`, bucket: 'write', idempotent: true, auth: true, sent: BODY,
    reply: () => noContent(), expected: undefined,
  },
  {
    name: 'postResync', call: (r) => r.postResync(GROUP, BODY),
    method: 'POST', path: `/v1/groups/${hex(GROUP)}/resync`, bucket: 'commit', idempotent: false, auth: true, sent: BODY,
    reply: () => cborReply(200, [11, 3]), expected: { seq: 11n, epoch: 3n },
  },
  {
    name: 'getWelcomes counts rows and reads the last welcome id', call: (r) => r.getWelcomes(0n),
    method: 'GET', path: '/v1/welcomes?after=0&limit=64', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, WELCOMES), expected: { raw: WELCOMES, count: 1, lastId: 5n },
  },
  {
    name: 'deleteWelcome', call: (r) => r.deleteWelcome(5n),
    method: 'DELETE', path: '/v1/welcomes/5', bucket: 'write', idempotent: true, auth: true, sent: null,
    reply: () => noContent(), expected: undefined,
  },
  {
    name: 'deleteWelcome counts a 404 as done', call: (r) => r.deleteWelcome(5n),
    method: 'DELETE', path: '/v1/welcomes/5', bucket: 'write', idempotent: true, auth: true, sent: null,
    reply: () => refusal(404, 'E_NOT_FOUND', 'welcome'), expected: undefined,
  },
  {
    name: 'getAccountMe ignores an appended element', call: (r) => r.getAccountMe(),
    method: 'GET', path: '/v1/accounts/me', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [USER, 'jonas', 'Jonas', 0, 1, 1_700_000_000, 'appended later']),
    expected: { userId: USER, username: 'jonas', display: 'Jonas', kind: 0, flags: 1n },
  },
  {
    name: 'getLimits reads elements 0, 4, 5, 7 and 8', call: (r) => r.getLimits(),
    method: 'GET', path: '/v1/instance/limits', bucket: 'read', idempotent: true, auth: false, sent: null,
    reply: () => cborReply(200, [131072, 104857600, 4, 2, 32, 8, 10737418240, 30000, 131584, 30, 30]),
    expected: { maxCiphertextBytes: 131072, keypackagesPerDevice: 32, keypackageRefillThreshold: 8, heartbeatMs: 30000, maxFrameBytes: 131584 },
  },
];

describe('Routes: one request per call, decoded as the server answers it', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { t, http, routes } = setup();
      t.replies.push(c.reply());
      expect(await c.call(routes)).toEqual(c.expected);
      expect(t.seen).toHaveLength(1);
      const s = t.seen[0];
      expect(s.method).toBe(c.method);
      expect(s.url).toBe(`https://dilla.test${c.path}`);
      expect(s.headers.get('authorization')).toBe(c.auth ? 'Bearer tok-1' : null);
      expect(s.headers.get('accept')).toBe(c.accept ?? null);
      expect(s.body).toEqual(c.sent);
      expect(http.requests[0].bucket).toBe(c.bucket);
      expect(http.requests[0].idempotent).toBe(c.idempotent);
      expect(http.requests[0].auth ?? true).toBe(c.auth);
    });
  }
});

interface RefusalCase { name: string; call(r: Routes): Promise<unknown>; reply(): Response; status: number; code: string; }

const REFUSALS: RefusalCase[] = [
  { name: 'getInstance 501', call: (r) => r.getInstance(), reply: () => refusal(501, 'E_INTERNAL'), status: 501, code: 'E_INTERNAL' },
  { name: 'getInvite 410', call: (r) => r.getInvite('ABCD'), reply: () => refusal(410, 'E_INVITE_INVALID', 'the invite is spent, expired, revoked or unknown'), status: 410, code: 'E_INVITE_INVALID' },
  { name: 'postAccount 409 username taken', call: (r) => r.postAccount(BODY), reply: () => refusal(409, 'E_INVALID_REQUEST', 'username taken'), status: 409, code: 'E_INVALID_REQUEST' },
  { name: 'postChallenge 400', call: (r) => r.postChallenge(DEVICE), reply: () => refusal(400, 'E_INVALID_REQUEST'), status: 400, code: 'E_INVALID_REQUEST' },
  { name: 'postSession 401', call: (r) => r.postSession(DEVICE, BODY), reply: () => refusal(401, 'E_UNAUTHENTICATED'), status: 401, code: 'E_UNAUTHENTICATED' },
  { name: 'putDeviceList 409', call: (r) => r.putDeviceList(USER, BODY), reply: () => refusal(409, 'E_INVALID_REQUEST', 'device-list version 1 already published'), status: 409, code: 'E_INVALID_REQUEST' },
  { name: 'getDeviceList 403', call: (r) => r.getDeviceList(USER), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'postKeyPackages 413', call: (r) => r.postKeyPackages(BODY), reply: () => refusal(413, 'E_TOO_LARGE'), status: 413, code: 'E_TOO_LARGE' },
  { name: 'postTicket 401', call: (r) => r.postTicket(), reply: () => refusal(401, 'E_UNAUTHENTICATED'), status: 401, code: 'E_UNAUTHENTICATED' },
  { name: 'listCommunities 403', call: (r) => r.listCommunities(), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'joinCommunity 410', call: (r) => r.joinCommunity(COMMUNITY, 'AB12'), reply: () => refusal(410, 'E_INVITE_INVALID'), status: 410, code: 'E_INVITE_INVALID' },
  { name: 'listChannels 404', call: (r) => r.listChannels(COMMUNITY), reply: () => refusal(404, 'E_NOT_FOUND', 'no such object'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'listMembers 404', call: (r) => r.listMembers(COMMUNITY), reply: () => refusal(404, 'E_NOT_FOUND'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'postGroup 409', call: (r) => r.postGroup(BODY), reply: () => refusal(409, 'E_GROUP_EXISTS'), status: 409, code: 'E_GROUP_EXISTS' },
  { name: 'getGroupInfo 404', call: (r) => r.getGroupInfo(GROUP), reply: () => refusal(404, 'E_NOT_FOUND'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'getGroupTree 404', call: (r) => r.getGroupTree(GROUP), reply: () => refusal(404, 'E_NOT_FOUND'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'getHandshakes 410', call: (r) => r.getHandshakes(GROUP, 1n, 512), reply: () => refusal(410, 'E_PRUNED'), status: 410, code: 'E_PRUNED' },
  { name: 'getMessages 410', call: (r) => r.getMessages(GROUP, 1n, 256), reply: () => refusal(410, 'E_PRUNED'), status: 410, code: 'E_PRUNED' },
  { name: 'getProposals 404', call: (r) => r.getProposals(GROUP), reply: () => refusal(404, 'E_NOT_FOUND'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'postCommit 409', call: (r) => r.postCommit(GROUP, BODY), reply: () => refusal(409, 'E_COMMIT_CONFLICT', 'another commit won this epoch', null, [WIN, [REF]]), status: 409, code: 'E_COMMIT_CONFLICT' },
  { name: 'postMessage 425', call: (r) => r.postMessage(GROUP, BODY), reply: () => refusal(425, 'E_COMMIT_REQUIRED', 'outstanding proposals must be committed first', 1500, [[REF]]), status: 425, code: 'E_COMMIT_REQUIRED' },
  { name: 'postCursor 400', call: (r) => r.postCursor(GROUP, BODY), reply: () => refusal(400, 'E_INVALID_REQUEST'), status: 400, code: 'E_INVALID_REQUEST' },
  { name: 'postResync 403', call: (r) => r.postResync(GROUP, BODY), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'getWelcomes 401', call: (r) => r.getWelcomes(0n), reply: () => refusal(401, 'E_UNAUTHENTICATED'), status: 401, code: 'E_UNAUTHENTICATED' },
  { name: 'deleteWelcome 403', call: (r) => r.deleteWelcome(5n), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'getAccountMe 401', call: (r) => r.getAccountMe(), reply: () => refusal(401, 'E_UNAUTHENTICATED'), status: 401, code: 'E_UNAUTHENTICATED' },
  { name: 'getLimits 501', call: (r) => r.getLimits(), reply: () => refusal(501, 'E_INTERNAL'), status: 501, code: 'E_INTERNAL' },
];

describe('Routes: a refusal propagates unchanged and is sent once', () => {
  for (const c of REFUSALS) {
    it(c.name, async () => {
      const { t, routes } = setup();
      t.replies.push(c.reply());
      const outcome = await c.call(routes).then(() => 'resolved', (e: unknown) => e);
      expect(outcome).toBeInstanceOf(DillaHttpError);
      expect(outcome).toMatchObject({ status: c.status, code: c.code });
      expect(t.seen).toHaveLength(1);
      expect(t.sleeps).toEqual([]);
    });
  }

  it('keeps the extras of a commit conflict', async () => {
    const { t, routes } = setup();
    t.replies.push(refusal(409, 'E_COMMIT_CONFLICT', 'another commit won this epoch', null, [WIN, [REF]]));
    const outcome = await routes.postCommit(GROUP, BODY).then(() => 'resolved', (e: unknown) => e);
    expect(outcome).toMatchObject({ code: 'E_COMMIT_CONFLICT', extra: [WIN, [REF]] });
  });

  it('postSession 401 never re-authenticates', async () => {
    const { t, routes } = setup({ reauth: () => ({ ok: true, token: 'tok-2' }) });
    t.replies.push(refusal(401, 'E_UNAUTHENTICATED'));
    await routes.postSession(DEVICE, BODY).then(() => 'resolved', (e: unknown) => e);
    expect(t.reauthCalls).toBe(0);
  });
});

describe('Routes: retries and inputs', () => {
  it('postMessage is sent once after a network failure', async () => {
    const { t, routes } = setup();
    t.replies.push(new TypeError('fetch failed'), bytesReply(200, UPLOADED));
    const outcome = await routes.postMessage(GROUP, BODY).then(() => 'sent', (e: unknown) => e);
    expect(t.seen).toHaveLength(1);
    expect(outcome).toBeInstanceOf(DillaHttpError);
    expect(outcome).toMatchObject({ status: 0, code: 'E_NETWORK' });
  });

  it('postAccount is sent once after a 500', async () => {
    const { t, routes } = setup();
    t.replies.push(refusal(500, 'E_INTERNAL'), cborReply(200, [USER, DEVICE, 'tok-new', 1]));
    const outcome = await routes.postAccount(BODY).then(() => 'sent', (e: unknown) => e);
    expect(t.seen).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 500, code: 'E_INTERNAL' });
  });

  it('a read is retried after a network failure', async () => {
    const { t, routes } = setup();
    t.replies.push(new TypeError('fetch failed'), bytesReply(200, MESSAGES));
    expect(await routes.getMessages(GROUP, 3n, 256)).toEqual({ raw: MESSAGES, count: 1, lastSeq: 3n });
    expect(t.seen).toHaveLength(2);
    expect(t.sleeps).toEqual([625]);
  });

  it('refuses bad inputs before sending', async () => {
    const { t, routes } = setup();
    // Thunks, not promises: each call starts only when its expectation is attached, so no
    // rejection is ever unhandled between two awaits.
    const attempts: (() => Promise<unknown>)[] = [
      () => routes.getHandshakes(GROUP, 1n, HANDSHAKES_MAX + 1),
      () => routes.getHandshakes(GROUP, 1n, 0),
      () => routes.getHandshakes(GROUP, -1n, 1),
      () => routes.getMessages(GROUP, 1n, MESSAGES_MAX + 1),
      () => routes.getWelcomes(-1n),
      () => routes.deleteWelcome(-1n),
      () => routes.listChannels(new Uint8Array(15)),
      () => routes.postCommit(new Uint8Array(17), BODY),
      () => routes.postChallenge(new Uint8Array(0)),
    ];
    for (const [i, attempt] of attempts.entries()) {
      await expect(attempt(), `attempt ${i}`).rejects.toThrow(/^E_ROUTE_INPUT: /);
    }
    expect(t.seen).toHaveLength(0);
  });

  it('exports the server page sizes', () => {
    expect([MEMBERS_PAGE, HANDSHAKES_MAX, MESSAGES_MAX, WELCOMES_PAGE]).toEqual([200, 512, 256, 64]);
  });
});

describe('Routes: response shapes', () => {
  it('refuses an answer with an element missing', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, INSTANCE_DOC.slice(0, 10)));
    await expect(routes.getInstance()).rejects.toMatchObject({ name: 'CborError', code: 'E_CBOR_SHAPE' });
  });

  it('refuses a registration mode outside 0 to 2 and a member kind outside 0 to 1', async () => {
    const { t, routes } = setup();
    const doc = [...INSTANCE_DOC];
    doc[6] = 3;
    t.replies.push(cborReply(200, doc), cborReply(200, [[USER, 1, '', [], 'jonas', 'Jonas', 2]]));
    await expect(routes.getInstance()).rejects.toMatchObject({ code: 'E_CBOR_RANGE' });
    await expect(routes.listMembers(COMMUNITY)).rejects.toMatchObject({ code: 'E_CBOR_RANGE' });
  });

  it('refuses an id of the wrong length in an answer', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, [[fill(15, 1), 'loot', USER, 1]]));
    await expect(routes.listCommunities()).rejects.toMatchObject({ code: 'E_CBOR_SHAPE' });
  });

  it('keeps auth methods it does not know', async () => {
    const { t, routes } = setup();
    const doc = [...INSTANCE_DOC];
    doc[7] = [0, 9];
    t.replies.push(cborReply(200, doc));
    expect((await routes.getInstance()).authMethods).toEqual([0, 9]);
  });

  it('reads a text/plain 404 of the mux as E_HTTP', async () => {
    const { t, routes } = setup();
    t.replies.push(textReply(404, '404 page not found\n'));
    await expect(routes.listCommunities()).rejects.toMatchObject({ status: 404, code: 'E_HTTP' });
  });
});

describe('Routes: member paging', () => {
  const row = (i: number) => [member(i), 1_700_000_000, '', [], `u${i}`, `U ${i}`, 0];

  it('follows ?after= until a short page', async () => {
    const { t, routes } = setup();
    const first = Array.from({ length: MEMBERS_PAGE }, (_, i) => row(i + 1));
    const second = [row(201), row(202), row(203)];
    t.replies.push(cborReply(200, first), cborReply(200, second));
    const members = await routes.listMembers(COMMUNITY);
    expect(t.seen.map((s) => s.url)).toEqual([
      `https://dilla.test/v1/communities/${hex(COMMUNITY)}/members`,
      `https://dilla.test/v1/communities/${hex(COMMUNITY)}/members?after=${hex(member(200))}`,
    ]);
    expect(members).toHaveLength(203);
    expect(members[0]).toEqual({ userId: member(1), username: 'u1', display: 'U 1', kind: 0, nick: '' });
    expect(members[202].userId).toEqual(member(203));
  });

  it('asks once more after a full last page and stops at an empty one', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, Array.from({ length: MEMBERS_PAGE }, (_, i) => row(i + 1))), cborReply(200, []));
    expect(await routes.listMembers(COMMUNITY)).toHaveLength(200);
    expect(t.seen).toHaveLength(2);
  });

  it('stops with a shape error when a full page does not advance', async () => {
    const { t, routes } = setup();
    const page = Array.from({ length: MEMBERS_PAGE }, (_, i) => row(i + 1));
    t.replies.push(cborReply(200, page), cborReply(200, page));
    await expect(routes.listMembers(COMMUNITY)).rejects.toMatchObject({ code: 'E_CBOR_SHAPE' });
    expect(t.seen).toHaveLength(2);
  });
});
