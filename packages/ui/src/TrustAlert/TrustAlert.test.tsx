import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { TrustAlert } from './TrustAlert.tsx';

it('names a changed contact, has no dismiss button and exposes Compare', async () => {
  const user = userEvent.setup();
  const onVerify = vi.fn();
  const view = render(<TrustAlert kind="changed" name="Ada" labels={{ changed: 'This contact’s identity changed. Compare the number before sending.', unlisted: 'This device is not on the contact’s list.', verify: 'Compare with Ada' }} onVerify={onVerify} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Ada');
  expect(screen.getByRole('alert')).toHaveTextContent('This contact’s identity changed. Compare the number before sending.');
  expect(screen.getAllByRole('button')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Compare with Ada' }));
  expect(onVerify).toHaveBeenCalledOnce();
  await expectNoAxeViolations(view.container);
});

// W-09: the most serious trust state reads like the danger banners beside it: the ✕ glyph and the danger tone.
it('is a danger banner, and stands without an action when there is nothing to compare', async () => {
  const labels = { changed: 'This contact’s identity changed.', unlisted: 'This device is not on the contact’s list.', verify: 'Compare with Ada' };
  const view = render(<TrustAlert kind="changed" name="Ada" labels={labels} />);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveAttribute('data-tone', 'danger');
  expect(alert.querySelector('[aria-hidden="true"]')).toHaveTextContent('✕');
  expect(screen.queryByRole('button')).toBeNull();
  await expectNoAxeViolations(view.container);
});
