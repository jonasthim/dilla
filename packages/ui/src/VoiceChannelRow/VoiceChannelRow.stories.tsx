import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceChannelRow } from './VoiceChannelRow.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';

const person = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false, ...more,
});

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/VoiceChannelRow', component: VoiceChannelRow,
  args: {
    name: 'harbour', current: false, joined: false, participants: [person('ada', { speaking: true }), person('bo', { muted: true })],
    labels: {
      open: 'voice {name}', count: '{n} in voice', canHear: 'can hear',
      state: {
        speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
        connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
      },
    },
    onOpen: () => {},
  },
  // The sidebar's width.
  decorators: [Story => <div style={{ width: 240 }}><Story /></div>],
} satisfies Meta<typeof VoiceChannelRow>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Live, not joined: the count and one sub-row per person with their state words. */
export const Live: Story = {};
/** No one in voice: no count and no sub-rows. */
export const Empty: Story = { args: { participants: [] } };
/** This device is in it, and the main pane shows it. */
export const JoinedCurrent: Story = {
  args: { current: true, joined: true, participants: [person('ada', { speaking: true }), person('bo', { muted: true }), person('you')] },
};
export const EveryState: Story = {
  args: {
    participants: [person('ada', { speaking: true, video: true }), person('bo', { muted: true, deafened: true }), person('cy', { screen: true }),
      person('dee', { state: 'connecting' }), person('eli', { state: 'not-heard' }), person('fay', { state: 'unverified' })],
  },
};
/** A bot in voice: the bot tag and `can hear`, visible before anyone joins (brief, trust facts). */
export const BotCanHear: Story = { args: { participants: [person('ada', { speaking: true }), person('relay', { bot: true, web: false })] } };
/** A voice channel readable by this server keeps its readable glyph. */
export const Readable: Story = { args: { readable: true } };
