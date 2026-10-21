import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('keeps save disabled after a save until something changes again', async () => {
    const { u } = setup();
    await u.type(status(), 'x');
    await u.click(save());
    expect(await screen.findByRole('status')).toHaveTextContent(t('profile.saved'));
    expect(save()).toBeDisabled();
    await u.type(status(), 'y');
    expect(save()).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('sends the text trimmed', async () => {
    const { fake, u } = setup();
    await u.type(status(), '  hello  ');
    await u.click(save());
    expect(fake.calls).toEqual([{ m: 'updateProfile', statusMsg: 'hello' }]);
  });

  it('names the problem next to the field, without "try again", and does not send', async () => {
    const { fake, u } = setup();
    // a pasted tab or invisible character, a pasted text over the limit, and whitespace only
    fireEvent.change(bio(), { target: { value: `a${String.fromCodePoint(0x09)}b` } });
    expect(screen.getByRole('alert')).toHaveTextContent(t('profile.error.chars'));
    expect(save()).toBeDisabled();
    fireEvent.change(bio(), { target: { value: `a${String.fromCodePoint(0x202e)}b` } });
    expect(screen.getByRole('alert')).toHaveTextContent(t('profile.error.chars'));
    fireEvent.change(bio(), { target: { value: 'x'.repeat(501) } });
    expect(screen.getByRole('alert')).toHaveTextContent(t('profile.error.long'));
    fireEvent.change(bio(), { target: { value: '   ' } });
    expect(screen.getByRole('alert')).toHaveTextContent(t('profile.error.blank'));
    expect(bio()).toHaveAccessibleDescription(expect.stringContaining(t('profile.error.blank')));
    expect(bio()).toBeInvalid();
    fireEvent.change(status(), { target: { value: 'y'.repeat(191) } });
    expect(screen.getAllByRole('alert').map(a => a.textContent).join(' ')).not.toMatch(/try again/i);
    await u.click(save());
    expect(fake.calls).toEqual([]);
    fireEvent.change(bio(), { target: { value: 'fine' } });
    fireEvent.change(status(), { target: { value: 'fine' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save()).toBeEnabled();
  });

  it('shows a refusal of the text by the server as a text problem, not as "try again"', async () => {
    const { fake, u } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_INVALID_REQUEST', status: 400 }));
    await u.type(bio(), 'text');
    await u.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('profile.error.chars'));
    expect(alert.textContent).not.toMatch(/try again/i);
    fake.handler = () => Promise.reject(refusal({ code: 'E_BAD_INPUT', status: 0 }));
    await u.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(t('profile.error.chars'));
  });

  it('does not validate a stored display name nobody changed, so status and bio still save', async () => {
    const legacy = `Ada${String.fromCodePoint(0x200b)}L`;
    const { fake, u } = setup({ display: legacy });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save()).toBeDisabled();
    await u.type(status(), 'still works');
    expect(save()).toBeEnabled();
    await u.click(save());
    expect(fake.calls).toEqual([{ m: 'updateProfile', statusMsg: 'still works' }]);
    // editing the name checks it, and putting the same name back is not an edit
    fireEvent.change(display(), { target: { value: `${legacy}x` } });
    expect(screen.getByRole('alert')).toHaveTextContent(t('profile.error.chars'));
    fireEvent.change(display(), { target: { value: legacy } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps what was typed when the account changes under the form, and follows it for a field left alone', async () => {
    const { fake, u } = setup({ statusMsg: 'old' });
    await u.type(bio(), 'my draft');
    fake.set('account', account({ user: { ...ME, display: 'Ada', statusMsg: 'from device two', bio: 'bio from device two' } }));
    await waitFor(() => expect(status()).toHaveValue('from device two'));
    // the bio was being edited: the draft stays
    expect(bio()).toHaveValue('my draft');
    expect(save()).toBeEnabled();
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

  it('tells a rate-limited save to wait', async () => {
    const { fake, u } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_RATE_LIMITED', status: 429, retryAfterMs: 2000 }));
    await u.type(bio(), 'text');
    await u.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(t('profile.error.wait'));
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
