import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../Button/Button.tsx';
import { InviteLink } from './InviteLink.tsx';

// Every string is flow 07's (docs/design/flows/07-create.md), as en.ts holds it.
const meta = {
  title: 'Shell/InviteLink', component: InviteLink,
  args: {
    open: true, state: 'creating', url: '', status: '', error: null,
    limits: 'It can be used 10 times and expires in 7 days. Anyone who has it can join Midgard Crew.',
    labels: {
      title: 'Invite people to Midgard Crew',
      creating: 'Making an invite link…',
      link: 'Invite link',
      copy: 'copy link',
      close: 'Close',
      retry: 'Try again',
    },
    onCopy: () => {}, onRetry: () => {}, onClose: () => {},
  },
} satisfies Meta<typeof InviteLink>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Creating: Story = {};
export const Copied = {
  args: { state: 'ready', url: 'https://chat.example.org/i/7KQ2-M4ZP-XW9D', status: 'Invite link copied.' },
} satisfies Story;
export const ClipboardBlocked: Story = {
  args: { state: 'ready', url: 'https://chat.example.org/i/7KQ2-M4ZP-XW9D',
    status: 'This browser did not copy the link. Press copy link to try again, or select the link and copy it yourself.' },
};
export const Refused: Story = { args: { state: 'failed', error: 'You cannot invite people to this server.' } };
export const WithExtraAction = {
  args: { state: 'ready', url: 'https://chat.example.org/i/7KQ2-M4ZP-XW9D', status: 'Invite link copied.',
    extra: <Button variant="ghost">more options</Button> },
} satisfies Story;
