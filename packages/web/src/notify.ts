// The page's desktop notifications (Q30, L-TS-25). The worker only appends what may notify to the `notices` slice;
// the page decides, by the person's permission and settings, and builds the Notification itself. Badges are the
// in-app signal and never depend on any of this.
//
// Attacker statement (lesson e): the notifier refuses nothing. What it shows is the body of a message the core
// already decrypted and the timeline would render, on this device only, and only with the person's own permission.
import { effectiveNotifyMode, isMuted } from '@dilla/client-core';
import type { CoreClient, Notice } from '@dilla/client-core';
import type { PermissionState } from './notify-permission.ts';
import { t } from './strings/index.ts';

export interface NotificationHandle { onclick: ((ev: Event) => unknown) | null; close(): void; }
export interface NotificationCtor { readonly permission: NotificationPermission; new (title: string, options: NotificationOptions): NotificationHandle; }
export interface NotifyContext { permission: PermissionState; settings: Readonly<Record<string, string>>; visible: boolean; onScreen: string | null; }

/** L-TS-25's decision for one notice; kind is the channel's for the mode: 0 a community channel, 3 | 4 a DM. */
export function shouldNotify(notice: Notice, kind: 0 | 3 | 4, ctx: NotifyContext): boolean {
  if (ctx.permission !== 'granted') return false;
  if (isMuted(ctx.settings, notice.channelId)) return false;
  // The person is looking at it: the timeline shows it, so nothing pops up over it.
  if (ctx.visible && ctx.onScreen === notice.channelId) return false;
  const mode = effectiveNotifyMode(ctx.settings, notice.channelId, kind);
  if (mode === 'all') return true;
  return mode === 'mentions' && (notice.kind === 'mention' || notice.kind === 'dm');
}

/** notify.title.dm for a DM notice, else notify.title.channel; an unknown name reads as the first 8 hex of its id. */
export function noticeTitle(notice: Notice, names: { channel: string | null; server: string | null }): string {
  if (notice.communityId === null) {
    return t('notify.title.dm', { sender: notice.senderName !== '' ? notice.senderName : (notice.senderUser ?? notice.channelId).slice(0, 8) });
  }
  return t('notify.title.channel', {
    channel: names.channel ?? notice.channelId.slice(0, 8),
    server: names.server ?? notice.communityId.slice(0, 8),
  });
}

/** globalThis.Notification, or undefined where the browser has none. */
export function notificationCtor(): NotificationCtor | undefined {
  const n = (globalThis as { Notification?: unknown }).Notification;
  return typeof n === 'function' ? n as NotificationCtor : undefined;
}

export interface NotifierDeps {
  client: Pick<CoreClient, 'get' | 'subscribe'>;
  Notification: NotificationCtor | undefined;
  visible(): boolean;
  onScreen(): string | null;
  focus(): void;
  open(notice: Notice): void;
}

/** Follows the notices slice and shows what L-TS-25 allows; returns the unsubscribe. */
export function startNotifier(deps: NotifierDeps): () => void {
  const { client } = deps;
  // The first value seen only sets the mark: what the worker held before this page started is never replayed.
  let handledFrom: number | null = null;
  let stopped = false;

  const show = (item: Notice) => {
    const Ctor = deps.Notification;
    const kind: 0 | 3 | 4 = item.communityId === null
      ? client.get('dms')?.find(d => d.id === item.channelId)?.kind ?? 3
      : 0;
    const ctx: NotifyContext = {
      permission: Ctor?.permission ?? 'unsupported',
      settings: client.get('settings') ?? {},
      visible: deps.visible(),
      onScreen: deps.onScreen(),
    };
    if (Ctor === undefined || !shouldNotify(item, kind, ctx)) return;
    const communityId = item.communityId;
    const title = noticeTitle(item, {
      channel: communityId === null ? null : client.get(`channels:${communityId}`)?.find(c => c.id === item.channelId)?.name ?? null,
      server: communityId === null ? null : client.get('communities')?.find(c => c.id === communityId)?.name ?? null,
    });
    try {
      // No icon: the CSP keeps img-src 'self' (Global Constraints).
      const note = new Ctor(title, { body: item.body, tag: `dilla:${item.channelId}`, silent: false });
      note.onclick = () => {
        deps.focus();
        deps.open(item);
        note.close();
      };
    } catch {
      // A browser that refuses to build one here (a page context without notifications) skips the item.
    }
  };

  const run = () => {
    if (stopped) return;
    const notices = client.get('notices');
    if (notices === undefined) return;
    if (handledFrom === null) {
      handledFrom = notices.nextId;
      return;
    }
    const from = handledFrom;
    handledFrom = notices.nextId;
    for (const item of notices.items) if (item.id >= from) show(item);
  };

  const unsubscribe = client.subscribe('notices', run);
  run();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
