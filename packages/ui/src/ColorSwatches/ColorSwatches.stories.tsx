import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ColorSwatches } from './ColorSwatches.tsx';

// Sample strings only; the real copy comes from the web package's roles.* keys.
const PALETTE = [
  { value: 0x1abc9c, name: 'teal' }, { value: 0x2ecc71, name: 'green' }, { value: 0x3498db, name: 'blue' },
  { value: 0x9b59b6, name: 'purple' }, { value: 0xe91e63, name: 'pink' }, { value: 0xf1c40f, name: 'yellow' },
  { value: 0xe67e22, name: 'orange' }, { value: 0xe74c3c, name: 'red' }, { value: 0x95a5a6, name: 'grey' },
  { value: 0x607d8b, name: 'slate' }, { value: 0x11806a, name: 'dark teal' }, { value: 0x206694, name: 'dark blue' },
];
const CUSTOM = { value: 0x7289da, name: 'custom 7289da' };

function Demo({ options, initial, width }: { options: typeof PALETTE; initial: number; width?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ width, maxWidth: '100%' }}>
      <ColorSwatches label="colour" hint="Shown as a dot beside the name." value={value} options={options} noneLabel="no colour" onChange={setValue} />
    </div>
  );
}

const meta: Meta = { title: 'Form/ColorSwatches' };
export default meta;
type Story = StoryObj;

export const None: Story = { render: () => <Demo options={PALETTE} initial={0} /> };
export const Selected: Story = {
  render: () => <Demo options={PALETTE} initial={0x3498db} />,
  // Keyboard in a real browser: the arrows move and select, wrapping through the "no colour" option.
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    c.getByRole('radio', { name: 'blue' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(c.getByRole('radio', { name: 'purple' })).toHaveFocus();
    await expect(c.getByRole('radio', { name: 'purple' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await expect(c.getByRole('radio', { name: 'teal' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await expect(c.getByRole('radio', { name: 'dark blue' })).toHaveFocus();
  },
};
/** The palette plus a custom 13th option the person set elsewhere. */
export const WithCustom: Story = { render: () => <Demo options={[...PALETTE, CUSTOM]} initial={CUSTOM.value} /> };
export const Narrow: Story = { render: () => <Demo options={[...PALETTE, CUSTOM]} initial={0xe74c3c} width={360} /> };
