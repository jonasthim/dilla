// A public thread (flow 11, state 11): the root, its replies and a composer whose sends carry the thread. It reads its own
// slices, so a shell mounts it and nothing else: mounted it opens the thread, unmounted it closes it and gives focus back.
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { encodeMentions, PERM, type TimelineItem } from '@dilla/client-core';
import { Button, Dialog, EmojiGrid, MessageLog, ThreadPane } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useChannelBits } from '../../core/use-channel-bits.ts';
import { useSlice } from '../../core/use-slice.ts';
import { REACTION_EMOJI } from '../../emoji.ts';
import { useRoute } from '../../router.ts';
import { t } from '../../strings/index.ts';
import { editableText, editRoles, mentionCandidates, mentionMembers, mentionRoles, nameBook } from '../shell-model.ts';
import { AttachmentLightbox, type LightboxState } from './Attachments.tsx';
import { ComposerArea, type OutgoingMessage } from './ComposerArea.tsx';
import { conversationReducer, INITIAL_UI } from './Conversation.tsx';
import { MessageItem, type RowEvent } from './MessageItem.tsx';

const NO_ITEMS: readonly TimelineItem[] = [];

// `announce` is unused here on purpose: the channel's composer announces a queued send once, and a second composer would say it again.
export function ThreadView(p: {
  channelId: string; rootMsgId: string; channelName: string; phone: boolean; onClose: () => void; announce: (text: string) => void;
  /** Where focus goes when the thread closes, when the shell knows better than the element focused at opening. */
  returnFocus?: () => HTMLElement | null;
}): React.JSX.Element {
  const client = useCore();
  const [route] = useRoute();
  const communityId = route.name === 'channel' ? route.communityId : null;
  const thread = useSlice(`thread:${p.channelId}`);
  const account = useSlice('account');
  const members = useSlice(`members:${communityId ?? ''}`);
  const roles = useSlice(`roles:${communityId ?? ''}`);
  const bits = useChannelBits(communityId, p.channelId);
  const self = account?.user ?? null;
  const [ui, dispatch] = useReducer(conversationReducer, INITIAL_UI);
  const [draft, setDraft] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [emojiFor, setEmojiFor] = useState<{ msgId: string } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ msgId: string; key: string } | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const rowEls = useRef(new Map<string, HTMLElement>());
  // The control that opened the thread, taken while the thread first renders (it still has the focus then).
  const [opener] = useState<Element | null>(() => document.activeElement);
  const returnFocus = useRef(p.returnFocus);
  returnFocus.current = p.returnFocus;

  // Open on mount, close on unmount; a different root closes the old thread first (the worker answers in order).
  useEffect(() => {
    client.call({ m: 'openThread', channelId: p.channelId, rootMsgId: p.rootMsgId })
      .catch((e: unknown) => dispatch({ type: 'trayError', text: t('shell.banner.commandError', { code: errorOf(e).code }) }));
    return () => { client.call({ m: 'closeThread', channelId: p.channelId }).catch(() => undefined); };
  }, [client, p.channelId, p.rootMsgId]);
  // Opening puts the cursor in the thread's composer, except on a phone, where script focus opens no keyboard.
  const phoneRef = useRef(p.phone);
  phoneRef.current = p.phone;
  useEffect(() => {
    if (!phoneRef.current) root.current?.querySelector<HTMLTextAreaElement>('.d-composer textarea')?.focus();
  }, [p.rootMsgId]);
  // Closing hands focus back to the control that opened it, else to the root's row in the channel (contract 2).
  useEffect(() => () => {
    queueMicrotask(() => {
      if (document.activeElement !== document.body && document.activeElement !== null) return;
      const row = document.querySelector<HTMLElement>(`.d-message-row[data-msg-id="${p.rootMsgId}"]`);
      const wanted = returnFocus.current?.() ?? null;
      if (wanted !== null) { wanted.focus(); return; }
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else row?.focus();
    });
  }, [opener, p.rootMsgId]);

  const book = useMemo(() => nameBook(self, members ?? [], roles ?? []), [self, members, roles]);
  const encodeWith = useMemo(() => mentionMembers(members ?? []), [members]);
  const candidates = useMemo(() => mentionCandidates(members ?? [], self?.id ?? null), [members, self]);
  const current = thread !== undefined && thread !== null && thread.rootMsgId === p.rootMsgId ? thread : null;
  const items = current?.items ?? NO_ITEMS;
  // The root and the replies are one roving order: the last row is the tab stop until another takes focus.
  const rootItem = current?.root ?? null;
  const ordered = rootItem === null ? items : [rootItem, ...items];
  const active = ordered.some(i => i.key === activeKey) ? activeKey : ordered.at(-1)?.key ?? null;
  const now = Date.now();

  const broadcast = bits !== null ? (bits & PERM.mentionEveryone) !== 0 : true;
  const roleMentionsFor = (body: string) => mentionRoles(editRoles(roles ?? [], broadcast, body), encodeWith);
  const report = (e: unknown) => dispatch({ type: 'trayError', text: t('shell.banner.commandError', { code: errorOf(e).code }) });
  const command = (m: Parameters<typeof client.call>[0]) => { client.call(m).catch(report); };
  const onRow = (item: TimelineItem, ev: RowEvent) => {
    const msgId = item.msgId;
    if (ev.kind === 'react') { if (msgId !== null) setEmojiFor({ msgId }); }
    else if (ev.kind === 'toggle') { if (msgId !== null) command({ m: 'react', channelId: p.channelId, msgId, emoji: ev.emoji, on: ev.on }); }
    else if (ev.kind === 'edit') { if (msgId !== null) dispatch({ type: 'edit', msgId, value: editableText(item.body, book) }); }
    else if (ev.kind === 'delete') { if (msgId !== null) setDeleteFor({ msgId, key: item.key }); }
    else if (ev.kind === 'retry') command({ m: 'retrySend', msgId: ev.msgId });
    else if (ev.kind === 'discard') command({ m: 'discardSend', msgId: ev.msgId });
  };
  const send = (m: OutgoingMessage) => {
    const withTray = m.attachments.length > 0;
    if (withTray && sending.current) return;
    if (withTray) sending.current = true;
    setDraft(d => (d === m.raw ? '' : d));
    void (async () => {
      try {
        await client.call({ m: 'send', channelId: p.channelId, text: m.text, threadId: p.rootMsgId,
          ...(withTray ? { attachments: [...m.attachments] } : {}) });
      } catch (e) {
        setDraft(d => (d === '' ? m.raw : d));
        report(e);
      } finally {
        if (withTray) sending.current = false;
      }
    })();
  };
  const openImage = (item: TimelineItem, index: number, opener: HTMLElement) => {
    if (item.seq === null) return;
    const images = item.attachments.filter(a => a.kind === 'image' && !a.tooLarge);
    const position = images.findIndex(a => a.index === index);
    if (position >= 0) setLightbox({ seq: item.seq, images, index: position, opener });
  };
  const rowKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('d-message-row') && target.getAttribute('role') !== 'log') return;
    const from = target.classList.contains('d-message-row') ? ordered.findIndex(i => rowEls.current.get(i.key) === target)
      : ordered.findIndex(i => i.key === active);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? ordered.length - 1 : e.key === 'ArrowUp' ? Math.max(0, from - 1) : Math.min(ordered.length - 1, from + 1);
    const next = ordered[index];
    if (next !== undefined) { e.preventDefault(); rowEls.current.get(next.key)?.focus(); }
  };
  const row = (item: TimelineItem, key: string, isActive: boolean) => (
    <MessageItem key={key} item={item} channelId={p.channelId} book={book} now={now} bits={bits} active={isActive} flash={false}
      editing={ui.editing?.msgId === item.msgId ? ui.editing.value : null}
      editMeasure={v => new TextEncoder().encode(encodeMentions(v, encodeWith, broadcast, roleMentionsFor(item.body))).length} rowRef={el => { if (el) rowEls.current.set(item.key, el); else rowEls.current.delete(item.key); }}
      onJumpPointerDown={e => e.preventDefault()} onEvent={onRow} onEditChange={value => dispatch({ type: 'editChange', value })}
      onEditSave={value => {
        if (value.trim() === '') return;
        const start = editableText(item.body, book);
        dispatch({ type: 'editDone' });
        rowEls.current.get(item.key)?.focus();
        if (value !== start && item.msgId) command({ m: 'editMessage', channelId: p.channelId, msgId: item.msgId, text: encodeMentions(value, encodeWith, broadcast, roleMentionsFor(item.body)) });
      }}
      onEditCancel={() => { dispatch({ type: 'editDone' }); rowEls.current.get(item.key)?.focus(); }}
      onOpenImage={(i, el) => openImage(item, i, el)} onError={report} inThread />
  );
  const rootNode = current === null ? null
    : current.root === null ? <p className="dw-thread-missing">{t('thread.rootMissing')}</p>
      : row(current.root, `root-${current.root.key}`, current.root.key === active);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- arrow keys bubbled from the rows, which are the focusable elements
    <div ref={root} className="dw-thread" onFocus={e => {
      const el = (e.target as Element).closest<HTMLElement>('.d-message-row');
      const key = el === null ? undefined : ordered.find(i => rowEls.current.get(i.key) === el)?.key;
      if (key !== undefined) setActiveKey(key);
    }} onKeyDown={rowKey}>
      <ThreadPane title={t('thread.title')} closeLabel={t('thread.close')} onClose={p.onClose} phone={p.phone} root={rootNode}
        composer={
          <ComposerArea channelId={p.channelId} label={t('thread.composer')} placeholder={t('thread.composer')} blocked={null}
            broadcast bits={bits} roles={roles} channelName={p.channelName} encodeWith={encodeWith} candidates={candidates} items={items}
            book={book} draft={draft} onDraft={setDraft} ui={ui} dispatch={dispatch} onSend={send} onError={report}
            threadId={p.rootMsgId} />
        }>
        <MessageLog label={t('thread.title')} emptyLabel={current === null ? '' : t('thread.noReplies')} busy={current === null}>
          {items.map(item => row(item, item.key, item.key === active))}
        </MessageLog>
      </ThreadPane>
      <Dialog open={emojiFor !== null} title={t('shell.emoji.label')} closeLabel={t('dialog.close')} onClose={() => setEmojiFor(null)}>
        <EmojiGrid label={t('shell.emoji.label')} items={REACTION_EMOJI.map(a => ({ emoji: a.emoji, name: t(a.key) }))}
          onPick={emoji => {
            const item = [...items, ...(current?.root != null ? [current.root] : [])].find(i => i.msgId === emojiFor?.msgId);
            if (item?.msgId) command({ m: 'react', channelId: p.channelId, msgId: item.msgId, emoji, on: !item.reactions.some(r => r.emoji === emoji && r.mine) });
            setEmojiFor(null);
          }} onClose={() => setEmojiFor(null)} />
      </Dialog>
      <Dialog open={deleteFor !== null} title={t('shell.delete.title')} closeLabel={t('shell.delete.cancel')}
        onClose={() => setDeleteFor(null)} footer={<Button variant="danger" onClick={() => {
          if (deleteFor === null) return;
          command({ m: 'deleteMessage', channelId: p.channelId, msgId: deleteFor.msgId });
          const key = deleteFor.key;
          setDeleteFor(null);
          queueMicrotask(() => rowEls.current.get(key)?.focus());
        }}>{t('shell.delete.confirm')}</Button>}>{t('shell.delete.body')}</Dialog>
      {lightbox !== null ? <AttachmentLightbox channelId={p.channelId} state={lightbox}
        onIndex={index => setLightbox(s => s ? { ...s, index } : null)} onClose={() => { lightbox.opener?.focus(); setLightbox(null); }} onError={report} /> : null}
    </div>
  );
}
