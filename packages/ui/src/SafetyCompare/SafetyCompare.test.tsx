import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { SafetyCompare } from './SafetyCompare.tsx';

const groups = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(5, '0'));
const key = 'ab'.repeat(32);
const labels = { title: 'Compare safety numbers', copy: 'Copy number', verify: 'All 12 blocks match', close: 'Close', instructions: 'Open Privacy on both devices. Read the 12 blocks of five digits to each other in person or on a call you started yourself.', confirm: 'Yes, all 12 blocks match', firstSeen: 'This is the first key this device saw for {name}. The server could have shown a different one. Compare numbers to verify.' };

describe('SafetyCompare', () => {
  // L-E2E-23: the browser e2e compares the displayed key byte for byte with the native witness and reads each block.
  it('marks the exact public key and each of the 12 blocks for the e2e witness', () => {
    const view = render(<SafetyCompare open contactName="Ada" state="changed" approvedUmk={key} groups={groups} canVerify labels={labels} onCopy={vi.fn()} onVerify={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: labels.title });
    expect([...dialog.querySelectorAll('[data-public-umk]')].map(el => el.textContent)).toEqual([key]);
    expect([...dialog.querySelectorAll('[data-safety-group]')].map(el => el.textContent)).toEqual(groups);
    view.unmount();
  });
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
      expect(dialog).not.toHaveTextContent('This is the first key this device saw for Ada.');
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
  it('requires fresh confirmation when the pending key or groups change', async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    const props = { open: true, contactName: 'Ada', state: 'changed' as const, canVerify: true, labels, onCopy: vi.fn(), onVerify, onClose: vi.fn() };
    const view = render(<SafetyCompare {...props} approvedUmk={key} groups={groups} />);
    const checkbox = screen.getByRole('checkbox', { name: labels.confirm });
    const verify = screen.getByRole('button', { name: labels.verify });
    await user.click(checkbox);
    expect(verify).toHaveAttribute('aria-disabled', 'false');
    const nextKey = 'cd'.repeat(32);
    view.rerender(<SafetyCompare {...props} approvedUmk={nextKey} groups={groups} />);
    expect(checkbox).not.toBeChecked();
    expect(verify).toHaveAttribute('aria-disabled', 'true');
    view.rerender(<SafetyCompare {...props} approvedUmk={key} groups={groups} />);
    expect(checkbox).not.toBeChecked();
    expect(verify).toHaveAttribute('aria-disabled', 'true');
    view.rerender(<SafetyCompare {...props} approvedUmk={nextKey} groups={groups} />);
    await user.click(verify);
    expect(onVerify).not.toHaveBeenCalled();
    await user.click(checkbox);
    expect(verify).toHaveAttribute('aria-disabled', 'false');
    const nextGroups = groups.map((group, index) => index === 0 ? '99999' : group);
    view.rerender(<SafetyCompare {...props} approvedUmk={nextKey} groups={nextGroups} />);
    expect(checkbox).not.toBeChecked();
    expect(verify).toHaveAttribute('aria-disabled', 'true');
    await user.click(checkbox);
    await user.click(verify);
    expect(onVerify).toHaveBeenCalledExactlyOnceWith(nextKey);
  });
  it('renders supplied state copy without changing the typed trust state', () => {
    render(<SafetyCompare open contactName="Ada" state="first-seen" approvedUmk={key} groups={groups} canVerify labels={{ ...labels, states: { 'first-seen': 'First seen here — not verified', changed: 'Identity changed', verified: 'Identity compared', unlisted: 'Device missing' } }} onCopy={vi.fn()} onVerify={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('First seen here — not verified');
    expect(screen.getByRole('dialog')).toHaveTextContent('This is the first key this device saw for Ada. The server could have shown a different one. Compare numbers to verify.');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('first-seen');
  });
  it('focuses Privacy when the opener was the document body', async () => {
    const user = userEvent.setup();
    document.body.focus();
    const props = { contactName: 'Ada', state: 'changed' as const, approvedUmk: key, groups, canVerify: true, labels, onCopy: vi.fn(), onVerify: vi.fn() };
    const view = render(<><h2 data-privacy-heading tabIndex={-1}>Privacy</h2><SafetyCompare {...props} open onClose={() => view.rerender(<><h2 data-privacy-heading tabIndex={-1}>Privacy</h2><SafetyCompare {...props} open={false} onClose={vi.fn()} /></>)} /></>);
    await user.click(screen.getByRole('button', { name: labels.close }));
    expect(screen.getByRole('heading', { name: 'Privacy' })).toHaveFocus();
  });
  it('focuses Privacy when the opener disconnects before closing', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.textContent = 'Compare with Ada';
    document.body.append(opener);
    opener.focus();
    const props = { contactName: 'Ada', state: 'changed' as const, approvedUmk: key, groups, canVerify: true, labels, onCopy: vi.fn(), onVerify: vi.fn() };
    try {
      const view = render(<><h2 data-privacy-heading tabIndex={-1}>Privacy</h2><SafetyCompare {...props} open onClose={() => view.rerender(<><h2 data-privacy-heading tabIndex={-1}>Privacy</h2><SafetyCompare {...props} open={false} onClose={vi.fn()} /></>)} /></>);
      opener.remove();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('heading', { name: 'Privacy' })).toHaveFocus();
    } finally { opener.remove(); }
  });
  // W-11 (a): an approval closes the dialog through its prop; focus still lands on the opener, or Privacy once it is gone.
  it('restores focus when the owner closes it, to Privacy when the opener went', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Compare with Ada';
    document.body.append(opener);
    opener.focus();
    const props = { contactName: 'Ada', state: 'changed' as const, approvedUmk: key, groups, canVerify: true, labels, onCopy: vi.fn(), onVerify: vi.fn(), onClose: vi.fn() };
    try {
      const view = render(<><h2 data-privacy-heading tabIndex={-1}>Privacy</h2><SafetyCompare {...props} open /></>);
      opener.remove();
      view.rerender(<><h2 data-privacy-heading tabIndex={-1}>Privacy</h2><SafetyCompare {...props} open={false} /></>);
      expect(screen.getByRole('heading', { name: 'Privacy' })).toHaveFocus();
    } finally { opener.remove(); }
  });
  // W-11 (b), W-04: the loading state says so, and a failure is Copy-table text inside the dialog, never a raw code.
  it('says the number is loading, and shows an error in place', () => {
    const props = { open: true, contactName: 'Ada', state: 'first-seen' as const, approvedUmk: key, canVerify: true, onCopy: vi.fn(), onVerify: vi.fn(), onClose: vi.fn() };
    const view = render(<SafetyCompare {...props} groups={[]} labels={{ ...labels, loading: 'Working out the number…' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Working out the number…');
    view.rerender(<SafetyCompare {...props} groups={[]} labels={{ ...labels, loading: 'Working out the number…' }} error="The number could not be worked out." />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('The number could not be worked out.');
    view.rerender(<SafetyCompare {...props} groups={groups} labels={labels} />);
    expect(screen.getByRole('group', { name: labels.title })).toBeInTheDocument();
  });
});
