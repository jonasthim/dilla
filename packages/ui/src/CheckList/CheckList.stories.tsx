import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CheckList, type CheckListItem } from './CheckList.tsx';

// Sample strings only; the real copy comes from the web package's roles.* keys.
const ITEMS: readonly CheckListItem[] = [
  { id: 'mods', label: 'moderators', detail: '3 members', checked: true, disabled: false, color: 0x3498db },
  { id: 'devs', label: 'developers', checked: false, disabled: false, color: 0xe67e22 },
  { id: 'guests', label: 'guests', checked: false, disabled: false, color: null },
  { id: 'owners', label: 'owners', detail: 'You cannot change a role at or above your own.', checked: false, disabled: true, color: 0x9b59b6 },
];

function Demo({ items, busyId = null, width, slow = false }: { items: readonly CheckListItem[]; busyId?: string | null; width?: number; slow?: boolean }) {
  const [state, setState] = useState(items);
  const [busy, setBusy] = useState<string | null>(busyId);
  const toggle = (id: string, checked: boolean) => {
    if (!slow) { setState(cur => cur.map(i => (i.id === id ? { ...i, checked } : i))); return; }
    setBusy(id);
    setTimeout(() => { setState(cur => cur.map(i => (i.id === id ? { ...i, checked } : i))); setBusy(null); }, 50);
  };
  return (
    <div style={{ width, maxWidth: '100%' }}>
      <CheckList label="roles" items={state} busyId={busy} emptyLabel="No roles yet." onToggle={toggle} />
    </div>
  );
}

const meta: Meta = { title: 'Form/CheckList' };
export default meta;
type Story = StoryObj;

export const Default: Story = { render: () => <Demo items={ITEMS} /> };
export const Busy: Story = { render: () => <Demo items={ITEMS} busyId="devs" /> };
export const Empty: Story = { render: () => <Demo items={[]} /> };
export const Narrow: Story = { render: () => <Demo items={ITEMS} width={360} /> };
/** In a real browser a disabled checkbox drops focus; when the change ends, focus is back on the checkbox that was toggled. */
export const FocusReturns: Story = {
  render: () => <Demo items={ITEMS} slow />,
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByRole('checkbox', { name: 'developers' });
    box.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(box).toBeChecked());
    await waitFor(() => expect(box).toHaveFocus());
  },
};
