import type { Meta, StoryObj } from '@storybook/react-vite';
import { FactorRow } from './FactorRow.tsx';

const meta = {
  title: 'Settings/FactorRow', component: FactorRow,
  args: { title: 'Authenticator app', detail: 'Added 5 Oct 2026' },
  decorators: [Story => <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, maxWidth: 640 }}><Story /></ul>],
} satisfies Meta<typeof FactorRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Enabled: Story = { args: { action: () => {}, actionLabel: 'Remove', actionAriaLabel: 'Remove authenticator app' } };
export const Disabled: Story = {
  args: { action: () => {}, actionLabel: 'Remove', actionAriaLabel: 'Remove authenticator app', disabledReason: 'Add another factor before removing this one' },
};
export const NoAction: Story = {};
