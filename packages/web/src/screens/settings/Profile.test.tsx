import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { t } from '../../strings/index.ts';
import { Profile } from './Profile.tsx';

function setup(user: { display?: string; statusMsg?: string; bio?: string } = {}) {
  const fake = new FakeClient();
  fake.set('account', account({ user: { ...ME, display: 'Ada', ...user } }));
  const u = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Profile /></CoreProvider></div>);
  return { fake, u, view };
}
const display = () => screen.getByRole('textbox', { name: t('profile.display.label') });
const status = () => screen.getByRole('textbox', { name: t('profile.status.label') });
const bio = () => screen.getByRole('textbox', { name: t('profile.bio.label') });
const save = () => screen.getByRole('button', { name: t('profile.save') });

describe('Settings → Profile', () => {
  it('shows the current display name, status message and bio, and says the server can read them', () => {
    setup({ statusMsg: 'on a call', bio: 'one\ntwo' });
    expect(screen.getByRole('heading', { level: 2, name: t('profile.title') })).toBeInTheDocument();
    expect(display()).toHaveValue('Ada');
    expect(status()).toHaveValue('on a call');
    expect(bio()).toHaveValue('one\ntwo');
    expect(bio().tagName).toBe('TEXTAREA');
    expect(screen.getByText(t('profile.body'))).toBeInTheDocument();
  });

  it('falls back to the username while the display name is not known yet', () => {
    const fake = new FakeClient();
    fake.set('account', account());
    render(<CoreProvider client={fake}><Profile /></CoreProvider>);
    expect(display()).toHaveValue('ada');
  });

  it('keeps save disabled until something changed, then sends only the changed fields', async () => {
    const { fake, u } = setup({ statusMsg: 'old' });
    expect(save()).toBeDisabled();
    await u.clear(status());
    await u.type(status(), 'new status');
    await u.type(bio(), 'hello{Enter}there');
    expect(save()).toBeEnabled();
    await u.click(save());
    expect(fake.calls).toEqual([{ m: 'updateProfile', statusMsg: 'new status', bio: 'hello\nthere' }]);
    expect(await screen.findByRole('status')).toHaveTextContent(t('profile.saved'));
  });

  it('clears a field by sending the empty string', async () => {
    const { fake, u } = setup({ statusMsg: 'old' });
    await u.clear(status());
    await u.click(save());
    expect(fake.calls).toEqual([{ m: 'updateProfile', statusMsg: '' }]);
  });

  it('will not save an empty display name', async () => {
    const { fake, u } = setup();
    await u.clear(display());
    await u.click(save());
    expect(fake.calls).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(t('profile.error.display'));
  });

  it('bounds each field to what the server accepts, and the status message is one line', () => {
    setup();
    expect(display()).toHaveAttribute('maxlength', '64');
    expect(status()).toHaveAttribute('maxlength', '190');
    expect(bio()).toHaveAttribute('maxlength', '500');
    expect(status().tagName).toBe('INPUT');
  });

  it('says so when the save is refused, keeps what was typed, and lets it be tried again', async () => {
    const { fake, u } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK', status: 0 }));
    await u.type(bio(), 'text');
    await u.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(t('profile.error.save'));
    expect(bio()).toHaveValue('text');
    expect(save()).toBeEnabled();
    fake.handler = () => Promise.resolve(null);
    await u.click(save());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent(t('profile.saved'));
  });

  it('follows the account when it changes on another device and nothing is being edited', () => {
    const { fake } = setup();
    fake.set('account', account({ user: { ...ME, display: 'Ada L', statusMsg: 'away' } }));
    return waitFor(() => { expect(display()).toHaveValue('Ada L'); expect(status()).toHaveValue('away'); });
  });

  it('has no serious axe violations', async () => {
    const { view } = setup({ statusMsg: 'x', bio: 'y' });
    await expectNoAxeViolations(view.container);
  });
});
