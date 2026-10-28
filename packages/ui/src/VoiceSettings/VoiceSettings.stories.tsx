import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceSettings } from './VoiceSettings.tsx';

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9); the device names are the browser's.
const meta = {
  title: 'Voice/VoiceSettings', component: VoiceSettings,
  args: {
    inputs: [{ id: 'mic-1', label: 'USB microphone' }, { id: 'mic-2', label: 'Headset microphone' }],
    outputs: [{ id: 'out-1', label: 'Speakers' }, { id: 'out-2', label: 'Headset' }],
    input: '', output: '', canSelectOutput: true, mode: 'vad', pttKey: null, capturing: false, noise: 'automatic', level: 5,
    // The shipped copy (packages/web/src/strings/en.ts, the prototype's Voice page), as Settings → Voice passes it.
    labels: {
      input: 'Input device', output: 'Output device', systemDefault: 'System default',
      outputUnsupported: 'This browser plays voice on the system default device.', mode: 'Input mode', vad: 'Voice activity', ptt: 'Push to talk',
      pttKey: 'Push-to-talk key', pttNone: 'No key set', pttSet: 'Set key',
      pttPrompt: 'Press the key to use. Escape cancels. It works only while dilla is the active tab.',
      pttRefused: 'That key types text, moves the focus or needs another key. Use one key on its own, such as Pause, Scroll Lock or F13 to F24.',
      noise: 'Noise suppression', automatic: 'Automatic', lightweight: 'Lightweight', off: 'Off', level: 'Input level',
      devices: 'Devices', test: 'Mic test', inputMode: 'Input mode', processing: 'Processing',
      pttHint: 'Works only while the dilla tab is active. F13–F24, Pause, Scroll Lock or Insert.',
      noiseHints: { automatic: 'Picks the best processor this device can run. Falls back to RNNoise.', lightweight: 'Lower CPU, removes less', off: 'Raw microphone, nothing removed' },
    },
    onInput: () => {}, onOutput: () => {}, onMode: () => {}, onCaptureKey: () => {}, onNoise: () => {},
  },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof VoiceSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Voice activity, the default. */
export const VoiceActivity: Story = {};
/** Push to talk with no key yet: there is no default key. */
export const PushToTalkNoKey: Story = { args: { mode: 'ptt' } };
/** README §5.9: push to talk with its shortcut, as the prototype opens it. */
export const PushToTalk: Story = { args: { mode: 'ptt', pttKey: 'F13', input: 'mic-2' } };
/** Listening for the next key: the key box takes the accent and its ring. */
export const PushToTalkListening: Story = { args: { mode: 'ptt', pttKey: 'F13', capturing: true } };
export const CapturingKey: Story = { args: { mode: 'ptt', capturing: true } };
/** A plain letter is refused while capturing: the prompt says why and the capture goes on (M9). */
export const CapturingRefused: Story = {
  args: { mode: 'ptt', capturing: true },
  play: ({ canvasElement }) => {
    const button = canvasElement.querySelector('.d-voice-settings__capture');
    if (!button) throw new Error('CapturingRefused: no capture button');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
  },
};
/** Firefox: the output follows the system default. */
export const OutputUnsupported: Story = { args: { canSelectOutput: false, noise: 'off' } };
/** Automatic while it is a beta: the row's BETA tag (the app's beta build, Automatic picked). */
export const NoiseBeta: Story = { args: { labels: { ...meta.args.labels, noiseTag: 'BETA' } } };
