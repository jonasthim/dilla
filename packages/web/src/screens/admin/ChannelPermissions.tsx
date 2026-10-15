import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, ConfirmDialog, PermissionGrid, Select, Toggle, type PermissionGridGroup, type PermValue } from '@dilla/ui';
import {
  COMMUNITY_BITS, PERM_BY_KEY, PERM_GROUPS, channelBitsOf, isPrivate, type MemberSummary, type OverwriteSummary, type RoleSummary,
} from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { forbidden, shownName, statusIs, useRun, type SectionProps } from './shared.ts';

const NO_ROLES: readonly RoleSummary[] = [];
const NO_MEMBERS: readonly MemberSummary[] = [];
const NO_ENTRIES: readonly OverwriteSummary[] = [];
const key = (kind: 0 | 1, targetId: string): string => `${String(kind)}:${targetId}`;
const text = (k: string, vars?: Record<string, string | number>): string => t(k as StringKey, vars);

/** The grid groups over the channel bits only: every right a channel overwrite can neither grant nor remove is left out. */
function channelGroups(disabledFor: (bit: number) => boolean): PermissionGridGroup[] {
  return PERM_GROUPS.map(group => ({
    id: group.id,
    title: text(`perm.group.${group.id}`),
    rows: group.keys.filter(k => (PERM_BY_KEY[k] & COMMUNITY_BITS) === 0).map(k => ({
      id: k, label: text(`perm.${k}`), hint: text(`perm.${k}.hint`), disabled: disabledFor(PERM_BY_KEY[k]),
      ...(disabledFor(PERM_BY_KEY[k]) ? { disabledHint: t('chperm.error.forbidden') } : {}),
    })),
  })).filter(group => group.rows.length > 0);
}

/** The copy of a refusal of an overwrite change. The instance decides every request again; this only words its answer. */
function refusalText(e: UiError): string {
  if (forbidden(e)) return t('chperm.error.forbidden');
  // The detail text is never read (protocol/02). Only the instance's own invalid-request refusal is its lockout rule; the
  // worker's E_BAD_INPUT means the page's overwrites could not be trusted.
  if (e.status === 400 && e.code === 'E_INVALID_REQUEST') return t('chperm.error.hidden');
  if (e.code === 'E_BAD_INPUT') return t('chperm.error.unread');
  if (statusIs(e, 404)) return t('chperm.error.gone');
  return t('chperm.error.other', { code: e.code });
}

interface Entry { key: string; kind: 0 | 1; targetId: string; name: string; member: boolean; allow: number; deny: number; rank: number; editable: boolean }

/**
 * A channel's own permissions (flow 09): the private switch and the roles and people that have settings of their own here.
 * The switch asks first (`setChannelPrivate`); each entry is a disclosure over a tri-state grid of the channel's rights
 * (`setOverwrite`). While the overwrites are not known the gate is shown as unknown and the switch is hidden, never read
 * as "public". Every gate here is advisory: the instance decides each request.
 */
