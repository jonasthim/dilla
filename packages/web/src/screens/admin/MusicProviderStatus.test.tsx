import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode, encodeMusicProviderStatus, fromHex } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { MusicProviderStatus } from './MusicProviderStatus.tsx';
import { noteSpotifyReturn } from '../../settings/spotify-return.ts';

const cid = '11'.repeat(16); const installationId = '22'.repeat(16);
function setup(status = 0, wrongInstallation = false, age = 0, empty = false, legacy = false, capabilityData?: Uint8Array, linked = true) {
  const fake = new FakeClient();
  fake.set(`permissions:${cid}`, { loaded: true, manageCommunity: true, top: 0, owner: false, manageRoles: false, manageChannels: false, createInvite: false, banMembers: false, kickMembers: false, everyoneId: '', overwritesLoaded: true });
  let requestId = '';
  let operation = 0;
  fake.handler = command => Promise.resolve((() => {
    if (command.m === 'humanInteractionRequest') { requestId = command.requestId; operation = command.operation; return { requestId, upload: 'accepted' }; }
    if (command.m === 'readBotInteractionResponses') return { responses: empty ? [] : [{ requestId, communityId: cid, operation, status: operation === 0 ? 0 : status, deliveryId: operation === 0 ? '8' : '9', revision: null,
      data: operation === 0 ? capabilityData ?? encode(legacy ? [1, fromHex('44'.repeat(16)), 0, 1, 0] : [2, fromHex('44'.repeat(16)), 0, 1, 0, [24]])
        : encodeMusicProviderStatus({ version: 1, installationId: fromHex(wrongInstallation ? '33'.repeat(16) : installationId), observedAt: BigInt(Math.floor(Date.now() / 1000) - age),
        spotifyAccount: linked ? 'linked' : 'not_linked', spotifyAccountReason: linked ? 'none' : 'missing_credentials', spotifyPlayback: 'missing_requirements', spotifyPlaybackReason: 'helper_missing',
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
    expect(fake.callsOf('readBotInteractionResponses').map(call => call.operations)).toEqual([[0], [24]]);
    expect(fake.callsOf('ackBotInteractionResponses')).toEqual([]);
    expect(fake.callsOf('humanInteractionRequest').map(call => call.operation)).toEqual([0, 24]);
    expect(fake.callsOf('humanInteractionRequest')[1]).toMatchObject({ operation: 24, args: [], revision: null, channelId: null });
  });
  it('does not send an unknown operation to an older runtime without a capability advertisement', async () => {
    const { fake } = setup(0, false, 0, false, true);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('unavailable'));
    expect(fake.callsOf('humanInteractionRequest').map(call => call.operation)).toEqual([0]);
    expect(fake.callsOf('ackBotInteractionResponses')).toEqual([]);
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
  });
  it('rejects malformed capability evidence before requesting provider status', async () => {
    const { fake } = setup(0, false, 0, false, false, encode([2, fromHex('44'.repeat(16)), 0, 1, 0, '24']));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('unavailable'));
    expect(fake.callsOf('humanInteractionRequest').map(call => call.operation)).toEqual([0]);
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
  it('reconciles an OAuth return for at most sixty seconds without treating delivery as Linked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    noteSpotifyReturn(cid);
    const { fake } = setup(0, false, 0, false, false, undefined, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText('Not linked')).toBeVisible();
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
    expect(fake.callsOf('humanInteractionRequest').filter(call => call.operation === 0)).toHaveLength(1);
    expect(fake.callsOf('humanInteractionRequest').filter(call => call.operation === 24).length).toBeGreaterThan(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const requests = fake.callsOf('humanInteractionRequest').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fake.callsOf('humanInteractionRequest')).toHaveLength(requests);
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
  });

});
