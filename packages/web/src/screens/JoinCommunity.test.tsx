import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { JoinCommunity } from './JoinCommunity.tsx';

const B = 'b2'.repeat(16);

function Host({ onJoined }: { onJoined: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>reopen</button>
      <JoinCommunity open={open} onClose={() => setOpen(false)} onJoined={onJoined} />
    </>
  );
}
function setup() {
  const fake = new FakeClient();
  const onJoined = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Host onJoined={onJoined} /></CoreProvider></div>);
  return { fake, onJoined, user, view };
}
const invite = () => screen.getByRole('textbox', { name: 'Invite' });

describe('JoinCommunity', () => {
  it('is a dialog with one field and has no serious axe violations', async () => {
    const { view } = setup();
    expect(screen.getByRole('dialog', { name: 'Join a server' })).toBeInTheDocument();
    expect(invite()).toHaveAccessibleDescription(expect.stringContaining('A server invite, as a code or a link.'));
    await expectNoAxeViolations(view.container);
  });
  it('refuses an empty invite without a call', async () => {
    const { user, fake } = setup();
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(invite()).toHaveAccessibleDescription(expect.stringContaining('Paste an invite first.'));
    expect(fake.calls).toEqual([]);
  });
  it('sends the code of a pasted link and reports the server', async () => {
    const { user, fake, onJoined } = setup();
    fake.handler = () => Promise.resolve({ communityId: B });
    await user.type(invite(), '  https://dilla.test/i/ABCD-EFGH ');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(fake.calls).toEqual([{ m: 'joinCommunity', invite: 'ABCD-EFGH' }]);
    expect(onJoined).toHaveBeenCalledWith(B);
  });
  it('submits on Enter and is busy while joining', async () => {
    const { user, fake } = setup();
    fake.handler = () => new Promise(() => {});
    await user.type(invite(), 'ABCD-EFGH{Enter}');
    expect(fake.calls).toEqual([{ m: 'joinCommunity', invite: 'ABCD-EFGH' }]);
    // Busy, but focusable (A11Y-DESIGN-06, WEB-APP-04; Global Constraints line 98, ruling 20(e)).
    expect(screen.getByRole('button', { name: 'Joining…' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('keeps focus on Join while joining, and sends nothing more', async () => {
    const { user, fake } = setup();
    fake.handler = () => new Promise(() => {});
    await user.type(invite(), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    const joining = screen.getByRole('button', { name: 'Joining…' });
    expect(joining).toHaveFocus();
    expect(joining).not.toBeDisabled();
    await user.keyboard('{Enter}');
    await user.click(joining);
    expect(fake.calls).toEqual([{ m: 'joinCommunity', invite: 'ABCD-EFGH' }]);
  });
  it.each([
    ['E_INVITE_INVALID', 'This invite is expired, used up or unknown.'],
    ['E_INVITE_NOT_COMMUNITY', 'This invite is for the instance, not for a server. Ask for a server invite.'],
    ['E_FORBIDDEN', 'This server does not let your account join.'],
    ['E_INVALID_REQUEST', 'That is not an invite code.'],
    ['E_NETWORK', 'Could not join (E_NETWORK).'],
  ])('%s says so on the field', async (code, message) => {
    const { user, fake, onJoined } = setup();
    fake.handler = () => Promise.reject(refusal({ code }));
    await user.type(invite(), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(invite()).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(onJoined).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();
  });
  it('treats a malformed answer as an error', async () => {
    const { user, fake, onJoined } = setup();
    fake.handler = () => Promise.resolve({ communityId: 'nope' });
    await user.type(invite(), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(invite()).toHaveAccessibleDescription(expect.stringContaining('Could not join (E_BAD_RESULT).'));
    expect(onJoined).not.toHaveBeenCalled();
  });
  it('forgets the field and the error when closed', async () => {
    const { user, fake } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    await user.type(invite(), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    // 'Close' is en.ts 'dialog.close', passed as Dialog's closeLabel.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'reopen' }));
    expect(invite()).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  // Pre-flight ruling (f): an error that is not one of the named refusals gives direction too.
  it('says what to do after an unnamed refusal', async () => {
    const { user, fake } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.type(invite(), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not join (E_NETWORK). Try again.');
    expect(invite()).toHaveFocus();
  });
  // Pre-flight ruling (g): a join refused right after signup opens the dialog with that refusal shown.
  it('shows the error it is opened with, until the field changes', async () => {
    const user = userEvent.setup();
    const fake = new FakeClient();
    const initialError = { code: 'E_INVITE_INVALID', detail: 'spent', status: 410, retryAfterMs: null };
    function ErrorHost() {
      const [open, setOpen] = useState(true);
      return <JoinCommunity open={open} onClose={() => setOpen(false)} onJoined={() => {}} initialInvite="ABCD" initialError={initialError} />;
    }
    render(<div className="d-root"><CoreProvider client={fake}><ErrorHost /></CoreProvider></div>);
    expect(invite()).toHaveValue('ABCD');
    expect(invite()).toHaveAccessibleDescription(expect.stringContaining('This invite is expired, used up or unknown.'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('spent');
    await user.type(invite(), 'E');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});
