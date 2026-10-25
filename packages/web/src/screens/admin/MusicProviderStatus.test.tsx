import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMusicProviderStatus, fromHex } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { MusicProviderStatus } from './MusicProviderStatus.tsx';

const cid = '11'.repeat(16); const installationId = '22'.repeat(16);
function setup(status = 0, wrongInstallation = false, age = 0, empty = false) {
  const fake = new FakeClient();
  fake.set(`permissions:${cid}`, { loaded: true, manageCommunity: true, top: 0, owner: false, manageRoles: false, manageChannels: false, createInvite: false, banMembers: false, kickMembers: false, everyoneId: '', overwritesLoaded: true });
  let requestId = '';
  fake.handler = command => Promise.resolve((() => {
    if (command.m === 'humanInteractionRequest') { requestId = command.requestId; return { requestId, upload: 'accepted' }; }
    if (command.m === 'readBotInteractionResponses') return { responses: empty ? [] : [{ requestId, communityId: cid, operation: 24, status, deliveryId: '9', revision: null,
      data: encodeMusicProviderStatus({ version: 1, installationId: fromHex(wrongInstallation ? '33'.repeat(16) : installationId), observedAt: BigInt(Math.floor(Date.now() / 1000) - age),
        spotifyAccount: 'linked', spotifyAccountReason: 'none', spotifyPlayback: 'missing_requirements', spotifyPlaybackReason: 'helper_missing',
        youtubePlayback: 'configured', youtubePlaybackReason: 'none' }) }], through: null, blocked: true };
    return null;
  })());
  const view = render(<CoreProvider client={fake}><MusicProviderStatus communityId={cid} installationId={installationId} /></CoreProvider>);
  return { fake, view };
}
afterEach(() => vi.useRealTimers());
describe('music provider status', () => {
  it('uses runtime evidence and never acknowledges another operation blocking its response', async () => {
    const { fake } = setup();
    expect(await screen.findByText('Linked')).toBeVisible();
    expect(screen.getByText('Missing requirements')).toBeVisible();
    expect(fake.callsOf('readBotInteractionResponses')[0]).toMatchObject({ operations: [24] });
    expect(fake.callsOf('ackBotInteractionResponses')).toEqual([]);
    expect(fake.callsOf('humanInteractionRequest')[0]).toMatchObject({ operation: 24, args: [], revision: null, channelId: null });
  });
  it('does not equate unsupported responses or wrong installation snapshots with linked', async () => {
    setup(0, true);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('unavailable'));
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
  });
  it('removes the observation and stops protected reads when access is revoked', async () => {
    const { fake } = setup(); await screen.findByText('Linked');
    act(() => fake.publish(`permissions:${cid}`, { ...fake.get(`permissions:${cid}`)!, manageCommunity: false }));
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
  });
  it('shows older observations as stale and unknown with their timestamp', async () => {
    setup(0, false, 70);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('out of date'));
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
    expect(screen.getByText(/^Observed /)).toBeVisible();
  });
  it('shows unsupported runtime responses as unavailable', async () => {
    setup(1);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('unavailable'));
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
  });
  it('bounds pending reads to thirty seconds and allows retry', async () => {
    vi.useFakeTimers();
    const { fake } = setup(0, false, 0, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(screen.getByRole('status')).toHaveTextContent('unavailable');
    expect(screen.getByRole('button', { name: 'Refresh provider status' })).toBeEnabled();
    const reads = fake.callsOf('readBotInteractionResponses').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fake.callsOf('readBotInteractionResponses')).toHaveLength(reads);
  });

});
