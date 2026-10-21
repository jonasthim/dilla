import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BIO_MAX_CHARS, DISPLAY_MAX_CHARS, STATUS_MAX_CHARS, profileTextProblem, profileTextValue, type ProfileTextProblem } from '@dilla/client-core';
import { Banner, Button, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';

const TITLE_ID = 'profile-title';
const PROBLEM: Record<ProfileTextProblem, StringKey> = { chars: 'profile.error.chars', long: 'profile.error.long', blank: 'profile.error.blank' };

interface Fields { display: string; statusMsg: string; bio: string }
const same = (a: Fields, b: Fields) => a.display === b.display && a.statusMsg === b.statusMsg && a.bio === b.bio;

/**
 * Settings → Profile (EOD E6): the display name, a one-line status message and a bio. The server stores them readable, and
 * the section says so. Save sends only the fields that changed ('' clears one), trimmed; a text the server would refuse is
 * named next to its field as it is typed, so a refusal never reads "try again". The worker puts the saved text on the account and
 * the member rows. A field changed on another device replaces the form's copy while nothing here has been edited.
 */
export function Profile(): React.JSX.Element {
  const client = useCore();
  const user = useSlice('account')?.user ?? null;
  const saved: Fields = { display: user?.display ?? user?.username ?? '', statusMsg: user?.statusMsg ?? '', bio: user?.bio ?? '' };
  const [fields, setFields] = useState<Fields>(saved);
  // What the last successful save wrote: the baseline until the account slice says the same.
  const [sent, setSent] = useState<Fields | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<'save' | 'text' | 'wait' | null>(null);
  const [done, setDone] = useState(false);
  const [displayError, setDisplayError] = useState(false);
  const baseline = sent ?? saved;

  // The account moved under the form (another device, or this save landing): follow it unless it is being edited.
  const previous = useRef(saved);
  useEffect(() => {
    const before = previous.current;
    previous.current = saved;
    if (same(before, saved)) return;
    setSent(null);
    // Each field follows the account unless it is being edited: a field still equal to the old stored value is replaced.
    setFields(current => ({
      display: current.display === before.display ? saved.display : current.display,
      statusMsg: current.statusMsg === before.statusMsg ? saved.statusMsg : current.statusMsg,
      bio: current.bio === before.bio ? saved.bio : current.bio,
    }));
  }, [saved.display, saved.statusMsg, saved.bio]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Partial<Fields>) => { setFields(current => ({ ...current, ...patch })); setDone(false); setFailed(null); setDisplayError(false); };
  const next: Fields = { display: profileTextValue(fields.display), statusMsg: profileTextValue(fields.statusMsg), bio: profileTextValue(fields.bio, true) };
  const changed = {
    ...(next.display !== baseline.display ? { display: next.display } : {}),
    ...(next.statusMsg !== baseline.statusMsg ? { statusMsg: next.statusMsg } : {}),
    ...(next.bio !== baseline.bio ? { bio: next.bio } : {}),
  };
  // Only a field that was changed is checked: a stored value that fails today's rule (it was kept from before) never blocks the others.
  const problem = {
    display: fields.display !== baseline.display ? profileTextProblem(fields.display, DISPLAY_MAX_CHARS) : null,
    statusMsg: fields.statusMsg !== baseline.statusMsg ? profileTextProblem(fields.statusMsg, STATUS_MAX_CHARS) : null,
    bio: fields.bio !== baseline.bio ? profileTextProblem(fields.bio, BIO_MAX_CHARS, true) : null,
  };
  const invalid = problem.display !== null || problem.statusMsg !== null || problem.bio !== null;
  const text = (p: ProfileTextProblem | null) => (p === null ? undefined : t(PROBLEM[p]));
  const dirty = Object.keys(changed).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending || !dirty || invalid) return;
    if (next.display === '') { setDisplayError(true); return; }
    setPending(true);
    setFailed(null);
    client.call({ m: 'updateProfile', ...changed }).then(() => { setSent(next); setDone(true); }).catch((e: unknown) => {
      const code = errorOf(e).code;
      setFailed(code === 'E_INVALID_REQUEST' || code === 'E_BAD_INPUT' ? 'text' : code === 'E_RATE_LIMITED' ? 'wait' : 'save');
    }).finally(() => { setPending(false); });
  };

  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID} tabIndex={-1}>{t('profile.title')}</h2>
      <p>{t('profile.body')}</p>
      {failed === null ? null : <Banner tone="danger">{t(failed === 'text' ? 'profile.error.chars' : failed === 'wait' ? 'profile.error.wait' : 'profile.error.save')}</Banner>}
      <form className="dw-profile-form" onSubmit={submit} noValidate>
        <TextField id="profile-display" label={t('profile.display.label')} value={fields.display} onChange={display => { edit({ display }); }}
          maxLength={DISPLAY_MAX_CHARS} required autoComplete="nickname" error={text(problem.display) ?? (displayError ? t('profile.error.display') : undefined)} />
        <TextField id="profile-status" label={t('profile.status.label')} value={fields.statusMsg} onChange={statusMsg => { edit({ statusMsg: statusMsg.replace(/[\r\n]+/g, ' ') }); }}
          maxLength={STATUS_MAX_CHARS} hint={t('profile.status.hint')} error={text(problem.statusMsg)} />
        <TextField id="profile-bio" label={t('profile.bio.label')} value={fields.bio} onChange={bio => { edit({ bio }); }}
          maxLength={BIO_MAX_CHARS} multiline rows={5} hint={t('profile.bio.hint')} error={text(problem.bio)} />
        <div className="dw-profile-form__actions">
          <Button type="submit" disabled={!dirty || pending || invalid}>{t('profile.save')}</Button>
          <p role="status" className="dw-profile-form__saved">{done && !dirty ? t('profile.saved') : ''}</p>
        </div>
      </form>
    </section>
  );
}
