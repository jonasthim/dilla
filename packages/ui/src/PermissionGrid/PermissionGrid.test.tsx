import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PermissionGrid, type PermissionGridGroup, type PermValue } from './PermissionGrid.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const LABELS = { allow: 'allow', inherit: 'inherit', deny: 'deny' };
const GROUPS: readonly PermissionGridGroup[] = [
  { id: 'general', title: 'General', rows: [
    { id: 'view', label: 'View channels', hint: 'See channels and read them.', disabled: false },
    { id: 'manage', label: 'Manage channels', hint: 'Create, edit and delete channels.', disabled: true, disabledHint: 'You cannot give a right you do not have.' },
  ] },
  { id: 'text', title: 'Text', rows: [
    { id: 'send', label: 'Send messages', hint: 'Post in text channels.', disabled: false },
    { id: 'pin', label: 'Pin messages', hint: 'Pin and unpin.', disabled: false },
  ] },
];

function Controlled({ mode, initial = {}, onValue }: { mode: 'toggle' | 'tri'; initial?: Record<string, PermValue>; onValue?: (id: string, v: PermValue) => void }) {
  const [values, setValues] = useState<Record<string, PermValue>>(initial);
  return (
    <>
      <button type="button">before</button>
      <PermissionGrid label="Permissions" groups={GROUPS} mode={mode} values={values} labels={LABELS}
        onChange={(id, v) => { setValues(cur => ({ ...cur, [id]: v })); onValue?.(id, v); }} />
      <button type="button">after</button>
    </>
  );
}
const row = (name: string) => screen.getByRole('radiogroup', { name });

