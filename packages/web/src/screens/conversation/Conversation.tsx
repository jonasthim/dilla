// The open conversation: folded rows, navigation, reactions, pins and overlays.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { encodeMentions, type MentionMember, type TimelineItem, type TimelineState } from '@dilla/client-core';
import { Banner, Button, Dialog, DropOverlay, EmojiGrid, MessageLog } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { REACTION_EMOJI } from '../../emoji.ts';
import { t } from '../../strings/index.ts';
import { authorName, editableText, excerpt, plainBody, type NameBook } from '../shell-model.ts';
import { attachFiles, AttachmentLightbox, type LightboxState } from './Attachments.tsx';
import { MessageItem, type RowEvent } from './MessageItem.tsx';
import { PinsPanel } from './Pins.tsx';

export const FLASH_MS = 1400;
export interface ConversationUi {
  reply: { msgId: string; author: string; excerpt: string } | null;
  editing: { msgId: string; value: string } | null;
  pinsOpen: boolean;
  jump: { msgId: string; n: number } | null;
  notice: 'shell.message.replyNotLoaded' | null;
  trayError: string | null;
}
export type ConversationAction =
  | { type: 'reply'; reply: ConversationUi['reply'] } | { type: 'replySent'; msgId: string }
  | { type: 'edit'; msgId: string; value: string } | { type: 'editChange'; value: string } | { type: 'editDone' }
  | { type: 'pins'; open: boolean } | { type: 'jump'; msgId: string }
  | { type: 'notice'; notice: ConversationUi['notice'] } | { type: 'trayError'; text: string | null } | { type: 'reset' };
export const INITIAL_UI: ConversationUi = { reply: null, editing: null, pinsOpen: false, jump: null, notice: null, trayError: null };
export function conversationReducer(s: ConversationUi, a: ConversationAction): ConversationUi {
  switch (a.type) {
    case 'reply': return { ...s, reply: a.reply };
    case 'replySent': return s.reply?.msgId === a.msgId ? { ...s, reply: null } : s;
    case 'edit': return { ...s, editing: { msgId: a.msgId, value: a.value } };
    case 'editChange': return s.editing === null ? s : { ...s, editing: { ...s.editing, value: a.value } };
    case 'editDone': return { ...s, editing: null };
    case 'pins': return { ...s, pinsOpen: a.open };
    case 'jump': return { ...s, pinsOpen: false, jump: { msgId: a.msgId, n: (s.jump?.n ?? 0) + 1 } };
    case 'notice': return { ...s, notice: a.notice };
    case 'trayError': return { ...s, trayError: a.text };
    case 'reset': return INITIAL_UI;
  }
}
export function useConversationUi(targetId: string | null): [ConversationUi, (a: ConversationAction) => void] {
  const [ui, dispatch] = useReducer(conversationReducer, INITIAL_UI);
  const [forId, setForId] = useState(targetId);
  if (forId !== targetId) {
    setForId(targetId);
    dispatch({ type: 'reset' });
  }
  return [ui, dispatch];
}
export function focusComposer(): void { document.querySelector<HTMLTextAreaElement>('.d-composer textarea')?.focus(); }
export function focusLog(): void { document.querySelector<HTMLElement>('[role="log"]')?.focus(); }

export interface ConversationProps { channelId: string; logKey: string; label: string; timeline: TimelineState | undefined;
  book: NameBook; encodeWith: readonly MentionMember[]; broadcast: boolean; pinsTitle: string; ui: ConversationUi;
  dispatch(a: ConversationAction): void; loadingEarlier: boolean; onLoadEarlier(): void; onError(e: unknown): void }

