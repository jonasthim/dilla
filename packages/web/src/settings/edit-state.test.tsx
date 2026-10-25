import { useMemo, useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsEditProvider, useSettingsEdit, useSettingsWorkspace, type SettingsEditState } from './edit-state.tsx';
import { settingsEditing as copy } from '../strings/settingsEditing.ts';
import { requestNavigation } from '../router.ts';

function Draft({ busy = false, canSave = true, saveResult = true }: { busy?: boolean; canSave?: boolean; saveResult?: boolean }) {
  const [dirty, setDirty] = useState(true);
  const [busyState, setBusy] = useState(busy);
  const [saved, setSaved] = useState(false);
  const save = vi.fn(async () => {
    if (saveResult) { setDirty(false); setSaved(true); }
    return saveResult;
  });
  const reset = vi.fn(() => { setDirty(false); setSaved(false); });
  const state = useMemo<SettingsEditState>(() => ({ dirty, busy: busyState, canSave, save, reset }),
    [dirty, busyState, canSave, saveResult]);
  const managed = useSettingsEdit(state);
  const workspace = useSettingsWorkspace();
  return <>
    <output data-testid="managed">{String(managed)}</output>
    <output data-testid="saved">{String(saved)}</output>
    {workspace?.footer}
    {workspace?.confirmation}
    <button type="button" onClick={() => setBusy(false)}>finish request</button>
    <button type="button" onClick={() => setDirty(false)}>clear dirty</button>
  </>;
}

function ManagedDraft(props: React.ComponentProps<typeof Draft>) {
  return <SettingsEditProvider><Draft {...props} /></SettingsEditProvider>;
}

function InlineDraft() {
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(true);
  const [saved, setSaved] = useState(-1);
  const managed = useSettingsEdit({
    dirty, busy: false, canSave: dirty,
    save: async () => { setSaved(revision); setDirty(false); return true; },
    reset: () => setDirty(false),
  });
  const workspace = useSettingsWorkspace();
  return <>
    <output data-testid="inline-managed">{String(managed)}</output>
    <output data-testid="inline-saved">{saved}</output>
    <button type="button" onClick={() => setRevision(value => value + 1)}>change revision</button>
    {workspace?.footer}
    {workspace?.confirmation}
  </>;
}

describe('useSettingsEdit', () => {
  it('keeps standalone forms unmanaged', () => {
    render(<Draft />);
    expect(screen.getByTestId('managed')).toHaveTextContent('false');
    expect(screen.queryByRole('button', { name: copy.save })).not.toBeInTheDocument();
  });

  it('accepts inline state objects and uses the latest operation closures without rerendering forever', async () => {
    const user = userEvent.setup();
    render(<SettingsEditProvider><InlineDraft /></SettingsEditProvider>);
    expect(await screen.findByRole('button', { name: copy.save })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'change revision' }));
    await user.click(screen.getByRole('button', { name: 'change revision' }));
    await user.click(screen.getByRole('button', { name: copy.save }));
    expect(await screen.findByTestId('inline-saved')).toHaveTextContent('2');
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.save })).not.toBeInTheDocument());
  });

  it('shows shared Save and Reset controls, retaining dirty state after a refused save', async () => {
    const user = userEvent.setup();
    render(<ManagedDraft saveResult={false} />);
    await screen.findByRole('button', { name: copy.save });
    await user.click(screen.getByRole('button', { name: copy.save }));
    expect(await screen.findByText(copy.saveFailed)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: copy.reset })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: copy.reset }));
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.save })).not.toBeInTheDocument());
  });

  it('runs a successful save and hides the footer after the section updates its baseline', async () => {
    const user = userEvent.setup();
    render(<ManagedDraft />);
    await user.click(await screen.findByRole('button', { name: copy.save }));
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('true'));
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.save })).not.toBeInTheDocument());
  });

  it('prompts once for router navigation, keeps editing on cancel, and permits after discard', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    render(<ManagedDraft />);
    await screen.findByRole('button', { name: copy.save });
    let request!: Promise<boolean>;
    act(() => { request = requestNavigation(action); });
    const dialog = await screen.findByRole('dialog', { name: copy.leaveTitle });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await expect(requestNavigation(action)).resolves.toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: copy.keepEditing }));
    await expect(request).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    act(() => { request = requestNavigation(action); });
    const nextDialog = await screen.findByRole('dialog', { name: copy.leaveTitle });
    await user.click(within(nextDialog).getByRole('button', { name: copy.discard }));
    await expect(request).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.save })).not.toBeInTheDocument());
  });

  it('guards a pending accepted request and explains that it continues after leaving', async () => {
    const user = userEvent.setup();
    render(<ManagedDraft busy />);
    let request!: Promise<boolean>;
    act(() => { request = requestNavigation(() => undefined); });
    const dialog = await screen.findByRole('dialog', { name: copy.leaveTitle });
    expect(within(dialog).getByText(copy.leaveBusyBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.save })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: copy.discard }));
    await expect(request).resolves.toBe(true);
  });

  it('sets beforeunload protection only while dirty or busy', async () => {
    const user = userEvent.setup();
    render(<ManagedDraft />);
    await screen.findByRole('button', { name: copy.save });
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('button', { name: 'clear dirty' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.save })).not.toBeInTheDocument());
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });
});
