import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LinkBanner } from './LinkBanner.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const labels = { offline: 'offline · reconnecting to dilla.thim.dev', connecting: 'connecting to dilla.thim.dev' };

describe('LinkBanner', () => {
  it('keeps an empty status region when online, and the text arrives in the same region', () => {
    const { rerender } = render(<LinkBanner status="online" labels={labels} />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    rerender(<LinkBanner status="offline" labels={labels} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent(labels.offline);
    rerender(<LinkBanner status="online" labels={labels} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });
  it('is a status with the offline text and a danger dot', () => {
    const { container } = render(<LinkBanner status="offline" labels={labels} />);
    expect(screen.getByRole('status')).toHaveTextContent(labels.offline);
    expect(container.querySelector('.d-state-dot')).toHaveAttribute('data-tone', 'danger');
  });
  it('is a status with the connecting text and a pending dot', () => {
    const { container } = render(<LinkBanner status="connecting" labels={labels} />);
    expect(screen.getByRole('status')).toHaveTextContent(labels.connecting);
    expect(container.querySelector('.d-state-dot')).toHaveAttribute('data-tone', 'pending');
  });
  it('has no axe violations', async () => {
    const { container } = render(<div className="d-root"><LinkBanner status="offline" labels={labels} /></div>);
    await expectNoAxeViolations(container);
  });
});
