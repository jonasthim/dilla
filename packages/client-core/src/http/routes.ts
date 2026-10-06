// One typed function per web-1 route. Core-built bodies pass through unchanged; raw answers return unchanged.
import { CborError, arr, bin, decode, encode, opt, str, u53, u64, type CborValue } from '../cbor';
import { toHex } from '../hex';
import { HttpClient, type Bucket, type HttpRequest } from './client';

export const MEMBERS_PAGE = 200;
export const HANDSHAKES_MAX = 512;
export const MESSAGES_MAX = 256;
export const WELCOMES_PAGE = 64;

export interface Instance { instanceId: Uint8Array; generation: bigint; name: string; registrationMode: 0 | 1 | 2;
  authMethods: number[]; policyVersion: bigint; externalSenderPub: Uint8Array; }
export interface InviteInfo { communityId: Uint8Array | null; communityName: string | null; expires: bigint; }
export interface AccountCreated { userId: Uint8Array; deviceId: Uint8Array; token: string; expires: bigint; }
export interface Challenge { nonce: Uint8Array; expires: bigint; }
export interface EstablishedSession { token: string; scope: 0 | 1 | 2; userId: Uint8Array; deviceId: Uint8Array;
  expires: bigint; idleExpires: bigint; generation: bigint; }
export interface DeviceListRecord { version: bigint; blob: Uint8Array; }
export interface Ticket { ticket: string; expires: bigint; }
export interface CommunityRow { id: Uint8Array; name: string; owner: Uint8Array; policyVersion: bigint; }
export interface ChannelRow { id: Uint8Array; kind: number; mode: number; visibility: number; parentId: Uint8Array | null;
  name: string; topic: string; position: number; seq: bigint; textGroupId: Uint8Array | null; }
export interface MemberRow { userId: Uint8Array; username: string; display: string; kind: 0 | 1; nick: string; }
export interface SeqEpoch { seq: bigint; epoch: bigint; }
export interface RowsPage { raw: Uint8Array; count: number; lastSeq: bigint | null; }
export interface WelcomesPage { raw: Uint8Array; count: number; lastId: bigint | null; }
export interface MessageUploaded { raw: Uint8Array; seq: bigint; }
export interface AccountMe { userId: Uint8Array; username: string; display: string; kind: number; flags: bigint; }
export interface Limits { maxCiphertextBytes: number; keypackagesPerDevice: number; keypackageRefillThreshold: number;
  heartbeatMs: number; maxFrameBytes: number; }

