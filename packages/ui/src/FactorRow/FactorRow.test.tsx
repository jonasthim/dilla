import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { FactorRow, type FactorRowProps } from './FactorRow.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

function renderRow(over: Partial<FactorRowProps> = {}) {
  const props: FactorRowProps = { title: 'Authenticator app', detail: 'Added 5 Oct 2026', action: vi.fn(), actionLabel: 'Remove', actionAriaLabel: 'Remove authenticator app', ...over };
  return { props, ...render(<ul><FactorRow {...props} /></ul>) };
}

describe('FactorRow', () => {
  it('shows the title and detail in a list item, and calls the action once', async () => {
    const user = userEvent.setup();
    const { props } = renderRow();
    expect(screen.getByRole('listitem')).toHaveTextContent('Authenticator app');
    expect(screen.getByText('Added 5 Oct 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove authenticator app' }));
    expect(props.action).toHaveBeenCalledTimes(1);
  });

  it('names the action by actionAriaLabel, else by its visible label', () => {
    const { unmount } = renderRow();
    expect(screen.getByRole('button', { name: 'Remove authenticator app' })).toBeInTheDocument();
    unmount();
    renderRow({ actionAriaLabel: undefined });
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('keeps a disabled action focusable, silent, and described by its visible reason', async () => {
    const user = userEvent.setup();
    const { props } = renderRow({ disabledReason: 'Add another factor first' });
    const button = screen.getByRole('button', { name: 'Remove authenticator app' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(screen.getByText('Add another factor first')).toBeVisible();
    expect(button).toHaveAccessibleDescription('Add another factor first');
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(button);
    expect(props.action).not.toHaveBeenCalled();
  });

  it('control: the same row without a reason is enabled and described by nothing extra', async () => {
    const user = userEvent.setup();
    const { props } = renderRow();
    const button = screen.getByRole('button', { name: 'Remove authenticator app' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{Tab}{Enter}');
    expect(props.action).toHaveBeenCalledTimes(1);
  });

  it('renders no button without an action', () => {
    renderRow({ action: undefined, actionLabel: undefined, actionAriaLabel: undefined });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Authenticator app')).toBeInTheDocument();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ul>
      <FactorRow title="Authenticator app" detail="Added 5 Oct 2026" action={() => {}} actionLabel="Remove" actionAriaLabel="Remove authenticator app" disabledReason="Add another factor first" />
    </ul></div>);
    await expectNoAxeViolations(container);
  });
});
