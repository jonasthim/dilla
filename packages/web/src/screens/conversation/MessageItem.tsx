// One folded timeline item, with its controls and focus hand-off.
import { useLayoutEffect, useRef, type PointerEvent } from 'react';
import type { TimelineItem, TimelineItemState } from '@dilla/client-core';
import { MessageEditor, MessageRow, MessageToolbar, ReactionBar } from '@dilla/ui';
import { reactionName } from '../../emoji.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { authorName, bodyParts, messageTime, plainBody, type NameBook } from '../shell-model.ts';
import { AttachmentList } from './Attachments.tsx';
import { focusLog } from './Conversation.tsx';

const STATE_LABEL: Record<TimelineItemState, StringKey | null> = {
  ok: null, pending: 'shell.message.pending', failed: 'shell.message.failed',
  'cannot-read': 'shell.message.cannotRead', deleted: 'shell.message.deleted',
};

export function handOnFromRow(action: number): void {
  const row = document.activeElement?.closest('.d-message-row') ?? null;
  if (row === null) return;
  const rows = Array.from(document.querySelectorAll('[role="log"] .d-message-row[data-state="failed"]'));
  const next = rows.slice(rows.indexOf(row) + 1).find(r => r.querySelector('.d-message-row__actions') !== null);
  const target = next?.querySelectorAll<HTMLElement>('.d-message-row__actions button')[action];
  if (target !== undefined) target.focus();
  else focusLog();
}

export type RowEvent =
  | { kind: 'react'; anchor: HTMLElement } | { kind: 'reply' } | { kind: 'edit' } | { kind: 'pin'; on: boolean } | { kind: 'delete' }
  | { kind: 'toggle'; emoji: string; on: boolean } | { kind: 'jump'; msgId: string }
  | { kind: 'retry'; msgId: string } | { kind: 'discard'; msgId: string };

export interface MessageItemProps { item: TimelineItem; channelId: string; book: NameBook; now: number; active: boolean; flash: boolean;
  editing: string | null; editMeasure(v: string): number; rowRef(el: HTMLElement | null): void;
  onJumpPointerDown(e: PointerEvent<HTMLButtonElement>): void;
  onEvent(item: TimelineItem, ev: RowEvent): void; onEditChange(v: string): void; onEditSave(v: string): void; onEditCancel(): void;
  onOpenImage(index: number, opener: HTMLElement): void; onError(e: unknown): void }

