// Flow 07 (v0.1.0-web3.1): start a server, add a channel, invite people. Each flow is a @dilla/ui dialog driven by one
// worker command at a time; every refusal is said by its code, never by the instance's detail text.
import { useEffect, useRef, useState } from 'react';
import { CreateChannel, CreateServer, InviteLink, type NewChannelKind } from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { t } from '../strings/index.ts';

/** The instance's own bounds (internal/api maxCommunityNameBytes, maxChannelNameBytes); the worker checks them again. */
export const SERVER_NAME_MAX_BYTES = 255;
export const CHANNEL_NAME_MAX_BYTES = 100;
/** An invite link works this many times and for this long (flow 07, Copy). */
export const INVITE_MAX_USES = 10;
export const INVITE_TTL_DAYS = 7;
export const INVITE_TTL_S = INVITE_TTL_DAYS * 24 * 3600;
/** What a new server starts with, in order: #general, then the voice channel general. */
const STARTERS: readonly { kind: NewChannelKind; name: string }[] = [{ kind: 'text', name: 'general' }, { kind: 'voice', name: 'general' }];

const UTF8 = new TextEncoder();
const CONTROL = /\p{Cc}/u;
const HEX32 = /^[0-9a-f]{32}$/;

/** Why the instance would refuse `raw` (trimmed) as a name of at most `maxBytes` UTF-8 bytes; null when it would not. */
export function nameProblem(raw: string, maxBytes: number): 'empty' | 'long' | 'control' | null {
  const name = raw.trim();
  if (name === '') return 'empty';
  if (UTF8.encode(name).length > maxBytes) return 'long';
  if (CONTROL.test(name)) return 'control';
  return null;
}

/** How a typed name is stored: a text channel as a lower-case slug (`ship-talk`), a voice channel as typed, trimmed. */
export function channelName(kind: NewChannelKind, raw: string): string {
  const spaced = raw.trim().replace(/\s+/g, kind === 'text' ? '-' : ' ');
  return kind === 'text' ? spaced.toLowerCase() : spaced;
}

/** The hex id a create answered with under `key`, or null when the answer is not { [key]: <32 hex> }. */
function idIn(value: unknown, key: 'communityId' | 'channelId'): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === 'string' && HEX32.test(id) ? id : null;
}

const BAD_RESULT: UiError = { code: 'E_BAD_RESULT', detail: '', status: 0, retryAfterMs: null };

/**
 * "Start a server": the name, then createCommunity, then the two starter channels. `onServer` runs as soon as the server
 * exists, so the shell selects it; `onDone` once #general exists too. A starter channel that fails leaves the server as
 * it is and says so, with a retry that adds only the missing channels (never a silent rollback).
 */
export function CreateServerFlow(props: {
  open: boolean; onClose(): void; onServer(communityId: string): void; onDone(result: { communityId: string; channelId: string }): void;
}): React.JSX.Element {
  const client = useCore();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const running = useRef(false);
  // The server this dialog created and the starter channels it holds so far, for the retry.
  const made = useRef<{ communityId: string; name: string; channels: Map<number, string> } | null>(null);

  useEffect(() => {
    if (props.open) return;
    setName(''); setError(null); setBusy(false); setPartial(null);
    made.current = null;
  }, [props.open]);

  const starters = async (server: { communityId: string; name: string; channels: Map<number, string> }) => {
    let failure: UiError | null = null;
    for (const [i, starter] of STARTERS.entries()) {
      if (server.channels.has(i)) continue;
      try {
        const id = idIn(await client.call({ m: 'createChannel', communityId: server.communityId, kind: starter.kind, name: starter.name }), 'channelId');
        if (id === null) failure ??= BAD_RESULT;
        else server.channels.set(i, id);
      } catch (e) {
        failure ??= errorOf(e);
      }
    }
    const general = server.channels.get(0);
    if (failure === null && general !== undefined) {
      props.onDone({ communityId: server.communityId, channelId: general });
      return;
    }
    setPartial(t('create.server.partial', { name: server.name, code: (failure ?? BAD_RESULT).code }));
  };

  const run = (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void work().finally(() => { running.current = false; setBusy(false); });
  };

  const submit = () => {
    const problem = nameProblem(name, SERVER_NAME_MAX_BYTES);
    if (problem !== null) {
      setError(t(problem === 'empty' ? 'create.server.error.empty' : problem === 'long' ? 'create.server.error.long' : 'create.name.control'));
      return;
    }
    const serverName = name.trim();
    run(async () => {
      let communityId: string | null;
      try {
        communityId = idIn(await client.call({ m: 'createCommunity', name: serverName }), 'communityId');
      } catch (e) {
        const code = errorOf(e).code;
        setError(code === 'E_INVALID_REQUEST' || code === 'E_BAD_INPUT' ? t('create.server.error.refused') : t('create.server.error.other', { code }));
        return;
      }
      if (communityId === null) { setError(t('create.server.error.other', { code: BAD_RESULT.code })); return; }
      const server = { communityId, name: serverName, channels: new Map<number, string>() };
      made.current = server;
      props.onServer(communityId);
      await starters(server);
    });
  };

  const retry = () => {
    const server = made.current;
    if (server === null) return;
    setPartial(null);
    run(() => starters(server));
  };

  return (
    <CreateServer open={props.open} name={name} onName={v => { setName(v); setError(null); }} error={error} busy={busy} partial={partial}
      labels={{ title: t('create.server.title'), body: t('create.server.body'), name: t('create.server.name'), hint: t('create.server.hint'),
        submit: t('create.server.submit'), busy: t('create.server.busy'), close: t('dialog.close'), retry: t('create.server.retry') }}
      onSubmit={submit} onRetry={retry} onClose={() => props.onClose()} />
  );
}

