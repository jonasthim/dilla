import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageRow } from './MessageRow.tsx';
import { MessageToolbar } from '../MessageToolbar/MessageToolbar.tsx';
import { ReactionBar } from '../ReactionBar/ReactionBar.tsx';
import { AttachmentCard } from '../AttachmentCard/AttachmentCard.tsx';
import { useDrawnImage } from '../internal/drawn-image.ts';

// The state strings are task 24's to own in en.ts; these are the drafts it starts from.
const meta = {
  title: 'Conversation/MessageRow', component: MessageRow,
  args: { author: 'ada', time: '21:02', body: 'anyone up for a round tonight?', state: 'ok' },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof MessageRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ok: Story = {};
export const Own: Story = { args: { author: 'mira', body: 'count me in', own: true } };
export const Web: Story = { args: { author: 'björn', body: 'after nine, still on the boat', tag: 'web' } };
export const Bot: Story = { args: { author: 'loot-bot', body: 'weekly reset in 2 h', tag: 'bot' } };
export const Pending: Story = { args: { author: 'mira', body: 'count me in', own: true, state: 'pending', stateLabel: 'sending' } };
export const Failed: Story = { args: { author: 'mira', body: 'count me in', own: true, state: 'failed', stateLabel: 'not sent', detail: 'E_TOO_LARGE',
  actions: [{ label: 'retry', onAction: () => {} }, { label: 'discard', onAction: () => {} }] } };
export const CannotRead: Story = { args: { state: 'cannot-read', stateLabel: 'This message could not be read on this device.', detail: 'E_SENDER_MISMATCH' } };
export const Deleted: Story = { args: { state: 'deleted', stateLabel: 'message deleted' } };
export const Multiline: Story = { args: { body: 'route for tonight:\n1. harbour\n2. the old mill\n3. back by midnight' } };

// ---- web-2b (L-UI-40): every string is L-COPY-03's, quoted (en.ts gains them in task 9). ----

/** An image card whose thumbnail is drawn on a canvas at story time and shown through a revoked-on-unmount blob: URL. */
function ImageCardStory({ tabbable = true }: { tabbable?: boolean }) {
  const thumbUrl = useDrawnImage(320, 240);
  return <AttachmentCard kind="image" name="drawn.png" size="48 KB" thumbUrl={thumbUrl} w={320} h={240} openLabel="open drawn.png"
    onOpen={() => {}} saveLabel="save drawn.png" state="idle" tabbable={tabbable} />;
}

/** The toolbar shows while the row holds focus: this focuses the row on mount, so the screenshots show it. */
function FocusRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('article')?.focus(); }, []);
  return <div ref={ref} style={{ paddingTop: 24 }}>{children}</div>;
}

const LONG = `${'meet at the harbour after nine, bring the rope and the good lantern. '.repeat(13).trimEnd()} Ok.`;

export const Everything: Story = {
  args: {
    author: 'ada', time: '21:04', state: 'ok', own: true, active: true, seq: '4', msgId: 'ab'.repeat(16), editedLabel: 'edited', pinnedLabel: 'pinned',
    mention: true,
    body: [{ kind: 'text', text: '' }, { kind: 'mention', label: '@mira', me: false, broadcast: false }, { kind: 'text', text: ' bring the map, ' },
      { kind: 'mention', label: '@everyone', me: true, broadcast: true }, { kind: 'text', text: ' meet at the harbour' }],
    reply: { label: 'reply to björn', author: 'björn', excerpt: 'after nine, still on the boat', state: 'ok', jumpLabel: 'go to the original message', onJump: () => {} },
    toolbar: <MessageToolbar label="actions for this message" tabbable items={[
      { id: 'react', label: 'react', onAction: () => {} }, { id: 'reply', label: 'reply', onAction: () => {} },
      { id: 'edit', label: 'edit', onAction: () => {} }, { id: 'pin', label: 'unpin', onAction: () => {} },
      { id: 'delete', label: 'delete', danger: true, onAction: () => {} },
    ]} />,
    attachments: <><ImageCardStory /><AttachmentCard kind="file" name="route.gpx" size="12.4 KB" thumbUrl={null} w={null} h={null}
      openLabel="open route.gpx" saveLabel="save route.gpx" onSave={() => {}} state="idle" tabbable /></>,
    reactions: <ReactionBar label="reactions" tabbable items={[{ emoji: '👍', count: 3, mine: true, name: 'thumbs up, 3' },
      { emoji: '🦀', count: 1, mine: false, name: 'crab, 1' }, { emoji: '🎉', count: 2, mine: false, name: 'party popper, 2' }]}
      onToggle={() => {}} addLabel="add a reaction" onAdd={() => {}} />,
    pendingAction: { label: 'saving…', tone: 'pending' },
  },
  decorators: [Story => <FocusRow><Story /></FocusRow>],
};
export const LongBody: Story = { args: { body: LONG } };
export const MentionsMe: Story = {
  args: { author: 'mira', time: '21:05', mention: true,
    body: [{ kind: 'mention', label: '@ada', me: true, broadcast: false }, { kind: 'text', text: ' are you bringing the map?' }] },
};
export const ReplyMissing: Story = {
  args: { author: 'mira', time: '21:05', body: 'count me in',
    reply: { label: 'reply to björn', author: 'björn', excerpt: '', state: 'missing', stateText: 'the original message cannot be shown here', jumpLabel: 'go to the original message' } },
};
export const ReplyDeleted: Story = {
  args: { author: 'mira', time: '21:05', body: 'count me in',
    reply: { label: 'reply to björn', author: 'björn', excerpt: '', state: 'deleted', stateText: 'the original message was deleted', jumpLabel: 'go to the original message' } },
};
export const PendingEdit: Story = {
  args: { author: 'ada', time: '21:04', own: true, body: 'meet at the harbour at nine', editedLabel: 'edited', pendingAction: { label: 'saving…', tone: 'pending' } },
};
export const FailedReaction: Story = {
  args: { author: 'mira', time: '21:05', body: 'count me in', active: true,
    pendingAction: { label: 'not saved', tone: 'failed', actions: [{ label: 'retry', onAction: () => {} }, { label: 'discard', onAction: () => {} }] } },
};
export const AttachmentOnly: Story = { args: { author: 'björn', time: '21:06', tag: 'web', body: [], attachments: <ImageCardStory tabbable={false} /> } };
export const Flash: Story = { args: { author: 'björn', time: '21:03', tag: 'web', body: 'after nine, still on the boat', flash: true } };
