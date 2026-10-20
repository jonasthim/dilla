import type { Meta, StoryObj } from '@storybook/react-vite';
import { VoiceChannelRow } from './VoiceChannelRow.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';

const person = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false, ...more,
});

/**
 * web3.8 (R29, U3): in a participant row (`.d-voice-row__person`) or a tile caption (`.d-call-tile__caption`) the name and
 * its glyphs share one line: each glyph's box lies within the name's line box (2px of slack), and the row is one line
 * high. Throws on the first row that wraps or sits off the name's line.
 */
export function expectGlyphLine(root: HTMLElement, story: string): void {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.d-voice-row__person, .d-call-tile__caption'));
  for (const row of rows) {
    const name = row.querySelector<HTMLElement>('.d-voice-row__person-name, .d-call-tile__name');
    if (name === null) throw new Error(`${story}: a row has no name`);
    const line = name.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.height > line.height + 2) throw new Error(`${story}: the row is ${String(box.height)} high, over one line (${String(line.height)})`);
    for (const glyph of Array.from(row.querySelectorAll<HTMLElement>('svg.d-icon, .d-state-dot'))) {
      const r = glyph.getBoundingClientRect();
      if (r.top < line.top - 2 || r.bottom > line.bottom + 2) {
        throw new Error(`${story}: a glyph at ${String(r.top)}-${String(r.bottom)} is off the name's line ${String(line.top)}-${String(line.bottom)}`);
      }
    }
  }
}

// Every string is L-COPY-05's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Voice/VoiceChannelRow', component: VoiceChannelRow,
  excludeStories: ['expectGlyphLine'],
  play: ({ canvasElement }) => { expectGlyphLine(canvasElement, 'VoiceChannelRow'); },
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
/** A long name truncates before its glyphs: they stay on its line, and nothing wraps (R29). */
export const LongNameWithGlyphs: Story = {
  args: { participants: [person('augusta-ada-king-noel-countess-of-lovelace', { muted: true, deafened: true, video: true, screen: true, speaking: true }),
    person('relay', { bot: true, web: false, state: 'unverified', muted: true })] },
};
/** The same list in each theme. */
export const EveryStateLight: Story = { ...EveryState, globals: { theme: 'light' } };
export const EveryStateHighContrast: Story = { ...EveryState, globals: { theme: 'high-contrast' } };
