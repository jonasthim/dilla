import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelHeader } from './ChannelHeader.tsx';
import { Button } from '../Button/Button.tsx';

const meta = { title: 'Shell/ChannelHeader', component: ChannelHeader, args: { name: 'general' } } satisfies Meta<typeof ChannelHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Plain: Story = {};
export const WithTopic: Story = { args: { topic: 'evening plans, screenshots and the odd argument' } };
export const Readable: Story = { args: { name: 'lfg', topic: 'looking for group', readable: true } };
export const DirectMessage: Story = { args: { name: 'ada', kind: 'dm' } };
// web-2b (L-UI-54): the pins button, `shell.pins.open` of L-COPY-03, quoted.
export const WithPinsButton: Story = { args: { topic: 'say hi', actions: <Button variant="ghost">pinned</Button> } };
