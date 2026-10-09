import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { Diagnostics } from './Diagnostics.tsx';

it('copies only stable codes and counts listed devices', async () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the copied value is asserted below
  const writeText = vi.fn(async (_text: string) => {});
  const data = { connection: 'online' as const, generation: '8', instance: 'home', devices: 2, errors: [{ code: 'E_CORE_INPUT', at: 1 }, { code: 'E_NOT_FOUND', at: 2 }] };
  render(<Diagnostics data={data} writeText={writeText} />);
  expect(screen.getByText(/2 devices/)).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Copy codes' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith('E_CORE_INPUT\nE_NOT_FOUND');
  expect(document.body).not.toHaveTextContent('detail');
});
