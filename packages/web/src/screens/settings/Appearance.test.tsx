import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { FakeIdb } from '../../test/fake-idb.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { readTheme, writeTheme } from '../../prefs.ts';
import { applyPreference } from '../../theme.ts';
import { Appearance } from './Appearance.tsx';

afterEach(() => { vi.unstubAllGlobals(); applyPreference(window, 'mesh'); });

function setup(stored: 'system' | 'mesh' | 'light' | 'high-contrast' | null) {
  const idb = new FakeIdb();
  vi.stubGlobal('indexedDB', idb.factory);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  const user = userEvent.setup();
  return { idb, user, ready: stored === null ? Promise.resolve() : writeTheme(stored, idb.factory) };
}
const theme = () => screen.getByRole('radiogroup', { name: 'Theme' });

describe('Appearance', () => {
  it('shows the stored preference and applies and stores a new one', async () => {
    const { user, ready } = setup('light');
    await ready;
    const view = render(<CoreProvider client={new FakeClient()}><Appearance /></CoreProvider>);
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
    expect(within(theme()).getAllByRole('radio')).toHaveLength(4);
    for (const name of ['system', 'mesh', 'light', 'high contrast']) expect(within(theme()).getByRole('radio', { name })).toBeInTheDocument();
    await waitFor(() => expect(within(theme()).getByRole('radio', { name: 'light' })).toHaveAttribute('aria-checked', 'true'));
    await user.click(within(theme()).getByRole('radio', { name: 'high contrast' }));
    expect(document.documentElement.dataset.theme).toBe('high-contrast');
    await waitFor(async () => expect(await readTheme()).toBe('high-contrast'));
    await expectNoAxeViolations(view.container);
  });
  it('starts at system when nothing is stored', async () => {
    setup(null);
    render(<CoreProvider client={new FakeClient()}><Appearance /></CoreProvider>);
    await waitFor(() => expect(within(theme()).getByRole('radio', { name: 'system' })).toHaveAttribute('aria-checked', 'true'));
  });
});
