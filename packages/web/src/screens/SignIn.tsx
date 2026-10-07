import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { normaliseRecoveryKey } from '@dilla/client-core';
import { Banner, Button, OnboardingFrame, RecoveryKeyField, Splash, TextField } from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { useSlice } from '../core/use-slice.ts';
import { t, type StringKey } from '../strings/index.ts';

const KEY_LENGTH = 52;
type Field = 'username' | 'password' | 'code' | 'key';
type SignInCommand = 'login' | 'totp' | 'key';
type Shown = 'login' | 'totp' | 'key' | 'noBackup' | 'done';
const FIELD_ID: Readonly<Record<Field, string>> = {
  username: 'signin-username', password: 'signin-password', code: 'signin-code', key: 'signin-key',
};
const FIELD_ORDER: readonly Field[] = ['username', 'password', 'code', 'key'];
const LENGTH_ID = 'signin-key-length';

interface BannerState { tone: 'warn' | 'danger'; key: StringKey; vars: Record<string, string | number> }
interface RefusalView { field?: Field; fieldKey?: StringKey; focus?: Field; banner?: BannerState; noBackup?: true }

/**
 * The refusal table of flow 03 (L-COPY-02 as task 15 froze it), first match wins. It reads the code, the HTTP
 * status and the wait, and never the server's detail text (protocol/02: a client must not parse it). The step a
 * refusal shows on is the one `account.phase` names afterwards, never the command's (head ruling 39).
 */
function signInRefusal(e: UiError, command: SignInCommand, instance: string): RefusalView {
  if (e.code === 'E_NO_BACKUP') {
    // From the fetch after the login the account has no recovery data; from signInKey its backup state is
    // missing or unreadable (task 14's ruling (e)).
    const key: StringKey = command === 'key' ? 'signin.error.noBackupState' : 'signin.error.noBackup';
    return { noBackup: true, banner: { tone: 'danger', key, vars: { instance } } };
  }
  if (e.code === 'E_RECOVERY_KEY') return { field: 'key', fieldKey: 'signin.error.wrongKey' };
  if ((e.code === 'E_UNAUTHENTICATED' || e.code === 'E_NO_ASSERTION') && command === 'totp') {
    // The worker moved the phase to signin-login: the assertion is spent and the person logs in again.
    return { banner: { tone: 'warn', key: 'signin.error.totpFailed', vars: {} }, focus: 'password' };
  }
  if (e.code === 'E_UNAUTHENTICATED' && command === 'login') {
    return { field: 'password', fieldKey: 'signin.error.loginFailed', focus: 'password' };
  }
  // REGISTRATION-DEVICES-02: the registration runs inside signInKey, after the key's form passed; its 403 is the cap.
  if (e.code === 'E_FORBIDDEN') {
    return { banner: { tone: 'danger', key: 'signin.error.deviceCap', vars: { instance } } };
  }
  // The row this browser registered was replaced before its list PUT; the worker dropped the enrolment (step 1).
  if (e.code === 'E_SIGNIN_EVICTED') return { banner: { tone: 'danger', key: 'signin.error.evicted', vars: {} } };
  if (e.code === 'E_RATE_LIMITED') {
    return {
      banner: e.retryAfterMs !== null
        ? { tone: 'warn', key: 'signin.error.tooMany', vars: { seconds: Math.ceil(e.retryAfterMs / 1000) } }
        : { tone: 'warn', key: 'onboarding.error.rateLimitedNoWait', vars: {} },
    };
  }
  if (e.code === 'E_NETWORK' || e.status >= 500) return { banner: { tone: 'danger', key: 'signin.error.network', vars: {} } };
  return { banner: { tone: 'danger', key: 'signin.error.other', vars: { code: e.code } } };
}

/** The four-step sign-in ceremony of L-COPY-02. Rendered by App for the phases signin-login, signin-totp,
 *  signin-key and enrolling, and kept mounted after the phase turns ready until its done step calls onFinish. */
