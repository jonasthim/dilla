import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, Dialog, TextField } from '@dilla/ui';
import { errorOf, type UiError } from '../../core/errors.ts';
import { t } from '../../strings/index.ts';

/** The longest device name; the server refuses more (protocol/09 § Devices). */
export const DEVICE_NAME_MAX = 64;

/**
 * The name dialog of Settings → Devices (flow 03). `initial` is the text the field starts on: the current name, or
 * for this browser without one the browser-and-system suggestion. The text is trimmed, and an empty field sends null,
 * which clears the name. While the command runs the submit is blocked and nothing closes the dialog; a refusal is the
 * danger banner by its code with the text kept.
 */
export function RenameDialog(props: {
  open: boolean; id: string; initial: string; onSave(label: string | null): Promise<unknown>; onClose(): void;
}): React.JSX.Element {
  const { open, initial } = props;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  // The in-flight guard a second press reads before React has re-rendered.
  const running = useRef(false);
  const formId = `${props.id}-form`;

  // Each opening starts again on the text it was given; a closed dialog keeps no error.
  useEffect(() => {
    if (!open) { setError(null); return; }
    setValue(initial);
  }, [open, initial]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const label = value.trim();
      await props.onSave(label === '' ? null : label);
      props.onClose();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={t('devices.renameTitle')} closeLabel={t('dialog.close')} onClose={() => { if (!running.current) props.onClose(); }}
      footer={<Button variant="accent" type="submit" form={formId} {...(busy ? { 'aria-disabled': true } : {})}>
        {busy ? t('devices.working') : t('devices.renameSave')}</Button>}>
      <form id={formId} noValidate onSubmit={e => { void submit(e); }}>
        {error === null ? null : <Banner tone="danger">{t('settings.error.other', { code: error.code })}</Banner>}
        <TextField id={`${props.id}-name`} label={t('devices.renameLabel')} hint={t('devices.renameBody')}
          note={t('devices.renameServerReads')} value={value}
          onChange={next => { if (!running.current) setValue(next); }} maxLength={DEVICE_NAME_MAX} spellCheck={false}
          autoComplete="off" initialFocus />
      </form>
    </Dialog>
  );
}