export function Conversation(p: ConversationProps): React.JSX.Element {
  const client = useCore();
  const items = p.timeline?.items ?? [];
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = items.some(i => i.key === activeKey) ? activeKey : items.at(-1)?.key ?? null;
  const [emojiFor, setEmojiFor] = useState<{ key: string; opener: HTMLElement } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ key: string; msgId: string } | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [gridPos, setGridPos] = useState<{ top: number; left: number } | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const paneRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | null>(null);
  const deleted = useRef<{ key: string } | null>(null);
  const closedLightbox = useRef<HTMLElement | null>(null);
  const noticeDismissed = useRef(false);
  const now = Date.now();

  const command = (m: Parameters<typeof client.call>[0]) => { client.call(m).catch(e => p.onError(e)); };
  const closeEmoji = (returnFocus: boolean) => {
    const opener = emojiFor?.opener;
    setEmojiFor(null);
    setGridPos(null);
    if (returnFocus) opener?.focus();
  };
  const jump = (msgId: string) => p.dispatch({ type: 'jump', msgId });
  // Focusing a reply button on pointer down activates its row. In a narrow log the toolbar then enters the layout
  // and moves the button before pointer up, so no click reaches it. The jump itself supplies the focus target.
  const keepJumpPointerStable = (e: PointerEvent<HTMLButtonElement>) => e.preventDefault();

  useEffect(() => {
    if (deleteFor !== null || deleted.current === null) return;
    rowEls.current.get(deleted.current.key)?.focus();
    deleted.current = null;
  }, [deleteFor]);
  useLayoutEffect(() => {
    if (lightbox !== null || closedLightbox.current === null) return;
    closedLightbox.current.focus();
    closedLightbox.current = null;
  }, [lightbox]);
  const jumpInputs = useRef({ items, dispatch: (a: ConversationAction) => p.dispatch(a) });
  jumpInputs.current = { items, dispatch: (a: ConversationAction) => p.dispatch(a) };
  const jumpTarget = p.ui.jump;
  useEffect(() => {
    const target = jumpTarget;
    if (target === null) return;
    const item = jumpInputs.current.items.find(i => i.msgId === target.msgId);
    if (item === undefined) {
      jumpInputs.current.dispatch({ type: 'notice', notice: 'shell.message.replyNotLoaded' });
      return;
    }
    setActiveKey(item.key);
    const row = rowEls.current.get(item.key);
    row?.focus();
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    row?.scrollIntoView?.({ block: 'center', behavior });
    setFlashKey(item.key);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashKey(null), FLASH_MS);
  }, [jumpTarget]);
  useLayoutEffect(() => {
    if (!noticeDismissed.current || p.ui.notice !== null) return;
    noticeDismissed.current = false;
    if (active !== null) rowEls.current.get(active)?.focus();
  }, [p.ui.notice, active]);
  useEffect(() => () => { if (flashTimer.current !== null) window.clearTimeout(flashTimer.current); }, []);

  useLayoutEffect(() => {
    if (emojiFor === null || gridPos === null || gridRef.current === null || paneRef.current === null) return;
    const opener = emojiFor.opener.getBoundingClientRect();
    const pane = paneRef.current.getBoundingClientRect();
    const grid = gridRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(0, opener.left - pane.left), Math.max(0, pane.width - grid.width));
    const top = opener.bottom - pane.top + grid.height <= pane.height ? opener.bottom - pane.top
      : Math.max(0, opener.top - pane.top - grid.height);
    if (left !== gridPos.left || top !== gridPos.top) setGridPos({ left, top });
  }, [emojiFor, gridPos]);

  const onRowEvent = (item: TimelineItem, ev: RowEvent) => {
    const msgId = item.msgId;
    switch (ev.kind) {
      case 'react': {
        const opener = ev.anchor.getBoundingClientRect();
        const pane = paneRef.current?.getBoundingClientRect();
        setEmojiFor({ key: item.key, opener: ev.anchor });
        setGridPos({ top: pane ? opener.bottom - pane.top : 0, left: pane ? Math.max(0, opener.left - pane.left) : 0 });
        break;
      }
      case 'reply': if (msgId !== null) p.dispatch({ type: 'reply', reply: {
        msgId, author: item.senderUser === null ? '' : authorName(item, p.book.members, p.book.self),
        excerpt: excerpt(plainBody(item.body, p.book)),
      } }); break;
      case 'edit': if (msgId !== null) p.dispatch({ type: 'edit', msgId, value: editableText(item.body, p.book) }); break;
      case 'pin': if (msgId !== null) command({ m: 'pin', channelId: p.channelId, msgId, on: ev.on }); break;
      case 'delete': if (msgId !== null) setDeleteFor({ key: item.key, msgId }); break;
      case 'toggle': if (msgId !== null) command({ m: 'react', channelId: p.channelId, msgId, emoji: ev.emoji, on: ev.on }); break;
      case 'jump': jump(ev.msgId); break;
      case 'retry': command({ m: 'retrySend', msgId: ev.msgId }); break;
      case 'discard': command({ m: 'discardSend', msgId: ev.msgId }); break;
    }
  };
  const rowKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      if (target.closest('.d-message-editor, .d-emoji-grid')) return;
      if (target === e.currentTarget || target.classList.contains('d-message-row')) focusComposer();
      else target.closest<HTMLElement>('.d-message-row')?.focus();
      e.preventDefault();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    if (target !== e.currentTarget && !target.classList.contains('d-message-row')) return;
    const from = target.classList.contains('d-message-row') ? items.findIndex(i => rowEls.current.get(i.key) === target)
      : items.findIndex(i => i.key === active);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowUp' ? Math.max(0, from - 1) : Math.min(items.length - 1, from + 1);
    const next = target === e.currentTarget && (e.key === 'ArrowUp' || e.key === 'ArrowDown') ? items.find(i => i.key === active) : items[index];
    if (next) { e.preventDefault(); rowEls.current.get(next.key)?.focus(); }
  };
  const fileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const openImage = (item: TimelineItem, index: number, opener: HTMLElement) => {
    if (item.seq === null) return;
    const images = item.attachments.filter(a => a.kind === 'image' && !a.tooLarge);
    const position = images.findIndex(a => a.index === index);
    if (position >= 0) setLightbox({ seq: item.seq, images, index: position, opener });
  };
  const closeLightbox = () => { closedLightbox.current = lightbox?.opener ?? null; setLightbox(null); };

  return <div ref={paneRef} className="dw-conversation"
    onFocus={e => { const row = (e.target as Element).closest<HTMLElement>('.d-message-row'); if (row) {
      const key = items.find(i => rowEls.current.get(i.key) === row)?.key;
      if (key) setActiveKey(key);
    } }}
    onDragEnter={e => { if (fileDrag(e)) { e.preventDefault(); setDragDepth(n => n + 1); } }}
    onDragOver={e => { if (fileDrag(e)) e.preventDefault(); }}
    onDragLeave={e => { if (fileDrag(e)) setDragDepth(n => Math.max(0, n - 1)); }}
    onDrop={e => { if (!fileDrag(e)) return; e.preventDefault(); setDragDepth(0);
      void attachFiles(client, p.channelId, Array.from(e.dataTransfer.files), a => p.dispatch(a)); }}>
    {p.ui.notice !== null ? <Banner tone="info">{t(p.ui.notice)} <Button variant="ghost" onClick={() => {
      noticeDismissed.current = true; p.dispatch({ type: 'notice', notice: null });
    }}>{t('shell.banner.dismiss')}</Button></Banner> : null}
    <MessageLog key={p.logKey} label={p.label} emptyLabel={p.timeline === undefined ? t('shell.log.loading') : t('shell.log.empty')}
      earlier={p.timeline?.hasEarlier ? { label: t('shell.log.earlier'), onLoad: () => p.onLoadEarlier() } : undefined}
      busy={p.timeline === undefined || p.loadingEarlier} onKeyDown={rowKey}>
      {items.map(item => <MessageItem key={item.key} item={item} channelId={p.channelId} book={p.book} now={now}
        active={item.key === active} flash={item.key === flashKey} editing={p.ui.editing?.msgId === item.msgId ? p.ui.editing.value : null}
        editMeasure={v => new TextEncoder().encode(encodeMentions(v, p.encodeWith, p.broadcast)).length}
        rowRef={el => { if (el) rowEls.current.set(item.key, el); else rowEls.current.delete(item.key); }}
        onEvent={onRowEvent} onJumpPointerDown={keepJumpPointerStable} onEditChange={value => p.dispatch({ type: 'editChange', value })}
        onEditSave={value => {
          if (value.trim() === '') return;
          const start = editableText(item.body, p.book);
          p.dispatch({ type: 'editDone' });
          rowEls.current.get(item.key)?.focus();
          if (value !== start && item.msgId) command({ m: 'editMessage', channelId: p.channelId, msgId: item.msgId, text: encodeMentions(value, p.encodeWith, p.broadcast) });
        }}
        onEditCancel={() => { p.dispatch({ type: 'editDone' }); rowEls.current.get(item.key)?.focus(); }}
        onOpenImage={(index, opener) => openImage(item, index, opener)} onError={e => p.onError(e)} />)}
    </MessageLog>
    <div className="dw-overlay">{emojiFor !== null && gridPos !== null ? <div ref={gridRef} style={gridPos}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) closeEmoji(false); }}>
      <EmojiGrid label={t('shell.emoji.label')} items={REACTION_EMOJI.map(a => ({ emoji: a.emoji, name: t(a.key) }))}
        onPick={emoji => {
          const item = items.find(i => i.key === emojiFor.key);
          if (item?.msgId) command({ m: 'react', channelId: p.channelId, msgId: item.msgId, emoji,
            on: !item.reactions.some(r => r.emoji === emoji && r.mine) });
          closeEmoji(true);
        }} onClose={() => closeEmoji(true)} />
    </div> : null}</div>
    <DropOverlay active={dragDepth > 0} title={t('shell.drop.title')} body={t('shell.drop.body')} />
    <p className="dw-drop-status d-sr-only" role="status">{dragDepth > 0 ? t('shell.drop.title') : ''}</p>
    <Dialog open={deleteFor !== null} title={t('shell.delete.title')} closeLabel={t('shell.delete.cancel')}
      onClose={() => setDeleteFor(null)} footer={<Button variant="danger" onClick={() => {
        if (deleteFor === null) return;
        command({ m: 'deleteMessage', channelId: p.channelId, msgId: deleteFor.msgId });
        deleted.current = { key: deleteFor.key };
        setDeleteFor(null);
      }}>{t('shell.delete.confirm')}</Button>}>{t('shell.delete.body')}</Dialog>
    <PinsPanel channelId={p.channelId} open={p.ui.pinsOpen} title={p.pinsTitle} book={p.book} items={items} now={now}
      onClose={() => p.dispatch({ type: 'pins', open: false })} onJump={jump} onError={e => p.onError(e)} />
    {lightbox !== null ? <AttachmentLightbox channelId={p.channelId} state={lightbox}
      onIndex={index => setLightbox(s => s ? { ...s, index } : null)} onClose={closeLightbox} onError={e => p.onError(e)} /> : null}
  </div>;
}
