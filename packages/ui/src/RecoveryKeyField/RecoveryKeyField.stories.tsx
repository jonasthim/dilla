import type { Meta, StoryObj } from '@storybook/react-vite';
import { RecoveryKeyField } from './RecoveryKeyField.tsx';

// Every string is L-COPY-02's (signin.key.label, signin.key.hint, signin.error.wrongKey); the key is flow 02's sample.
const GROUPED = '7k3m-qw9d-x2rt-0pna-hv5c-j8ze-m4tb-s6yf-1gkd-r3wp-zn7h-c9qx-5tva';
const meta = {
  title: 'Form/RecoveryKeyField', component: RecoveryKeyField,
  args: { id: 'recovery-key', label: 'Recovery key', value: '', hint: '0 of 52 characters', onChange: () => {} },
  decorators: [Story => <div style={{ maxWidth: 480 }}><Story /></div>],
} satisfies Meta<typeof RecoveryKeyField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Typing: Story = { args: { value: '7K3M QW9D X2RT', hint: '12 of 52 characters' } };
export const Pasted: Story = { args: { value: GROUPED, hint: '52 of 52 characters' } };
export const WrongKey: Story = { args: { value: GROUPED, hint: '52 of 52 characters', error: 'This is not the recovery key of this account. Check every character.' } };
export const Disabled: Story = { args: { value: GROUPED, hint: '52 of 52 characters', disabled: true } };
