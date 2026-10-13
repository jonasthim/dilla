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
  open: 'voice {name}', count: '{n} in voice',
  state: {
    speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
    connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot',
  },
};
const base: VoiceChannelRowProps = {
  name: 'harbour', current: false, joined: false, participants: [person('ada', { speaking: true }), person('bo', { muted: true })], labels, onOpen: () => {},
};

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('VoiceChannelRow', () => {
  it('is one button named for the voice, with the count, and the people as text below it', async () => {
    const onOpen = vi.fn();
    render(<VoiceChannelRow {...base} onOpen={onOpen} />);
    const row = screen.getByRole('button', { name: 'voice harbour' });
    expect(row).toHaveAccessibleDescription('2 in voice');
    expect(screen.getAllByRole('button')).toEqual([row]);
    const people = screen.getByRole('list');
    expect(within(people).getAllByRole('listitem').map(li => li.textContent)).toEqual(['ada speaking', 'bo muted']);
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
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

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceChannelRow {...(meta.args as VoiceChannelRowProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
