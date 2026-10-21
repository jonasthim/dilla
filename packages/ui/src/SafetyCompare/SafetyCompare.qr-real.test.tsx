import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SafetyCompare } from './SafetyCompare.tsx';

const groups = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(5, '0'));
const labels = { title: 'Compare safety numbers', copy: 'Copy number', verify: 'All 12 blocks match', close: 'Close', instructions: 'Read the 12 blocks.', confirm: 'Yes', firstSeen: 'First key for {name}.', showQr: 'show qr', hideQr: 'hide qr', qrLabel: 'Safety number as a QR code' };

// No mock: the real encoder takes the real payload (115 bytes, ECC M) and gives a version 7 symbol, 45 modules plus a quiet zone of 4.
describe('SafetyCompare QR with the real QrCode', () => {
  it('draws a version 7 symbol at 4 px or more per module', async () => {
    const user = userEvent.setup();
    render(<SafetyCompare open contactName="Ada" state="changed" approvedUmk={'ab'.repeat(32)} groups={groups} canVerify labels={labels}
      qrUserId={'aa'.repeat(16)} onCopy={vi.fn()} onVerify={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'show qr' }));
    const svg = screen.getByRole('img', { name: labels.qrLabel });
    const side = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    expect(side).toBe(45 + 2 * 4);
    expect(Number(svg.getAttribute('width')) / side).toBeGreaterThanOrEqual(4);
  });
});
