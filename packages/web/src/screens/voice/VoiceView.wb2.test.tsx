// The second whole-branch fix wave of web-3 (review/wb-product-walk.md): the shell's side.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { t } from '../../strings/index.ts';
import { callState, DM, renderVoiceShell } from '../../test/fake-client.ts';
import { RING_MS, UNANSWERED_LEAVE_MS } from './useCall.tsx';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const main = () => within(screen.getByRole('main'));
const dockStatus = () => document.querySelector('.d-voice-dock [role="status"]');

/** Starts a DM call with bob from the DM's strip; the worker then reports it in with `outgoing`. */
async function calling(outgoing: { ringing: string[]; declined: string[]; notRung: string[] }) {
  const app = renderVoiceShell({ path: `/dm/${DM}` });
  await app.user.click(await main().findByRole('button', { name: 'call' }));
  await waitFor(() => expect(app.sessions).toHaveLength(1));
  app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM, outgoing }));
  return app;
}

describe('the outgoing ring says what the instance did (product walk I6)', () => {
  it('a participant the instance did not ring is said as not rung, never as ringing, and no answer waits for the ring time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await calling({ ringing: [], declined: [], notRung: ['bob'] });
    await waitFor(() => expect(dockStatus()).toHaveTextContent(t('call.outgoing.notRung', { names: 'bob' })));
    expect(dockStatus()).not.toHaveTextContent('ringing bob');
    expect(dockStatus()).not.toHaveTextContent(t('call.outgoing.noAnswer'));
    // bob can still join from the DM's call button during the ring time; then nobody did.
    await act(() => vi.advanceTimersByTimeAsync(RING_MS));
    await waitFor(() => expect(dockStatus()).toHaveTextContent(t('call.outgoing.noAnswer')));
    expect(app.session.leave).not.toHaveBeenCalled();
  });

  it('after no answer the caller leaves by itself, and the strip says why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await calling({ ringing: [], declined: ['bob'], notRung: [] });
    await waitFor(() => expect(dockStatus()).toHaveTextContent('bob declined.'));
    await act(() => vi.advanceTimersByTimeAsync(UNANSWERED_LEAVE_MS - 100));
    expect(app.session.leave).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('user'));
    const strip = document.querySelector('.dw-call-strip__notice');
    await waitFor(() => expect(strip).toHaveTextContent('bob declined.'));
    expect(main().getByRole('button', { name: 'call' })).toBeInTheDocument();
  });

  it('a call someone answered never ends by itself when they leave again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await calling({ ringing: ['bob'], declined: [], notRung: [] });
    act(() => app.session.update({ tiles: [{ deviceId: 'b1', userId: 'bob', state: 'ok', speaking: false, video: null, screen: null }] }));
    app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM, outgoing: { ringing: [], declined: [], notRung: [] } }));
    act(() => app.session.update({ tiles: [] }));
    await act(() => vi.advanceTimersByTimeAsync(RING_MS + UNANSWERED_LEAVE_MS + 1000));
    expect(app.session.leave).not.toHaveBeenCalled();
  });
});
