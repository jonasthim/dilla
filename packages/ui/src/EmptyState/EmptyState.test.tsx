import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { EmptyState } from './EmptyState.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const TITLE = 'No servers yet';
const BODY = 'Paste an invite to join one.';

describe('EmptyState', () => {
  it('is a region named by its level-two heading, with the body as text', () => {
    const { container } = render(<EmptyState title={TITLE} body={BODY} />);
    const region = screen.getByRole('region', { name: TITLE });
    expect(screen.getByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument();
    expect(region).toHaveTextContent(BODY);
    expect(container.firstElementChild).toHaveClass('d-empty-state');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the action as a button that calls onAction', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<EmptyState title={TITLE} body={BODY} action={{ label: 'join a server', onAction }} />);
    await user.click(screen.getByRole('button', { name: 'join a server' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><EmptyState title={TITLE} body={BODY} action={{ label: 'join a server', onAction: () => {} }} /></div>);
    await expectNoAxeViolations(container);
  });
});
