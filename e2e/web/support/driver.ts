import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { REPO_ROOT } from './host.ts';

export function parseInvite(banner: string): string | null { return /DILLA_TESTKIT_INVITE=(\S+)/.exec(banner)?.[1] ?? null; }
export function testkitEnv(): Record<string, string> {
  const invite = process.env.DILLA_TESTKIT_INVITE;
  if (!invite) throw new Error('DILLA_TESTKIT_INVITE is unset: the web globalSetup exports it from the test host banner');
  return { DILLA_TESTKIT_INVITE: invite, DILLA_TESTKIT_CONTROL: process.env.DILLA_TESTKIT_CONTROL ?? '' };
}
export function instanceInvite(): string { return testkitEnv().DILLA_TESTKIT_INVITE.split(',')[0]; }
export function testHostUrl(): string {
  const url = process.env.DILLA_TEST_HOST;
  if (!url) throw new Error('DILLA_TEST_HOST is unset: the web globalSetup exports it');
  return url;
}
export function testkitBinary(): string { return process.env.DILLA_TESTKIT ?? join(REPO_ROOT, 'target', 'release', 'dilla-testkit'); }

export interface PeerSetup { username: string; display: string; user_id: string; device_id: string; community_id: string; channel_id: string; channel_ids: string[]; invite_code: string }
export interface PeerReceived { seq: number; body: string; sender_user: string; sender_device: string; tier: number }
export interface PeerSync { epoch: number; members: number; received: PeerReceived[] }
export interface PeerDm { channel_id: string; group_id: string; epoch: number; }
export interface PeerOpenedDm { channel_id: string; group_id: string; epoch: number; created: boolean; }
export interface PeerEnrolled { device_id: string; version: number; epoch: number; scopes: number[] }
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class WebDriver {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private constructor(private readonly child: ChildProcessWithoutNullStreams, readonly seed: number) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const answer = JSON.parse(line) as { id: number; ok: boolean; error?: string } & Record<string, unknown>;
      const p = this.pending.get(answer.id);
      if (!p) return;
      this.pending.delete(answer.id);
      if (answer.ok) p.resolve(answer);
      else p.reject(new Error(`web-driver: ${answer.error}`));
    });
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`web-driver exited with ${code}`));
      this.pending.clear();
    });
  }
  static async start(dsUrl: string, env: Record<string, string>, seed = Date.now() % 0xff_ffff): Promise<WebDriver> {
    const bin = testkitBinary();
    if (!existsSync(bin)) throw new Error(`dilla-testkit not found at ${bin}: build it with cargo build -p dilla-testkit --release --locked, or set DILLA_TESTKIT`);
    const child = spawn(bin, ['web-driver', '--ds', dsUrl, '--seed', String(seed)], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    return new WebDriver(child, seed);
  }
  request<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }
  private strip<T>(answer: T & { id: number; ok: boolean }): T {
    const { id: _id, ok: _ok, ...fields } = answer;
    return fields as T;
  }
  async setup(a: { community: string; channel: string; password?: string; channels?: number }): Promise<PeerSetup> { return this.strip(await this.request<PeerSetup & { id: number; ok: boolean }>('setup', a)); }
  async register(): Promise<{ group_id: string; epoch: number }> { return this.strip(await this.request<{ group_id: string; epoch: number; id: number; ok: boolean }>('register', {})); }
  async join(a: { community_id: string; channel_id: string; group_id: string; invite_code: string }): Promise<{ group_id: string; epoch: number }> { return this.strip(await this.request<{ group_id: string; epoch: number; id: number; ok: boolean }>('join', a)); }
  async send(body: string, channelId?: string): Promise<{ seq: number }> { return this.strip(await this.request<{ seq: number; id: number; ok: boolean }>('send', channelId === undefined ? { body } : { body, channel_id: channelId })); }
  async sync(channelId?: string): Promise<PeerSync> { return this.strip(await this.request<PeerSync & { id: number; ok: boolean }>('sync', channelId === undefined ? {} : { channel_id: channelId })); }
  async members(channelId?: string): Promise<{ devices: string[] }> { return this.strip(await this.request<{ devices: string[]; id: number; ok: boolean }>('members', channelId === undefined ? {} : { channel_id: channelId })); }
  async update(): Promise<{ epoch: number }> { return this.strip(await this.request<{ epoch: number; id: number; ok: boolean }>('update', {})); }
  /** L-E2E-10 `enrol`: a second Browser-tier device of the peer's account, by host login, pending then listed. */
  async enrol(): Promise<PeerEnrolled> { return this.strip(await this.request<PeerEnrolled & { id: number; ok: boolean }>('enrol', {})); }
  /** L-E2E-10 `revoke`: list v+1 with that device revoked, signed and published by the peer's first device. */
  async revoke(deviceId: string): Promise<{ version: number }> { return this.strip(await this.request<{ version: number; id: number; ok: boolean }>('revoke', { device_id: deviceId })); }
  async openDm(userId: string): Promise<PeerOpenedDm> { return this.strip(await this.request<PeerOpenedDm & { id: number; ok: boolean }>('open_dm', { user_id: userId })); }
  async dms(): Promise<{ dms: PeerDm[] }> { return this.strip(await this.request<{ dms: PeerDm[]; id: number; ok: boolean }>('dms', {})); }
  async sendDm(channelId: string, body: string): Promise<{ seq: number }> { return this.strip(await this.request<{ seq: number; id: number; ok: boolean }>('send_dm', { channel_id: channelId, body })); }
  async syncDm(channelId: string): Promise<PeerSync> { return this.strip(await this.request<PeerSync & { id: number; ok: boolean }>('sync_dm', { channel_id: channelId })); }
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); done(); }, 5_000);
      this.child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
}
