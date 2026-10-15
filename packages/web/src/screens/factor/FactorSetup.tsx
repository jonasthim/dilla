// Flow 10: choosing and setting up a second factor. One component for the three places it is mounted: the last sign-up
// step, a sign-in on a new browser, and the forced screen for an account that owes one. There is no skip and no cancel in
// any origin; Back only returns to the choice. The TOTP secret, the otpauth URI and the backup codes come back from the
// commands and live in this component's state only: never a slice, the URL, storage or a log, and gone when it unmounts.
// No step-up is sent from here: the instance lets an account that holds no factor add its first without one.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Banner, Button, ChoiceCards, CodeList, OnboardingFrame, QrCode, TextField } from '@dilla/ui';
import { browser } from '../../browser.ts';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { PasskeyError, createPasskey, passkeysUsable } from '../../webauthn.ts';

export interface FactorSetupResult { kind: 'totp' | 'passkey' }

export interface FactorSetupProps {
  origin: 'signup' | 'signin' | 'required';
  stepLabel: string;
  instanceName: string;
  username: string;
  announce: (text: string) => void;
  onDone: (result: FactorSetupResult) => void;
}

type Step = 'choose' | 'totp' | 'passkey' | 'codes' | 'done';
type Choice = 'app' | 'passkey';
interface Problem { key: StringKey; vars: Record<string, string | number>; n: number }

const SIX_DIGITS = /^\d{6}$/;
const NAME_MAX = 64;
const FIELD_CODE = 'factor-totp-code';
const FIELD_NAME = 'factor-passkey-name';
const BUTTON_PASSKEY = 'factor-passkey-submit';
const KIND_GROUP = 'factor-kind';

const codePoints = (s: string): number => [...s].length;

/** The refusals every request shares, by status and code only (never by detail). Null: the caller's own rows apply. */
function sharedRefusal(e: UiError): Pick<Problem, 'key' | 'vars'> | null {
  if (e.status === 429) return { key: 'factor.error.tooMany', vars: { seconds: Math.max(1, Math.ceil((e.retryAfterMs ?? 1000) / 1000)) } };
  if (e.status === 0) return { key: 'factor.error.network', vars: {} };
  return null;
}

