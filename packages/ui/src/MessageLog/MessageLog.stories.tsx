import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageLog } from './MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';

const rows = [
  <MessageRow key="1" author="ada" time="21:02" body="anyone up for a round tonight?" state="ok" />,
  <MessageRow key="2" author="björn" time="21:03" body="after nine, still on the boat" state="ok" tag="web" />,
  <MessageRow key="3" author="mira" time="21:04" body="count me in" state="pending" stateLabel="sending" own />,
];
const meta = {
  title: 'Conversation/MessageLog', component: MessageLog,
  args: { label: 'messages in #general', emptyLabel: 'No messages yet.', children: rows },
  decorators: [Story => <div style={{ height: 360, display: 'flex', flexDirection: 'column' }}><Story /></div>],
} satisfies Meta<typeof MessageLog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WithRows: Story = {};
export const WithEarlier: Story = { args: { earlier: { label: 'load earlier', onLoad: () => {} } } };
export const Empty: Story = { args: { children: [] } };
export const Loading: Story = { args: { busy: true, children: [] } };
