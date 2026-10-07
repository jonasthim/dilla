// Page-side attachment cards, downloads, lightbox and upload tray.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BROWSER_ATTACHMENT_CAP, safeName, type AttachmentSummary, type CoreClient, type TimelineItem, type TrayItem } from '@dilla/client-core';
import { AttachmentCard, AttachmentTray, Lightbox } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { t } from '../../strings/index.ts';
import { formatSize } from '../shell-model.ts';
import type { ConversationAction } from './Conversation.tsx';
import { useBlobUrl } from './useBlobUrl.tsx';

export const REVOKE_SAVED_AFTER_MS = 10_000;
export interface Opened { blob: Blob; name: string; mime: string }

export function isOpened(v: unknown): v is Opened {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.blob instanceof Blob && typeof o.name === 'string' && typeof o.mime === 'string';
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_SAVED_AFTER_MS);
}

export async function attachFiles(client: Pick<CoreClient, 'call'>, channelId: string, files: readonly File[], dispatch: (a: ConversationAction) => void): Promise<void> {
  if (files.length === 0) return;
  try {
    await client.call({ m: 'attachFiles', channelId, files });
    dispatch({ type: 'trayError', text: null });
  } catch (err) {
    const code = errorOf(err).code;
    const text = code === 'E_ATTACHMENT_TOO_LARGE'
      ? t('shell.tray.tooLarge', { name: safeName(files.find(f => f.size > BROWSER_ATTACHMENT_CAP)?.name ?? files[0]?.name ?? '', t('shell.attachment.unnamed')) })
      : code === 'E_ATTACHMENT_COUNT' ? t('shell.tray.tooMany') : t('shell.banner.commandError', { code });
    dispatch({ type: 'trayError', text });
  }
}

function Card(p: { channelId: string; seq: string | null; summary: AttachmentSummary; tabbable: boolean;
  onOpenImage(index: number, opener: HTMLElement): void; onError(e: unknown): void }) {
  const client = useCore();
  const { summary: a } = p;
  const [thumb, setThumb] = useState<Blob | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [code, setCode] = useState('');
  const requested = useRef(new Set<string>());
  const mounted = useRef(false);
  const activeThumb = useRef<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const thumbUrl = useBlobUrl(thumb);
  useEffect(() => {
    if (a.kind !== 'image' || !a.thumb || a.tooLarge || p.seq === null) return;
    const key = `${p.seq}:${a.index}`;
    mounted.current = true;
    activeThumb.current = key;
    if (requested.current.has(key)) return () => { mounted.current = false; };
    requested.current.add(key);
    client.call({ m: 'openAttachment', channelId: p.channelId, seq: p.seq, index: a.index, thumb: true })
      .then(v => { if (mounted.current && activeThumb.current === key && isOpened(v)) setThumb(v.blob); })
      .catch(() => undefined);
    return () => { mounted.current = false; };
  }, [client, p.channelId, p.seq, a.index, a.kind, a.thumb, a.tooLarge]);
  const save = async () => {
    if (p.seq === null || a.tooLarge) return;
    setState('loading');
    try {
      const result = await client.call({ m: 'openAttachment', channelId: p.channelId, seq: p.seq, index: a.index, thumb: false });
      if (!isOpened(result)) throw new Error('E_BLOB_OPEN');
      saveBlob(result.blob, result.name || t('shell.attachment.unnamed'));
      setState('idle');
    } catch (e) {
      setCode(errorOf(e).code);
      setState('failed');
    }
  };
  const name = safeName(a.name, t('shell.attachment.unnamed'));
  return <div ref={el => { buttonRef.current = el?.querySelector('button') ?? null; }}>
    <AttachmentCard kind={a.kind} name={name} size={formatSize(a.size)} thumbUrl={thumbUrl} w={a.w} h={a.h}
      openLabel={t('shell.attachment.open', { name })} saveLabel={t('shell.attachment.save', { name })}
      {...(a.kind === 'image' && p.seq !== null && !a.tooLarge ? { onOpen: () => { if (buttonRef.current) p.onOpenImage(a.index, buttonRef.current); } } : {})}
      {...(p.seq !== null && !a.tooLarge ? { onSave: () => { void save(); } } : {})}
      state={a.tooLarge ? 'too-large' : state}
      stateText={a.tooLarge ? t('shell.attachment.tooLarge') : state === 'loading' ? t('shell.attachment.opening') : state === 'failed' ? t('shell.attachment.failed', { code }) : undefined}
      tabbable={p.tabbable} />
  </div>;
}

