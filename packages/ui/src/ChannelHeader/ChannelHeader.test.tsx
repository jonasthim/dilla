import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChannelHeader } from './ChannelHeader.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('ChannelHeader', () => {
  it('names the channel in a level-two heading without the decorative brackets', () => {
    const { container } = render(<ChannelHeader name="general" />);
    expect(container.firstElementChild?.tagName).toBe('HEADER');
    expect(container.firstElementChild).toHaveClass('d-channel-header');
    expect(screen.getByRole('heading', { level: 2, name: 'general' })).toBeInTheDocument();
    expect(container.querySelector('.d-channel-header__topic')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the topic when there is one', () => {
    render(<ChannelHeader name="general" topic="evening plans, screenshots and the odd argument" />);
    expect(screen.getByText('evening plans, screenshots and the odd argument')).toHaveClass('d-channel-header__topic');
  });

  it('shows the readable glyph with its default name, or the name the caller gives', () => {
    const { rerender } = render(<ChannelHeader name="lfg" readable />);
    expect(screen.getByRole('img', { name: 'Readable by this server' }).querySelector('[data-icon="eye"]')).not.toBeNull();
    rerender(<ChannelHeader name="lfg" readable readableLabel="readable by dilla.thim.dev" />);
    expect(screen.getByRole('img', { name: 'readable by dilla.thim.dev' })).toBeInTheDocument();
  });

  it('holds nothing focusable', () => {
    const { container } = render(<ChannelHeader name="lfg" topic="looking for group" readable />);
    expect(container.querySelectorAll('a, button, input, textarea, select, [tabindex]')).toHaveLength(0);
  });

  it('heads a direct message with @ in place of #, named by the name alone', () => {
    const { container, rerender } = render(<ChannelHeader name="ada" kind="dm" />);
    expect(screen.getByRole('heading', { level: 2, name: 'ada' })).toBeInTheDocument();
    const brackets = () => [...container.querySelectorAll('.d-channel-header__bracket')];
    expect(brackets().map(b => b.textContent)).toEqual(['[ @ ', ' ]']);
    expect(brackets().map(b => b.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
    expect(container.querySelector('.d-channel-header__name')?.textContent).toBe('[ @ ada ]');
    expect(container.textContent).not.toContain('#');
    rerender(<ChannelHeader name="general" />);
    expect(brackets().map(b => b.textContent)).toEqual(['[ # ', ' ]']);
    rerender(<ChannelHeader name="general" kind="channel" />);
    expect(container.querySelector('.d-channel-header__name')?.textContent).toBe('[ # general ]');
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ChannelHeader name="lfg" topic="looking for group" readable /></div>);
    await expectNoAxeViolations(container);
  });

  it('renders its actions after the topic', () => {
    const { container } = render(<ChannelHeader name="general" topic="say hi" actions={<button type="button">pinned</button>} />);
    const actions = container.querySelector('.d-channel-header__actions')!;
    expect(actions).toContainElement(screen.getByRole('button', { name: 'pinned' }));
    expect(container.querySelector('.d-channel-header__topic')!.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('phone', () => {
    it('renders a PhoneHeader with the back button, the bracketed channel heading and the menu', async () => {
      const onBack = vi.fn();
      const { container } = render(<ChannelHeader name="general" phone={{ backLabel: 'back to channels', onBack, menu: <button type="button">more</button> }} />);
      expect(container.querySelector('.d-phone-header')).not.toBeNull();
      expect(container.querySelector('.d-channel-header')).toBeNull();
      expect(container.querySelector('.d-channel-header__actions')).toBeNull();
      const heading = screen.getByRole('heading', { level: 2, name: 'general' });
      expect(heading.textContent).toBe('[ # general ]');
      expect(screen.getByRole('button', { name: 'more' })).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: 'back to channels' }));
      expect(onBack).toHaveBeenCalledTimes(1);
    });
    it('uses the @ bracket for a direct message', () => {
      render(<ChannelHeader kind="dm" name="ada" phone={{ backLabel: 'back', onBack: () => {} }} />);
      expect(screen.getByRole('heading', { level: 2, name: 'ada' }).textContent).toBe('[ @ ada ]');
    });
    it('keeps the readable cue next to the title on a phone', () => {
      const { container } = render(<ChannelHeader name="lfg" readable readableLabel="readable by dilla.thim.dev" phone={{ backLabel: 'back', onBack: () => {} }} />);
      const cue = screen.getByRole('img', { name: 'readable by dilla.thim.dev' });
      expect(cue.querySelector('[data-icon="eye"]')).not.toBeNull();
      expect(container.querySelector('.d-phone-header')).toContainElement(cue);
      expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName('lfg');
    });
    it('shows no cue on a phone for a channel the server cannot read', () => {
      render(<ChannelHeader name="lfg" phone={{ backLabel: 'back', onBack: () => {} }} />);
      expect(screen.queryByRole('img')).toBeNull();
    });
    it('without phone the markup is the desktop header', () => {
      const { container } = render(<ChannelHeader name="general" />);
      expect(container.querySelector('.d-phone-header')).toBeNull();
      expect(container.querySelector('header')).toHaveClass('d-channel-header');
    });
  });
});
