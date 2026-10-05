import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { EpochWire } from '../../../packages/media/harness/main';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The test host task 1's global setup starts (public /v1 + /rtc, and the /debug control listener). */
export const DS_URL = 'http://127.0.0.1:8443';
export const CONTROL_URL = 'http://127.0.0.1:8444';

export interface MediaKey {
  groupId: string;
  epoch: string;
  baseKey: string;
  selfLeaf: number;
  roster: Array<{ leaf: number; deviceId: string }>;
}

export interface CallToken {
  callId: string;
  groupId: string;
  livekitUrl: string;
  token: string;
  iceServers: Array<[string[], string, string]>;
  caps: [number, number, number];
}

export interface MediabotReport {
  published: Record<string, string>;
  decrypted: number;
  decrypted_by_kind: Record<string, number>;
  dropped: Record<string, number>;
}

function testkitBinary(): string {
  return process.env.DILLA_TESTKIT ?? resolve(repoRoot, 'target', 'release', 'dilla-testkit');
}

function mediabotBinary(): string {
  return process.env.DILLA_MEDIABOT ?? resolve(repoRoot, 'target', 'dilla-mediabot');
}

/** The codes after `DILLA_TESTKIT_INVITE=` in dilla-testhost's start-up banner. */
export function parseInvite(banner: string): string | null {
  return /DILLA_TESTKIT_INVITE=(\S+)/.exec(banner)?.[1] ?? null;
}

export function testkitEnv(): Record<string, string> {
  const invite = process.env.DILLA_TESTKIT_INVITE;
  if (!invite) throw new Error('DILLA_TESTKIT_INVITE is unset: the media global setup exports it from the test host banner');
  return { DILLA_TESTKIT_INVITE: invite, DILLA_TESTKIT_CONTROL: CONTROL_URL };
}

/** KID = (leaf << 8) | (epoch & 0xff), unpadded lowercase hex: the key of `DillaMediaStats.decrypted`. */
export function kidHex(leaf: number, epoch: string | bigint): string {
  return ((BigInt(leaf) << 8n) | (BigInt(epoch) & 0xffn)).toString(16);
}

export function epochWire(k: MediaKey, minEpoch: string): EpochWire {
  return { groupId: k.groupId, epoch: k.epoch, baseKey: k.baseKey, selfLeaf: k.selfLeaf, minEpoch, roster: k.roster };
}

/** The room a LiveKit token's `video.room` grant names (no signature check: test-side only). */
export function roomOfToken(jwt: string): string {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as { video?: { room?: string } };
  if (!payload.video?.room) throw new Error('the token names no room');
  return payload.video.room;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** `dilla-testkit media-driver`: one native MLS client per actor (MD-12). */
export class MediaDriver {
  private next = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const answer = JSON.parse(line) as { id: number; ok: boolean; error?: string } & Record<string, unknown>;
      const p = this.pending.get(answer.id);
      if (!p) return;
      this.pending.delete(answer.id);
      if (answer.ok) p.resolve(answer);
      else p.reject(new Error(`media-driver: ${answer.error}`));
    });
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`media-driver exited with ${code}`));
      this.pending.clear();
    });
  }

  static async start(dsUrl: string, env: Record<string, string>, seed = Date.now() % 0xff_ffff): Promise<MediaDriver> {
    const bin = testkitBinary();
    if (!existsSync(bin)) {
      throw new Error(`dilla-testkit not found at ${bin}: build it with cargo build -p dilla-testkit --release --locked, or set DILLA_TESTKIT`);
    }
    const child = spawn(bin, ['media-driver', '--ds', dsUrl, '--seed', String(seed)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new MediaDriver(child);
  }

  request<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        done();
      }, 5_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

/** Runs dilla-mediabot to completion and parses its one-line report. */
export function runMediabot(args: string[], timeoutMs: number, stdin?: string): Promise<MediabotReport> {
  const bin = mediabotBinary();
  if (!existsSync(bin)) {
    return Promise.reject(new Error(`dilla-mediabot not found at ${bin}: go build -o target/dilla-mediabot ./cmd/dilla-mediabot, or set DILLA_MEDIABOT`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(stdin === undefined ? undefined : `${stdin}\n`);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`dilla-mediabot exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim()) as MediabotReport);
    });
  });
}
