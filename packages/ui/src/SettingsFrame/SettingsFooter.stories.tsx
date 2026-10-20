import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsFooter } from './SettingsFooter.tsx';
import { Button } from '../Button/Button.tsx';

const noop = () => {};
const meta = {
  title: 'Settings/SettingsFooter', component: SettingsFooter,
  decorators: [Story => <div style={{ maxWidth: '40rem', padding: '0.625rem 1.375rem', background: 'var(--surface)' }}><Story /></div>],
} satisfies Meta<typeof SettingsFooter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  args: { children: <><Button variant="ghost" onClick={noop}>reset</Button><Button variant="accent" onClick={noop}>save</Button></> },
};
// UI-1's disabled outline (I5): nothing to save yet.
export const NothingToSave: Story = {
  args: { children: <><Button variant="ghost" disabled>reset</Button><Button variant="accent" disabled>save</Button></> },
};
export const Saved: Story = {
  args: { status: 'Saved', children: <><Button variant="ghost" disabled>reset</Button><Button variant="accent" disabled>save</Button></> },
};
export const Failed: Story = {
  args: { status: 'Could not save. Try again.', children: <><Button variant="ghost" onClick={noop}>reset</Button><Button variant="accent" onClick={noop}>save</Button></> },
};
