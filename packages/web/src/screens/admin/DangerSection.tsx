import { useEffect, useId, useRef, useState } from 'react';
import { Button, ConfirmDialog, Select, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { forbidden, nfc, shownName, statusIs, useRun, type SectionProps } from './shared.ts';

type Dialog = 'leave' | 'delete' | 'transfer' | null;

/**
 * The danger zone. A member leaves; the owner cannot (they are told why) and instead deletes the server or hands it to
 * another member, both behind the typed server name (NFC, trimmed). The worker drops a server it left or deleted, so after
 * either `onGone` closes the dialog for it.
 */
export function DangerSection({ communityId, serverName, announce, owner, onGone }: SectionProps & { owner: boolean; onGone: () => void }): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const me = useSlice('account')?.user?.id ?? null;
  const members = useSlice(`members:${communityId}`);
  const others = (members ?? []).filter(m => m.userId !== me);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [typed, setTyped] = useState('');
  const [target, setTarget] = useState('');
  const action = useRun();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set by a resolved hand over; read once its dialog has closed. The opener is gone then, so focus goes to the heading.
  const focusHeading = useRef(false);
  useEffect(() => {
    if (dialog !== null || !focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  }, [dialog]);

  const chosen = others.find(m => m.userId === target) ?? others[0];
  const matches = nfc(typed) === nfc(serverName);
  const choose = (next: Dialog) => { action.reset(); setTyped(''); setDialog(next); };
  const close = () => { if (!action.busy) setDialog(null); };

  const leave = () => {
    void action.run(() => client.call({ m: 'leaveCommunity', communityId }), e => t('admin.leave.error.other', { code: e.code }))
      .then(ok => { if (ok) { announce(t('admin.left', { server: serverName })); setDialog(null); onGone(); } });
  };
  const remove = () => {
    void action.run(() => client.call({ m: 'deleteCommunity', communityId }), e =>
      forbidden(e) ? t('admin.delete.error.forbidden') : t('admin.delete.error.other', { code: e.code }))
      .then(ok => { if (ok) { announce(t('admin.delete.done', { server: serverName })); setDialog(null); onGone(); } });
  };
  const hand = () => {
    if (chosen === undefined) return;
    const to = chosen;
    void action.run(() => client.call({ m: 'transferOwnership', communityId, userId: to.userId }), e =>
      statusIs(e, 404) ? t('admin.transfer.error.gone', { server: serverName })
        : forbidden(e) ? t('admin.transfer.error.forbidden')
          : t('admin.transfer.error.other', { code: e.code }))
      .then(ok => {
        if (!ok) return;
        announce(t('admin.transfer.done', { name: shownName(to), server: serverName }));
        focusHeading.current = true;
        setDialog(null);
      });
  };
  const typedField = (label: string) => (
    <TextField id={`${base}-typed`} label={label} value={typed} onChange={v => { setTyped(v); action.reset(); }}
      hint={typed !== '' && !matches ? t('admin.delete.mismatch') : undefined} autoComplete="off" spellCheck={false} />
  );

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} ref={headingRef} tabIndex={-1}>{t(owner ? 'admin.nav.delete' : 'admin.nav.leave')}</h2>
      {owner ? (
        <>
          <p>{t('admin.leave.owner', { server: serverName })}</p>
          {others.length === 0 ? <p>{t('admin.transfer.none')}</p> : null}
          <div className="dw-settings-actions">
            {others.length > 0 ? <Button onClick={() => choose('transfer')}>{t('admin.nav.transfer')}</Button> : null}
            <Button variant="danger" onClick={() => choose('delete')}>{t('admin.nav.delete')}</Button>
          </div>
        </>
      ) : (
        <div className="dw-settings-actions">
          <Button variant="danger" onClick={() => choose('leave')}>{t('admin.leave.open')}</Button>
        </div>
      )}
      <ConfirmDialog open={dialog === 'leave'} title={t('admin.leave.title', { server: serverName })} body={t('admin.leave.body', { server: serverName })}
        confirmLabel={t('admin.leave.confirm')} busyLabel={t('admin.leave.busy')} cancelLabel={t('admin.cancel')}
        busy={action.busy} error={action.error} attempt={action.attempt} onConfirm={leave} onClose={close} />
      <ConfirmDialog open={dialog === 'delete'} title={t('admin.delete.title', { server: serverName })} body={t('admin.delete.body', { server: serverName })}
        confirmLabel={t('admin.delete.confirm')} busyLabel={t('admin.delete.busy')} cancelLabel={t('admin.cancel')}
        busy={action.busy} error={action.error} attempt={action.attempt} canConfirm={matches} onConfirm={remove} onClose={close}>
        {dialog === 'delete' ? typedField(t('admin.delete.confirmName')) : null}
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'transfer'} title={t('admin.transfer.title', { server: serverName })} body={t('admin.transfer.body', { server: serverName })}
        confirmLabel={t('admin.transfer.confirm')} busyLabel={t('admin.transfer.busy')} cancelLabel={t('admin.cancel')}
        busy={action.busy} error={action.error} attempt={action.attempt} canConfirm={matches && chosen !== undefined} onConfirm={hand} onClose={close}>
        {dialog === 'transfer' ? (
          <>
            <Select label={t('admin.transfer.member')} value={chosen?.userId ?? ''} options={others.map(m => ({ value: m.userId, label: shownName(m) }))}
              onChange={v => { setTarget(v); action.reset(); }} />
            {typedField(t('admin.transfer.confirmName'))}
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
