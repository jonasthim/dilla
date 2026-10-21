import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Banner, Button, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';

const TITLE_ID = 'profile-title';
// The limits the server enforces (internal/auth/profile_text.go), in characters.
const DISPLAY_MAX = 64;
const STATUS_MAX = 190;
const BIO_MAX = 500;

interface Fields { display: string; statusMsg: string; bio: string }

/**
 * Settings → Profile (EOD E6): the display name, a one-line status message and a bio. The server stores them readable, and
 * the section says so. Save sends only the fields that changed ('' clears one); the worker reads the account and the member
 * lists again, so the new profile is on the card at once. A field changed on another device replaces the form's copy while
 * nothing here has been edited.
 */
export function Profile(): React.JSX.Element {
  const client = useCore();
  const user = useSlice('account')?.user ?? null;
  const saved: Fields = { display: user?.display ?? user?.username ?? '', statusMsg: user?.statusMsg ?? '', bio: user?.bio ?? '' };
  const [fields, setFields] = useState<Fields>(saved);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [displayError, setDisplayError] = useState(false);

  // The account moved under the form (another device, or this save landing): follow it unless it is being edited.
  const previous = useRef(saved);
  useEffect(() => {
    const before = previous.current;
    previous.current = saved;
    if (before.display === saved.display && before.statusMsg === saved.statusMsg && before.bio === saved.bio) return;
    setFields(current => (current.display === before.display && current.statusMsg === before.statusMsg && current.bio === before.bio ? saved : current));
  }, [saved.display, saved.statusMsg, saved.bio]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Partial<Fields>) => { setFields(current => ({ ...current, ...patch })); setDone(false); setFailed(false); setDisplayError(false); };
  const changed = {
    ...(fields.display.trim() !== saved.display ? { display: fields.display.trim() } : {}),
    ...(fields.statusMsg !== saved.statusMsg ? { statusMsg: fields.statusMsg } : {}),
    ...(fields.bio !== saved.bio ? { bio: fields.bio } : {}),
  };
  const dirty = Object.keys(changed).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending || !dirty) return;
    if (fields.display.trim() === '') { setDisplayError(true); return; }
    setPending(true);
    setFailed(false);
    client.call({ m: 'updateProfile', ...changed }).then(() => { setDone(true); }).catch(() => { setFailed(true); }).finally(() => { setPending(false); });
  };

  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID} tabIndex={-1}>{t('profile.title')}</h2>
      <p>{t('profile.body')}</p>
      {failed ? <Banner tone="danger">{t('profile.error.save')}</Banner> : null}
      <form className="dw-profile-form" onSubmit={submit} noValidate>
        <TextField id="profile-display" label={t('profile.display.label')} value={fields.display} onChange={display => { edit({ display }); }}
          maxLength={DISPLAY_MAX} required autoComplete="nickname" error={displayError ? t('profile.error.display') : undefined} />
        <TextField id="profile-status" label={t('profile.status.label')} value={fields.statusMsg} onChange={statusMsg => { edit({ statusMsg: statusMsg.replace(/[\r\n]+/g, ' ') }); }}
          maxLength={STATUS_MAX} hint={t('profile.status.hint')} />
        <TextField id="profile-bio" label={t('profile.bio.label')} value={fields.bio} onChange={bio => { edit({ bio }); }}
          maxLength={BIO_MAX} multiline rows={5} hint={t('profile.bio.hint')} />
        <div className="dw-profile-form__actions">
          <Button type="submit" disabled={!dirty || pending}>{t('profile.save')}</Button>
          <p role="status" className="dw-profile-form__saved">{done ? t('profile.saved') : ''}</p>
        </div>
      </form>
    </section>
  );
}
