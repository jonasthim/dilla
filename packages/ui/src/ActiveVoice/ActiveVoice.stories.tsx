import type { Meta, StoryObj } from '@storybook/react-vite';
import { ActiveVoice } from './ActiveVoice.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';

const person = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false, ...more,
});

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9). With no live voice the component renders
// nothing, so that state has no story (a screenshot needs something on the page).
const meta = {
  title: 'Voice/ActiveVoice', component: ActiveVoice,
  args: {
    channels: [{ id: 'v1', name: 'harbour', current: false, joined: false, participants: [person('ada', { speaking: true }), person('bo', { muted: true })] }],
    labels: {
      heading: 'active voice', open: 'voice {name}', count: '{n} in voice',
      state: {
        speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
        connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
      },
    },
    onOpen: () => {},
  },
  decorators: [Story => <div style={{ width: 240 }}><Story /></div>],
} satisfies Meta<typeof ActiveVoice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OneLive: Story = {};
export const JoinedAndAnother: Story = {
  args: {
    channels: [
      { id: 'v1', name: 'harbour', current: true, joined: true, participants: [person('ada', { speaking: true }), person('bo', { muted: true }), person('you')] },
      { id: 'v2', name: 'workshop', current: false, joined: false, participants: [person('cy', { screen: true })] },
    ],
  },
};
