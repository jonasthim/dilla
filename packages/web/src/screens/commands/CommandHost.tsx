import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '@dilla/ui';
import { InviteFlow } from '../Create.tsx';
import { ModerationLog } from '../admin/ModerationLog.tsx';
import { COMMANDS, availableCommands, type CommandContext as Binding, type CommandDefinition, type CommandInvocation, type CommandOption, type CommandResult } from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import { useCommandProviders } from './CommandContext.tsx';
import { CommandComposer } from './CommandComposer.tsx';
import { builtinHandlers } from './builtin.ts';
import type { CommandExecutionContext } from './command-types.ts';
import type { TimelineItem } from '@dilla/client-core';
import type { CommandSuggestion } from './CommandComposer.tsx';

interface Confirmation { title: string; body: string }
interface SavedDraft { text: string; requestId: string; invocationKey: string }
const drafts = new Map<string, SavedDraft>();
const LIMIT = 128;
const requestId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
function remember(key: string, value: SavedDraft): void {
  drafts.delete(key); drafts.set(key, value);
  while (drafts.size > LIMIT) drafts.delete(drafts.keys().next().value!);
}

export interface CommandHostProps {
  communityId: string | null; channelId: string; threadId?: string; bits?: number; items: readonly TimelineItem[]; selfId: string | null;
  draft: string; onDraft(text: string): void; onSendLiteral(text: string): void; onModeChange?(active: boolean): void; encodeMessage(text: string): string; openGif(query: string): void; gifsEnabled: boolean;
}

