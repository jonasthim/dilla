import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { SafetyCompare } from './SafetyCompare.tsx';

const groups = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(5, '0'));
const key = 'ab'.repeat(32);
const labels = { title: 'Compare safety numbers', copy: 'Copy number', verify: 'I compared every group with this person', close: 'Close', instructions: 'Open Privacy on both devices. Compare all 12 groups over a voice call you started separately or in person.', confirm: 'I compared all 12 groups with this person' };

describe('SafetyCompare', () => {
  it('shows the person, state, exact key and 12 groups; Copy cannot approve', async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    const onCopy = vi.fn();
    const opener = document.createElement('button');
    opener.textContent = 'Compare with Ada';
    document.body.append(opener);
    opener.focus();
    try {
      const view = render(<SafetyCompare open contactName="Ada" state="changed" approvedUmk={key} groups={groups} canVerify labels={labels} onCopy={onCopy} onVerify={onVerify} onClose={() => view.rerender(<SafetyCompare open={false} contactName="Ada" state="changed" approvedUmk={key} groups={groups} canVerify labels={labels} onCopy={onCopy} onVerify={onVerify} onClose={vi.fn()} />)} />);
      const dialog = screen.getByRole('dialog', { name: labels.title });
      expect(dialog).toHaveAccessibleDescription(labels.instructions);
      expect(dialog).toHaveTextContent('Ada');
      expect(dialog).toHaveTextContent('changed');
      expect(dialog).toHaveTextContent(key);
      for (const group of groups) expect(dialog).toHaveTextContent(group);
      const approve = screen.getByRole('button', { name: labels.verify });
      expect(approve).toHaveAttribute('aria-disabled', 'true');
      await user.click(screen.getByRole('button', { name: labels.copy }));
      expect(onCopy).toHaveBeenCalledOnce();
      expect(approve).toHaveAttribute('aria-disabled', 'true');
      await user.click(screen.getByRole('checkbox', { name: labels.confirm }));
      await user.click(approve);
      expect(onVerify).toHaveBeenCalledExactlyOnceWith(key);
      await user.keyboard('{Escape}');
      expect(opener).toHaveFocus();
      view.unmount();
    } finally { opener.remove(); }
  });
  it('keeps approval disabled for missing, malformed or unvalidated public key', async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    const props = { open: true, contactName: 'Ada', state: 'first-seen' as const, groups, labels, onCopy: vi.fn(), onVerify, onClose: vi.fn() };
    const view = render(<SafetyCompare {...props} approvedUmk={null} canVerify={false} />);
    await user.click(screen.getByRole('checkbox', { name: labels.confirm }));
    expect(screen.getByRole('button', { name: labels.verify })).toHaveAttribute('aria-disabled', 'true');
    view.rerender(<SafetyCompare {...props} approvedUmk={'ab'.repeat(31)} canVerify />);
    expect(screen.getByRole('button', { name: labels.verify })).toHaveAttribute('aria-disabled', 'true');
    view.rerender(<SafetyCompare {...props} approvedUmk={key} canVerify={false} />);
    expect(screen.getByRole('button', { name: labels.verify })).toHaveAttribute('aria-disabled', 'true');
    expect(onVerify).not.toHaveBeenCalled();
    await expectNoAxeViolations(view.container);
  });
});