export function SignIn(props: { onFinish(): void }): React.JSX.Element {
  const client = useCore();
  const account = useSlice('account');
  const [username, setUsername] = useState(() => account?.signIn?.username ?? '');
  // The password stays in page memory no longer than the call (Global Constraints "Never written").
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, StringKey>>>({});
  const [banner, setBanner] = useState<BannerState | null>(null);
  // The no-backup view's banner after a refusal of this mount; null otherwise.
  const [noBackup, setNoBackup] = useState<StringKey | null>(null);
  const [busy, setBusy] = useState<SignInCommand | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: 'heading' | Field; n: number }>({ target: 'heading', n: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  const phase = account?.phase;
  const instance = account?.instance ?? null;
  const enrolling = phase === 'enrolling';
  const blocked = busy !== null || enrolling;
  // Requirement 10: a reload in the ceremony meets E_NO_BACKUP only through the slice. No other code is read there.
  const noBackupKey: StringKey | null = phase !== 'signin-key' ? null
    : noBackup ?? (busy === null && account?.error?.code === 'E_NO_BACKUP' ? 'signin.error.noBackup' : null);
  const shown: Shown = phase === 'ready' ? 'done'
    : noBackupKey !== null ? 'noBackup'
      : phase === 'signin-totp' ? 'totp'
        : phase === 'signin-key' || enrolling ? 'key'
          : 'login';

  // A cancel and a fresh ceremony start clean.
  useEffect(() => { if (phase !== 'signin-key') setNoBackup(null); }, [phase]);

  // OnboardingFrame focuses its heading when the title changes; this effect runs after the frame's (child effects
  // first), so a field request after a step change lands on the field.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (focusRequest.target === 'heading') root.querySelector('h1')?.focus();
    else root.querySelector<HTMLElement>(`#${FIELD_ID[focusRequest.target]}`)?.focus();
  }, [shown, focusRequest]);

  if (account === undefined || instance === null) return <Splash status={t('boot.loading.status')} />;
  const name = instance.name;

  const requestFocus = (target: 'heading' | Field) => setFocusRequest(f => ({ target, n: f.n + 1 }));
  const change = (field: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors(e => {
      if (e[field] === undefined) return e;
      const rest = { ...e };
      delete rest[field];
      return rest;
    });
  };
  const showErrors = (next: Partial<Record<Field, StringKey>>): boolean => {
    setErrors(next);
    const first = FIELD_ORDER.find(f => next[f] !== undefined);
    if (first === undefined) return false;
    requestFocus(first);
    return true;
  };
  const apply = (e: UiError, command: SignInCommand) => {
    const view = signInRefusal(e, command, name);
    if (view.noBackup && view.banner) setNoBackup(view.banner.key);
    if (view.field && view.fieldKey) {
      setErrors({ [view.field]: view.fieldKey });
      requestFocus(view.field);
    }
    if (view.focus) {
      if (view.focus === 'password') setPassword('');
      requestFocus(view.focus);
    }
    setBanner(view.noBackup ? null : view.banner ?? null);
  };
  const run = (command: SignInCommand, call: Promise<unknown>, done: () => void) => {
    void call
      .then(done, (e: unknown) => { apply(errorOf(e), command); })
      .finally(() => setBusy(null));
  };

  const submitLogin = () => {
    const next: Partial<Record<Field, StringKey>> = {};
    if (username.trim() === '') next.username = 'signin.error.required';
    if (password === '') next.password = 'signin.error.required';
    if (showErrors(next)) return;
    setBusy('login');
    run('login', client.call({ m: 'signInLogin', username: username.trim().toLowerCase(), password }), () => setPassword(''));
  };
  const submitTotp = () => {
    const trimmed = code.trim();
    if (showErrors(trimmed === '' ? { code: 'signin.error.required' } : {})) return;
    setBusy('totp');
    run('totp', client.call({ m: 'signInTotp', code: trimmed }), () => {});
  };
  const submitKey = () => {
    // The page counts only; Rust normalises and judges the raw text (L-CORE-26 step 1).
    if (normaliseRecoveryKey(key).length !== KEY_LENGTH) {
      showErrors({ key: 'signin.error.keyLength' });
      return;
    }
    setBusy('key');
    run('key', client.call({ m: 'signInKey', recoveryKey: key }), () => setKey(''));
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (blocked) return;
    setBanner(null);
    setErrors({});
    switch (shown) {
      case 'login': submitLogin(); break;
      case 'totp': submitTotp(); break;
      case 'key': submitKey(); break;
      default: break;
    }
  };
  const cancel = () => {
    if (blocked) return;
    client.call({ m: 'signInCancel' }).catch((e: unknown) => { apply(errorOf(e), 'login'); });
  };

  const stepLabel = (n: number) => t('signin.step', { n });
  const errorText = (field: Field) => {
    const k = errors[field];
    return k === undefined ? undefined : t(k);
  };
  // A blocked button stays focusable (aria-disabled, never the native attribute): the person who pressed it
  // keeps focus there while the step works.
  const blockedProps = blocked ? { 'aria-disabled': true } : {};
  const cancelButton = (label: StringKey) => (
    <Button variant="ghost" type="button" onClick={cancel} {...blockedProps}>{t(label)}</Button>
  );
  const bannerEl = banner === null ? null : <Banner tone={banner.tone}>{t(banner.key, banner.vars)}</Banner>;
  const form = (title: string, n: number, foot: ReactNode, children: ReactNode) => (
    <form noValidate onSubmit={onSubmit}>
      <OnboardingFrame title={title} stepLabel={stepLabel(n)} footer={foot}>
        {bannerEl}
        {children}
      </OnboardingFrame>
    </form>
  );

  let content: React.JSX.Element;
  if (shown === 'done') {
    const who = account.user?.username ?? account.signIn?.username ?? username.trim().toLowerCase();
    content = (
      <OnboardingFrame title={t('signin.done.title')} stepLabel={stepLabel(4)}
        footer={<Button variant="accent" type="button" onClick={() => props.onFinish()}>{t('signin.done.next')}</Button>}>
        <p>{t('signin.done.body', { username: who, instance: name })}</p>
      </OnboardingFrame>
    );
  } else if (shown === 'noBackup' && noBackupKey !== null) {
    content = (
      <OnboardingFrame title={t('signin.key.title')} stepLabel={stepLabel(3)} footer={cancelButton('signin.cancel')}>
        <Banner tone="danger">{t(noBackupKey, { instance: name })}</Banner>
      </OnboardingFrame>
    );
  } else if (shown === 'totp') {
    content = form(t('signin.totp.title'), 2, <>
      {cancelButton('signin.cancel')}
      <Button variant="accent" type="submit" {...blockedProps}>{t(busy === 'totp' ? 'signin.login.working' : 'signin.login.submit')}</Button>
    </>, <>
      <p>{t('signin.totp.body')}</p>
      <TextField id={FIELD_ID.code} label={t('signin.totp.code')} value={code} onChange={change('code', setCode)}
        error={errorText('code')} required inputMode="numeric" autoComplete="one-time-code" spellCheck={false} maxLength={6} />
    </>);
  } else if (shown === 'key') {
    const n = normaliseRecoveryKey(key).length;
    const short = n !== KEY_LENGTH;
    const working = busy === 'key' || enrolling;
    // The text cannot change under a running enrolment.
    const onKey = change('key', setKey);
    content = form(t('signin.key.title'), 3, <>
      {cancelButton('signin.cancel')}
      <Button variant="accent" type="submit" {...(short || blocked ? { 'aria-disabled': true } : {})}
        aria-describedby={short ? LENGTH_ID : undefined}>{t('signin.key.submit')}</Button>
    </>, <>
      <p>{t('signin.key.body')}</p>
      <RecoveryKeyField id={FIELD_ID.key} label={t('signin.key.label')} value={key}
        onChange={value => { if (!blocked) onKey(value); }} hint={t('signin.key.hint', { n })} error={errorText('key')} />
      {short ? <p id={LENGTH_ID}>{t('signin.error.keyLength')}</p> : null}
      {working ? <p role="status">{t('signin.key.working')}</p> : null}
    </>);
  } else {
    content = form(t('signin.login.title', { instance: name }), 1, <>
      {cancelButton('signin.login.createInstead')}
      <Button variant="accent" type="submit" {...blockedProps}>{t(busy === 'login' ? 'signin.login.working' : 'signin.login.submit')}</Button>
    </>, <>
      <p>{t('signin.login.body', { instance: name })}</p>
      <TextField id={FIELD_ID.username} label={t('signin.login.username')} value={username}
        onChange={change('username', setUsername)} error={errorText('username')}
        required autoComplete="username" spellCheck={false} maxLength={32} />
      <TextField id={FIELD_ID.password} type="password" label={t('signin.login.password')} value={password}
        onChange={change('password', setPassword)} error={errorText('password')} required autoComplete="current-password" />
    </>);
  }
  return <div ref={rootRef}>{content}</div>;
}
