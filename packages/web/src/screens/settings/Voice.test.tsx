import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { Voice } from './Voice.tsx';

afterEach(() => { vi.unstubAllGlobals(); });

/** The worker republishes what setSetting stored, as the real one does. */
function setup(settings: Record<string, string> = {}, media?: { permission: PermissionState; devices: MediaDeviceInfo[] }) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('settings', settings);
  fake.handler = command => {
    if (command.m === 'setSetting') {
      const next = { ...fake.get('settings') };
      if (command.value === null) delete next[command.key]; else next[command.key] = command.value;
      fake.set('settings', next);
    }
    return Promise.resolve(null);
  };
  const enumerateDevices = vi.fn(() => Promise.resolve(media?.devices ?? []));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices } });
  Object.defineProperty(navigator, 'permissions', { configurable: true,
    value: { query: vi.fn(() => Promise.resolve({ state: media?.permission ?? 'prompt' })) } });
  const user = userEvent.setup();
  const view = render(<CoreProvider client={fake}><Voice /></CoreProvider>);
  return { fake, user, view, enumerateDevices };
}
const settingCalls = (fake: FakeClient) => fake.callsOf('setSetting').map(c => [c.key, c.value]);

describe('Settings → Voice', () => {
  it('Settings → Voice and → Notifications store their keys through setSetting (the Voice half)', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('radio', { name: 'push to talk' }));
    expect(settingCalls(fake)).toEqual([['voice.mode', 'ptt']]);
    // The capture prompt; F13 is the key.
    await user.click(await screen.findByRole('button', { name: 'set key' }));
    expect(screen.getByText('Press the key to use. Escape cancels. It works only while dilla is the active tab.')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'F13', code: 'F13' });
    expect(settingCalls(fake)).toEqual([['voice.mode', 'ptt'], ['voice.pttKey', 'F13']]);
    expect(await screen.findByText('F13')).toBeInTheDocument();
    // Escape in the prompt stores nothing.
    await user.click(screen.getByRole('button', { name: 'set key' }));
    await user.keyboard('{Escape}');
    expect(settingCalls(fake)).toHaveLength(2);
    expect(screen.queryByText(/Press the key to use/)).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'noise suppression' }));
    expect(settingCalls(fake).at(-1)).toEqual(['voice.noise', 'off']);
  });

  it('shows a stored key that is not one key on its own as unset', () => {
    setup({ 'voice.mode': 'ptt', 'voice.pttKey': 'KeyV' });
    expect(screen.getByText('no key set')).toBeInTheDocument();
    expect(screen.queryByText('KeyV')).toBeNull();
  });

  it('lists devices only after the microphone permission was granted', async () => {
    const mic = { deviceId: 'mic-1', kind: 'audioinput', label: 'Desk mic', groupId: 'g' } as MediaDeviceInfo;
    const first = setup({}, { permission: 'prompt', devices: [mic] });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'input device' })).toBeInTheDocument());
    expect(first.enumerateDevices).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Desk mic' })).toBeNull();
    first.view.unmount();
    const second = setup({}, { permission: 'granted', devices: [mic] });
    expect(await screen.findByRole('option', { name: 'Desk mic' })).toBeInTheDocument();
    expect(second.enumerateDevices).toHaveBeenCalled();
    await second.user.selectOptions(screen.getByRole('combobox', { name: 'input device' }), 'mic-1');
    expect(settingCalls(second.fake).at(-1)).toEqual(['voice.input', 'mic-1']);
  });

  it('has no axe violations', async () => {
    const { view } = setup({ 'voice.mode': 'ptt', 'voice.pttKey': 'F13' });
    await expectNoAxeViolations(view.container);
  });
});
