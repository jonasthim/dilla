import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toggle } from './Toggle.tsx';

// Every string is L-COPY-02's (notify.mute).
const meta = {
  title: 'Form/Toggle', component: Toggle,
  args: { id: 'mute-general', label: 'mute', checked: false, onChange: () => {} },
} satisfies Meta<typeof Toggle>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Off: Story = {};
export const On: Story = { args: { checked: true } };
export const Disabled: Story = { args: { checked: true, disabled: true } };
// The per-channel mute of Settings → Notifications: the word `mute` beside the knob (L-UI-20 showLabel).
export const WithLabel: Story = { args: { showLabel: true } };