export function MessageItem(p: MessageItemProps): React.JSX.Element {
  const { item } = p;
  const rowEl = useRef<HTMLElement | null>(null);
  const priorReactions = useRef(item.reactions.length);
  useLayoutEffect(() => {
    if (priorReactions.current > 0 && item.reactions.length === 0 && document.activeElement === document.body) rowEl.current?.focus();
    priorReactions.current = item.reactions.length;
  }, [item.reactions.length]);
  const emit = (event: RowEvent) => p.onEvent(item, event);
  const ownAuthor = item.senderUser !== null && item.senderUser === p.book.self?.id;
  const author = authorName(item, p.book.members, p.book.self);
  const label = STATE_LABEL[item.state];
  const shown = item.state === 'ok' || item.state === 'pending' || item.state === 'failed';
  const gone = item.state === 'failed' && item.reason === 'E_ATTACHMENT_MISSING' && item.msgId !== null;
  const action = item.actions.find(a => a.state === 'failed') ?? item.actions.find(a => a.state === 'pending');
  const pendingAction = gone ? {
    label: t('shell.message.attachmentGone'), tone: 'failed' as const,
    actions: [{ label: t('shell.message.discard'), onAction: () => { handOnFromRow(1); emit({ kind: 'discard', msgId: item.msgId! }); } }],
  } : action ? action.state === 'pending' ? { label: t('shell.message.saving'), tone: 'pending' as const } : {
    label: t('shell.message.notSaved'), tone: 'failed' as const,
    actions: [
      { label: t('shell.message.retry'), onAction: () => { emit({ kind: 'retry', msgId: action.msgId }); document.querySelector<HTMLElement>(`[data-msg-id="${item.msgId}"]`)?.focus(); } },
      { label: t('shell.message.discard'), onAction: () => { emit({ kind: 'discard', msgId: action.msgId }); document.querySelector<HTMLElement>(`[data-msg-id="${item.msgId}"]`)?.focus(); } },
    ],
  } : undefined;
  const toolbar = item.state === 'ok' && item.msgId !== null && item.seq !== null ? <MessageToolbar
    label={t('shell.message.toolbar')} tabbable={p.active} items={[
      { id: 'react', label: t('shell.message.react'), onAction: e => emit({ kind: 'react', anchor: e.currentTarget as HTMLElement }) },
      { id: 'reply', label: t('shell.message.reply'), onAction: () => emit({ kind: 'reply' }) },
      ...(ownAuthor ? [{ id: 'edit' as const, label: t('shell.message.edit'), onAction: () => emit({ kind: 'edit' as const }) }] : []),
      { id: 'pin', label: t(item.pinned ? 'shell.message.unpin' : 'shell.message.pin'), onAction: () => emit({ kind: 'pin', on: !item.pinned }) },
      ...(ownAuthor ? [{ id: 'delete' as const, label: t('shell.message.delete'), danger: true, onAction: () => emit({ kind: 'delete' as const }) }] : []),
    ]} /> : undefined;
  const reply = item.reply;
  const replyProps = reply === null ? undefined : {
    author: reply.senderUser === null ? '' : authorName({ senderUser: reply.senderUser, senderDevice: null }, p.book.members, p.book.self),
    excerpt: plainBody(reply.excerpt, p.book), state: reply.state,
    label: reply.state === 'ok' ? t('shell.message.replyLabel', { name: reply.senderUser === null ? '' : authorName({ senderUser: reply.senderUser, senderDevice: null }, p.book.members, p.book.self) })
      : t(reply.state === 'missing' ? 'shell.message.replyMissing' : 'shell.message.replyDeleted'),
    stateText: reply.state === 'ok' ? undefined : t(reply.state === 'missing' ? 'shell.message.replyMissing' : 'shell.message.replyDeleted'),
    jumpLabel: t('shell.message.replyJump'),
    onJump: reply.state === 'missing' ? undefined : () => emit({ kind: 'jump', msgId: reply.msgId }),
    onJumpPointerDown: (e: PointerEvent<HTMLButtonElement>) => p.onJumpPointerDown(e),
  };
  return <MessageRow rowRef={el => { rowEl.current = el; p.rowRef(el); }} author={author} time={messageTime(item.ts, p.now)} body={shown ? bodyParts(item.body, p.book) : ''}
    own={item.own} tag={item.bot ? 'bot' : item.web ? 'web' : undefined} state={item.state}
    stateLabel={label === null ? undefined : t(label)} detail={gone ? undefined : item.state === 'failed' || item.state === 'cannot-read' ? item.reason : undefined}
    actions={!gone && item.state === 'failed' && item.msgId !== null ? [
      { label: t('shell.message.retry'), onAction: () => { handOnFromRow(0); emit({ kind: 'retry', msgId: item.msgId! }); } },
      { label: t('shell.message.discard'), onAction: () => { handOnFromRow(1); emit({ kind: 'discard', msgId: item.msgId! }); } },
    ] : undefined}
    active={p.active} flash={p.flash} mention={item.mention} editedLabel={item.edited ? t('shell.message.edited') : undefined}
    pinnedLabel={item.pinned ? t('shell.message.pinned') : undefined} seq={item.seq} msgId={item.msgId}
    reply={replyProps} toolbar={toolbar} pendingAction={pendingAction}
    editor={p.editing !== null ? <MessageEditor label={t('shell.edit.label')} value={p.editing} onChange={v => p.onEditChange(v)}
      onSave={v => p.onEditSave(v)} onCancel={() => p.onEditCancel()} hint={t('shell.edit.hint')} saveLabel={t('shell.edit.save')}
      cancelLabel={t('shell.edit.cancel')} maxLength={4000} measure={v => p.editMeasure(v)}
      counterLabel={n => n < 0 ? t('shell.composer.over', { n: -n }) : t('shell.composer.remaining', { n })} /> : undefined}
    attachments={<AttachmentList channelId={p.channelId} item={item} tabbable={p.active} onOpenImage={(i, el) => p.onOpenImage(i, el)} onError={e => p.onError(e)} />}
    reactions={item.reactions.length === 0 ? undefined : <ReactionBar label={t('shell.message.reactions')} tabbable={p.active}
      items={item.reactions.map(r => ({ ...r, name: t('shell.message.reaction', { name: reactionName(r.emoji), count: r.count }) }))}
      onToggle={emoji => emit({ kind: 'toggle', emoji, on: !item.reactions.some(r => r.emoji === emoji && r.mine) })}
      addLabel={t('shell.message.reactionAdd')} onAdd={anchor => emit({ kind: 'react', anchor })} />} />;
}
