import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { SafetyCompare } from './SafetyCompare.tsx';

vi.mock('../QrCode/QrCode.tsx', () => ({
  QrCode: ({ value, label }: { value: string; label: string }) => <svg role="img" aria-label={label} data-qr-value={value} />,
}));

const groups = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(5, '0'));
const key = 'ab'.repeat(32);
const labels = { title: 'Compare safety numbers', copy: 'Copy number', verify: 'All 12 blocks match', close: 'Close', instructions: 'Read the 12 blocks to each other.', confirm: 'Yes, all 12 blocks match', firstSeen: 'First key for {name}.', showQr: 'show qr', hideQr: 'hide qr', qrLabel: 'Safety number as a QR code' };
const props = { open: true, contactName: 'Ada', state: 'changed' as const, approvedUmk: key, groups, canVerify: true, labels, onCopy: vi.fn(), onVerify: vi.fn(), onClose: vi.fn() };

describe('SafetyCompare QR', () => {
  it('shows no QR until the toggle is pressed, then encodes exactly dilla-sn:1:<userId>:<groups>', async () => {
    const user = userEvent.setup();
    render(<SafetyCompare {...props} qrUserId="u_ada" />);
    expect(screen.queryByRole('img', { name: labels.qrLabel })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'show qr' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'hide qr' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: labels.qrLabel })).toHaveAttribute('data-qr-value', `dilla-sn:1:u_ada:${groups.join('-')}`);
    // The text blocks stay the screen-reader path.
    expect(screen.getByRole('group', { name: labels.title })).toBeInTheDocument();
  });
  it('offers no toggle without a user id or without 12 groups', () => {
    const view = render(<SafetyCompare {...props} />);
    expect(screen.queryByRole('button', { name: 'show qr' })).toBeNull();
    view.rerender(<SafetyCompare {...props} qrUserId="u_ada" groups={[]} />);
    expect(screen.queryByRole('button', { name: 'show qr' })).toBeNull();
  });
  it('passes axe with the QR shown', async () => {
    const user = userEvent.setup();
    const view = render(<SafetyCompare {...props} qrUserId="u_ada" />);
    await user.click(screen.getByRole('button', { name: 'show qr' }));
    await expectNoAxeViolations(view.baseElement);
  });
});
