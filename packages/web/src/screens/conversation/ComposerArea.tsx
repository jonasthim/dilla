// The open conversation's draft, mentions, replies and file tray.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { encodeMentions, mentionQuery, type MemberSummary, type MentionMember, type TimelineItem } from '@dilla/client-core';
import { Composer, MentionList, ReplyChip } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { editableText, mentionOptions, type NameBook } from '../shell-model.ts';
import { attachFiles, TrayList } from './Attachments.tsx';
import type { ConversationAction, ConversationUi } from './Conversation.tsx';

export interface OutgoingMessage { raw: string; text: string; replyTo: string | null; attachments: readonly string[] }
export interface ComposerAreaProps { channelId: string; label: string; placeholder: string; blocked: string | null;
  broadcast: boolean; encodeWith: readonly MentionMember[]; candidates: readonly MemberSummary[]; items: readonly TimelineItem[];
  book: NameBook; draft: string; onDraft(text: string): void; ui: ConversationUi; dispatch(a: ConversationAction): void;
  onSend(m: OutgoingMessage): void; onError(e: unknown): void }

export function ComposerArea(p: ComposerAreaProps): React.JSX.Element {
  const client = useCore();
  const tray = useSlice(`tray:${p.channelId}`) ?? [];
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const id = useId().replace(/:/g, '-');
  const query = mentionQuery(p.draft, caret);
  const queryEnded = query === null;
  const options = query === null ? [] : mentionOptions(query.query, p.candidates, p.broadcast);
  const open = query !== null && options.length > 0 && query.start !== dismissed;
  const index = Math.min(active, options.length - 1);
  const listId = `${id}-mentions`;
  const optionId = (o: { id: string }) => `${id}-${o.id}`;
  useLayoutEffect(() => {
    if (queryEnded && dismissed !== null) setDismissed(null);
  }, [queryEnded, dismissed]);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const next = pendingCaret.current;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(next, next);
    setCaret(next);
    textareaRef.current?.focus();
  }, [p.draft]);
  useLayoutEffect(() => {
    if (p.ui.reply !== null) textareaRef.current?.focus();
  }, [p.ui.reply]);
  const insert = (option: typeof options[number]) => {
    if (query === null) return;
    const text = p.draft.slice(0, query.start) + option.insert + p.draft.slice(caret);
    pendingCaret.current = query.start + option.insert.length;
    setDismissed(query.start);
    p.onDraft(text);
  };
  const onKey = (key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean => {
    if (open) {
      if (key === 'Escape') { setDismissed(query.start); return true; }
      if (key === 'ArrowDown') { setActive(i => (i + 1) % options.length); return true; }
      if (key === 'ArrowUp') { setActive(i => (i - 1 + options.length) % options.length); return true; }
      if (key === 'Enter' || key === 'Tab') { insert(options[index]); return true; }
    } else if (key === 'Escape' && p.ui.reply !== null) {
      p.dispatch({ type: 'reply', reply: null });
      textareaRef.current?.focus();
      return true;
    }
    return false;
  };
  const send = (value: string) => {
    if (tray.some(a => a.phase !== 'ready')) {
      p.dispatch({ type: 'trayError', text: t('shell.tray.notReady') });
      return;
    }
    p.dispatch({ type: 'trayError', text: null });
    p.onSend({ raw: value, text: encodeMentions(value, p.encodeWith, p.broadcast), replyTo: p.ui.reply?.msgId ?? null,
      attachments: tray.map(a => a.id) });
  };
  return <>
    <input ref={inputRef} className="dw-attach-input" type="file" multiple hidden
      onChange={e => { void attachFiles(client, p.channelId, Array.from(e.currentTarget.files ?? []), a => p.dispatch(a)); e.currentTarget.value = ''; }} />
    <Composer label={p.label} placeholder={p.placeholder} maxLength={4000} value={p.draft}
      onChange={text => { p.onDraft(text); setActive(0);
        setCaret(textareaRef.current?.selectionStart ?? text.length); }}
      disabled={p.blocked !== null} disabledReason={p.blocked ?? undefined} onSend={send}
      sendLabel={t('shell.composer.send')}
      counterLabel={n => n < 0 ? t('shell.composer.over', { n: -n }) : t('shell.composer.remaining', { n })}
      attachLabel={t('shell.composer.attach')} onAttach={() => inputRef.current?.click()}
      top={<>
        {p.ui.reply !== null ? <ReplyChip label={t('shell.composer.replying', { name: p.ui.reply.author })}
          excerpt={p.ui.reply.excerpt} cancelLabel={t('shell.composer.replyCancel')}
          onCancel={() => { p.dispatch({ type: 'reply', reply: null }); textareaRef.current?.focus(); }} /> : null}
        <TrayList channelId={p.channelId} items={tray} onError={e => p.onError(e)} />
        {p.ui.trayError !== null ? <p className="dw-tray-error" role="alert">{p.ui.trayError}</p> : null}
        {open ? <MentionList id={listId} label={t('shell.composer.mentions')}
          options={options.map(o => ({ id: optionId(o), primary: o.primary, secondary: o.secondary }))}
          activeId={optionId(options[index])} onPick={picked => { const found = options.find(o => optionId(o) === picked); if (found) insert(found); }} /> : null}
      </>}
      measure={value => new TextEncoder().encode(encodeMentions(value, p.encodeWith, p.broadcast)).length}
      combobox={{ expanded: open, controls: listId, activeDescendant: open ? optionId(options[index]) : null, onKey }}
      onCaret={setCaret} onArrowUpEmpty={() => {
        const item = [...p.items].reverse().find(i => i.senderUser === p.book.self?.id && i.state === 'ok' && i.msgId !== null && i.seq !== null);
        if (item?.msgId) p.dispatch({ type: 'edit', msgId: item.msgId, value: editableText(item.body, p.book) });
      }}
      onPasteFiles={files => { void attachFiles(client, p.channelId, files, a => p.dispatch(a)); }} textareaRef={textareaRef}
      canSendEmpty={tray.length > 0} />
  </>;
}
