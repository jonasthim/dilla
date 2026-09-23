import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button.tsx';

const meta = { title: 'Primitives/Button', component: Button, args: { children: 'Save changes' } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Accent: Story = { args: { variant: 'accent', keyHint: '⌘↵' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Leave voice', keyHint: 'X' } };
export const Ghost: Story = { args: { variant: 'ghost', children: 'Cancel', keyHint: 'esc' } };
// Pressed state must never be colour-only: the label swaps ("Mute" ->
// "Unmute") via `pressedLabel`, and a `[x]`/`[ ]` mark plus an inset
// underline bar accompany the colour change. Two stories show both states
// so the non-colour cues are visible side by side.
export const Unpressed: Story = { args: { pressed: false, pressedLabel: 'Unmute', children: 'Mute', keyHint: 'M' } };
export const Pressed: Story = { args: { pressed: true, pressedLabel: 'Unmute', children: 'Mute', keyHint: 'M' } };
export const Small: Story = { args: { size: 'sm', children: 'Verify' } };