describe('PermissionGrid', () => {
  it('is a group named by its label with one h3 per group', () => {
    render(<Controlled mode="tri" />);
    expect(screen.getByRole('group', { name: 'Permissions' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['General', 'Text']);
  });

  it('tri: one radiogroup per row, three radios labelled from labels, the value checked (inherit by default)', () => {
    render(<Controlled mode="tri" initial={{ send: 'deny' }} />);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(4);
    const send = within(row('Send messages'));
    expect(send.getAllByRole('radio').map(r => r.textContent)).toEqual(['allow', 'inherit', 'deny']);
    expect(send.getByRole('radio', { name: 'deny' })).toHaveAttribute('aria-checked', 'true');
    expect(within(row('Pin messages')).getByRole('radio', { name: 'inherit' })).toHaveAttribute('aria-checked', 'true');
  });

  it('tri: roving tabindex sits on the checked radio only', () => {
    render(<Controlled mode="tri" initial={{ send: 'allow' }} />);
    const radios = within(row('Send messages')).getAllByRole('radio');
    expect(radios.map(r => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('tri: the arrows move and select within the row and wrap', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled mode="tri" onValue={onValue} />);
    const send = within(row('Send messages'));
    send.getByRole('radio', { name: 'inherit' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(send.getByRole('radio', { name: 'deny' })).toHaveFocus();
    expect(send.getByRole('radio', { name: 'deny' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(send.getByRole('radio', { name: 'allow' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(send.getByRole('radio', { name: 'deny' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(send.getByRole('radio', { name: 'allow' })).toHaveFocus();
    expect(onValue.mock.calls).toEqual([['send', 'deny'], ['send', 'allow'], ['send', 'deny'], ['send', 'allow']]);
  });

  it('tri: Tab goes to the next row, not the next radio', async () => {
    const user = userEvent.setup();
    render(<Controlled mode="tri" />);
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(within(row('View channels')).getByRole('radio', { name: 'inherit' })).toHaveFocus();
    await user.tab();
    // Manage channels is disabled but stays a tab stop, so its reason can be read.
    expect(within(row('Manage channels')).getByRole('radio', { name: 'inherit' })).toHaveFocus();
    await user.tab();
    expect(within(row('Send messages')).getByRole('radio', { name: 'inherit' })).toHaveFocus();
  });

  it('tri: a disabled row ignores keys and clicks and is described by its hint and disabledHint', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled mode="tri" onValue={onValue} />);
    const group = row('Manage channels');
    expect(group).toHaveAttribute('aria-disabled', 'true');
    expect(group).toHaveAccessibleDescription('Create, edit and delete channels. You cannot give a right you do not have.');
    // The tab-stop radio carries the description itself: a screen reader announces it from the radio, not the group.
    const stop = within(group).getByRole('radio', { name: 'inherit' });
    expect(stop).toHaveAccessibleDescription('Create, edit and delete channels. You cannot give a right you do not have.');
    stop.focus();
    await user.keyboard('{ArrowRight}');
    expect(stop).toHaveFocus();
    await user.keyboard('{Home}');
    expect(stop).toHaveFocus();
    await user.click(within(group).getByRole('radio', { name: 'allow' }));
    expect(onValue).not.toHaveBeenCalled();
    expect(within(row('View channels')).getByRole('radio', { name: 'inherit' })).toHaveAccessibleDescription('See channels and read them.');
    expect(row('View channels')).not.toHaveAttribute('aria-disabled');
    expect(row('View channels')).toHaveAccessibleDescription('See channels and read them.');
  });

  it('toggle: one switch per row, on is allow, off is inherit', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled mode="toggle" initial={{ pin: 'allow' }} onValue={onValue} />);
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(screen.queryByRole('radio')).toBeNull();
    const send = screen.getByRole('switch', { name: 'Send messages' });
    expect(send).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Pin messages' })).toHaveAttribute('aria-checked', 'true');
    expect(send).toHaveAccessibleDescription('Post in text channels.');
    await user.click(send);
    await user.click(screen.getByRole('switch', { name: 'Pin messages' }));
    expect(onValue.mock.calls).toEqual([['send', 'allow'], ['pin', 'inherit']]);
  });

  it('toggle: a disabled row is described by hint and disabledHint and ignores activation', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled mode="toggle" onValue={onValue} />);
    const sw = screen.getByRole('switch', { name: 'Manage channels' });
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(sw).toHaveAccessibleDescription('Create, edit and delete channels. You cannot give a right you do not have.');
    await user.click(sw);
    expect(onValue).not.toHaveBeenCalled();
  });

  it('toggle: the disabledHint is its own element with its own id, apart from the hint', () => {
    render(<Controlled mode="toggle" />);
    const sw = screen.getByRole('switch', { name: 'Manage channels' });
    const hint = screen.getByText('Create, edit and delete channels.');
    const reason = screen.getByText('You cannot give a right you do not have.');
    expect(hint).not.toBe(reason);
    expect(hint.id).not.toBe('');
    expect(reason.id).not.toBe('');
    expect(sw.getAttribute('aria-describedby')).toBe(`${hint.id} ${reason.id}`);
  });

  it('tri: Home and End select the first and last radio of a row', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled mode="tri" initial={{ send: 'inherit' }} onValue={onValue} />);
    const send = within(row('Send messages'));
    send.getByRole('radio', { name: 'inherit' }).focus();
    await user.keyboard('{End}');
    expect(send.getByRole('radio', { name: 'deny' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(send.getByRole('radio', { name: 'allow' })).toHaveFocus();
    expect(onValue.mock.calls).toEqual([['send', 'deny'], ['send', 'allow']]);
  });

  it('has no serious axe violations in either mode', async () => {
    const tri = render(<div className="d-root"><Controlled mode="tri" initial={{ send: 'allow' }} /></div>);
    await expectNoAxeViolations(tri.container);
    tri.unmount();
    const toggle = render(<div className="d-root"><Controlled mode="toggle" initial={{ send: 'allow' }} /></div>);
    await expectNoAxeViolations(toggle.container);
  });
});
describe('PermissionGrid heading level', () => {
  it('uses headingLevel for its group headings, so it can sit under a deeper heading', () => {
    render(<PermissionGrid label="Permissions" groups={GROUPS} mode="tri" values={{}} labels={LABELS} onChange={() => {}} headingLevel={5} />);
    expect(screen.getAllByRole('heading', { level: 5 }).map(h => h.textContent)).toEqual(['General', 'Text']);
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });
});
