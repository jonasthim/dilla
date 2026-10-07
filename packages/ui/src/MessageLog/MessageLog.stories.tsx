import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageLog } from './MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';
import { MessageToolbar } from '../MessageToolbar/MessageToolbar.tsx';
import { ReactionBar } from '../ReactionBar/ReactionBar.tsx';

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

// ---- web-2b (L-UI-52): the log as one tab stop with a roving row; strings are L-COPY-03's, quoted. ----

/** Focuses the active row on mount, so the screenshots show the toolbar the log shows while focus is inside it. */
function FocusActiveRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('article[data-active="true"]')?.focus(); }, []);
  return <div ref={ref} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

const toolbar = (tabbable: boolean) => (
  <MessageToolbar label="actions for this message" tabbable={tabbable} items={[
    { id: 'react', label: 'react', onAction: () => {} }, { id: 'reply', label: 'reply', onAction: () => {} }, { id: 'pin', label: 'pin', onAction: () => {} },
  ]} />
);
export const RovingRows: Story = {
  args: {
    children: [
      <MessageRow key="1" author="ada" time="21:02" body="anyone up for a round tonight?" state="ok" seq="1" toolbar={toolbar(false)} />,
      <MessageRow key="2" author="björn" time="21:03" body="after nine, still on the boat" state="ok" tag="web" seq="2" active toolbar={toolbar(true)}
        reactions={<ReactionBar label="reactions" tabbable items={[{ emoji: '👍', count: 2, mine: true, name: 'thumbs up, 2' }]}
          onToggle={() => {}} addLabel="add a reaction" onAdd={() => {}} />} />,
      <MessageRow key="3" author="mira" time="21:04" body="count me in" state="ok" seq="3" toolbar={toolbar(false)} />,
    ],
  },
  decorators: [Story => <FocusActiveRow><Story /></FocusActiveRow>],
};
