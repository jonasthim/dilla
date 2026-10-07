import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { normaliseRecoveryKey } from '@dilla/client-core';
import { Banner, Button, Dialog, RecoveryKeyField } from '@dilla/ui';
import { errorOf, type UiError } from '../../core/errors.ts';
import { t, type StringKey } from '../../strings/index.ts';

const KEY_LENGTH = 52;

/**
 * The recovery-key confirmation the remove-listed and sign-out dialogs of Settings → Devices share (flow 03). The
 * key lives in this component's state only and leaves it inside the one command `onConfirm` sends; closing the
 * dialog or a resolved command drops it. The page counts the characters and Rust judges the text: a submit before
 * the count is 52 sends nothing. A wrong key (`E_RECOVERY_KEY`) is a field error with the text kept; any other
 * refusal is the danger banner by its code. While the command runs nothing closes the dialog.
 */
export function KeyDialog(props: {
  open: boolean; id: string; title: string; body: string; confirmLabel: string;
  onConfirm(recoveryKey: string): Promise<unknown>; onClose(): void;
}): React.JSX.Element {
  const { open, id } = props;
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<StringKey | null>(null);
  const [banner, setBanner] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  // The in-flight guard a second press reads before React has re-rendered.
  const running = useRef(false);
  const [focusField, setFocusField] = useState(0);
  const fieldId = `${id}-key`;
  const formId = `${id}-form`;
  const lengthId = `${id}-length`;

  // A closed dialog keeps no key text and no error.
  useEffect(() => {
    if (open) return;
    setValue('');
    setFieldError(null);
    setBanner(null);
  }, [open]);

  // Applied after the render that re-enabled the field, so the focus lands on it.
  useEffect(() => {
    if (focusField > 0) document.getElementById(fieldId)?.focus();
  }, [focusField, fieldId]);

  const n = normaliseRecoveryKey(value).length;
  const short = n !== KEY_LENGTH;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (running.current) return;
    if (short) {
      setFieldError('signin.error.keyLength');
      setFocusField(f => f + 1);
      return;
    }
    running.current = true;
    setBusy(true);
    setFieldError(null);
    setBanner(null);
    try {
      await props.onConfirm(value);
      props.onClose();
    } catch (err) {
      const refusal = errorOf(err);
      if (refusal.code === 'E_RECOVERY_KEY') {
        setFieldError('devices.error.wrongKey');
        setFocusField(f => f + 1);
      } else {
        setBanner(refusal);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const change = (next: string) => {
    if (running.current) return;
    setValue(next);
    setFieldError(null);
  };

  const blocked = short || busy;
  return (
    <Dialog open={open} title={props.title} closeLabel={t('dialog.close')} onClose={() => { if (!running.current) props.onClose(); }}
      footer={
        <Button variant="danger" type="submit" form={formId} {...(blocked ? { 'aria-disabled': true } : {})}
          aria-describedby={short ? lengthId : undefined}>{busy ? t('devices.working') : props.confirmLabel}</Button>
      }>
      <form id={formId} noValidate onSubmit={e => { void submit(e); }}>
        <p>{props.body}</p>
        {banner === null ? null : <Banner tone="danger">{t('settings.error.other', { code: banner.code })}</Banner>}
        <RecoveryKeyField id={fieldId} label={t('devices.keyLabel')} value={value} onChange={change}
          hint={t('signin.key.hint', { n })} error={fieldError === null ? undefined : t(fieldError)} disabled={busy} />
        {short ? <p id={lengthId}>{t('signin.error.keyLength')}</p> : null}
      </form>
    </Dialog>
  );
}
