// One folded timeline item, with its controls and focus hand-off.
import { useLayoutEffect, useRef, type PointerEvent } from 'react';
import { PERM, type TimelineItem, type TimelineItemState } from '@dilla/client-core';
import { MessageEditor, MessageRow, MessageToolbar, ReactionBar } from '@dilla/ui';
import { reactionDisplay, reactionName } from '../../emoji.ts';
import { formatGutterTime, t, type StringKey } from '../../strings/index.ts';
import { authorName, bodyParts, knownName, messageTime, plainBody, type NameBook } from '../shell-model.ts';
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

export type ProfileOpener = (userId: string, anchor: HTMLElement, source: 'mention' | 'author', name: string) => void;

export interface MessageItemProps { item: TimelineItem; channelId: string; book: NameBook; now: number; active: boolean; flash: boolean;
  /** What I may do in this channel; null while unknown, which shows every item as before. */
  bits?: number | null;
  editing: string | null; editMeasure(v: string): number; rowRef(el: HTMLElement | null): void;
  onJumpPointerDown(e: PointerEvent<HTMLButtonElement>): void;
  onEvent(item: TimelineItem, ev: RowEvent): void; onEditChange(v: string): void; onEditSave(v: string): void; onEditCancel(): void;
  onOpenImage(index: number, opener: HTMLElement): void; onError(e: unknown): void;
  /** Opens this message's thread (web3.7): the toolbar item and the summary chip. Absent where no thread can be opened (the thread pane's own rows). */
  onOpenThread?: (msgId: string) => void;
  /** Opens a profile card for a mentioned user or the author (MP7), anchored to the pill or the author name; `name` is shown when the person is no longer a member. Absent: neither is a button. */
  onOpenProfile?: ProfileOpener;
  /** True: a row of the thread pane. Its toolbar takes react, and edit and delete on own messages; reply, pin and thread stay in the channel. */
  inThread?: boolean;
  /** The row continues the author's run above it (R29): its head is hidden and its time stands in the gutter. */
  grouped?: boolean;
  /** Phone only (R30): whether this row's toolbar is shown, and the row's ask to show or hide it. Absent: the toolbar is always shown. */
  revealed?: boolean;
  onReveal?: (on: boolean) => void }

