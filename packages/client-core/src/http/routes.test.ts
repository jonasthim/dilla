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
const STORED = fill(5, 0x1a);

function octetReply(status: number, body: Uint8Array): Response {
  return new Response(body.slice(), { status, headers: { 'Content-Type': 'application/octet-stream', 'X-Dilla-Generation': '7' } });
}

const DEVICE_2 = fill(16, 0x19);
const PEER_USER = fill(16, 0x18);
const BLOB_ID = fill(32, 0x17);
const ASSERTION = 'asrt-1';
const OBJECT = encode([1, fill(12, 0x15), fill(86, 0x16)]);
const HISTORY = encode([[2, BLOB, SIG, HASH], [3, BLOB, SIG, HASH]]);

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
    reply: () => cborReply(200, [1, BLOB, SIG, ZERO32]), expected: { version: 1n, blob: BLOB, raw: encode([1, BLOB, SIG, ZERO32]) },
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
      { userId: USER, username: 'jonas', display: 'Jonas', kind: 0, nick: '', roleIds: [] },
      { userId: BOT, username: 'bot1', display: 'Bot One', kind: 1, nick: 'helper', roleIds: [ROLE] },
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
  {
    name: 'passwordLogin sends both strings without a token', call: (r) => r.passwordLogin('ada', 'hunter2 hunter2'),
    method: 'POST', path: '/v1/auth/password/login', bucket: 'none', idempotent: false, auth: false, sent: encode(['ada', 'hunter2 hunter2']),
    reply: () => cborReply(200, [ASSERTION, 1]), expected: { assertion: ASSERTION, needsTotp: true },
  },
  {
    name: 'passwordLogin without a second factor', call: (r) => r.passwordLogin('ada', 'pw'),
    method: 'POST', path: '/v1/auth/password/login', bucket: 'none', idempotent: false, auth: false, sent: encode(['ada', 'pw']),
    reply: () => cborReply(200, [ASSERTION, 0]), expected: { assertion: ASSERTION, needsTotp: false },
  },
  {
    name: 'totpVerify', call: (r) => r.totpVerify(ASSERTION, '123456'),
    method: 'POST', path: '/v1/auth/totp/verify', bucket: 'none', idempotent: false, auth: false, sent: encode([ASSERTION, '123456']),
    reply: () => cborReply(200, ['asrt-2']), expected: { assertion: 'asrt-2' },
  },
  {
    name: 'postSessionPending reads the pending answer', call: (r) => r.postSessionPending(DEVICE, BODY),
    method: 'POST', path: `/v1/devices/${hex(DEVICE)}/sessions`, bucket: 'none', idempotent: false, auth: false, sent: BODY,
    reply: () => cborReply(201, ['tok-p', 1, USER, DEVICE, 1_800_604_800, 1_800_043_200, 7]),
    expected: { token: 'tok-p', scope: 1, userId: USER, deviceId: DEVICE, expires: 1_800_604_800n, idleExpires: 1_800_043_200n, generation: 7n },
  },
  {
    name: 'listBackups', call: (r) => r.listBackups(),
    method: 'GET', path: '/v1/backups', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [[0, 0, 103, 1_800_000_000], [1, 0, 2048, 1_800_000_100]]),
    expected: [{ kind: 0, chunkSeq: 0, size: 103, created: 1_800_000_000n }, { kind: 1, chunkSeq: 0, size: 2048, created: 1_800_000_100n }],
  },
  {
    name: 'getBackup of the root object', call: (r) => r.getBackup(0),
    method: 'GET', path: '/v1/backups/0/0', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [OBJECT, 1_800_000_000]), expected: { object: OBJECT, created: 1_800_000_000n },
  },
  {
    name: 'getBackup answers null for a 404', call: (r) => r.getBackup(1),
    method: 'GET', path: '/v1/backups/1/0', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => refusal(404, 'E_NOT_FOUND', 'no such backup'), expected: null,
  },
  {
    name: 'putBackup of a new object', call: (r) => r.putBackup(0, OBJECT),
    method: 'PUT', path: '/v1/backups/0/0', bucket: 'write', idempotent: true, auth: true, sent: encode([OBJECT]),
    reply: () => cborReply(201, [BLOB_ID, 103]), expected: { blobId: BLOB_ID, size: 103, created: true },
  },
  {
    name: 'putBackup of a replaced object', call: (r) => r.putBackup(1, OBJECT),
    method: 'PUT', path: '/v1/backups/1/0', bucket: 'write', idempotent: true, auth: true, sent: encode([OBJECT]),
    reply: () => cborReply(200, [BLOB_ID, 103]), expected: { blobId: BLOB_ID, size: 103, created: false },
  },
  {
    name: 'listDevices', call: (r) => r.listDevices(),
    method: 'GET', path: '/v1/devices', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [[DEVICE, 1, 1, null, null, 1_800_000_000], [DEVICE_2, 0, 0, 1_799_000_000, 1_800_000_050, 1_799_999_999]]),
    expected: [
      { id: DEVICE, tier: 1, signerTier: 1, verifiedAt: null, revokedAt: null, lastSeen: 1_800_000_000n },
      { id: DEVICE_2, tier: 0, signerTier: 0, verifiedAt: 1_799_000_000n, revokedAt: 1_800_000_050n, lastSeen: 1_799_999_999n },
    ],
  },
  {
    name: 'deleteSessions', call: (r) => r.deleteSessions(DEVICE),
    method: 'DELETE', path: `/v1/devices/${hex(DEVICE)}/sessions`, bucket: 'write', idempotent: true, auth: true, sent: null,
    reply: () => noContent(), expected: undefined,
  },
  {
    name: 'getDeviceListHistory returns the body for the core and its last version', call: (r) => r.getDeviceListHistory(USER, 1n),
    method: 'GET', path: `/v1/users/${hex(USER)}/device-list?after=1`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, HISTORY), expected: { raw: HISTORY, count: 2, lastVersion: 3n },
  },
  {
    name: 'getDeviceListHistory with nothing newer', call: (r) => r.getDeviceListHistory(USER, 3n),
    method: 'GET', path: `/v1/users/${hex(USER)}/device-list?after=3`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => bytesReply(200, EMPTY_ARRAY), expected: { raw: EMPTY_ARRAY, count: 0, lastVersion: null },
  },
  {
    name: 'postDm opens a new DM', call: (r) => r.postDm([PEER_USER]),
    method: 'POST', path: '/v1/dms', bucket: 'write', idempotent: false, auth: true, sent: encode([[PEER_USER]]),
    reply: () => cborReply(201, [CHANNEL]), expected: { channelId: CHANNEL, created: true },
  },
  {
    name: 'postDm finds the existing DM', call: (r) => r.postDm([PEER_USER]),
    method: 'POST', path: '/v1/dms', bucket: 'write', idempotent: false, auth: true, sent: encode([[PEER_USER]]),
    reply: () => cborReply(200, [CHANNEL]), expected: { channelId: CHANNEL, created: false },
  },
  {
    name: 'listDms reads a null member list as empty', call: (r) => r.listDms(),
    method: 'GET', path: '/v1/dms', bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [[CHANNEL, 3, [USER, PEER_USER]], [CATEGORY, 4, null]]),
    expected: [{ channelId: CHANNEL, kind: 3, members: [USER, PEER_USER] }, { channelId: CATEGORY, kind: 4, members: [] }],
  },
  {
    name: 'getChannel of a DM reads the twelve-element row', call: (r) => r.getChannel(CHANNEL),
    method: 'GET', path: `/v1/channels/${hex(CHANNEL)}`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [CHANNEL, null, 3, 0, 0, null, '', '', 0, 0, 4, GROUP]),
    expected: { id: CHANNEL, kind: 3, mode: 0, visibility: 0, parentId: null, name: '', topic: '', position: 0, seq: 4n, textGroupId: GROUP },
  },
  {
    name: 'getChannel skips community_id and slow mode', call: (r) => r.getChannel(CHANNEL),
    method: 'GET', path: `/v1/channels/${hex(CHANNEL)}`, bucket: 'read', idempotent: true, auth: true, sent: null,
    reply: () => cborReply(200, [CHANNEL, COMMUNITY, 0, 0, 0, CATEGORY, 'general', 'say hi', 1, 30, 5, null]),
    expected: { id: CHANNEL, kind: 0, mode: 0, visibility: 0, parentId: CATEGORY, name: 'general', topic: 'say hi', position: 1, seq: 5n, textGroupId: null },
  },
  {
    name: 'deleteDevice removes an unlisted device row (73)', call: (r) => r.deleteDevice(DEVICE_2),
    method: 'DELETE', path: `/v1/devices/${hex(DEVICE_2)}`, bucket: 'write', idempotent: false, auth: true, sent: null,
    reply: () => noContent(), expected: undefined,
  },
{
  name: 'deleteGroupMessage', call: (r) => r.deleteGroupMessage(GROUP, 12n),
  method: 'DELETE', path: `/v1/groups/${hex(GROUP)}/messages/12`, bucket: 'write', idempotent: true, auth: true, sent: null,
  reply: () => noContent(), expected: 'deleted',
},
{
  name: 'deleteGroupMessage answers gone for a 404', call: (r) => r.deleteGroupMessage(GROUP, 12n),
  method: 'DELETE', path: `/v1/groups/${hex(GROUP)}/messages/12`, bucket: 'write', idempotent: true, auth: true, sent: null,
  reply: () => refusal(404, 'E_NOT_FOUND', 'no such object'), expected: 'gone',
},
{
  name: 'putBlob of new bytes', call: (r) => r.putBlob(CHANNEL, BLOB_ID, STORED),
  method: 'PUT', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}`, bucket: 'upload', idempotent: true, auth: true,
  sent: STORED, reply: () => cborReply(201, [BLOB_ID, 5]), expected: { created: true, size: 5 },
},
{
  name: 'putBlob of bytes the instance already holds', call: (r) => r.putBlob(CHANNEL, BLOB_ID, STORED),
  method: 'PUT', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}`, bucket: 'upload', idempotent: true, auth: true,
  sent: STORED, reply: () => cborReply(200, [BLOB_ID, 5]), expected: { created: false, size: 5 },
},
{
  name: 'confirmBlob sends no body', call: (r) => r.confirmBlob(CHANNEL, BLOB_ID),
  method: 'POST', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}/confirm`, bucket: 'write', idempotent: true,
  auth: true, sent: null, reply: () => noContent(), expected: undefined,
},
{
  name: 'getBlob returns the stored bytes as served', call: (r) => r.getBlob(CHANNEL, BLOB_ID),
  method: 'GET', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}`, bucket: 'read', idempotent: true, auth: true,
  sent: null, reply: () => octetReply(200, STORED), expected: STORED,
},
{
  name: 'getBlob answers null for a 404', call: (r) => r.getBlob(CHANNEL, BLOB_ID),
  method: 'GET', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}`, bucket: 'read', idempotent: true, auth: true,
  sent: null, reply: () => refusal(404, 'E_NOT_FOUND', 'no such object'), expected: null,
},
{
  name: 'deleteBlob', call: (r) => r.deleteBlob(CHANNEL, BLOB_ID),
  method: 'DELETE', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}`, bucket: 'write', idempotent: true, auth: true,
  sent: null, reply: () => noContent(), expected: undefined,
},
{
  name: 'deleteBlob counts a 404 as done', call: (r) => r.deleteBlob(CHANNEL, BLOB_ID),
  method: 'DELETE', path: `/v1/channels/${hex(CHANNEL)}/blobs/${hex(BLOB_ID)}`, bucket: 'write', idempotent: true, auth: true,
  sent: null, reply: () => refusal(404, 'E_NOT_FOUND', 'no such object'), expected: undefined,
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
  { name: 'passwordLogin 401', call: (r) => r.passwordLogin('ada', 'x'), reply: () => refusal(401, 'E_UNAUTHENTICATED'), status: 401, code: 'E_UNAUTHENTICATED' },
  { name: 'totpVerify 401', call: (r) => r.totpVerify(ASSERTION, '000000'), reply: () => refusal(401, 'E_UNAUTHENTICATED'), status: 401, code: 'E_UNAUTHENTICATED' },
  { name: 'postSessionPending 429 beyond the retry window', call: (r) => r.postSessionPending(DEVICE, BODY), reply: () => refusal(429, 'E_RATE_LIMITED', '', 1_200_000), status: 429, code: 'E_RATE_LIMITED' },
  { name: 'postSessionPending 403 device cap', call: (r) => r.postSessionPending(DEVICE, BODY), reply: () => refusal(403, 'E_FORBIDDEN', 'device cap reached'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'listBackups 403', call: (r) => r.listBackups(), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'getBackup 403', call: (r) => r.getBackup(0), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'putBackup 409 root stored', call: (r) => r.putBackup(0, OBJECT), reply: () => refusal(409, 'E_INVALID_REQUEST', 'root object already stored'), status: 409, code: 'E_INVALID_REQUEST' },
  { name: 'listDevices 403', call: (r) => r.listDevices(), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'deleteSessions 404', call: (r) => r.deleteSessions(DEVICE), reply: () => refusal(404, 'E_NOT_FOUND', 'not found'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'getDeviceListHistory 400', call: (r) => r.getDeviceListHistory(USER, 0n), reply: () => refusal(400, 'E_INVALID_REQUEST'), status: 400, code: 'E_INVALID_REQUEST' },
  { name: 'postDm 404', call: (r) => r.postDm([PEER_USER]), reply: () => refusal(404, 'E_NOT_FOUND', 'no such user'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'listDms 403', call: (r) => r.listDms(), reply: () => refusal(403, 'E_FORBIDDEN'), status: 403, code: 'E_FORBIDDEN' },
  { name: 'getChannel 404', call: (r) => r.getChannel(CHANNEL), reply: () => refusal(404, 'E_NOT_FOUND'), status: 404, code: 'E_NOT_FOUND' },
  { name: 'deleteDevice 404', call: (r) => r.deleteDevice(DEVICE_2), reply: () => refusal(404, 'E_NOT_FOUND', 'not found'), status: 404, code: 'E_NOT_FOUND' },
{ name: 'deleteGroupMessage 403 another user\'s upload', call: (r) => r.deleteGroupMessage(GROUP, 12n), reply: () => refusal(403, 'E_NOT_UPLOADER', 'only the uploading user may delete this message'), status: 403, code: 'E_NOT_UPLOADER' },
{ name: 'putBlob 413', call: (r) => r.putBlob(CHANNEL, BLOB_ID, STORED), reply: () => refusal(413, 'E_TOO_LARGE', 'at most 104857600 bytes'), status: 413, code: 'E_TOO_LARGE' },
{ name: 'putBlob 422 hash mismatch', call: (r) => r.putBlob(CHANNEL, BLOB_ID, STORED), reply: () => refusal(422, 'E_INVALID_REQUEST', 'the body does not hash to the requested blob_id'), status: 422, code: 'E_INVALID_REQUEST' },
{ name: 'putBlob 507 quota', call: (r) => r.putBlob(CHANNEL, BLOB_ID, STORED), reply: () => refusal(507, 'E_STORAGE_FULL', 'your attachment quota is exhausted'), status: 507, code: 'E_STORAGE_FULL' },
{ name: 'putBlob 410 purged', call: (r) => r.putBlob(CHANNEL, BLOB_ID, STORED), reply: () => refusal(410, 'E_PRUNED', 'these bytes were removed by the server operator'), status: 410, code: 'E_PRUNED' },
{ name: 'confirmBlob 403', call: (r) => r.confirmBlob(CHANNEL, BLOB_ID), reply: () => refusal(403, 'E_NOT_UPLOADER'), status: 403, code: 'E_NOT_UPLOADER' },
{ name: 'confirmBlob 404', call: (r) => r.confirmBlob(CHANNEL, BLOB_ID), reply: () => refusal(404, 'E_NOT_FOUND', 'no such object'), status: 404, code: 'E_NOT_FOUND' },
{ name: 'confirmBlob 410', call: (r) => r.confirmBlob(CHANNEL, BLOB_ID), reply: () => refusal(410, 'E_PRUNED'), status: 410, code: 'E_PRUNED' },
{ name: 'getBlob 410', call: (r) => r.getBlob(CHANNEL, BLOB_ID), reply: () => refusal(410, 'E_PRUNED'), status: 410, code: 'E_PRUNED' },
{ name: 'deleteBlob 403', call: (r) => r.deleteBlob(CHANNEL, BLOB_ID), reply: () => refusal(403, 'E_NOT_UPLOADER', 'only the uploading user may delete this object'), status: 403, code: 'E_NOT_UPLOADER' },
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
  it('sends one request for a short 429 on login and session routes', async () => {
    for (const call of [
      (routes: Routes) => routes.passwordLogin('ada', 'pw'),
      (routes: Routes) => routes.postSession(DEVICE, BODY),
      (routes: Routes) => routes.postSessionPending(DEVICE, BODY),
    ]) {
      const { t, routes } = setup();
      t.replies.push(refusal(429, 'E_RATE_LIMITED', '', 1000));
      await expect(call(routes)).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
      expect(t.seen).toHaveLength(1);
      expect(t.sleeps).toEqual([]);
    }
  });
  it('refuses bad web-2a inputs before sending', async () => {
    const { t, routes } = setup();
    const attempts: (() => Promise<unknown>)[] = [
      () => routes.getBackup(2 as 0),
      () => routes.putBackup(3 as 1, OBJECT),
      () => routes.deleteSessions(new Uint8Array(15)),
      () => routes.getDeviceListHistory(USER, -1n),
      () => routes.getDeviceListHistory(new Uint8Array(17), 0n),
      () => routes.postDm([]),
      () => routes.postDm([new Uint8Array(15)]),
      () => routes.postDm(Array.from({ length: 65 }, () => PEER_USER)),
      () => routes.getChannel(new Uint8Array(17)),
      () => routes.deleteDevice(new Uint8Array(15)),
    ];
    for (const [i, attempt] of attempts.entries()) {
      await expect(attempt(), `attempt ${i}`).rejects.toThrow(/^E_ROUTE_INPUT: /);
    }
    expect(t.seen).toHaveLength(0);
  });
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
    expect(members[0]).toEqual({ userId: member(1), username: 'u1', display: 'U 1', kind: 0, nick: '', roleIds: [] });
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

describe('Routes: web-2b deletes and blobs', () => {
  it('putBlob labels its body octet-stream and hands it to fetch uncopied', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(201, [BLOB_ID, 5]));
    await routes.putBlob(CHANNEL, BLOB_ID, STORED);
    expect(t.seen[0].headers.get('content-type')).toBe('application/octet-stream');
    expect(t.seen[0].init.body).toBe(STORED);
  });

  it('confirmBlob sends neither a body nor a content type', async () => {
    const { t, routes } = setup();
    t.replies.push(noContent());
    await routes.confirmBlob(CHANNEL, BLOB_ID);
    expect(t.seen[0].body).toBeNull();
    expect(t.seen[0].headers.get('content-type')).toBeNull();
  });

  it('waits out a 429 on an upload and sends the bytes once more', async () => {
    const { t, routes } = setup();
    t.replies.push(refusal(429, 'E_RATE_LIMITED', '', 1000), cborReply(201, [BLOB_ID, 5]));
    expect(await routes.putBlob(CHANNEL, BLOB_ID, STORED)).toEqual({ created: true, size: 5 });
    expect(t.sleeps).toEqual([1000]);
    expect(t.seen).toHaveLength(2);
  });

  it('getBlob bounds the body by maxBytes and is unbounded without it (FACTS-SECURITY-13)', async () => {
    const { t, routes } = setup();
    t.replies.push(octetReply(200, STORED));
    await expect(routes.getBlob(CHANNEL, BLOB_ID, STORED.length - 1)).rejects.toMatchObject({ code: 'E_BODY_TOO_LARGE', status: 200 });
    t.replies.push(octetReply(200, STORED));
    expect(await routes.getBlob(CHANNEL, BLOB_ID, STORED.length)).toEqual(STORED);
    t.replies.push(octetReply(200, STORED));
    expect(await routes.getBlob(CHANNEL, BLOB_ID)).toEqual(STORED);
    expect(t.seen).toHaveLength(3);
  });

  it('refuses bad ids before sending', async () => {
    const { t, routes } = setup();
    await expect(routes.deleteGroupMessage(fill(15, 1), 1n)).rejects.toThrow('E_ROUTE_INPUT: groupId must be 16 bytes');
    await expect(routes.deleteGroupMessage(GROUP, -1n)).rejects.toThrow('E_ROUTE_INPUT: seq must not be negative');
    await expect(routes.putBlob(CHANNEL, fill(31, 1), STORED)).rejects.toThrow('E_ROUTE_INPUT: blobId must be 32 bytes');
    await expect(routes.getBlob(fill(15, 1), BLOB_ID)).rejects.toThrow('E_ROUTE_INPUT: channelId must be 16 bytes');
    await expect(routes.confirmBlob(CHANNEL, fill(33, 1))).rejects.toThrow('E_ROUTE_INPUT: blobId must be 32 bytes');
    await expect(routes.deleteBlob(CHANNEL, fill(16, 1))).rejects.toThrow('E_ROUTE_INPUT: blobId must be 32 bytes');
    expect(t.seen).toHaveLength(0);
  });

  it('listMembers reads a null role list as empty', async () => {
    const { t, routes } = setup();
    t.replies.push(cborReply(200, [[USER, 1_700_000_000, '', null, 'jonas', 'Jonas', 0]]));
    expect(await routes.listMembers(COMMUNITY)).toEqual([{ userId: USER, username: 'jonas', display: 'Jonas', kind: 0, nick: '', roleIds: [] }]);
  });
});
