import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceDock } from './VoiceDock.tsx';
import { AudioMeter } from '../AudioMeter/AudioMeter.tsx';
import { expectVoiceTargets } from '../CallControls/CallControls.stories.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/VoiceDock', component: VoiceDock,
  args: {
    phase: 'connected', where: 'harbour', muted: false, deafened: false, announcement: '',
    labels: {
      region: 'voice controls', connecting: 'connecting', connected: 'in {where}', reconnecting: 'reconnecting', paused: 'paused in {where}',
      mute: 'mute', unmute: 'unmute', deafen: 'deafen', undeafen: 'undeafen', leave: 'leave',
    },
    onMute: () => {}, onDeafen: () => {}, onLeave: () => {},
  },
  // The dock's width is the sidebar's (240 px).
  decorators: [Story => <div style={{ width: 240 }}><Story /></div>],
  // Each control is at least 40 × 40 CSS px (44 × 44 under 48rem of viewport), flow 06.
  play: ({ canvasElement }) => { expectVoiceTargets(canvasElement, 'VoiceDock'); },
} satisfies Meta<typeof VoiceDock>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = { args: { announcement: 'You joined harbour.', meter: <AudioMeter level={6} label="input level" /> } };
export const Connecting: Story = { args: { phase: 'connecting' } };
export const Reconnecting: Story = { args: { phase: 'reconnecting', meter: <AudioMeter level={0} label="input level" /> } };
export const MutedAndDeafened: Story = { args: { muted: true, deafened: true, announcement: 'Sound off.', meter: <AudioMeter level={0} label="input level" /> } };
/** Paused (RV-3): the dock says so; the banner with its action lives on the stage. */
export const Paused: Story = { args: { phase: 'paused' } };
/** A DM call: `{where}` is the DM's name, and the outgoing ring is announced through the dock's status region. */
export const DmRinging: Story = { args: { where: 'ada', announcement: 'ringing ada' } };
