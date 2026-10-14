import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PermissionGrid, type PermissionGridGroup, type PermValue } from './PermissionGrid.tsx';

// Sample strings only; the real copy comes from the web package's perm.* keys.
const GROUPS: readonly PermissionGridGroup[] = [
  { id: 'general', title: 'General', rows: [
    { id: 'view', label: 'View channels', hint: 'See channels and read them.', disabled: false },
    { id: 'manage', label: 'Manage channels', hint: 'Create, edit and delete channels.', disabled: true, disabledHint: 'You cannot give a right you do not have.' },
  ] },
  { id: 'text', title: 'Text', rows: [
    { id: 'send', label: 'Send messages', hint: 'Post in text channels.', disabled: false },
    { id: 'pin', label: 'Pin messages', hint: 'Pin and unpin messages.', disabled: false },
  ] },
];
const LABELS = { allow: 'allow', inherit: 'inherit', deny: 'deny' };

function Demo({ mode, width, initial }: { mode: 'toggle' | 'tri'; width: number; initial: Record<string, PermValue> }) {
  const [values, setValues] = useState<Record<string, PermValue>>(initial);
  return (
    <div style={{ width, maxWidth: '100%' }}>
      <PermissionGrid label="Permissions" groups={GROUPS} mode={mode} values={values} labels={LABELS}
        onChange={(id, v) => setValues(cur => ({ ...cur, [id]: v }))} />
    </div>
  );
}

const meta: Meta = { title: 'Settings/PermissionGrid' };
export default meta;
type Story = StoryObj;
const render = (mode: 'toggle' | 'tri', width: number, initial: Record<string, PermValue>): Story['render'] => () => <Demo mode={mode} width={width} initial={initial} />;

export const ToggleWide: Story = { render: render('toggle', 1280, { view: 'allow' }) };
export const ToggleNarrow: Story = { render: render('toggle', 360, { view: 'allow' }) };
/** Keyboard in a real browser: the arrows move and select within a row, wrapping; Tab leaves the row. */
export const TriWide: Story = {
  render: render('tri', 1280, { view: 'allow', send: 'deny' }),
  play: async ({ canvasElement }) => {
    const send = within(within(canvasElement).getByRole('radiogroup', { name: 'Send messages' }));
    send.getByRole('radio', { name: 'deny' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(send.getByRole('radio', { name: 'allow' })).toHaveFocus();
    await expect(send.getByRole('radio', { name: 'allow' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowLeft}');
    await expect(send.getByRole('radio', { name: 'deny' })).toHaveFocus();
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('radiogroup', { name: 'Send messages' }).contains(document.activeElement)).toBe(false);
  },
};
export const TriNarrow: Story = { render: render('tri', 360, { view: 'allow', send: 'deny' }) };
/** The "manage channels" row is disabled with its reason shown and described. */
export const DisabledRow: Story = { render: render('tri', 720, { manage: 'inherit' }) };