export function MessageItem(p: MessageItemProps): React.JSX.Element {
  const { item } = p;
  const rowEl = useRef<HTMLElement | null>(null);
  const priorReactions = useRef(item.reactions.length);
  const focusedReaction = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (priorReactions.current > 0 && document.activeElement === document.body &&
      (item.reactions.length === 0 || (focusedReaction.current !== null && !item.reactions.some(r => r.emoji === focusedReaction.current)))) {
      rowEl.current?.focus();
    }
    priorReactions.current = item.reactions.length;
  }, [item.reactions]);
  const emit = (event: RowEvent) => p.onEvent(item, event);
  const ownAuthor = item.senderUser !== null && item.senderUser === p.book.self?.id;
  const author = authorName(item, p.book.members, p.book.self);
  const label = STATE_LABEL[item.state];
  const cannotReadDetail = item.state !== 'cannot-read' ? undefined
    : item.reason === 'E_UMK_CHANGED' ? t('privacy.changed')
      : item.reason === 'E_DEVICE_UNLISTED' ? t('privacy.unlisted') : undefined;
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
  // Walk 11: reply and reply in thread lead to the composer, so a reader who cannot send there is not offered them.
  const canSend = p.bits == null || (p.bits & PERM.sendMessages) !== 0;
  const openThread = item.state === 'ok' && item.msgId !== null && item.seq !== null ? p.onOpenThread : undefined;
  const toolbar = item.state === 'ok' && item.msgId !== null && item.seq !== null ? <MessageToolbar
    label={t('shell.message.toolbar')} tabbable={p.active} items={[
      { id: 'react', label: t('shell.message.react'), onAction: e => emit({ kind: 'react', anchor: e.currentTarget as HTMLElement }) },
      ...(p.inThread === true || !canSend ? [] : [{ id: 'reply' as const, label: t('shell.message.reply'), onAction: () => emit({ kind: 'reply' }) }]),
      ...(openThread !== undefined && canSend ? [{ id: 'thread' as const, label: t('thread.open'), onAction: () => openThread(item.msgId!) }] : []),
      ...(ownAuthor ? [{ id: 'edit' as const, label: t('shell.message.edit'), onAction: () => emit({ kind: 'edit' as const }) }] : []),
      ...(p.inThread !== true && (p.bits == null || (p.bits & PERM.pinMessages) !== 0) ? [{ id: 'pin' as const, label: t(item.pinned ? 'shell.message.unpin' : 'shell.message.pin'), onAction: () => emit({ kind: 'pin', on: !item.pinned }) }] : []),
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
  // In the gutter the time stands alone: the day divider above the run names the day.
  const time = messageTime(item.ts, p.now);
  const openProfile = p.onOpenProfile;
  return <MessageRow rowRef={el => { rowEl.current = el; p.rowRef(el); }} author={author} time={time}
    authorId={item.senderUser ?? undefined}
    onOpenProfile={openProfile === undefined ? undefined : (userId, anchor, from) =>
      openProfile(userId, anchor, from, knownName(from === 'author' ? author : (anchor.textContent ?? '').replace(/^@/, ''), userId))} body={shown ? bodyParts(item.body, p.book, item.mention) : ''}
    grouped={p.grouped} gutterTime={p.grouped === true ? formatGutterTime(item.ts) : undefined} revealed={p.revealed} onReveal={p.onReveal}
    own={item.own} tag={item.bot ? 'bot' : item.web ? 'web' : undefined} state={item.state}
    stateLabel={label === null ? undefined : t(label)} detail={gone ? undefined : item.state === 'failed' ? item.reason : cannotReadDetail}
    actions={!gone && item.state === 'failed' && item.msgId !== null ? [
      { label: t('shell.message.retry'), onAction: () => { handOnFromRow(0); emit({ kind: 'retry', msgId: item.msgId! }); } },
      { label: t('shell.message.discard'), onAction: () => { handOnFromRow(1); emit({ kind: 'discard', msgId: item.msgId! }); } },
    ] : undefined}
    active={p.active} flash={p.flash} mention={item.mention} editedLabel={item.edited ? t('shell.message.edited') : undefined}
    pinnedLabel={item.pinned ? t('shell.message.pinned') : undefined} seq={item.seq} msgId={item.msgId}
    reply={replyProps} toolbar={toolbar} pendingAction={pendingAction}
    thread={openThread !== undefined && item.thread !== null ? { label: item.thread.count === 1 ? t('thread.summary.one') : t('thread.summary.other', { count: item.thread.count }),
      onOpen: () => openThread(item.msgId!) } : undefined}
    editor={p.editing !== null ? <MessageEditor label={t('shell.edit.label')} value={p.editing} onChange={v => p.onEditChange(v)}
      onSave={v => p.onEditSave(v)} onCancel={() => p.onEditCancel()} hint={t('shell.edit.hint')} saveLabel={t('shell.edit.save')}
      cancelLabel={t('shell.edit.cancel')} maxLength={4000} measure={v => p.editMeasure(v)}
      counterLabel={n => n < 0 ? t('shell.composer.over', { n: -n }) : t('shell.composer.remaining', { n })} /> : undefined}
    attachments={<AttachmentList channelId={p.channelId} item={item} tabbable={p.active} onOpenImage={(i, el) => p.onOpenImage(i, el)} onError={e => p.onError(e)} />}
    reactions={item.reactions.length === 0 ? undefined : <ReactionBar label={t('shell.message.reactions')} tabbable={p.active}
      onChipFocus={emoji => { focusedReaction.current = emoji; }}
      items={item.reactions.map(r => ({ ...r, display: reactionDisplay(r.emoji) || t('shell.message.unknownReaction'),
        name: t('shell.message.reaction', { name: reactionName(r.emoji), count: r.count }) }))}
      onToggle={emoji => emit({ kind: 'toggle', emoji, on: !item.reactions.some(r => r.emoji === emoji && r.mine) })}
      addLabel={t('shell.message.reactionAdd')} onAdd={anchor => emit({ kind: 'react', anchor })} />} />;
}
