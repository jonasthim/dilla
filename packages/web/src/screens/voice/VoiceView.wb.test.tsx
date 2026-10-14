// The whole-branch fix wave of web-3 (wb-security.md, wb-client.md, wb-web-a11y.md): the shell's side.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { t } from '../../strings/index.ts';
import { BOB, callState, GENV, renderVoiceShell, type VoiceHarnessOptions } from '../../test/fake-client.ts';

afterEach(() => { vi.unstubAllGlobals(); });

const main = () => within(screen.getByRole('main'));
const UMK = { code: 'E_UMK_CHANGED', detail: '', status: 0, retryAfterMs: null };
const STALE = { ...UMK, code: 'E_DEVICE_LIST_STALE' };

async function inVoice(o: VoiceHarnessOptions = {}) {
  const app = renderVoiceShell(o);
  await app.user.click(await main().findByRole('button', { name: 'join voice' }));
  await waitFor(() => expect(app.sessions).toHaveLength(1));
  app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
  await main().findByRole('toolbar', { name: 'call controls' });
  return app;
}

describe('the hold after a refused rekey (wb-security I1)', () => {
  it('pauses the session, drops its media keys, says voice.held, and resumes on the next key', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: STALE, changedUser: null }));
    expect(await main().findByText(t('voice.held'))).toBeInTheDocument();
    await waitFor(() => expect(app.session.setPaused).toHaveBeenCalledWith(true));
    expect(app.session.dropKeys).toHaveBeenCalledTimes(1);
    expect(main().queryByRole('button', { name: 'compare safety numbers' })).toBeNull();
    // The same hold published again drops nothing more.
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: STALE, changedUser: null }));
    expect(app.session.dropKeys).toHaveBeenCalledTimes(1);
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(app.session.setPaused).toHaveBeenLastCalledWith(false));
    expect(screen.queryByText(t('voice.held'))).toBeNull();
  });

  it('an identity pause keeps the keys (it may resume on the same epoch); a hold after it drops them', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.setPaused).toHaveBeenCalledWith(true));
    expect(app.session.dropKeys).not.toHaveBeenCalled();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: { ...UMK, code: 'E_CORE_STATE' }, changedUser: null }));
    await waitFor(() => expect(app.session.dropKeys).toHaveBeenCalledTimes(1));
    expect(app.session.setPaused).toHaveBeenCalledTimes(1);
  });
});