export function CommandHost(props: CommandHostProps): React.JSX.Element | null {
  const client = useCore();
  const providers = useCommandProviders();
  const runtime = providers.runtime;
  const binding = useMemo<Binding>(() => ({ communityId: props.communityId, channelId: props.channelId,
    ...(props.threadId === undefined ? {} : { threadId: props.threadId }), ...(props.bits === undefined ? {} : { bits: props.bits }) }),
  [props.communityId, props.channelId, props.threadId, props.bits]);
  const key = `${binding.communityId ?? 'dm'}/${binding.channelId}/${binding.threadId ?? ''}`;
  const [active, setActive] = useState(false);
  const [commandText, setCommandText] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [modlogOpen, setModlogOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteResolve = useRef<((created: boolean) => void) | null>(null);
  const confirmationResolve = useRef<((accepted: boolean) => void) | null>(null);
  const suppress = useRef<string | null>(null);
  const activeRef = useRef(false); activeRef.current = active;
  const contextKey = key;

  const open = useCallback((text: string) => {
    setCommandText(text);
    setActive(true);
    props.onModeChange?.(true);
    activeRef.current = true;
    remember(key, { text, requestId: requestId(), invocationKey: text });
    props.onDraft('');
  }, [key, props.onDraft, props.onModeChange]);
  const onOrdinaryDraft = useCallback((text: string) => {
    if (suppress.current !== null) { suppress.current = null; props.onDraft(text); return; }
    if (text.startsWith('/')) { open(text); return; }
    props.onDraft(text);
  }, [open, props.onDraft]);
  useEffect(() => { if (!active && props.draft.startsWith('/') && suppress.current !== props.draft) open(props.draft); }, [active, props.draft, open]);
  const definitions = useMemo(() => {
    const extra = providers.handlers ?? {};
    return availableCommands(binding).filter(command => (command.id !== 'giphy' || props.gifsEnabled) && (command.provider === 'builtin'
      ? builtinHandlers[command.id] !== undefined || extra[command.id] !== undefined
      : extra[command.id] !== undefined));
  }, [binding, providers.handlers, props.gifsEnabled]);
  const execution = useCallback((invocation: CommandInvocation): Promise<CommandResult> => {
    const handler = (providers.handlers ?? {})[invocation.commandId] ?? builtinHandlers[invocation.commandId];
    if (handler === undefined) return Promise.resolve({ status: 'failure', private: true, message: 'This command is temporarily unavailable.' });
    const invocationKey = `${contextKey}\u0000${invocation.commandId}\u0000${JSON.stringify(invocation.args)}`;
    const previous = drafts.get(key);
    const attempt = previous?.invocationKey === invocationKey ? previous.requestId : requestId();
    const snapshot = Object.freeze({ ...binding });
    remember(key, { text: commandText, requestId: attempt, invocationKey });
    const confirm = (title: string, body: string) => new Promise<boolean>(resolve => { confirmationResolve.current = resolve; setConfirmation({ title, body }); });
    const openInvite = () => new Promise<boolean>(resolve => { inviteResolve.current = resolve; setInviteOpen(true); });
    const openModerationLog = () => { setModlogOpen(true); runtime?.openModerationLog?.(); };
    const context: CommandExecutionContext = { requestId: attempt, binding: snapshot, client,
      call: runtime?.call ?? ({} as never), navigate: runtime?.navigate ?? (() => undefined),
      openThread: runtime?.openThread ?? (() => undefined), openSearch: runtime?.openSearch ?? (() => undefined),
      items: props.items, selfId: props.selfId, encodeMessage: props.encodeMessage, confirm, openInvite, openGif: props.openGif, openModerationLog };
    return handler(invocation, context);
  }, [providers.handlers, contextKey, key, binding, commandText, client, runtime, props.items, props.selfId, props.encodeMessage, props.openGif]);
  const suggest = useCallback(async (commandId: string, option: CommandOption, query: string): Promise<readonly CommandSuggestion[]> => {
    const supplied = await providers.suggest?.(commandId, option, query, binding);
    if (supplied !== undefined) return supplied;
    if (option.kind === 'message') return props.items.filter(item => item.state === 'ok' && item.msgId !== null && item.body.toLowerCase().includes(query.toLowerCase()))
      .slice(-20).map(item => ({ id: item.msgId!, value: item.msgId!, label: item.body.slice(0, 100), description: item.senderUser === props.selfId ? 'Your message' : undefined }));
    if (option.kind === 'user' && binding.communityId !== null && commandId === 'unban') {
      await client.call({ m: 'loadBans', communityId: binding.communityId });
      return (client.get(`bans:${binding.communityId}`) ?? []).filter(row => row.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 20).map(row => ({ id: row.userId, value: row.userId, label: row.name, description: 'Banned member' }));
    }
    if (option.kind === 'user' && binding.communityId !== null) return (client.get(`members:${binding.communityId}` as never) as unknown as { userId: string; username: string; display: string }[] | undefined ?? [])
      .filter(row => (row.display || row.username).toLowerCase().includes(query.toLowerCase())).slice(0, 20)
      .map(row => ({ id: row.userId, value: row.userId, label: row.display || row.username }));
    if (option.kind === 'role' && binding.communityId !== null && commandId.startsWith('selfrole ')) {
      const rows = await client.call({ m: 'listSelfRoles', communityId: binding.communityId }) as { id: string; name: string }[];
      return rows.filter(row => row.name.toLowerCase().includes(query.toLowerCase())).slice(0, 20).map(row => ({ id: row.id, value: row.id, label: row.name }));
    }
    if (option.kind === 'role' && binding.communityId !== null) return (client.get(`roles:${binding.communityId}` as never) as unknown as { id: string; name: string }[] | undefined ?? [])
      .filter(row => row.name.toLowerCase().includes(query.toLowerCase())).slice(0, 20).map(row => ({ id: row.id, value: row.id, label: row.name }));
    if (option.kind === 'channel' && binding.communityId !== null && commandId === 'join') return (client.get(`channels:${binding.communityId}` as never) as unknown as { id: string; name: string; kind: number; mode: number }[] | undefined ?? [])
      .filter(row => row.kind === 1 && row.mode === 0 && row.name.toLowerCase().includes(query.toLowerCase())).slice(0, 20).map(row => ({ id: row.id, value: row.id, label: row.name, description: 'Voice channel' }));
    return [];
  }, [providers.suggest, binding, props.items, props.selfId, client]);
  const cancel = (text: string) => {
    remember(key, { text, requestId: requestId(), invocationKey: text });
    setCommandText(''); setActive(false); props.onModeChange?.(false); activeRef.current = false;
    suppress.current = text;
    props.onDraft(text);
  };
  const sendLiteral = (text: string) => {
    setCommandText(''); setActive(false); props.onModeChange?.(false); activeRef.current = false;
    props.onSendLiteral(text);
  };
  if (!active) return null;
  const saved = drafts.get(key)?.text ?? commandText;
  const community = binding.communityId === null ? null : client.get('communities')?.find(row => row.id === binding.communityId) ?? null;
  return <>{inviteOpen && community !== null ? <InviteFlow open community={{ id: community.id, name: community.name }} onClose={() => { setInviteOpen(false); inviteResolve.current?.(false); inviteResolve.current = null; }} onCreated={() => { inviteResolve.current?.(true); inviteResolve.current = null; }} /> : null}
    {modlogOpen && binding.communityId !== null ? <Dialog open title="Moderation history" closeLabel="Close" onClose={() => setModlogOpen(false)}><ModerationLog communityId={binding.communityId} /></Dialog> : null}
    {confirmation !== null ? <ConfirmDialog open title={confirmation.title} body={confirmation.body} confirmLabel="Continue" busyLabel="Working…" cancelLabel="Cancel" busy={false} error={null}
    onConfirm={() => { setConfirmation(null); confirmationResolve.current?.(true); confirmationResolve.current = null; }}
    onClose={() => { setConfirmation(null); confirmationResolve.current?.(false); confirmationResolve.current = null; }} /> : null}<CommandComposer key={key} definitions={definitions as readonly CommandDefinition[]} initialText={saved}
    onExecute={execution} onCancel={cancel} onSendLiteral={sendLiteral} suggest={suggest} contextKey={contextKey}
    onDraftChange={text => { setCommandText(text); const row = drafts.get(key); remember(key, { text, requestId: row?.requestId ?? requestId(), invocationKey: row?.invocationKey ?? text }); }} /></>;
}
