import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceSettings } from './VoiceSettings.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9); the device names are the browser's.
const meta = {
  title: 'Voice/VoiceSettings', component: VoiceSettings,
  args: {
    inputs: [{ id: 'mic-1', label: 'USB microphone' }, { id: 'mic-2', label: 'Headset microphone' }],
    outputs: [{ id: 'out-1', label: 'Speakers' }, { id: 'out-2', label: 'Headset' }],
    input: '', output: '', canSelectOutput: true, mode: 'vad', pttKey: null, capturing: false, noise: true, level: 5,
    labels: {
      input: 'input device', output: 'output device', systemDefault: 'system default',
      outputUnsupported: 'This browser plays voice on the system default device.', mode: 'input mode', vad: 'voice activity', ptt: 'push to talk',
      pttKey: 'push-to-talk key', pttNone: 'no key set', pttSet: 'set key',
      pttPrompt: 'Press the key to use. Escape cancels. It works only while dilla is the active tab.', noise: 'noise suppression', level: 'input level',
    },
    onInput: () => {}, onOutput: () => {}, onMode: () => {}, onCaptureKey: () => {}, onNoise: () => {},
  },
  decorators: [Story => <div style={{ maxWidth: 640 }}><Story /></div>],
} satisfies Meta<typeof VoiceSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Voice activity, the default. */
export const VoiceActivity: Story = {};
/** Push to talk with no key yet: there is no default key. */
export const PushToTalkNoKey: Story = { args: { mode: 'ptt' } };
export const PushToTalkKey: Story = { args: { mode: 'ptt', pttKey: 'F8', input: 'mic-2' } };
export const CapturingKey: Story = { args: { mode: 'ptt', capturing: true } };
/** Firefox: the output follows the system default. */
export const OutputUnsupported: Story = { args: { canSelectOutput: false, noise: false } };
