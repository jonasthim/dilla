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
  args: { title: 'general', backLabel: 'back to channels', onBack: () => {}, actions: <Button variant="ghost" aria-label="members"><Icon name="ellipsis-vertical" size={22} /></Button> },
  render: args => frame(<PhoneHeader {...args} />),
};
export const LongTitle: Story = {
  args: { title: 'a-channel-with-a-name-that-keeps-going-past-the-edge', backLabel: 'back', onBack: () => {}, actions: <Button variant="ghost" aria-label="members"><Icon name="ellipsis-vertical" size={22} /></Button> },
  render: args => frame(<PhoneHeader {...args} />),
};
export const NoBack: Story = { args: { title: 'activity' }, render: args => frame(<PhoneHeader {...args} />) };

/** Signal §5.10 (the prototype's phone header): 52px, the 44px back, the hash and the name, the topic, threads, members and search (44px targets, Ruling N). */
export const Signal: Story = {
  args: { title: <><span className="d-channel-header__glyph" aria-hidden="true"><Icon name="hash" size={14} /></span><span className="d-phone-header__text">general</span></>,
    topic: 'raids, plans and the bridge troll', backLabel: 'back to channels', onBack: () => {},
    actions: <>
      <Button variant="ghost" aria-label="threads"><Icon name="messages-square" size={14} /></Button>
      <Button variant="ghost" aria-label="members, 6"><Icon name="users" size={14} />6</Button>
      <Button variant="ghost" aria-label="search"><Icon name="search" size={15} /></Button>
    </> },
  globals: { theme: 'signal' },
  render: args => <div data-layout="phone" style={{ maxWidth: 390 }}><PhoneHeader {...args} /></div>,
};