function id(name: string, v: Uint8Array): string {
  if (v.length !== 16) throw new RangeError('E_ROUTE_INPUT: ' + name + ' must be 16 bytes');
  return toHex(v);
}
function count(name: string, v: bigint): string {
  if (v < 0n) throw new RangeError('E_ROUTE_INPUT: ' + name + ' must not be negative');
  return String(v);
}
function limit(name: string, v: number, max: number): number {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError('E_ROUTE_INPUT: ' + name + ' must be 1..' + max);
  return v;
}
function atLeast(v: CborValue, n: number): CborValue[] {
  const items = arr(v);
  if (items.length < n) throw new CborError('E_CBOR_SHAPE', 'expected at least ' + n + ' elements, got ' + items.length);
  return items;
}
function oneOf<T extends number>(v: CborValue, allowed: readonly T[]): T {
  const n = u53(v);
  if (!allowed.includes(n as T)) throw new CborError('E_CBOR_RANGE', 'expected one of ' + allowed.join(',') + ', got ' + n);
  return n as T;
}
function page(raw: Uint8Array): { raw: Uint8Array; count: number; last: bigint | null } {
  const rows = arr(decode(raw));
  const last = rows.length ? u64(atLeast(rows[rows.length - 1], 1)[0]) : null;
  return { raw, count: rows.length, last };
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function memberRow(value: CborValue): MemberRow {
  const row = atLeast(value, 7);
  return { userId: bin(row[0], 16), nick: str(row[2]), username: str(row[4]), display: str(row[5]), kind: oneOf(row[6], [0, 1]) };
}

export class Routes {
  constructor(private readonly http: HttpClient) {}

  private async body(method: HttpRequest['method'], path: string, bucket: Bucket, idempotent: boolean,
    options: Pick<HttpRequest, 'body' | 'auth' | 'accept' | 'ok'> = {}): Promise<Uint8Array> {
    return (await this.http.request({ method, path, bucket, idempotent, ...options })).body;
  }

  async getInstance(): Promise<Instance> {
    const a = atLeast(decode(await this.body('GET', '/v1/instance', 'read', true, { auth: false })), 11);
    return { instanceId: bin(a[3], 16), generation: u64(a[4]), name: str(a[5]), registrationMode: oneOf(a[6], [0, 1, 2]),
      authMethods: arr(a[7]).map(u53), policyVersion: u64(a[8]), externalSenderPub: bin(a[10], 32) };
  }
  async getInvite(code: string): Promise<InviteInfo> {
    const a = atLeast(decode(await this.body('GET', '/i/' + encodeURIComponent(code), 'none', true,
      { auth: false, accept: 'application/cbor' })), 4);
    return { communityId: opt(a[1], (v) => bin(v, 16)), expires: u64(a[2]), communityName: opt(a[3], str) };
  }
  async postAccount(body: Uint8Array): Promise<AccountCreated> {
    const a = atLeast(decode(await this.body('POST', '/v1/accounts', 'none', false, { body, auth: false })), 4);
    return { userId: bin(a[0], 16), deviceId: bin(a[1], 16), token: str(a[2]), expires: u64(a[3]) };
  }
  async postChallenge(deviceId: Uint8Array): Promise<Challenge> {
    const path = `/v1/devices/${id('deviceId', deviceId)}/sessions/challenge`;
    const a = atLeast(decode(await this.body('POST', path, 'none', true, { body: encode([]), auth: false })), 2);
    return { nonce: bin(a[0], 32), expires: u64(a[1]) };
  }
  async postSession(deviceId: Uint8Array, body: Uint8Array): Promise<EstablishedSession> {
    const path = `/v1/devices/${id('deviceId', deviceId)}/sessions`;
    const a = atLeast(decode(await this.body('POST', path, 'none', false, { body, auth: false })), 7);
    return { token: str(a[0]), scope: oneOf(a[1], [0, 1, 2]), userId: bin(a[2], 16), deviceId: bin(a[3], 16),
      expires: u64(a[4]), idleExpires: u64(a[5]), generation: u64(a[6]) };
  }
  async putDeviceList(userId: Uint8Array, body: Uint8Array): Promise<void> {
    await this.body('PUT', `/v1/users/${id('userId', userId)}/device-list`, 'write', true, { body });
  }
  async getDeviceList(userId: Uint8Array): Promise<DeviceListRecord | null> {
    const response = await this.http.request({ method: 'GET', path: `/v1/users/${id('userId', userId)}/device-list`,
      bucket: 'read', idempotent: true, ok: [200, 404] });
    if (response.status === 404) return null;
    const a = atLeast(decode(response.body), 2);
    return { version: u64(a[0]), blob: bin(a[1]) };
  }
  async postKeyPackages(body: Uint8Array): Promise<number> {
    return u53(atLeast(decode(await this.body('POST', '/v1/keypackages', 'write', false, { body })), 1)[0]);
  }
  async postTicket(): Promise<Ticket> {
    const a = atLeast(decode(await this.body('POST', '/v1/gateway/ticket', 'write', false, { body: encode([]) })), 2);
    return { ticket: str(a[0]), expires: u64(a[1]) };
  }
  async listCommunities(): Promise<CommunityRow[]> {
    return arr(decode(await this.body('GET', '/v1/communities', 'read', true))).map((value) => {
      const a = atLeast(value, 4);
      return { id: bin(a[0], 16), name: str(a[1]), owner: bin(a[2], 16), policyVersion: u64(a[3]) };
    });
  }
  async joinCommunity(communityId: Uint8Array, invite: string | null): Promise<void> {
    await this.body('POST', `/v1/communities/${id('communityId', communityId)}/join`, 'none', true, { body: encode([invite]) });
  }
  async listChannels(communityId: Uint8Array): Promise<ChannelRow[]> {
    const raw = await this.body('GET', `/v1/communities/${id('communityId', communityId)}/channels`, 'read', true);
    return arr(decode(raw)).map((value) => {
      const a = atLeast(value, 11);
      return { id: bin(a[0], 16), kind: u53(a[1]), mode: u53(a[2]), visibility: u53(a[3]),
        parentId: opt(a[4], (v) => bin(v, 16)), name: str(a[5]), topic: str(a[6]), position: u53(a[7]),
        seq: u64(a[9]), textGroupId: opt(a[10], (v) => bin(v, 16)) };
    });
  }
  async listMembers(communityId: Uint8Array): Promise<MemberRow[]> {
    const path = `/v1/communities/${id('communityId', communityId)}/members`;
    const result: MemberRow[] = [];
    let after: Uint8Array | null = null;
    for (;;) {
      const raw = await this.body('GET', path + (after ? '?after=' + toHex(after) : ''), 'read', true);
      const rows = arr(decode(raw));
      const parsed = rows.map(memberRow);
      result.push(...parsed);
      if (rows.length < MEMBERS_PAGE) return result;
      const last = parsed[parsed.length - 1].userId;
      if (after && compareBytes(last, after) <= 0) throw new CborError('E_CBOR_SHAPE', 'members page did not advance');
      after = last;
    }
  }
  async postGroup(body: Uint8Array): Promise<{ nextSeq: bigint }> {
    const a = atLeast(decode(await this.body('POST', '/v1/groups', 'write', false, { body })), 2);
    return { nextSeq: u64(a[1]) };
  }
  async getGroupInfo(groupId: Uint8Array): Promise<Uint8Array> {
    return this.body('GET', `/v1/groups/${id('groupId', groupId)}/info`, 'read', true);
  }
  async getGroupTree(groupId: Uint8Array): Promise<Uint8Array> {
    return this.body('GET', `/v1/groups/${id('groupId', groupId)}/tree`, 'read', true);
  }
  async getHandshakes(groupId: Uint8Array, from: bigint, limitValue: number): Promise<RowsPage> {
    const path = `/v1/groups/${id('groupId', groupId)}/handshakes?from=${count('from', from)}&limit=${limit('limit', limitValue, HANDSHAKES_MAX)}`;
    const p = page(await this.body('GET', path, 'read', true));
    return { raw: p.raw, count: p.count, lastSeq: p.last };
  }
  async getMessages(groupId: Uint8Array, from: bigint, limitValue: number): Promise<RowsPage> {
    const path = `/v1/groups/${id('groupId', groupId)}/messages?from=${count('from', from)}&limit=${limit('limit', limitValue, MESSAGES_MAX)}`;
    const p = page(await this.body('GET', path, 'read', true));
    return { raw: p.raw, count: p.count, lastSeq: p.last };
  }
  async getProposals(groupId: Uint8Array): Promise<Uint8Array> {
    return this.body('GET', `/v1/groups/${id('groupId', groupId)}/proposals`, 'read', true);
  }
  async postCommit(groupId: Uint8Array, body: Uint8Array): Promise<SeqEpoch> {
    const a = atLeast(decode(await this.body('POST', `/v1/groups/${id('groupId', groupId)}/commit`, 'commit', false, { body })), 2);
    return { seq: u64(a[0]), epoch: u64(a[1]) };
  }
  async postMessage(groupId: Uint8Array, body: Uint8Array): Promise<MessageUploaded> {
    const raw = await this.body('POST', `/v1/groups/${id('groupId', groupId)}/message`, 'message', false, { body });
    return { raw, seq: u64(atLeast(decode(raw), 1)[0]) };
  }
  async postCursor(groupId: Uint8Array, body: Uint8Array): Promise<void> {
    await this.body('POST', `/v1/groups/${id('groupId', groupId)}/cursor`, 'write', true, { body });
  }
  async postResync(groupId: Uint8Array, body: Uint8Array): Promise<SeqEpoch> {
    const a = atLeast(decode(await this.body('POST', `/v1/groups/${id('groupId', groupId)}/resync`, 'commit', false, { body })), 2);
    return { seq: u64(a[0]), epoch: u64(a[1]) };
  }
  async getWelcomes(after: bigint): Promise<WelcomesPage> {
    const p = page(await this.body('GET', `/v1/welcomes?after=${count('after', after)}&limit=${WELCOMES_PAGE}`, 'read', true));
    return { raw: p.raw, count: p.count, lastId: p.last };
  }
  async deleteWelcome(welcomeId: bigint): Promise<void> {
    await this.body('DELETE', `/v1/welcomes/${count('welcomeId', welcomeId)}`, 'write', true, { ok: [204, 404] });
  }
  async getAccountMe(): Promise<AccountMe> {
    const a = atLeast(decode(await this.body('GET', '/v1/accounts/me', 'read', true)), 5);
    return { userId: bin(a[0], 16), username: str(a[1]), display: str(a[2]), kind: u53(a[3]), flags: u64(a[4]) };
  }
  async getLimits(): Promise<Limits> {
    const a = atLeast(decode(await this.body('GET', '/v1/instance/limits', 'read', true, { auth: false })), 9);
    return { maxCiphertextBytes: u53(a[0]), keypackagesPerDevice: u53(a[4]), keypackageRefillThreshold: u53(a[5]),
      heartbeatMs: u53(a[7]), maxFrameBytes: u53(a[8]) };
  }
}