export function ChannelPermissions({ channelId, communityId, announce }: { channelId: string; communityId: string; announce: SectionProps['announce'] }): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const account = useSlice('account');
  const communities = useSlice('communities');
  const channels = useSlice(`channels:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const roles = useSlice(`roles:${communityId}`) ?? NO_ROLES;
  const members = useSlice(`members:${communityId}`) ?? NO_MEMBERS;
  const byChannel = useSlice(`overwrites:${communityId}`);
  const entries = byChannel?.[channelId] ?? NO_ENTRIES;
  const [open, setOpen] = useState<string | null>(null);
  const [added, setAdded] = useState<{ kind: 0 | 1; targetId: string }[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [asking, setAsking] = useState<'private' | 'public' | null>(null);
  const [problem, setProblem] = useState<{ message: string; n: number } | null>(null);
  const confirm = useRun();
  const lastAsk = useRef<'private' | 'public'>('private');
  if (asking !== null) lastAsk.current = asking;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const toggleId = `${base}-private`;
  const focusEntry = useRef<string | null>(null);
  const entryButton = (k: string) => `${base}-entry-${k.replace(':', '-')}`;

  const community = communities?.find(c => c.id === communityId) ?? null;
  const channel = channels?.find(c => c.id === channelId) ?? null;
  const channelLabel = channel?.name ?? '';
  const me = account?.user?.id ?? null;
  const everyoneId = access?.everyoneId ?? '';
  const owner = access?.owner === true;
  const top = access?.top ?? 0;

  const myBits = useMemo(() => (me === null || community === null || everyoneId === '' ? null
    : channelBitsOf({ owner: community.owner, everyoneId, roles, members, overwrites: entries }, me)), [me, community, everyoneId, roles, members, entries]);

  const rows = useMemo((): Entry[] => {
    const has = new Set(entries.map(o => key(o.kind, o.targetId)));
    const all = [...entries, ...added.filter(a => !has.has(key(a.kind, a.targetId))).map((a): OverwriteSummary => ({ ...a, allow: 0, deny: 0 }))];
    const rank = new Map(roles.map(r => [r.id, r.position]));
    const topOfMember = (m: MemberSummary | undefined): number => (m === undefined ? 0 : Math.max(0, ...m.roleIds.map(id => rank.get(id) ?? 0)));
    const out = all.map((o): Entry => {
      if (o.kind === 0) {
        const r = roles.find(x => x.id === o.targetId);
        return { key: key(0, o.targetId), kind: 0, targetId: o.targetId, name: o.targetId === everyoneId ? t('chperm.everyone') : r?.name ?? o.targetId.slice(0, 8),
          member: false, allow: o.allow, deny: o.deny, rank: r?.position ?? 0, editable: owner || (r !== undefined && r.position < top) };
      }
      const m = members.find(x => x.userId === o.targetId);
      const mTop = topOfMember(m);
      return { key: key(1, o.targetId), kind: 1, targetId: o.targetId, name: m === undefined ? o.targetId.slice(0, 8) : shownName(m), member: true,
        allow: o.allow, deny: o.deny, rank: -1, editable: o.targetId !== community?.owner && (owner || mTop < top) };
    });
    // @everyone first, then roles by position (highest first), then members.
    return out.sort((a, b) => (a.targetId === everyoneId && a.kind === 0 ? -1 : b.targetId === everyoneId && b.kind === 0 ? 1 : 0)
      || b.rank - a.rank);
  }, [entries, added, roles, members, everyoneId, owner, top, community]);

  const options = useMemo(() => {
    const taken = new Set(rows.map(r => r.key));
    const roleOptions = roles.filter(r => !taken.has(key(0, r.id)) && (owner || r.position < top))
      .sort((a, b) => a.position - b.position).map(r => ({ value: key(0, r.id), label: r.id === everyoneId ? t('chperm.everyone') : r.name }));
    const topOf = (m: MemberSummary): number => Math.max(0, ...m.roleIds.map(id => roles.find(r => r.id === id)?.position ?? 0));
    const memberOptions = members.filter(m => !taken.has(key(1, m.userId)) && m.userId !== community?.owner && m.userId !== me && (owner || topOf(m) < top))
      .map(m => ({ value: key(1, m.userId), label: shownName(m) }));
    return [...roleOptions, ...memberOptions];
  }, [rows, roles, members, owner, top, everyoneId, community, me]);
  const picked = choice !== null && options.some(o => o.value === choice) ? choice : options[0]?.value ?? '';

  const fail = (e: UiError) => setProblem(p => ({ message: refusalText(e), n: (p?.n ?? 0) + 1 }));
  // One change at a time, in order; each reads the entry as it is when its turn comes.
  const save = (entry: Entry, bit: number, value: PermValue) => {
    setProblem(null);
    queue.current = queue.current.then(async () => {
      const now = client.get(`overwrites:${communityId}`)?.[channelId]?.find(o => o.kind === entry.kind && o.targetId === entry.targetId);
      const allow = value === 'allow' ? ((now?.allow ?? 0) | bit) : (now?.allow ?? 0) & ~bit;
      const deny = value === 'deny' ? ((now?.deny ?? 0) | bit) : (now?.deny ?? 0) & ~bit;
      try {
        await client.call({ m: 'setOverwrite', channelId, kind: entry.kind, targetId: entry.targetId, allow, deny });
        announce(t('chperm.saved', { name: channelLabel }));
      } catch (e) {
        fail(errorOf(e));
      }
    });
  };
  const remove = (entry: Entry) => {
    setProblem(null);
    queue.current = queue.current.then(async () => {
      try {
        await client.call({ m: 'setOverwrite', channelId, kind: entry.kind, targetId: entry.targetId, allow: 0, deny: 0 });
        setAdded(a => a.filter(x => key(x.kind, x.targetId) !== entry.key));
        setOpen(o => (o === entry.key ? null : o));
        announce(t('chperm.saved', { name: channelLabel }));
        headingRef.current?.focus();
      } catch (e) {
        fail(errorOf(e));
      }
    });
  };
  const add = () => {
    const [k, ...rest] = picked.split(':');
    if (rest.length === 0) return;
    const entry = { kind: k === '1' ? 1 as const : 0 as const, targetId: rest.join(':') };
    setAdded(a => [...a, entry]);
    setOpen(key(entry.kind, entry.targetId));
    focusEntry.current = key(entry.kind, entry.targetId);
    setChoice(null);
  };

  useEffect(() => {
    if (focusEntry.current === null) return;
    document.getElementById(entryButton(focusEntry.current))?.focus();
    focusEntry.current = null;
  });

  const closeAsk = () => {
    if (confirm.busy) return;
    confirm.reset();
    setAsking(null);
    document.getElementById(toggleId)?.focus();
  };
  const ask = lastAsk.current;
  const confirmAsk = () => {
    if (asking === null) return;
    const makePrivate = asking === 'private';
    void confirm.run(() => client.call({ m: 'setChannelPrivate', channelId, private: makePrivate }), refusalText)
      .then(ok => { if (ok) { announce(t('chperm.saved', { name: channelLabel })); setAsking(null); document.getElementById(toggleId)?.focus(); } });
  };

  // Unknown is never read as public or as "none": missing data shows a loading line, a failed overwrites read says so.
  if (access === undefined || !access.loaded || !access.overwritesLoaded || byChannel === undefined) {
    const failed = access !== undefined && access.loaded && !access.overwritesLoaded;
    return (
      <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
        <h3 id={`${base}-title`}>{t('chperm.title')}</h3>
        <p role="status">{failed ? t('chperm.error.unread') : t('roles.loading')}</p>
      </section>
    );
  }
  const privateNow = isPrivate(entries, everyoneId);
  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h3 id={`${base}-title`}>{t('chperm.title')}</h3>
      <Toggle id={toggleId} label={t('chperm.private')} showLabel hint={t('chperm.privateHint')} checked={privateNow}
        onChange={on => { confirm.reset(); setAsking(on ? 'private' : 'public'); }} />
      <h4 id={`${base}-who`} ref={headingRef} tabIndex={-1} className="dw-admin-name">{t('chperm.who')}</h4>
      {rows.length === 0 ? <p>{t('chperm.none')}</p> : (
        <ul aria-label={t('chperm.who')} className="dw-admin-rows">
          {rows.map(entry => {
            const panel = `${base}-${entry.key.replace(':', '-')}`;
            const shown = open === entry.key;
            const values: Record<string, PermValue> = {};
            for (const group of PERM_GROUPS) for (const k of group.keys) {
              const bit = PERM_BY_KEY[k];
              values[k] = (entry.allow & bit) !== 0 ? 'allow' : (entry.deny & bit) !== 0 ? 'deny' : 'inherit';
            }
            const groups = channelGroups(bit => !entry.editable || (myBits !== null && (myBits & bit) === 0));
            return (
              <li key={entry.key} className="dw-admin-group">
                <div className="dw-admin-row">
                  <Button variant="ghost" id={entryButton(entry.key)} aria-expanded={shown} aria-controls={panel} onClick={() => setOpen(shown ? null : entry.key)}>
                    {entry.name}{entry.member ? <> <span>{t('chperm.member')}</span></> : null}
                  </Button>
                  {entry.kind === 0 && entry.targetId === everyoneId ? null : (
                    <Button variant="ghost" aria-label={t('chperm.removeLabel', { name: entry.name })} disabled={!entry.editable}
                      onClick={() => remove(entry)}>{t('chperm.remove')}</Button>
                  )}
                </div>
                {shown ? (
                  <div id={panel}>
                    <PermissionGrid label={entry.name} groups={groups} mode="tri" values={values}
                      labels={{ allow: t('perm.allow'), inherit: t('perm.inherit'), deny: t('perm.deny') }}
                      onChange={(id, v) => save(entry, PERM_BY_KEY[id as keyof typeof PERM_BY_KEY], v)} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {options.length > 0 ? (
        <div className="dw-admin-row">
          <Select label={t('chperm.addLabel')} value={picked} options={options} onChange={setChoice} />
          <Button variant="ghost" onClick={add}>{t('chperm.add')}</Button>
        </div>
      ) : null}
      {problem !== null ? <p key={problem.n} role="alert" className="dw-admin-error">{problem.message}</p> : null}
      <ConfirmDialog open={asking !== null}
        title={ask === 'private' ? t('chperm.makePrivate.title', { name: channelLabel }) : t('chperm.makePublic.title', { name: channelLabel })}
        body={ask === 'private' ? t('chperm.makePrivate.body') : t('chperm.makePublic.body', { server: community?.name ?? '' })}
        confirmLabel={ask === 'private' ? t('chperm.makePrivate.confirm') : t('chperm.makePublic.confirm')} busyLabel={t('chperm.busy')}
        cancelLabel={t('chperm.cancel')} tone="accent" busy={confirm.busy} error={confirm.error} attempt={confirm.attempt}
        onConfirm={confirmAsk} onClose={closeAsk} />
    </section>
  );
}
