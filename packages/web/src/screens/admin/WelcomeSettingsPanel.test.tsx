// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '../../strings/index.ts';
import { encodeWelcomeSettings } from './welcome-settings.ts';
import { WelcomeSettingsPanel, type WelcomeSettingsGateway } from './WelcomeSettingsPanel.tsx';

const COMMUNITY = 'a1'.repeat(16);
const CHANNEL = 'b2'.repeat(16);
const CONFIG = { channelId: CHANNEL, template: 'Welcome {member}!', serverName: 'Midgard' };

function setup() {
  let lastRequest: Parameters<WelcomeSettingsGateway['request']>[0] | undefined;
  let response: { requestId: string; operation: number; status: number; revision: string | null; data: Uint8Array } | null = null;
  const gateway: WelcomeSettingsGateway = {
    request: vi.fn(async input => {
      lastRequest = input;
      return { requestId: input.requestId, upload: 'accepted' as const };
    }),
    read: vi.fn(async () => ({ responses: response === null ? [] : [{ deliveryId: '1', communityId: COMMUNITY,
      channelId: null, sourceSeq: '1', ...response }], through: response === null ? null : '1', blocked: false })),
    ack: vi.fn(async () => null),
  };
  render(<WelcomeSettingsPanel communityId={COMMUNITY} serverName="Midgard" channels={[{ id: CHANNEL, name: 'general' }]}
    enabled canManage gateway={gateway} />);
  return { gateway, getRequest: () => lastRequest, setResponse: (next: typeof response) => { response = next; } };
}

