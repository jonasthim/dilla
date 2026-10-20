import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { VoiceChannelRow, type VoiceChannelRowProps } from './VoiceChannelRow.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import type { VoiceParticipantView } from '../CallTile/CallTile.tsx';
import meta from './VoiceChannelRow.stories.tsx';

const person = (name: string, more: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
  video: false, screen: false, web: true, bot: false, ...more,
});
const labels: VoiceChannelRowProps['labels'] = {
  open: 'voice {name}', count: '{n} in voice', canHear: 'can hear', join: 'join voice',
  state: {
    speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
    connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
  },
};
const base: VoiceChannelRowProps = {
  name: 'harbour', current: false, joined: false, participants: [person('ada', { speaking: true }), person('bo', { muted: true })], labels, onOpen: () => {},
};

afterEach(() => { delete document.documentElement.dataset.theme; });

/** The text a screen reader reads: aria-hidden glyphs left out, white space collapsed. */
function spoken(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('VoiceChannelRow', () => {
  it('is one button named for the voice, with the count, and the people as text below it', async () => {
    const onOpen = vi.fn();
    render(<VoiceChannelRow {...base} onOpen={onOpen} />);
    const row = screen.getByRole('button', { name: 'voice harbour' });
    expect(row).toHaveAccessibleDescription('2 in voice');
    expect(screen.getAllByRole('button')).toEqual([row]);
    const people = screen.getByRole('list');
    expect(within(people).getAllByRole('listitem').map(spoken)).toEqual(['ada', 'bo']);
    expect(within(people).getByRole('img', { name: 'speaking' })).toBeInTheDocument();
    expect(within(people).getByRole('img', { name: 'muted' })).toBeInTheDocument();
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reads the count after the name as harbour · 3, and no count when nobody is in it', () => {
    const { container, rerender } = render(<VoiceChannelRow {...base} participants={[person('a'), person('b'), person('c')]} />);
    expect(container.querySelector('.d-voice-row__title')?.textContent).toBe('harbour · 3');
    expect(container.querySelector('.d-voice-row__name')?.textContent).toBe('harbour');
    rerender(<VoiceChannelRow {...base} participants={[]} />);
    expect(container.querySelector('.d-voice-row__title')?.textContent).toBe('harbour');
  });

  it('the trailing slot holds the join icon button or, when joined, the connected glyph, never both', async () => {
    const onJoin = vi.fn();
    const { container, rerender } = render(<VoiceChannelRow {...base} onJoin={onJoin} />);
    const join = screen.getByRole('button', { name: 'join voice' });
    expect(join.closest('.d-slot')).not.toBeNull();
    expect(container.querySelector('.d-voice-row__connected')).toBeNull();
    await userEvent.click(join);
    expect(onJoin).toHaveBeenCalledTimes(1);
    rerender(<VoiceChannelRow {...base} joined onJoin={onJoin} />);
    expect(screen.queryByRole('button', { name: 'join voice' })).toBeNull();
    const slot = container.querySelector('.d-voice-row > .d-slot') as HTMLElement;
    expect(slot.children).toHaveLength(1);
    expect(slot.querySelector('.d-voice-row__connected svg')).toHaveAttribute('data-icon', 'phone');
    rerender(<VoiceChannelRow {...base} />);
    expect(screen.queryByRole('button', { name: 'join voice' })).toBeNull();
  });

  it('a participant row is data-row at its own height with a 24px avatar, the speaking mark, and the mute glyph in the slot', () => {
    const { container } = render(<VoiceChannelRow {...base} participants={[person('ada', { speaking: true }), person('bo', { muted: true, deafened: true })]} />);
    const [ada, bo] = [...container.querySelectorAll<HTMLElement>('.d-voice-row__person')];
    expect(ada).toHaveAttribute('data-row');
    expect(ada).toHaveAttribute('data-speaking', 'true');
    expect(bo).not.toHaveAttribute('data-speaking');
    expect(ada.querySelector('.d-avatar')).toHaveAttribute('data-size', 'xs');
    const slot = bo.querySelector('.d-slot') as HTMLElement;
    expect([...slot.querySelectorAll('.d-voice-row__state')].map(s => s.getAttribute('data-state'))).toEqual(['muted', 'deafened']);
    expect(slot.querySelector('svg')).toHaveAttribute('data-icon', 'mic-off');
    expect(ada.querySelector('.d-slot')?.children).toHaveLength(0);
  });

  it('the row marker is the volume-2 icon, live or not; live and joined are data attributes', () => {
    const { container, rerender } = render(<VoiceChannelRow {...base} participants={[]} />);
    expect(container.querySelector('.d-voice-row__glyph svg')).toHaveAttribute('data-icon', 'volume-2');
    expect(container.querySelector('.d-voice-row__glyph .d-state-dot')).toBeNull();
    expect(container.querySelector('.d-voice-row')).not.toHaveAttribute('data-live');
    rerender(<VoiceChannelRow {...base} participants={[person('bo', {})]} />);
    expect(container.querySelector('.d-voice-row__glyph svg')).toHaveAttribute('data-icon', 'volume-2');
    expect(container.querySelector('.d-voice-row')).toHaveAttribute('data-live', 'true');
  });

  it('with nobody in voice shows no count and no sub-rows; current and joined are marked', () => {
    const { rerender } = render(<VoiceChannelRow {...base} participants={[]} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('button', { name: 'voice harbour' })).not.toHaveAccessibleDescription();
    rerender(<VoiceChannelRow {...base} current joined />);
    const row = screen.getByRole('button', { name: 'voice harbour' });
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row).toHaveAttribute('data-joined', 'true');
  });

  it('ChannelList renders voice channels as voice rows, still one roving tab stop', async () => {
    const onSelect = vi.fn();
    render(<ChannelList label="channels" title="harbour club" activeId="t1" onSelect={onSelect} emptyLabel="none"
      channels={[{ id: 't1', name: 'general', kind: 'text', readable: false }, { id: 'v1', name: 'harbour', kind: 'voice', readable: false },
        { id: 'v2', name: 'workshop', kind: 'voice', readable: false }]}
      voice={{ labels, rooms: { v1: { joined: true, participants: base.participants } } }} />);
    const harbour = screen.getByRole('button', { name: 'voice harbour' });
    expect(harbour).toHaveAccessibleDescription('2 in voice');
    expect(harbour).toHaveAttribute('data-joined', 'true');
    expect(screen.getByRole('button', { name: 'voice workshop' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').filter(b => b.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard('{Tab}{ArrowDown}');
    expect(harbour).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'voice workshop' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('v2');
  });

  it('keeps the readable-by-this-server glyph of a voice channel, also inside ChannelList (I4)', () => {
    const { rerender } = render(<VoiceChannelRow {...base} readable />);
    expect(screen.getByRole('img', { name: 'Readable by this server' })).toBeInTheDocument();
    rerender(<ChannelList label="channels" title="harbour club" activeId={null} onSelect={() => {}} emptyLabel="none"
      channels={[{ id: 'v1', name: 'harbour', kind: 'voice', readable: true }]} voice={{ labels, rooms: {} }} />);
    expect(screen.getByRole('img', { name: 'Readable by this server' })).toBeInTheDocument();
  });

  it('shows a bot in voice with the bot tag and can hear before anyone joins (I5)', () => {
    render(<VoiceChannelRow {...base} participants={[person('relay', { bot: true, web: false })]} />);
    const row = screen.getByRole('listitem');
    expect(spoken(row)).toBe('relay bot can hear');
  });

  // web3.8 (R29): muted, deafened, camera and screen are 14px icons, speaking a dot; each is a named image with no text.
  it('a glyph-only state is a role=img named and titled by its voice.state word, with no text node', () => {
    render(<VoiceChannelRow {...base} participants={[person('bo', { muted: true, deafened: true, video: true, screen: true, speaking: true })]} />);
    const row = screen.getByRole('listitem');
    const states = [...row.querySelectorAll<HTMLElement>('.d-voice-row__state')];
    // The mute and deafen glyphs are in the trailing slot, after the others.
    expect(states.map(s => s.dataset.state)).toEqual(['video', 'screen', 'speaking', 'muted', 'deafened']);
    expect(states.map(s => s.getAttribute('aria-label'))).toEqual(['camera on', 'sharing screen', 'speaking', 'muted', 'deafened']);
    expect(states.map(s => s.getAttribute('title'))).toEqual(['camera on', 'sharing screen', 'speaking', 'muted', 'deafened']);
    for (const s of states) { expect(s).toHaveAttribute('role', 'img'); expect(s.textContent).toBe(''); }
    expect([states[0], states[1], states[3], states[4]].map(s => s.querySelector('svg')?.getAttribute('data-icon'))).toEqual(['video', 'monitor-up', 'mic-off', 'headphone-off']);
    expect([states[0], states[1], states[3], states[4]].map(s => s.querySelector('svg')?.getAttribute('width'))).toEqual(['14', '14', '14', '14']);
    expect(states[2].querySelector('.d-state-dot')).toHaveAttribute('data-tone', 'ok');
    expect(spoken(row)).toBe('bo');
  });

  it('a muted camera participant shows two icons on one row, named by the labels, and no text besides the name', () => {
    render(<VoiceChannelRow {...base} participants={[person('bo', { muted: true, video: true })]} />);
    const row = screen.getByRole('listitem');
    expect(within(row).getAllByRole('img').map(i => i.getAttribute('aria-label'))).toEqual(['camera on', 'muted']);
    expect(row.querySelectorAll('svg')).toHaveLength(2);
    expect(spoken(row)).toBe('bo');
  });

  it('an unverified participant also shows the unverified stream word, after the icons', () => {
    render(<VoiceChannelRow {...base} participants={[person('bo', { muted: true, state: 'unverified' })]} />);
    const row = screen.getByRole('listitem');
    expect(row.querySelector('.d-voice-row__person-name')?.textContent).toBe('bo');
    expect(row.querySelector('[data-state="unverified"]')).toHaveTextContent('unverified stream');
    expect(spoken(row)).toBe('bounverified stream');
    const kids = [...row.querySelectorAll<HTMLElement>('.d-voice-row__state')].map(s => s.dataset.state);
    expect(kids).toEqual(['unverified', 'muted']);
    expect(row.querySelector('[data-state="unverified"]')).not.toHaveAttribute('role', 'img');
  });

  it('the old font glyphs are gone', () => {
    render(<VoiceChannelRow {...base} participants={[person('bo', { muted: true, deafened: true })]} />);
    expect(screen.getByRole('listitem').textContent).not.toMatch(/[⊘⊗]/);
  });

  it('the voice row marker is volume-2 and never carries a badge', () => {
    const { container } = render(<ChannelList label="channels" title="x" activeId={null} onSelect={() => {}} emptyLabel="none"
      channels={[{ id: 'v1', name: 'harbour', kind: 'voice', readable: false, unread: 3, mentions: 1 }]} voice={{ labels, rooms: {} }} />);
    expect(container.querySelector('.d-voice-row__glyph [data-icon="volume-2"]')).not.toBeNull();
    expect(container.querySelector('.d-chrow__badge, .d-chrow__mention, .d-chrow__count')).toBeNull();
    expect(container.querySelector('.d-voice-row')?.textContent).toBe('harbour');
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceChannelRow {...(meta.args as VoiceChannelRowProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
