import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, TextField } from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { extractInviteCode } from '../invite.ts';
import { t } from '../strings/index.ts';

const COMMUNITY_ID = /^[0-9a-f]{32}$/;
const FIELD_ID = 'join-invite';

/** The field's error for a refused join: by code only, never by the server's detail text (protocol/02). */
function refusalText(e: UiError): string {
  switch (e.code) {
    case 'E_INVITE_INVALID': return t('join.error.invalid');
    case 'E_INVITE_NOT_COMMUNITY': return t('join.error.notCommunity');
    case 'E_FORBIDDEN': return t('join.error.forbidden');
    case 'E_INVALID_REQUEST': return t('join.error.malformed');
    default: return t('join.error.other', { code: e.code });
  }
}

/** The server id a joinCommunity call resolved with, or null when the answer is not { communityId: <32 hex> }. */
function joinedId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { communityId } = value as Record<string, unknown>;
  return typeof communityId === 'string' && COMMUNITY_ID.test(communityId) ? communityId : null;
}

/**
 * The join dialog: one invite field (a code or a pasted link) in one form, whose submit sends
 * joinCommunity. `initialInvite` fills the field and `initialError` (a join refused right after
 * signup, pre-flight ruling (g)) is shown each time the dialog opens; closing it forgets both.
 */
export function JoinCommunity(props: {
  open: boolean; onClose(): void; onJoined(communityId: string): void; initialInvite?: string; initialError?: UiError;
}): React.JSX.Element {
  const { open, initialInvite, initialError } = props;
  const client = useCore();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Typing changes `value`, which is not a dependency: an open dialog never overwrites what was typed.
  useEffect(() => {
    if (open) {
      setValue(initialInvite ?? '');
      setError(initialError === undefined ? null : refusalText(initialError));
    } else {
      setValue('');
      setError(null);
      setBusy(false);
    }
  }, [open, initialInvite, initialError]);

  const showError = (text: string) => {
    setError(text);
    // A submit that leaves the field in error puts focus on it (Global Constraints, forms).
    document.getElementById(FIELD_ID)?.focus();
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const code = extractInviteCode(value);
    if (code === '') { showError(t('join.error.empty')); return; }
    setBusy(true);
    const run = async () => {
      try {
        const id = joinedId(await client.call({ m: 'joinCommunity', invite: code }));
        setBusy(false);
        if (id === null) { showError(t('join.error.other', { code: 'E_BAD_RESULT' })); return; }
        setValue('');
        setError(null);
        props.onJoined(id);
      } catch (rejection) {
        setBusy(false);
        showError(refusalText(errorOf(rejection)));
      }
    };
    void run();
  };

  return (
    <Dialog open={open} title={t('join.title')} closeLabel={t('dialog.close')} onClose={() => props.onClose()}
      footer={<Button variant="accent" type="submit" form="join-form" disabled={busy}>{busy ? t('join.joining') : t('join.submit')}</Button>}>
      <form id="join-form" noValidate onSubmit={submit}>
        <TextField id={FIELD_ID} label={t('join.invite')} value={value} onChange={v => { setValue(v); setError(null); }}
          hint={t('join.inviteHint')} error={error ?? undefined} required autoComplete="off" spellCheck={false} />
      </form>
    </Dialog>
  );
}