export function AttachmentList(p: { channelId: string; item: TimelineItem; tabbable: boolean;
  onOpenImage(index: number, opener: HTMLElement): void; onError(e: unknown): void }): React.JSX.Element | null {
  if (p.item.attachments.length === 0) return null;
  return <div className="dw-attachments">{p.item.attachments.map(a =>
    <Card key={a.index} channelId={p.channelId} seq={p.item.seq} summary={a} tabbable={p.tabbable}
      onOpenImage={(index, opener) => p.onOpenImage(index, opener)} onError={e => p.onError(e)} />)}</div>;
}

export interface LightboxState { seq: string; images: readonly AttachmentSummary[]; index: number; opener: HTMLElement | null }
export function AttachmentLightbox(p: { channelId: string; state: LightboxState; onIndex(index: number): void; onClose(): void;
  onError(e: unknown): void }): React.JSX.Element {
  const client = useCore();
  const [blob, setBlob] = useState<Blob | null>(null);
  const request = useRef(0);
  const callbacks = useRef(p);
  callbacks.current = p;
  const item = p.state.images[p.state.index];
  const url = useBlobUrl(blob);
  useEffect(() => {
    const id = ++request.current;
    setBlob(null);
    client.call({ m: 'openAttachment', channelId: p.channelId, seq: p.state.seq, index: item.index, thumb: false })
      .then(v => { if (id === request.current && isOpened(v)) setBlob(v.blob); })
      .catch(e => { if (id === request.current) { callbacks.current.onError(e); callbacks.current.onClose(); } });
    return () => { if (request.current === id) request.current = id + 1; };
  }, [client, p.channelId, p.state.seq, item.index]);
  const name = safeName(item.name, t('shell.attachment.unnamed'));
  return <Lightbox open label={t('shell.lightbox.label', { name, size: formatSize(item.size) })} src={url} alt={name}
    closeLabel={t('shell.lightbox.close')} onClose={() => p.onClose()} saveLabel={t('shell.lightbox.save')}
    onSave={() => { if (blob) saveBlob(blob, name); }}
    previous={p.state.index > 0 ? { label: t('shell.lightbox.previous'), onPrevious: () => p.onIndex(p.state.index - 1) } : undefined}
    next={p.state.index + 1 < p.state.images.length ? { label: t('shell.lightbox.next'), onNext: () => p.onIndex(p.state.index + 1) } : undefined} />;
}

export function TrayList(p: { channelId: string; items: readonly TrayItem[]; onError(e: unknown): void }): React.JSX.Element | null {
  const client = useCore();
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const buttons = document.querySelectorAll<HTMLButtonElement>('.d-attachment-tray__remove');
    (buttons[pendingFocus.current] ?? document.querySelector<HTMLTextAreaElement>('.d-composer textarea'))?.focus();
    pendingFocus.current = null;
  }, [p.items]);
  if (p.items.length === 0) return null;
  return <AttachmentTray label={t('shell.tray.label')} items={p.items.map((a, i) => ({
    id: a.id, name: a.name, size: formatSize(a.size),
    phase: a.phase === 'failed' ? t('shell.tray.failed', { code: a.reason }) : t(`shell.tray.${a.phase}`),
    failed: a.phase === 'failed', step: a.phase,
    ...(a.phase === 'failed' ? { hint: t('shell.tray.failedHint') } : {}),
    removeLabel: t('shell.tray.remove', { name: a.name }),
    onRemove: () => { pendingFocus.current = i; client.call({ m: 'discardAttachment', channelId: p.channelId, trayId: a.id }).catch(e => p.onError(e)); },
  }))} />;
}
