import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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
    expect(screen.getByRole('img', { name: 'Readable by this server' })).toHaveTextContent('◌');
    rerender(<ChannelHeader name="lfg" readable readableLabel="readable by dilla.thim.dev" />);
    expect(screen.getByRole('img', { name: 'readable by dilla.thim.dev' })).toBeInTheDocument();
  });

  it('holds nothing focusable', () => {
    const { container } = render(<ChannelHeader name="lfg" topic="looking for group" readable />);
    expect(container.querySelectorAll('a, button, input, textarea, select, [tabindex]')).toHaveLength(0);
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ChannelHeader name="lfg" topic="looking for group" readable /></div>);
    await expectNoAxeViolations(container);
  });
});
