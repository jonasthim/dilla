import type { Meta, StoryObj } from '@storybook/react-vite';
import { TextField } from './TextField.tsx';

// Every string is L-COPY-01's (onboarding.identity.*, onboarding.connect.*, onboarding.error.*).
const HINT = '3 to 32 characters: a–z, 0–9, dot, underscore or hyphen.';
const meta = {
  title: 'Form/TextField', component: TextField,
  args: { id: 'username', label: 'Username', value: '', onChange: () => {}, autoComplete: 'username', spellCheck: false },
  decorators: [Story => <div style={{ maxWidth: 480 }}><Story /></div>],
} satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Filled: Story = { args: { value: 'ada' } };
export const Hint: Story = { args: { hint: HINT } };
export const Invalid: Story = { args: { value: 'ada', hint: HINT, error: 'That username is taken. Try another.' } };
export const Password: Story = { args: { id: 'password', label: 'Password', type: 'password', value: '1234567', hint: 'At least 8 characters.', error: 'Use at least 8 characters.', autoComplete: 'new-password' } };
export const Disabled: Story = { args: { id: 'invite', label: 'Invite', value: 'k7qm3zrdw0pahv5cj8zem4tbs6', hint: 'A code or a link, as you received it.', disabled: true } };
