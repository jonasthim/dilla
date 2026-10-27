import type { Meta, StoryObj } from '@storybook/react-vite';
import { PhoneHeader } from './PhoneHeader.tsx';
import { Button } from '../Button/Button.tsx';
import { Icon } from '../Icon/Icon.tsx';

// Switch the theme in the toolbar (signal, light, high-contrast). A real 390px phone width.
const meta = { title: 'Shell/PhoneHeader', component: PhoneHeader, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof PhoneHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

const frame = (el: React.ReactNode) => <div style={{ maxWidth: 390 }}>{el}</div>;
export const WithBackAndMenu: Story = {
  args: { title: '[ # general ]', backLabel: 'back to channels', onBack: () => {}, actions: <Button variant="ghost" aria-label="members"><Icon name="ellipsis-vertical" size={22} /></Button> },
  render: args => frame(<PhoneHeader {...args} />),
};
export const LongTitle: Story = {
  args: { title: '[ # a-channel-with-a-name-that-keeps-going-past-the-edge ]', backLabel: 'back', onBack: () => {}, actions: <Button variant="ghost" aria-label="members"><Icon name="ellipsis-vertical" size={22} /></Button> },
  render: args => frame(<PhoneHeader {...args} />),
};
export const NoBack: Story = { args: { title: 'activity' }, render: args => frame(<PhoneHeader {...args} />) };
