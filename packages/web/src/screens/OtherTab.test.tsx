import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { OtherTab } from './OtherTab.tsx';

it('offers hand-over without rendering a leader slice', async () => {
  const onUse = vi.fn();
  render(<OtherTab onUse={onUse} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Use this tab' }));
  expect(onUse).toHaveBeenCalledOnce();
  expect(screen.queryByRole('log')).toBeNull();
});
