// Pins for the open conversation.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TimelineItem } from '@dilla/client-core';
import { Button, PinsDialog } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { authorName, messageTime, plainBody, type NameBook } from '../shell-model.ts';

export function PinsButton(p: { onOpen(): void }): React.JSX.Element {
  return <Button variant="ghost" size="md" onClick={() => p.onOpen()}>{t('shell.pins.open')}</Button>;
}

export interface PinsPanelProps { channelId: string; open: boolean; title: string; book: NameBook; items: readonly TimelineItem[];
  now: number; onClose(): void; onJump(msgId: string): void; onError(e: unknown): void }

export function PinsPanel(p: PinsPanelProps): React.JSX.Element {
  const client = useCore();
  const pins = useSlice(`pins:${p.channelId}`);
  const pendingFocus = useRef<number | null>(null);
  const callbacks = useRef(p);
  callbacks.current = p;
  useEffect(() => {
    if (!p.open) return;
    client.call({ m: 'loadPins', channelId: p.channelId }).catch(e => callbacks.current.onError(e));
    return () => { client.call({ m: 'closePins', channelId: p.channelId }).catch(e => callbacks.current.onError(e)); };
  }, [client, p.channelId, p.open]);
  useLayoutEffect(() => {
    if (!p.open || pendingFocus.current === null) return;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.d-pins-dialog__item button'))
      .filter(b => b.textContent === t('shell.message.unpin'));
    (buttons[pendingFocus.current] ?? document.querySelector<HTMLButtonElement>('dialog.d-dialog .d-dialog__footer button'))?.focus();
    pendingFocus.current = null;
  }, [p.open, pins]);
  return <PinsDialog open={p.open} title={p.title} closeLabel={t('shell.pins.close')} onClose={() => p.onClose()}
    emptyLabel={t('shell.pins.empty')} items={(pins ?? []).map((pin, i) => ({
      id: pin.msgId, author: authorName({ senderUser: pin.senderUser, senderDevice: null }, p.book.members, p.book.self),
      time: messageTime(pin.ts, p.now), excerpt: plainBody(pin.excerpt, p.book),
      pinnedBy: t('shell.pins.by', { name: authorName({ senderUser: pin.pinnedBy, senderDevice: null }, p.book.members, p.book.self) }),
      jumpLabel: t('shell.pins.jump'), onJump: () => p.onJump(pin.msgId),
      unpinLabel: t('shell.message.unpin'), onUnpin: () => {
        pendingFocus.current = i;
        client.call({ m: 'pin', channelId: p.channelId, msgId: pin.msgId, on: false }).catch(e => p.onError(e));
      },
    }))} />;
}
