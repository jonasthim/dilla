// Flow 10 state 5: "Confirm it is you". A step-up token is one use and short-lived; this dialog turns the account's password
// (or, with no password, a passkey) into one and hands it to the caller, who spends it on exactly one change. The password
// goes once into `stepUp` and is cleared from the field the moment it is sent; the token is never stored here.
import { useEffect, useRef, useState } from 'react';
import { Banner, ConfirmDialog, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { t } from '../../strings/index.ts';
import { PasskeyError, getPasskey } from '../../webauthn.ts';
import { sharedRefusal } from '../factor/FactorSetup.tsx';

export interface StepUpDialogProps {
  open: boolean;
  hasPassword: boolean;
  /** The last token was refused as spent or expired: say so above the field until the next attempt. */
  expired: boolean;
  onToken: (token: string) => void;
  onClose: () => void;
}

interface Run { busy: boolean; error: string | null; attempt: number }
const IDLE: Run = { busy: false, error: null, attempt: 0 };
const FIELD = 'stepup-password';

/** A refused step-up, by status and code only. A ceremony the browser ended itself has no code of ours. */
function say(e: UiError): string {
  if (e.status === 403 && e.code === 'E_STEP_UP') return t('factorSettings.stepUp.failed');
  const shared = sharedRefusal(e);
  if (shared !== null) return t(shared.key, shared.vars);
  return t('factorSettings.error.other', { code: e.code });
}

export function StepUpDialog({ open, hasPassword, expired, onToken, onClose }: StepUpDialogProps): React.JSX.Element {
  const client = useCore();
  const [password, setPassword] = useState('');
  const [run, setRun] = useState<Run>(IDLE);
  const [notice, setNotice] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    if (open) { setNotice(expired); return; }
    setPassword('');
    setRun(IDLE);
    setNotice(false);
  }, [open, expired]);

  // Contract 1: the refusal and the end of busy are one update, so ConfirmDialog moves focus to Cancel.
  const refused = (message: string) => setRun(r => ({ busy: false, error: message, attempt: r.attempt + 1 }));
  const settle = (token: string) => {
    running.current = false;
    setRun(r => ({ busy: false, error: null, attempt: r.attempt }));
    onToken(token);
  };
  const fail = (e: unknown) => {
    running.current = false;
    // The browser ending a ceremony (cancelled, no key) is not an answer of the instance: it has no code of ours.
    refused(e instanceof PasskeyError ? t('factorSettings.error.other', { code: 'E_PASSKEY' }) : say(errorOf(e)));
  };

  const submit = () => {
    if (running.current) return;
    if (hasPassword && password === '') { refused(t('factor.error.required')); return; }
    running.current = true;
    setNotice(false);
    setRun(r => ({ busy: true, error: null, attempt: r.attempt }));
    if (hasPassword) {
      const secret = password;
      setPassword('');
      client.call({ m: 'stepUp', method: 'password', secret }).then(
        v => { settle((v as { token: string }).token); }, fail);
      return;
    }
    const ceremony = async () => {
      const begin = await client.call({ m: 'stepUpPasskeyBegin' }) as { ceremonyId: string; options: string };
      const response = await getPasskey(begin.options);
      const done = await client.call({ m: 'stepUpPasskeyFinish', ceremonyId: begin.ceremonyId, response }) as { token: string };
      settle(done.token);
    };
    ceremony().catch(fail);
  };

  return (
    <ConfirmDialog open={open} tone="accent" title={t('factorSettings.stepUp.title')}
      body={t(hasPassword ? 'factorSettings.stepUp.body' : 'factorSettings.stepUp.passkeyBody')}
      confirmLabel={t(hasPassword ? 'factorSettings.stepUp.confirm' : 'factorSettings.stepUp.usePasskey')}
      busyLabel={t('factorSettings.stepUp.working')} cancelLabel={t('factorSettings.cancel')}
      busy={run.busy} error={run.error} attempt={run.attempt} onConfirm={submit} onClose={onClose}>
      {notice ? <Banner tone="warn">{t('factorSettings.stepUp.expired')}</Banner> : null}
      {hasPassword ? (
        <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <TextField id={FIELD} type="password" label={t('factorSettings.stepUp.password')} value={password}
            onChange={setPassword} autoComplete="current-password" required />
        </form>
      ) : null}
    </ConfirmDialog>
  );
}
