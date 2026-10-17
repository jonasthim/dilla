import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { Voice } from './Voice.tsx';

vi.hoisted(() => { vi.stubGlobal('__DILLA_NOISE_MODE__', 'beta'); });
afterEach(() => { vi.unstubAllGlobals(); });

it('explains the beta before opt-in, preserves legacy On, and lets the user leave it', async () => {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('settings', { 'voice.noise': 'on' });
  fake.handler = command => {
    if (command.m === 'setSetting') fake.set('settings', { ...fake.get('settings'), [command.key]: command.value! });
    return Promise.resolve(null);
  };
  const user = userEvent.setup();
  render(<CoreProvider client={fake}><Voice /></CoreProvider>);
  expect(screen.getByRole('radio', { name: 'Lightweight' })).toHaveAttribute('aria-checked', 'true');
  expect(fake.callsOf('setSetting')).toHaveLength(0);
  expect(screen.getByText(/beta.*audio glitches/i)).toBeVisible();
  await user.click(screen.getByRole('radio', { name: 'Automatic (beta)' }));
  expect(fake.get('settings')?.['voice.noise']).toBe('automatic');
  expect(screen.getByRole('radio', { name: 'Automatic (beta)' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('radio', { name: 'Lightweight' }));
  expect(fake.get('settings')?.['voice.noise']).toBe('lightweight');
  await user.click(screen.getByRole('radio', { name: 'Off' }));
  expect(fake.get('settings')?.['voice.noise']).toBe('off');
});
