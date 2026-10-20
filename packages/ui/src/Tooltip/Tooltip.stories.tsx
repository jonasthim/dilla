import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Tooltip } from './Tooltip.tsx';
import { Button } from '../Button/Button.tsx';

const meta = {
  title: 'Primitives/Tooltip', component: Tooltip,
  args: { label: 'mute', keys: ['Ctrl', 'M'], children: <Button>mute</Button> },
  decorators: [Story => <div style={{ padding: '3rem 6rem' }}><Story /></div>],
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

// The tooltip is drawn on document.body, outside the story root.
const tip = () => within(document.body).queryByRole('tooltip');

// Hover: nothing at once, the tooltip after 400 ms, and Escape takes it away while the button keeps focus.
export const Hover: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'mute' });
    await userEvent.hover(button);
    await expect(tip()).toBeNull();
    await waitFor(() => expect(tip()).not.toBeNull(), { timeout: 1500 });
    await expect(tip()).toHaveTextContent('mute');
    button.focus();
    await userEvent.keyboard('{Escape}');
    await expect(tip()).toBeNull();
    await expect(button).toHaveFocus();
  },
};

// Keyboard focus shows it at once, with the chord at the right.
export const Focus: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('button', { name: 'mute' })).toHaveFocus();
    await expect(tip()).not.toBeNull();
    await expect(within(canvasElement).getByRole('button', { name: 'mute' })).toHaveAccessibleDescription('Ctrl M');
  },
};

export const NoChord: Story = { args: { keys: undefined } };
export const Right: Story = { args: { placement: 'right' }, decorators: [Story => <div style={{ padding: '1rem' }}><Story /></div>] };
export const Bottom: Story = { args: { placement: 'bottom' } };
