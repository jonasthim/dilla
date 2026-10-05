import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from './Composer.tsx';

// The Composer is controlled (L-UI-13): each story passes the text as `value`. 69 bytes per line, so 53
// lines (less the last space) leave 344 of the 4000-byte budget and 59 lines are 70 bytes over it.
const LINE = 'meet at the harbour after nine, bring the rope and the good lantern. ';
const meta = {
  title: 'Conversation/Composer', component: Composer,
  args: { label: 'message #general', placeholder: 'message #general', maxLength: 4000, value: '', onChange: () => {}, onSend: () => {},
    sendLabel: 'send', counterLabel: (n: number) => `${n} left` },
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
