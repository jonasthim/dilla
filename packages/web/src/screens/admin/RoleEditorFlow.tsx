// Flow 09: make or edit one role. A Dialog (mounted while it is open) over TextField, ColorSwatches, two Toggles and the
// PermissionGrid; the dialog's close hands focus back to whatever opened it.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, ColorSwatches, Dialog, PermissionGrid, TextField, Toggle, type PermValue } from '@dilla/ui';
import { PERM_BY_KEY, PERM_GROUPS, resolveCommunity, type PermKey, type RoleSummary } from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import type { UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { paletteFor } from './role-palette.ts';
import { forbidden, refused, statusIs, useRun, type Announce } from './shared.ts';

export const ROLE_NAME_MAX_BYTES = 100;
const UTF8 = new TextEncoder();
/** Every one of the 24 bits (the owner's and an administrator's). */
const ALL_BITS = 0xFFFFFF;

export interface RoleEditorFlowProps {
  communityId: string;
  /** The role to edit, or null to make a new one. */
  roleId: string | null;
  onClose: () => void;
  announce: Announce;
}

/** The bits `me` holds community-wide: everything for the owner and administrators, else the resolver's answer. */
function heldBits(args: { owner: boolean; ownerId: string; everyoneId: string; roles: readonly RoleSummary[]; held: readonly string[]; me: string }): number {
  if (args.owner) return ALL_BITS;
  return resolveCommunity({ owner: args.ownerId, everyoneId: args.everyoneId, roles: args.roles, held: args.held }, args.me);
}

const keyBits = (values: Readonly<Record<string, PermValue>>): number =>
  (Object.keys(PERM_BY_KEY) as PermKey[]).reduce((bits, k) => (values[k] === 'allow' ? bits | PERM_BY_KEY[k] : bits), 0);
const valuesOf = (allow: number): Record<string, PermValue> =>
  Object.fromEntries((Object.keys(PERM_BY_KEY) as PermKey[]).map(k => [k, (allow & PERM_BY_KEY[k]) !== 0 ? 'allow' : 'inherit']));

export function RoleEditorFlow({ communityId, roleId, onClose, announce }: RoleEditorFlowProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const members = useSlice(`members:${communityId}`);
  const account = useSlice('account');
  const community = useSlice('communities')?.find(c => c.id === communityId);
  const role = roleId === null ? undefined : roles?.find(r => r.id === roleId);
  const everyoneId = access?.everyoneId ?? '';
  const isEveryone = roleId !== null && roleId === everyoneId;

  const [name, setName] = useState(role?.name ?? '');
  const [color, setColor] = useState(role?.color ?? 0);
  const [hoist, setHoist] = useState(role?.hoist ?? false);
  const [mentionable, setMentionable] = useState(role?.mentionable ?? false);
  const [values, setValues] = useState<Record<string, PermValue>>(() => valuesOf(role?.allow ?? 0));
  const [problem, setProblem] = useState<{ message: string; n: number } | null>(null);
  const action = useRun();

  // A role deleted elsewhere while it is being edited closes the editor.
  const gone = roleId !== null && roles !== undefined && role === undefined;
  useEffect(() => { if (gone) onClose(); }, [gone, onClose]);

  const me = account?.user?.id ?? '';
  const held = members?.find(m => m.userId === me)?.roleIds ?? [];
  const mine = heldBits({ owner: access?.owner === true, ownerId: community?.owner ?? '', everyoneId, roles: roles ?? [], held, me });

  const close = () => { if (!action.busy) onClose(); };
  const fail = (message: string) => setProblem(p => ({ message, n: (p?.n ?? 0) + 1 }));
  const edit = (change: () => void) => { change(); setProblem(null); action.reset(); };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action.busy) return;
    const shown = name.normalize('NFC').trim();
    if (!isEveryone) {
      if (shown === '') { fail(t('roles.error.empty')); return; }
      if (UTF8.encode(shown).length > ROLE_NAME_MAX_BYTES) { fail(t('roles.error.long')); return; }
    }
    setProblem(null);
    const allow = keyBits(values);
    // protocol/02 (and copy.test.ts) forbid reading a refusal's detail text, so "250 roles" cannot be told from the detail:
    // a create the instance refuses as invalid, after the name checks above, can only be the full server.
    const refuse = (e: UiError): string =>
      forbidden(e) ? t('roles.error.forbidden')
        : statusIs(e, 409) ? t('roles.error.conflict')
          : role === undefined && (statusIs(e, 400) || refused(e)) ? t('roles.error.full')
            : statusIs(e, 404) ? t('roles.error.gone')
              : t('roles.error.other', { code: e.code });
    if (role === undefined) {
      void action.run(() => client.call({ m: 'createRole', communityId, name: shown, color, hoist, mentionable, allow }), refuse)
        .then(ok => { if (ok) { announce(t('roles.editor.created', { name: shown })); onClose(); } });
      return;
    }
    const changed = {
      name: !isEveryone && shown !== role.name ? shown : null,
      color: !isEveryone && color !== role.color ? color : null,
      hoist: !isEveryone && hoist !== role.hoist ? hoist : null,
      mentionable: !isEveryone && mentionable !== role.mentionable ? mentionable : null,
      allow: allow !== role.allow ? allow : null,
    };
    if (Object.values(changed).every(v => v === null)) { onClose(); return; }
    void action.run(() => client.call({ m: 'updateRole', communityId, roleId: role.id, ...changed }), refuse)
      .then(ok => { if (ok) { announce(t('roles.editor.saved', { name: isEveryone ? role.name : shown })); onClose(); } });
  };

  const title = role === undefined ? t('roles.editor.titleNew', { server: community?.name ?? '' }) : t('roles.editor.titleEdit', { name: role.name });
  const nameError = problem?.message ?? undefined;
  const formId = `${base}-form`;
  const groups = PERM_GROUPS.map(g => ({
    id: g.id, title: t(`perm.group.${g.id}` as StringKey),
    rows: g.keys.map(k => {
      const lacking = (mine & PERM_BY_KEY[k]) === 0;
      return { id: k, label: t(`perm.${k}` as StringKey), hint: t(`perm.${k}.hint` as StringKey), disabled: lacking,
        ...(lacking ? { disabledHint: t('roles.editor.notHeld') } : {}) };
    }),
  }));
  const busyAttr = action.busy || undefined;

  return (
    <Dialog open title={title} closeLabel={t('roles.editor.cancel')} onClose={close}
      footer={<Button variant="accent" type="submit" form={formId} aria-disabled={busyAttr}>
        {role === undefined ? t(action.busy ? 'roles.editor.creating' : 'roles.editor.create') : t(action.busy ? 'roles.editor.saving' : 'roles.editor.save')}
      </Button>}>
      <form id={formId} className="dw-role-form" noValidate onSubmit={submit}>
        <RoleName id={`${base}-name`} value={name} readOnly={isEveryone} error={nameError} attempt={problem?.n ?? 0}
          onChange={v => edit(() => setName(v))} />
        {isEveryone ? null : <>
          <ColorSwatches label={t('roles.editor.color')} hint={t('roles.editor.colorHint')} value={color} options={paletteFor(role?.color ?? 0)}
            noneLabel={t('roles.color.none')} onChange={v => edit(() => setColor(v))} />
          <Toggle id={`${base}-hoist`} label={t('roles.editor.hoist')} showLabel checked={hoist} onChange={v => edit(() => setHoist(v))} />
          <Toggle id={`${base}-mention`} label={t('roles.editor.mentionable')} showLabel hint={t('roles.editor.mentionableHint')} checked={mentionable}
            onChange={v => edit(() => setMentionable(v))} />
        </>}
        <PermissionGrid label={t('roles.editor.permissions')} groups={groups} mode="toggle" values={values}
          labels={{ allow: t('perm.allow'), inherit: t('perm.inherit'), deny: t('perm.deny') }}
          onChange={(id, v) => edit(() => setValues(s => ({ ...s, [id]: v })))} />
        {action.error !== null ? <p key={action.attempt} role="alert" className="dw-admin-error">{action.error}</p> : null}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
        <p className="d-sr-only" role="status">{action.busy ? t(role === undefined ? 'roles.editor.creating' : 'roles.editor.saving') : ''}</p>
      </form>
    </Dialog>
  );
}

/** The name field (disabled for @everyone, whose name is fixed): focus starts here, and a refusal of the name puts it back here. */
function RoleName({ id, value, readOnly, error, attempt, onChange }: {
  id: string; value: string; readOnly: boolean; error: string | undefined; attempt: number; onChange: (v: string) => void;
}): React.JSX.Element {
  useEffect(() => { document.getElementById(id)?.focus(); }, [id]);
  useEffect(() => { if (error !== undefined) document.getElementById(id)?.focus(); }, [id, error, attempt]);
  return (
    <TextField id={id} label={t('roles.editor.name')} value={value} hint={t('roles.editor.nameHint')} error={error}
      onChange={onChange} required={!readOnly} disabled={readOnly} autoComplete="off" spellCheck={false} />
  );
}
