import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from './Composer.tsx';
import { ReplyChip } from '../ReplyChip/ReplyChip.tsx';
import { AttachmentTray } from '../AttachmentTray/AttachmentTray.tsx';
import { MentionList } from '../MentionList/MentionList.tsx';

// The Composer is controlled (L-UI-13): each story passes the text as `value`. 69 bytes per line, so 53
// lines (less the last space) leave 344 of the 4000-byte budget and 59 lines are 70 bytes over it.
// The counter words a negative remainder as the shell does (shell.composer.over): never a negative "left".
const LINE = 'meet at the harbour after nine, bring the rope and the good lantern. ';
const meta = {
  title: 'Conversation/Composer', component: Composer,
  args: { label: 'message #general', placeholder: 'message #general', maxLength: 4000, value: '', onChange: () => {}, onSend: () => {},
    sendLabel: 'send', counterLabel: (n: number) => (n < 0 ? `${-n} bytes over the limit` : `${n} left`) },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof Composer>;
export default meta;
type Story = StoryObj<typeof meta>;

// The label shows only while the composer holds focus: this story focuses the field on mount so the
// label (its label part cased as a label, the channel name as given) is visible in the screenshots.
function FocusField({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('textarea')?.focus(); }, []);
  return <div ref={ref}>{children}</div>;
}

export const Empty: Story = {};
export const Disabled: Story = { args: { disabled: true, disabledReason: 'joining this channel' } };
export const NearLimit: Story = { args: { value: LINE.repeat(53).trimEnd() } };
export const OverBudget: Story = { args: { value: LINE.repeat(59).trimEnd() } };
export const Focused: Story = {
  args: { label: 'message #Harbour-Crew', placeholder: 'message #Harbour-Crew' },
  decorators: [Story => <FocusField><Story /></FocusField>],
};

// ---- web-2b (L-UI-53): every string is L-COPY-03's, quoted (en.ts gains them in task 9). ----
const ATTACH = { attachLabel: 'attach files', onAttach: () => {} };
export const WithReplyChip: Story = {
  args: { ...ATTACH, value: 'see you there',
    top: <ReplyChip label="replying to björn" excerpt="after nine, still on the boat" cancelLabel="cancel reply" onCancel={() => {}} /> },
};
export const WithTray: Story = {
  args: { ...ATTACH, canSendEmpty: true,
    top: <AttachmentTray label="files to send" items={[
      { id: 't0', name: 'drawn.png', size: '48 KB', step: 'uploading', failed: false, phase: 'uploading', removeLabel: 'remove drawn.png', onRemove: () => {} },
      { id: 't1', name: 'notes.txt', size: '2 KB', step: 'ready', failed: false, phase: 'ready', removeLabel: 'remove notes.txt', onRemove: () => {} },
    ]} /> },
};
// The list open while typing `@mi`: the textarea is a combobox and points at the list.
export const WithMentionList: Story = {
  args: { ...ATTACH, value: '@mi',
    combobox: { expanded: true, controls: 'mentions', activeDescendant: 'mention-mira', onKey: () => false },
    top: <MentionList id="mentions" label="people to mention" activeId="mention-mira" onPick={() => {}} options={[
      { id: 'mention-mira', primary: 'mira', secondary: '@mira' }, { id: 'mention-mike', primary: 'Mike Dahl', secondary: '@mike' },
    ]} /> },
};
export const WithAttach: Story = { args: { ...ATTACH } };
