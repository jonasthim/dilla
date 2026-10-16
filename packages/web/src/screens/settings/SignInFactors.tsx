// Settings → Sign-in (flow 10 state 5): the account's second factors, and adding, removing and making new backup codes.
// Every change takes a step-up token. The flow is one dialog at a time: the step-up dialog closes (its focus goes back to the
// button that opened the whole thing) and only then does the action dialog open, so each one's focus return is the same button.
// Making new backup codes runs the other way round: "are you sure" first, then the step-up, then the codes are made.
// The token lives in this component's state until the one command that spends it; the codes live there until their dialog closes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, CodeList, ConfirmDialog, Dialog, FactorRow } from '@dilla/ui';
import { browser } from '../../browser.ts';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { formatDay, t } from '../../strings/index.ts';
import { useRun } from '../admin/shared.ts';
import { FactorSetup, sharedRefusal } from '../factor/FactorSetup.tsx';
import { StepUpDialog } from './StepUpDialog.tsx';

const TITLE_ID = 'signin-title';
const PASSKEYS_ID = 'signin-passkeys';

type Purpose =
  | { kind: 'totp' }
  | { kind: 'passkey' }
  | { kind: 'remove'; which: 'totp' | 'passkey'; credId: string | null; name: string }
  | { kind: 'codes' };
type Phase = 'idle' | 'stepup' | 'action' | 'codes';

type Notice = 'expired' | 'again';

/** `live` is the text of the page's one polite region (Settings owns the announcer). The region is rendered inside the topmost
 *  open modal, because every modal above the frame makes the frame, and a region in it, inert for assistive tech. */