/** "New channel": a kind and a name, then createChannel; `onDone` hands over the new channel to select. */
export function CreateChannelFlow(props: {
  open: boolean; community: { id: string; name: string } | null; onClose(): void; onDone(channelId: string, kind: NewChannelKind): void;
}): React.JSX.Element {
  const client = useCore();
  const [kind, setKind] = useState<NewChannelKind>('text');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    if (props.open) return;
    setKind('text'); setName(''); setError(null); setBusy(false);
  }, [props.open]);

  const shown = channelName(kind, name);
  const hint = shown === '' ? t('create.channel.hint')
    : t(kind === 'text' ? 'create.channel.hintText' : 'create.channel.hintVoice', { name: shown });

  const submit = () => {
    const community = props.community;
    if (community === null || running.current) return;
    const problem = nameProblem(shown, CHANNEL_NAME_MAX_BYTES);
    if (problem !== null) {
      setError(t(problem === 'empty' ? 'create.channel.error.empty' : problem === 'long' ? 'create.channel.error.long' : 'create.name.control'));
      return;
    }
    running.current = true;
    setBusy(true);
    const chosen = kind;
    void (async () => {
      try {
        const id = idIn(await client.call({ m: 'createChannel', communityId: community.id, kind: chosen, name: shown }), 'channelId');
        if (id === null) setError(t('create.channel.error.other', { code: BAD_RESULT.code }));
        else props.onDone(id, chosen);
      } catch (e) {
        const code = errorOf(e).code;
        setError(code === 'E_FORBIDDEN' ? t('create.channel.error.forbidden')
          : code === 'E_INVALID_REQUEST' || code === 'E_BAD_INPUT' ? t('create.channel.error.refused')
            : t('create.channel.error.other', { code }));
      } finally {
        running.current = false;
        setBusy(false);
      }
    })();
  };

  return (
    <CreateChannel open={props.open} kind={kind} onKind={k => { setKind(k); setError(null); }} name={name}
      onName={v => { setName(v); setError(null); }} hint={hint} error={error} busy={busy}
      labels={{ title: t('create.channel.title', { server: props.community?.name ?? '' }), kind: t('create.channel.kind'),
        text: t('create.channel.text'), voice: t('create.channel.voice'), name: t('create.channel.name'), submit: t('create.channel.submit'),
        busy: t('create.channel.busy'), close: t('dialog.close') }}
      onSubmit={submit} onClose={() => props.onClose()} />
  );
}

/** Copies `url`; true when the browser let it. A blocked or absent clipboard is not an error: the dialog shows the link. */
async function copied(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The invite action: on open, createInvite for INVITE_MAX_USES uses over INVITE_TTL_DAYS days, then the link is copied and
 * "Invite link copied." is announced. The link stays in the dialog for a clipboard the browser blocked.
 */
export function InviteFlow(props: { open: boolean; community: { id: string; name: string } | null; onClose(): void }): React.JSX.Element {
  const client = useCore();
  const [state, setState] = useState<'creating' | 'ready' | 'failed'>('creating');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const communityId = props.community?.id ?? null;

  useEffect(() => {
    if (!props.open || communityId === null) {
      setState('creating'); setUrl(''); setStatus(''); setError(null);
      return;
    }
    let live = true;
    setState('creating');
    setStatus('');
    void (async () => {
      try {
        const value = await client.call({ m: 'createInvite', communityId, maxUses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_S });
        const link = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).url : undefined;
        if (typeof link !== 'string' || link === '') throw Object.assign(new Error(BAD_RESULT.code), BAD_RESULT);
        if (!live) return;
        setUrl(link);
        setState('ready');
        const ok = await copied(link);
        if (live) setStatus(t(ok ? 'invite.copied' : 'invite.blocked'));
      } catch (e) {
        if (!live) return;
        const code = errorOf(e).code;
        setError(code === 'E_FORBIDDEN' ? t('invite.error.forbidden') : t('invite.error.other', { code }));
        setState('failed');
      }
    })();
    return () => { live = false; };
  }, [props.open, communityId, attempt, client]);

  const copyAgain = () => {
    setStatus('');
    void copied(url).then(ok => setStatus(t(ok ? 'invite.copied' : 'invite.blocked')));
  };

  return (
    <InviteLink open={props.open} state={state} url={url} status={status} error={error}
      limits={t('invite.limits', { uses: INVITE_MAX_USES, days: INVITE_TTL_DAYS, server: props.community?.name ?? '' })}
      labels={{ title: t('invite.title', { server: props.community?.name ?? '' }), creating: t('invite.creating'), link: t('invite.link'),
        copy: t('invite.copy'), close: t('dialog.close'), retry: t('invite.retry') }}
      onCopy={copyAgain} onRetry={() => setAttempt(a => a + 1)} onClose={() => props.onClose()} />
  );
}