export function FactorSetup(props: FactorSetupProps): React.JSX.Element {
  const { origin, stepLabel, instanceName, username, announce, onDone } = props;
  const client = useCore();
  const account = useSlice('account');
  const factors = useSlice('factors');
  const hasPassword = factors?.hasPassword ?? true;
  const usable = passkeysUsable(account?.instance);

  const [step, setStep] = useState<Step>('choose');
  const [choice, setChoice] = useState<Choice>('app');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<StringKey | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<StringKey | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [kind, setKind] = useState<'totp' | 'passkey'>('totp');
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  // A request made for a screen the person has left (Back, or a newer request) must not write into the new one.
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const factorsKnown = factors !== undefined;
  useEffect(() => {
    if (!factorsKnown) client.call({ m: 'refreshFactors' }).catch(() => undefined);
  }, [client, factorsKnown]);
  useEffect(() => {
    if (focusRequest !== null) rootRef.current?.querySelector<HTMLElement>(`#${focusRequest.id}`)?.focus();
  }, [focusRequest]);

  const requestFocus = (id: string) => setFocusRequest(f => ({ id, n: (f?.n ?? 0) + 1 }));
  const fail = (shown: Pick<Problem, 'key' | 'vars'>) => setProblem(p => ({ ...shown, n: (p?.n ?? 0) + 1 }));
  const live = (g: number): boolean => mounted.current && generation.current === g;

  // Without a password the only factor on offer is a passkey.
  const effective: Choice = hasPassword ? choice : 'passkey';
  const passkeyName = name ?? t('factor.passkey.defaultName', { n: (factors?.passkeys.length ?? 0) + 1 });

  const goTo = (next: Step) => {
    generation.current += 1;
    setProblem(null);
    setBusy(false);
    setStep(next);
  };
  const toChoose = () => {
    setKey(null);
    setCode('');
    setCodeError(null);
    setNameError(null);
    goTo('choose');
  };
  /** The factor is in place: show the codes, or skip them when the account already held some. */
  const added = (which: 'totp' | 'passkey', backupCodes: string[]) => {
    setKey(null);
    setKind(which);
    setCode('');
    setCodes(backupCodes);
    setBusy(false);
    generation.current += 1;
    if (backupCodes.length > 0) { setStep('codes'); return; }
    finish(which);
  };
  const finish = (which: 'totp' | 'passkey') => {
    if (origin !== 'required') { onDone({ kind: which }); return; }
    setStep('done');
    announce(t('factor.added'));
  };

  const beginTotp = () => {
    goTo('totp');
    setBusy(true);
    const g = generation.current;
    client.call({ m: 'factorTotpBegin', stepup: null }).then((v) => {
      if (!live(g)) return;
      const r = v as { secret: string; uri: string };
      setKey({ secret: r.secret, uri: r.uri });
      setBusy(false);
      requestFocus(FIELD_CODE);
    }).catch((e: unknown) => {
      if (!live(g)) return;
      const err = errorOf(e);
      fail(sharedRefusal(err) ?? { key: 'factor.error.other', vars: { code: err.code } });
      setBusy(false);
    });
  };

  const submitTotp = () => {
    if (busy || key === null) return;
    const digits = code.replace(/\s/g, '');
    if (digits === '') { setCodeError('factor.error.required'); requestFocus(FIELD_CODE); return; }
    if (!SIX_DIGITS.test(digits)) { setCodeError('factor.error.codeFormat'); requestFocus(FIELD_CODE); return; }
    setCodeError(null);
    setProblem(null);
    setBusy(true);
    const g = generation.current;
    client.call({ m: 'factorTotpConfirm', code: digits }).then((v) => {
      if (!live(g)) return;
      added('totp', (v as { backupCodes: string[] }).backupCodes);
    }).catch((e: unknown) => {
      if (!live(g)) return;
      const err = errorOf(e);
      setBusy(false);
      if (err.status === 400 && err.code === 'E_INVALID_REQUEST') {
        setCode('');
        setCodeError('factor.error.code');
        requestFocus(FIELD_CODE);
        return;
      }
      fail(sharedRefusal(err) ?? { key: 'factor.error.other', vars: { code: err.code } });
    });
  };

  const submitPasskey = () => {
    if (busy) return;
    const trimmed = passkeyName.trim();
    if (trimmed === '') { setNameError('factor.error.required'); requestFocus(FIELD_NAME); return; }
    if (codePoints(trimmed) > NAME_MAX) { setNameError('factor.error.nameLong'); requestFocus(FIELD_NAME); return; }
    setNameError(null);
    setProblem(null);
    setBusy(true);
    const g = generation.current;
    const run = async () => {
      try {
        const begin = await client.call({ m: 'factorPasskeyBegin', stepup: null }) as { ceremonyId: string; options: string };
        if (!live(g)) return;
        // The options come from the instance's begin and nowhere else; the page makes no challenge of its own.
        const response = await createPasskey(begin.options);
        if (!live(g)) return;
        const done = await client.call({ m: 'factorPasskeyFinish', ceremonyId: begin.ceremonyId, response, name: trimmed }) as { backupCodes: string[] };
        if (!live(g)) return;
        added('passkey', done.backupCodes);
      } catch (e) {
        if (!live(g)) return;
        setBusy(false);
        fail(passkeyProblem(e, instanceName));
        requestFocus(BUTTON_PASSKEY);
      }
    };
    void run();
  };

  const copy = (text: string, announced: StringKey) => {
    navigator.clipboard?.writeText(text).then(() => { announce(t(announced)); }, () => undefined);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    switch (step) {
      case 'choose':
        if (effective === 'app') beginTotp();
        else if (usable) { goTo('passkey'); }
        break;
      case 'totp': submitTotp(); break;
      case 'passkey': submitPasskey(); break;
      case 'codes': if (acknowledged) finish(kind); break;
      case 'done': onDone({ kind }); break;
    }
  };

  const banner = problem === null ? null : (
    <Banner key={problem.n} tone="danger">{t(problem.key, problem.vars)}</Banner>
  );
  const blocked = busy ? { 'aria-disabled': true as const } : {};
  const frame = (title: string, foot: ReactNode, children: ReactNode) => (
    <form noValidate onSubmit={onSubmit}>
      <OnboardingFrame title={title} stepLabel={stepLabel} footer={foot}>
        {banner}
        {children}
      </OnboardingFrame>
    </form>
  );
  const back = <Button variant="ghost" type="button" onClick={() => { if (!busy) toChoose(); }} {...blocked}>{t('factor.back')}</Button>;

  let content: React.JSX.Element;
  if (step === 'choose') {
    const options = [
      ...(hasPassword ? [{ id: 'app', title: t('factor.choose.app'), hint: t('factor.choose.appHint') }] : []),
      { id: 'passkey', title: t('factor.choose.passkey'), hint: t('factor.choose.passkeyHint'),
        ...(usable ? {} : { disabled: true, reason: t('factor.choose.passkeyOff') }) },
    ];
    const cannot = effective === 'passkey' && !usable;
    content = frame(t('factor.choose.title'),
      <Button variant="accent" type="submit" {...(cannot ? { 'aria-disabled': true } : {})}>{t('factor.choose.next')}</Button>, <>
        <p>{origin === 'required' ? t('factor.choose.required', { instance: instanceName }) : t('factor.choose.body', { instance: instanceName })}</p>
        {hasPassword ? null : <p>{t('factor.choose.noPassword')}</p>}
        <ChoiceCards name={KIND_GROUP} label={t('factor.choose.label')} options={options} value={effective}
          onChange={(id) => { setChoice(id === 'passkey' ? 'passkey' : 'app'); }} />
      </>);
  } else if (step === 'totp') {
    content = frame(t('factor.totp.title'),
      <>
        {back}
        <Button variant="accent" type="submit" {...(busy || key === null ? { 'aria-disabled': true } : {})}>
          {t(busy && key !== null ? 'factor.totp.working' : 'factor.totp.submit')}
        </Button>
      </>,
      key === null ? (busy ? <p role="status">{t('factor.totp.loading')}</p> : null) : <>
        <p>{t('factor.totp.body')}</p>
        <div className="dw-factor-key">
          <QrCode value={key.uri} label={t('factor.totp.qr', { username, instance: instanceName })} />
          <div className="dw-factor-key__text">
            <div className="dw-factor-key__field">
              <div className="d-text-field">
                <label className="d-text-field__label" htmlFor="factor-totp-key">{t('factor.totp.key')}</label>
                <input id="factor-totp-key" className="d-text-field__input dw-factor-key__input" type="text" readOnly value={key.secret}
                  spellCheck={false} autoComplete="off" onFocus={(e) => { e.currentTarget.select(); }} />
              </div>
              <Button type="button" onClick={() => { copy(key.secret, 'factor.totp.keyCopied'); }}>{t('factor.totp.copyKey')}</Button>
            </div>
          </div>
        </div>
        <TextField id={FIELD_CODE} label={t('factor.totp.code')} hint={t('factor.totp.codeHint')} value={code}
          onChange={(v) => { setCode(v); setCodeError(null); }} {...(codeError === null ? {} : { error: t(codeError) })}
          autoComplete="one-time-code" inputMode="numeric" spellCheck={false} required />
      </>);
  } else if (step === 'passkey') {
    content = frame(t('factor.passkey.title'),
      <>
        {back}
        <Button id={BUTTON_PASSKEY} variant="accent" type="submit" {...blocked}>{t(busy ? 'factor.passkey.working' : 'factor.passkey.submit')}</Button>
      </>, <>
        <p>{t('factor.passkey.body')}</p>
        <TextField id={FIELD_NAME} label={t('factor.passkey.name')} hint={t('factor.passkey.nameHint')} value={passkeyName}
          onChange={(v) => { setName(v); setNameError(null); }} {...(nameError === null ? {} : { error: t(nameError) })}
          autoComplete="off" required />
      </>);
  } else if (step === 'codes') {
    content = frame(t('factor.codes.title'),
      <Button variant="accent" type="submit"
        {...(acknowledged ? {} : { 'aria-disabled': true as const, 'aria-describedby': 'factor-ack-hint' })}>{t('factor.codes.next')}</Button>, <>
        <p>{t('factor.codes.body')}</p>
        <p>{t('factor.codes.notKey')}</p>
        <CodeList codes={codes} label={t('factor.codes.label')} labels={{ copy: t('factor.codes.copy'), print: t('factor.codes.print') }}
          onCopy={() => { copy(codes.join('\n'), 'factor.codes.copied'); }} onPrint={() => { browser.print(); }} />
        <div>
          <input id="factor-ack" type="checkbox" checked={acknowledged} onChange={(e) => { setAcknowledged(e.currentTarget.checked); }} />
          {' '}
          <label htmlFor="factor-ack">{t('factor.codes.ack')}</label>
        </div>
        {acknowledged ? null : <p id="factor-ack-hint">{t('factor.codes.ackHint')}</p>}
      </>);
  } else {
    content = frame(t('factor.done.title'), <Button variant="accent" type="submit">{t('factor.done.next')}</Button>,
      <p>{t(kind === 'totp' ? 'factor.done.totp' : 'factor.done.passkey')}</p>);
  }
  return <div ref={rootRef}>{content}</div>;
}

/** What a failed passkey ceremony shows: the browser's own end by kind, the instance's refusals by status and code. */
function passkeyProblem(e: unknown, instanceName: string): Pick<Problem, 'key' | 'vars'> {
  if (e instanceof PasskeyError) {
    switch (e.kind) {
      case 'cancelled': return { key: 'factor.error.cancelled', vars: {} };
      case 'wrongAddress': return { key: 'factor.error.wrongAddress', vars: { instance: instanceName } };
      case 'exists': return { key: 'factor.error.exists', vars: {} };
      default: return { key: 'factor.error.other', vars: { code: 'E_PASSKEY' } };
    }
  }
  const err = errorOf(e);
  const shared = sharedRefusal(err);
  if (shared !== null) return shared;
  if (err.status >= 400 && err.status < 500) return { key: 'factor.error.refused', vars: { instance: instanceName } };
  return { key: 'factor.error.other', vars: { code: err.code } };
}