export function SignInFactors({ announce, live }: { announce: (text: string) => void; live: string }): React.JSX.Element {
  const client = useCore();
  const factors = useSlice('factors');
  const account = useSlice('account');
  const instance = account?.instance?.name ?? '';
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  // The dialog to open once the current one has closed and given its focus back.
  const [next, setNext] = useState<Phase | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const action = useRun();
  const rootRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<string | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const refresh = useCallback(() => {
    setLoadError(null);
    client.call({ m: 'refreshFactors' }).catch((e: unknown) => { setLoadError(errorOf(e)); });
  }, [client]);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (next === null || phase !== 'idle') return;
    setPhase(next);
    setNext(null);
  }, [next, phase]);
  // After a removal the row's button is gone: focus goes to the add button of that group, once the dialog has closed.
  useEffect(() => {
    if (phase !== 'idle' || next !== null || focusAfter.current === null) return;
    const label = focusAfter.current;
    focusAfter.current = null;
    const found = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button') ?? []).find(b => b.textContent === label);
    found?.focus();
  }, [phase, next]);

  const begin = (p: Purpose) => {
    action.reset();
    setNotice(null);
    setPurpose(p);
    setPhase('stepup');
  };
  /** Walk M6: making new codes asks "are you sure" first; the password comes after the person said yes, and the codes are
   *  then made without a second press (`codesConfirmed`). */
  const codesConfirmed = useRef(false);
  const askCodes = () => {
    action.reset();
    setNotice(null);
    codesConfirmed.current = false;
    setToken(null);
    setPurpose({ kind: 'codes' });
    setPhase('action');
  };
  const end = () => {
    codesConfirmed.current = false;
    action.reset();
    setPhase('idle');
    setNext(null);
    setPurpose(null);
    setToken(null);
    setCodes([]);
  };
  const gotToken = (tok: string) => {
    // Only the open step-up dialog may hand a token on; a late one from a cancelled attempt is dropped there as well.
    if (phaseRef.current !== 'stepup') return;
    action.reset();
    setToken(tok);
    setNotice(null);
    setPhase('idle');
    setNext('action');
  };
  /** The token was refused as spent or expired: back to the password, saying so. */
  const lost = (why: Notice | null) => {
    action.reset();
    setToken(null);
    setNotice(why);
    setPhase('idle');
    setNext('stepup');
  };

  /** What a refused change shows, by status and code (never by detail). */
  const refusedChange = (e: UiError): string => {
    if (e.status === 403 && e.code === 'E_STEP_UP') {
      // The person already said yes to new codes: once confirmed again, they are made.
      if (purpose?.kind === 'codes') codesConfirmed.current = true;
      lost('expired');
      return t('factorSettings.stepUp.expired');
    }
    // The instance spends the token before it decides, so after these three it is gone: re-read, and the next try steps up.
    if (e.status === 409) { refresh(); setToken(null); return t('factorSettings.error.only'); }
    if (e.status === 404 || (e.status === 403 && e.code === 'E_FORBIDDEN')) { refresh(); setToken(null); return t('factorSettings.error.changed'); }
    const shared = sharedRefusal(e);
    return shared !== null ? t(shared.key, shared.vars) : t('factorSettings.error.other', { code: e.code });
  };

  const remove = () => {
    if (purpose?.kind !== 'remove') return;
    if (token === null) { lost(null); return; }
    const { which, credId, name } = purpose;
    const spent = token;
    void action.run(() => client.call({ m: 'removeFactor', stepup: spent, kind: which, credId }), refusedChange).then(ok => {
      if (!ok) return;
      announce(which === 'totp' ? t('factorSettings.removed.totp') : t('factorSettings.removed.passkey', { name }));
      focusAfter.current = t(which === 'totp' ? 'factorSettings.totp.add' : 'factorSettings.passkeys.add');
      end();
    });
  };
  const regenerate = () => {
    if (purpose?.kind !== 'codes') return;
    if (token === null) { codesConfirmed.current = true; lost(null); return; }
    const spent = token;
    void action.run(async () => {
      const made = await client.call({ m: 'regenerateBackupCodes', stepup: spent }) as { backupCodes: string[] };
      setCodes(made.backupCodes);
    }, refusedChange).then(ok => {
      if (!ok) return;
      setToken(null);
      setPhase('idle');
      setNext('codes');
    });
  };
  // Back from the step-up with a token, after a yes: the confirm shows busy and the codes are made.
  useEffect(() => {
    if (phase !== 'action' || purpose?.kind !== 'codes' || token === null || !codesConfirmed.current) return;
    codesConfirmed.current = false;
    regenerate();
    // regenerate reads the state these name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, purpose, token]);
  // Spoken once the list is on screen, so the region it is spoken in is inside the modal that shows.
  useEffect(() => { if (phase === 'codes') announce(t('factorSettings.codesMade')); }, [phase, announce]);
  const copyCodes = () => { navigator.clipboard?.writeText(codes.join('\n')).then(() => { announce(t('factor.codes.copied')); }, () => undefined); };

  const hasPassword = factors?.hasPassword ?? true;
  const passkeys = factors?.passkeys ?? [];
  // The last factor cannot be removed (the instance refuses it as well); with it disabled the person sees why.
  const count = (factors?.totp != null ? 1 : 0) + passkeys.length;
  const only = count <= 1 ? t('factorSettings.only') : undefined;
  const addPasskey = (): void => { begin({ kind: 'passkey' }); };

  const stepUpOpen = phase === 'stepup';
  const confirmOpen = phase === 'action' && (purpose?.kind === 'remove' || purpose?.kind === 'codes');
  const addOpen = phase === 'action' && token !== null && (purpose?.kind === 'totp' || purpose?.kind === 'passkey');
  const removing = purpose?.kind === 'remove' ? purpose : null;
  const region = <p className="d-sr-only" role="status" aria-live="polite" data-testid="settings-announcer">{live}</p>;
  const modalOpen = stepUpOpen || confirmOpen || addOpen || phase === 'codes';

  return (
    <section ref={rootRef} className="dw-settings-section" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID} tabIndex={-1} className="dw-settings-heading">{t('factorSettings.title')}</h2>
      {loadError !== null ? (
        <Banner tone="danger" action={{ label: t('factorSettings.retry'), onAction: refresh }}>
          {t('factorSettings.error.load', { code: loadError.code })}
        </Banner>
      ) : null}
      {factors === undefined ? (loadError === null ? <p aria-busy="true">{t('factorSettings.loading')}</p> : null) : (
        <>
          <p>{t('factorSettings.body', { instance })}</p>
          <ul className="dw-device-list">
            <FactorRow title={t('factorSettings.password')}
              detail={t(factors.hasPassword ? 'factorSettings.password.set' : 'factorSettings.password.none')} />
            {factors.totp === null ? (
              <FactorRow title={t('factorSettings.totp')} detail={t('factorSettings.totp.off')}
                action={() => { begin({ kind: 'totp' }); }} actionLabel={t('factorSettings.totp.add')} />
            ) : (
              <FactorRow title={t('factorSettings.totp')} detail={t('factorSettings.totp.on', { date: formatDay(factors.totp.confirmedAt) })}
                action={() => { begin({ kind: 'remove', which: 'totp', credId: null, name: '' }); }}
                actionLabel={t('factorSettings.totp.remove')} actionAriaLabel={t('factorSettings.totp.removeLabel')}
                {...(only === undefined ? {} : { disabledReason: only })} />
            )}
            {passkeys.length === 0 ? (
              <FactorRow title={t('factorSettings.passkeys')} detail={t('factorSettings.passkeys.none')}
                action={addPasskey} actionLabel={t('factorSettings.passkeys.add')} />
            ) : (
              // Walk I3 (flow 10 state 19): the passkeys are a group of their own, under its heading, with its add button
              // after its rows, so a passkey never reads as part of the app above or the backup codes below.
              <li className="dw-factor-group" role="group" aria-labelledby={PASSKEYS_ID}>
                <h3 id={PASSKEYS_ID} className="dw-factor-group__title">{t('factorSettings.passkeys')}</h3>
                <ul className="dw-factor-group__rows">
                  {passkeys.map(k => (
                    <FactorRow key={k.id} title={k.name}
                      detail={k.lastUsed === null ? t('factorSettings.passkeys.unused', { created: formatDay(k.created) })
                        : t('factorSettings.passkeys.used', { created: formatDay(k.created), used: formatDay(k.lastUsed) })}
                      action={() => { begin({ kind: 'remove', which: 'passkey', credId: k.id, name: k.name }); }}
                      actionLabel={t('factorSettings.passkeys.remove')} actionAriaLabel={t('factorSettings.passkeys.removeLabel', { name: k.name })}
                      {...(only === undefined ? {} : { disabledReason: only })} />
                  ))}
                </ul>
                <div className="dw-factor-group__actions"><Button onClick={addPasskey}>{t('factorSettings.passkeys.add')}</Button></div>
              </li>
            )}
            <FactorRow title={t('factorSettings.codes')}
              detail={factors.backupCodesLeft === 0 ? t('factorSettings.codes.none') : factors.backupCodesLeft === 1
                ? t('factorSettings.codes.one') : t('factorSettings.codes.other', { count: factors.backupCodesLeft })}
              action={askCodes} actionLabel={t('factorSettings.codes.make')} />
          </ul>
          <p>{t('factorSettings.lost', { instance })}</p>
        </>
      )}

      {modalOpen ? null : region}
      <StepUpDialog open={stepUpOpen} hasPassword={hasPassword} notice={notice} live={region} onToken={gotToken} onClose={end} />
      <ConfirmDialog open={confirmOpen}
        title={purpose?.kind === 'codes' ? t('factorSettings.codes.makeTitle')
          : removing?.which === 'passkey' ? t('factorSettings.removeTitle.passkey', { name: removing.name }) : t('factorSettings.removeTitle.totp')}
        body={purpose?.kind === 'codes' ? t('factorSettings.codes.makeBody') : t('factorSettings.removeBody')}
        confirmLabel={purpose?.kind === 'codes' ? t('factorSettings.codes.makeConfirm') : t('factorSettings.removeConfirm')}
        busyLabel={t(purpose?.kind === 'codes' ? 'factorSettings.codes.makeBusy' : 'factorSettings.removeBusy')} cancelLabel={t('factorSettings.cancel')}
        tone={purpose?.kind === 'codes' ? 'accent' : 'danger'}
        busy={action.busy} error={action.error} attempt={action.attempt}
        onConfirm={purpose?.kind === 'codes' ? regenerate : remove} onClose={() => { if (!action.busy) end(); }}>
        {region}
      </ConfirmDialog>
      {addOpen && token !== null && (purpose?.kind === 'totp' || purpose?.kind === 'passkey') ? (
        <FactorSetup origin="settings" stepLabel="" instanceName={instance} username={account?.user?.username ?? ''} announce={announce}
          embedded={{ stepup: token, start: purpose.kind === 'totp' ? 'app' : 'passkey', onClose: end, onStepUpLost: lost, live: region }}
          onDone={(result) => {
            announce(result.kind === 'totp' ? t('factorSettings.added.totp') : t('factorSettings.added.passkey', { name: result.name ?? '' }));
            // The opener may re-mount (the first passkey turns an unkeyed row into a keyed list): focus goes to the group's button.
            focusAfter.current = t(result.kind === 'totp' ? 'factorSettings.totp.remove' : 'factorSettings.passkeys.add');
            end();
          }} />
      ) : null}
      <Dialog open={phase === 'codes'} title={t('factorSettings.codes.newTitle')} closeLabel={t('dialog.close')} onClose={end}>
        <p>{t('factorSettings.codes.newBody')}</p>
        <p>{t('factor.codes.notKey')}</p>
        <CodeList codes={codes} label={t('factor.codes.label')} labels={{ copy: t('factor.codes.copy'), print: t('factor.codes.print') }}
          onCopy={copyCodes} onPrint={() => { browser.print(); }} />
        {region}
      </Dialog>
    </section>
  );
}
