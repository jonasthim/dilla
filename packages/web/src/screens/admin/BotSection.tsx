// Server Settings → Bot: inspect the managed installation and enable/disable it through the core worker.
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, SettingsRow } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { StepUpDialog } from '../settings/StepUpDialog.tsx';
import { type SectionProps } from './shared.ts';

type Installation = { id: string; communityId: string; state: 0 | 1 | 2 | 3 | 4 | 5; revision: string;
  userId: string | null; deviceId: string | null; capabilities: number; updatedAt: string };
type Phase = 'idle' | 'stepup';

const requestId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const stateKey = (state: Installation['state']): StringKey => state <= 1 ? 'admin.bot.status.pending'
  : state === 2 ? 'admin.bot.status.joining' : state === 3 ? 'admin.bot.status.ready'
    : state === 4 ? 'admin.bot.status.disabled' : 'admin.bot.status.failed';
const capabilityNames = (n: number): string => [
  'music', 'welcome', 'roles', 'announcements', 'warnings', 'removal', 'kick', 'ban',
].filter((_, bit) => (n & (1 << bit)) !== 0).map(name => t(`admin.bot.capability.${name}` as StringKey)).join(', ');

function errorMessage(error: UiError): string {
  if (error.code === 'E_FORBIDDEN' || error.status === 403) return t('admin.bot.error.forbidden');
  if (error.status === 409 || error.code === 'E_CONFLICT') return t('admin.bot.error.conflict');
  return t('admin.bot.error.other', { code: error.code });
}

export function BotSection({ communityId, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const factors = useSlice('factors');
  const members = useSlice(`members:${communityId}`);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const readGeneration = useRef(0);
  const selectedCommunity = useRef(communityId);
  selectedCommunity.current = communityId;

  useEffect(() => {
    const generation = ++readGeneration.current;
    setInstallation(null);
    setLoadedFor(null);
    setError(null);
    setPhase('idle');
    void client.call({ m: 'getBotInstallation', communityId }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation | null);
      setLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (generation !== readGeneration.current) return;
      setError(errorMessage(errorOf(e)));
      setLoadedFor(communityId);
    });
    void client.call({ m: 'refreshFactors' }).catch(() => undefined);
  }, [client, communityId]);

  const current = loadedFor === communityId;
  const currentInstallation = current && installation?.communityId === communityId ? installation : null;
  const currentError = current ? error : null;
  const busy = busyFor === communityId;
  const enable = () => {
    if (busy || !current || currentError !== null || factors === undefined) return;
    setPhase('stepup');
  };
  const configure = (stepUp: string) => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null || factors === undefined) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    setBusyFor(requestCommunity);
    setError(null);
    void client.call({ m: 'configureBotInstallation', communityId, requestId: requestId(),
      expectedRevision: currentInstallation?.revision ?? null, capabilities: 0, stepUp }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation);
      announce(t('admin.bot.enabledNotice'));
    }).catch((e: unknown) => { if (generation === readGeneration.current) setError(errorMessage(errorOf(e))); })
      .finally(() => setBusyFor(value => value === requestCommunity ? null : value));
  };
  const disable = () => {
    if (busy || !current || currentError !== null || currentInstallation === null) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    setBusyFor(requestCommunity);
    setError(null);
    void client.call({ m: 'disableBotInstallation', communityId: requestCommunity, requestId: requestId(), expectedRevision: currentInstallation.revision }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation);
      announce(t('admin.bot.disabledNotice'));
    }).catch((e: unknown) => { if (generation === readGeneration.current) setError(errorMessage(errorOf(e))); })
      .finally(() => setBusyFor(value => value === requestCommunity ? null : value));
  };

  const bot = currentInstallation?.userId === null || currentInstallation?.userId === undefined
    ? undefined : members?.find(m => m.userId === currentInstallation.userId && m.kind === 1);
  const enabled = currentInstallation !== null && currentInstallation.state !== 4;
  const enableUnavailable = !current || currentError !== null || factors === undefined;
  const status = currentInstallation === null ? null : t(stateKey(currentInstallation.state));

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} tabIndex={-1}>{t('admin.bot.title')}</h2>
      {!current ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
      {current && currentInstallation === null && currentError === null ? <p>{t('admin.bot.none')}</p> : null}
      {currentInstallation !== null ? (
        <SettingsRow id={`${base}-status-row`} label={t('admin.bot.title')}>
          {bot ? <div className="dw-bot-identity"><Avatar name={bot.display || bot.username} size="sm" /><span>{bot.display || bot.username}</span></div> : null}
          <p role="status" aria-live="polite">{status}</p>
          <p>{currentInstallation.capabilities === 0 ? t('admin.bot.staged') : t('admin.bot.capabilities', { names: capabilityNames(currentInstallation.capabilities) })}</p>
        </SettingsRow>
      ) : null}
      {currentError === null ? null : <p role="alert">{currentError}</p>}
      <div>
        {enabled ? <Button aria-disabled={busy || undefined} onClick={disable}>{busy ? t('admin.bot.disabling') : t('admin.bot.disable')}</Button>
          : <Button variant="accent" aria-disabled={busy || enableUnavailable || undefined}
            aria-describedby={factors === undefined ? `${base}-stepup-reason` : undefined} onClick={enable}>
            {busy ? t('admin.bot.enabling') : t('admin.bot.enable')}
          </Button>}
      </div>
      {factors === undefined && !enabled ? <p id={`${base}-stepup-reason`}>{t('admin.bot.stepUpMissing')}</p> : null}
      <StepUpDialog open={phase === 'stepup'} hasPassword={factors?.hasPassword ?? true} notice={null}
        onToken={value => { setPhase('idle'); configure(value); }} onClose={() => setPhase('idle')} />
    </section>
  );
}