describe('welcome settings panel', () => {
  it('waits for a correlated Bot get response before loading settings and acknowledging it', async () => {
    const { gateway, getRequest, setResponse } = setup();
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(getRequest()).toMatchObject({ communityId: COMMUNITY, channelId: null, operation: 1,
      args: [5], revision: null }));
    const request = getRequest()!;
    setResponse({ requestId: request.requestId, operation: 1, status: 0, revision: '7', data: encodeWelcomeSettings(CONFIG) });
    expect(await screen.findByDisplayValue('Welcome {member}!')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: en['admin.bot.welcomeSettings.channel'] })).toHaveValue(CHANNEL);
    await waitFor(() => expect(gateway.ack).toHaveBeenCalledWith(COMMUNITY, '1'));
  });

  it('does not report a save as complete until the exact request receives a successful revised response', async () => {
    const { gateway, getRequest, setResponse } = setup();
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(getRequest()).toBeDefined());
    const read = getRequest()!;
    setResponse({ requestId: read.requestId, operation: 1, status: 0, revision: '7', data: encodeWelcomeSettings(CONFIG) });
    await screen.findByDisplayValue('Welcome {member}!');
    await waitFor(() => expect(gateway.ack).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox', { name: en['admin.bot.welcomeSettings.template'] }),
      { target: { value: 'Hello {member}!' } });
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.save'] }));
    await waitFor(() => expect(getRequest()?.operation).toBe(2));
    const put = getRequest()!;
    expect(put.revision).toBe('7');
    expect(put.args[0]).toBe(5);
    expect(put.args[1]).toBeInstanceOf(Uint8Array);
    expect(screen.queryByText(en['admin.bot.welcomeSettings.saved'])).not.toBeInTheDocument();

    setResponse({ requestId: put.requestId, operation: 2, status: 0, revision: '8', data: new Uint8Array([0x80]) });
    expect(await screen.findByText(en['admin.bot.welcomeSettings.saved'])).toBeInTheDocument();
    await waitFor(() => expect(gateway.ack).toHaveBeenLastCalledWith(COMMUNITY, '1'));
    expect(gateway.request).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 2, revision: '7' }));
  });

  it('ignores a response for a different request ID', async () => {
    const { gateway, getRequest, setResponse } = setup();
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(getRequest()).toBeDefined());
    const request = getRequest()!;
    setResponse({ requestId: 'ff'.repeat(16), operation: 1, status: 0, revision: '7', data: encodeWelcomeSettings(CONFIG) });
    expect(await screen.findByText(en['admin.bot.welcomeSettings.waiting'])).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Welcome {member}!')).not.toBeInTheDocument();
    expect(gateway.ack).not.toHaveBeenCalled();
    expect(request.operation).toBe(1);
  });

  it('requires a fresh get after a revision conflict before another save', async () => {
    const { gateway, getRequest, setResponse } = setup();
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(getRequest()).toBeDefined());
    let request = getRequest()!;
    setResponse({ requestId: request.requestId, operation: 1, status: 0, revision: '7', data: encodeWelcomeSettings(CONFIG) });
    await screen.findByDisplayValue(CONFIG.template);
    await waitFor(() => expect(gateway.ack).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.save'] }));
    await waitFor(() => expect(getRequest()?.operation).toBe(2));
    request = getRequest()!;
    setResponse({ requestId: request.requestId, operation: 2, status: 4, revision: '8', data: new Uint8Array([0x80]) });
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.bot.welcomeSettings.conflict']);
    expect(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.save'] })).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.reload'] }));
    await waitFor(() => expect(getRequest()?.operation).toBe(1));
    request = getRequest()!;
    const latest = { ...CONFIG, template: 'Updated elsewhere' };
    setResponse({ requestId: request.requestId, operation: 1, status: 0, revision: '8', data: encodeWelcomeSettings(latest) });
    expect(await screen.findByDisplayValue(latest.template)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.save'] })).not.toHaveAttribute('aria-disabled', 'true'));
  });

  it('hides the configured-message claim while the form has unsaved changes', async () => {
    const { getRequest, setResponse } = setup();
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(getRequest()).toBeDefined());
    const request = getRequest()!;
    setResponse({ requestId: request.requestId, operation: 1, status: 0, revision: '7', data: encodeWelcomeSettings(CONFIG) });
    expect(await screen.findByText(en['admin.bot.welcomeSettings.configured'])).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: en['admin.bot.welcomeSettings.template'] }),
      { target: { value: 'An unsaved draft' } });
    expect(screen.queryByText(en['admin.bot.welcomeSettings.configured'])).not.toBeInTheDocument();
  });

  it('keeps a new community request intact when the previous community upload finishes late', async () => {
    const communityA = 'c3'.repeat(16);
    const communityB = 'd4'.repeat(16);
    const channelB = 'e5'.repeat(16);
    const configB = { channelId: channelB, template: 'Welcome to B, {member}!', serverName: 'Server B' };
    let resolveA: ((value: { requestId: string; upload: 'accepted' }) => void) | undefined;
    const requests: Parameters<WelcomeSettingsGateway['request']>[0][] = [];
    let response: { requestId: string; operation: number; status: number; revision: string | null; data: Uint8Array } | null = null;
    const gateway: WelcomeSettingsGateway = {
      request: input => {
        requests.push(input);
        return input.communityId === communityA
          ? new Promise(resolve => { resolveA = resolve; })
          : Promise.resolve({ requestId: input.requestId, upload: 'accepted' as const });
      },
      read: vi.fn(async communityId => ({ responses: response === null || communityId !== communityB ? [] : [{ deliveryId: '1',
        communityId: communityB, channelId: null, sourceSeq: '1', ...response }], through: response === null ? null : '1', blocked: false })),
      ack: vi.fn(async () => null),
    };
    const view = render(<WelcomeSettingsPanel communityId={communityA} serverName="Server A" channels={[{ id: CHANNEL, name: 'general' }]}
      enabled canManage gateway={gateway} />);
    fireEvent.click(screen.getByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(requests).toHaveLength(1));

    view.rerender(<WelcomeSettingsPanel communityId={communityB} serverName="Server B" channels={[{ id: channelB, name: 'general-b' }]}
      enabled canManage gateway={gateway} />);
    fireEvent.click(await screen.findByRole('button', { name: en['admin.bot.welcomeSettings.load'] }));
    await waitFor(() => expect(requests).toHaveLength(2));
    const requestB = requests[1]!;
    await act(async () => { resolveA?.({ requestId: requests[0]!.requestId, upload: 'accepted' }); });
    response = { requestId: requestB.requestId, operation: 1, status: 0, revision: '9', data: encodeWelcomeSettings(configB) };

    expect(await screen.findByDisplayValue(configB.template)).toBeInTheDocument();
    expect(gateway.ack).toHaveBeenCalledWith(communityB, '1');
    expect(gateway.read).toHaveBeenCalledWith(communityB, [1, 2]);
  });
});
