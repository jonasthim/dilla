import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { StatusBar, StatusChunk, Meter, BrandMark } from './StatusBar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('StatusBar', () => {
  it('is a labelled region with clickable and static chunks', async () => {
    const onClick = vi.fn();
    render(
      <StatusBar position="bottom" label="Connection">
        <StatusChunk label="node">dilla.thim.dev</StatusChunk>
        <StatusChunk label="voice" tone="ok" onClick={onClick}>OPUS 48kHz</StatusChunk>
      </StatusBar>,
    );
    // A region, not a toolbar: the bar is a strip of facts with the odd
    // button, not a set of grouped controls with arrow-key navigation.
    expect(screen.getByRole('region', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.getByText('dilla.thim.dev').closest('button')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /voice ok OPUS 48kHz/ }));
    expect(onClick).toHaveBeenCalled();
  });
  it('backs a chunk tone with a glyph and a word, never colour alone', () => {
    render(
      <StatusBar position="bottom" label="Connection">
        <StatusChunk label="sync" tone="danger">stalled</StatusChunk>
        <StatusChunk label="node">dilla.thim.dev</StatusChunk>
      </StatusBar>,
    );
    const toned = screen.getByText('stalled').closest('.d-chunk') as HTMLElement;
    expect(toned).toHaveTextContent(/error/);
    expect(screen.getByText('✕')).toHaveAttribute('aria-hidden', 'true');
    const plain = screen.getByText('dilla.thim.dev').closest('.d-chunk') as HTMLElement;
    expect(plain).not.toHaveTextContent(/error|ok|warning/);
    expect(plain.querySelector('[aria-hidden="true"]')).toBeNull();
  });
  it('renders the brand mark with the product name readable once', () => {
    render(<StatusBar position="top" label="Session"><BrandMark /></StatusBar>);
    expect(screen.getByText('DILLA')).toBeInTheDocument();
    expect(screen.queryByText('D')).toHaveAttribute('aria-hidden', 'true');
  });
  it('meter is decorative', () => {
    const { container } = render(<Meter levels={[1, 3, 5, 2, 0, 4, 6, 2, 1, 3, 2, 1]} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('i')).toHaveLength(12);
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><StatusBar position="top" label="Session"><BrandMark /><StatusChunk>server Midgard Crew</StatusChunk></StatusBar></div>);
    await expectNoAxeViolations(container);
  });
});
