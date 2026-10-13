import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { TabHandover } from './TabHandover.tsx';

it('offers the action only in other-tab and retry in failure', async () => {
  const user = userEvent.setup();
  const onUse = vi.fn();
  const onRetry = vi.fn();
  const labels = { otherTab: 'dilla is open in another tab', use: 'Use this tab', wait: 'Moving to this tab…', failed: 'Close the other tab, then try again.', paused: 'This tab is paused' };
  const view = render(<TabHandover phase="other-tab" labels={labels} onUse={onUse} onRetry={onRetry} />);
  // The status names the state, not only the action: the heading is the explanation, the button stays the action.
  expect(screen.getByRole('status')).toHaveTextContent(labels.otherTab);
  expect(screen.getByRole('heading', { name: labels.otherTab })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: labels.use }));
  expect(onUse).toHaveBeenCalledOnce();
  view.rerender(<TabHandover phase="waiting" labels={labels} onUse={onUse} onRetry={onRetry} />);
  expect(screen.getByRole('status')).toHaveTextContent(labels.wait);
  expect(screen.queryByRole('button', { name: labels.use })).toBeNull();
  view.rerender(<TabHandover phase="failed" labels={labels} onUse={onUse} onRetry={onRetry} />);
  expect(screen.getByRole('status')).toHaveTextContent(labels.failed);
  await user.click(screen.getByRole('button', { name: labels.use }));
  expect(onRetry).toHaveBeenCalledOnce();
  await expectNoAxeViolations(view.container);
});

it('announces the paused copy without offering an action', () => {
  render(<TabHandover phase="paused" labels={{ otherTab: 'dilla is open in another tab', use: 'Use this tab', wait: 'Moving to this tab…', failed: 'Close the other tab, then try again.', paused: 'This tab is paused' }} onUse={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('This tab is paused');
  expect(screen.getByRole('heading', { name: 'This tab is paused' })).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
