import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ActiveVoice, type ActiveVoiceProps } from './ActiveVoice.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';
import meta from './ActiveVoice.stories.tsx';

const person = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false, ...more,
});
const labels: ActiveVoiceProps['labels'] = {
  heading: 'active voice', open: 'voice {name}', count: '{n} in voice',
  state: {
    speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
    connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
  },
};
const channels: ActiveVoiceProps['channels'] = [
  { id: 'v1', name: 'harbour', current: false, joined: true, participants: [person('ada', { speaking: true }), person('bo', { muted: true })] },
  { id: 'v2', name: 'workshop', current: false, joined: false, participants: [person('cy', { screen: true })] },
];

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('ActiveVoice', () => {
  it('is a section headed active voice, listing each live voice as a roving row', async () => {
    const onOpen = vi.fn();
    render(<ActiveVoice channels={channels} labels={labels} onOpen={onOpen} />);
    const section = screen.getByRole('region', { name: 'active voice' });
    expect(within(section).getByRole('heading', { name: 'active voice' })).toBeInTheDocument();
    const rows = within(section).getAllByRole('button');
    expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['voice harbour', 'voice workshop']);
    expect(rows.filter(r => r.tabIndex === 0)).toHaveLength(1);
    expect(within(section).getByText('sharing screen')).toBeInTheDocument();
    await userEvent.keyboard('{Tab}{ArrowDown}{Enter}');
    expect(onOpen).toHaveBeenCalledWith('v2');
  });

  it('renders nothing when no voice is live', () => {
    const { container } = render(<ActiveVoice channels={[]} labels={labels} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><ActiveVoice {...(meta.args as ActiveVoiceProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
