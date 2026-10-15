import type { Meta, StoryObj } from '@storybook/react-vite';
import { CodeList } from './CodeList.tsx';

const meta = {
  title: 'Ceremony/CodeList', component: CodeList,
  args: {
    codes: ['k3m7qw9dx2', 'rt0pnahv5c', 'j8zem4tbs6', 'yf1gkdr3wp', 'n7hz2cq9xa', 'b5tv8ld1um', 'e4sg6rw0oi', 'q2xk9fjy3z'],
    label: 'Backup codes', onCopy: () => {}, onPrint: () => {}, labels: { copy: 'Copy codes', print: 'Print codes' },
  },
} satisfies Meta<typeof CodeList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Wide: Story = { decorators: [Story => <div style={{ width: 1280 }}><Story /></div>] };
export const Narrow: Story = { decorators: [Story => <div style={{ width: 360 }}><Story /></div>] };
