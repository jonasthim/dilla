import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MessageEditor, type MessageEditorProps } from './MessageEditor.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

function setup(initial = 'meet at nine', over: Partial<MessageEditorProps> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  function Owner() {
    const [v, setV] = useState(initial);
    return <MessageEditor label="edit your message" value={v} onChange={setV} onSave={onSave} onCancel={onCancel}
      hint="escape to cancel · enter to save" saveLabel="save" cancelLabel="cancel" maxLength={4000} counterLabel={(n) => `${n} left`} {...over} />;
  }
  render(<Owner />);
  return { onSave, onCancel, box: screen.getByRole('textbox', { name: 'edit your message' }) as HTMLTextAreaElement };
}

describe('MessageEditor', () => {
  it('is a named textarea described by its hint, focused with the caret at the end', () => {
    const { box } = setup();
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveValue('meet at nine');
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(12);
    expect(box.selectionEnd).toBe(12);
    expect(box).toHaveAccessibleDescription('escape to cancel · enter to save');
    expect(box.closest('.d-message-editor')).not.toBeNull();
  });

  it('saves on Enter and on the save button; Shift+Enter, IME and repeats do not save', async () => {
    const user = userEvent.setup();
    const { box, onSave } = setup();
    await user.type(box, ' sharp');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(box, { key: 'Enter', repeat: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('meet at nine sharp');
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('cancels on Escape, letting it bubble, and on the cancel button', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const onCancel = vi.fn();
    render(<div onKeyDown={(e) => outer(e.key)}><MessageEditor label="edit your message" value="x" onChange={() => {}} onSave={() => {}} onCancel={onCancel}
      hint="escape to cancel · enter to save" saveLabel="save" cancelLabel="cancel" maxLength={4000} counterLabel={(n) => `${n} left`} /></div>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'edit your message' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledWith('Escape');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('does not cancel on Escape while an IME is composing', () => {
    const { box, onCancel } = setup();
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty text and a text over the budget, measured by the given measure', () => {
    const { box, onSave } = setup('   ');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'save' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the counter near the budget and refuses over it', () => {
    const { box, onSave } = setup('abcd', { maxLength: 10, measure: (v) => v.length * 3 });
    expect(screen.getByText('-2 left')).toHaveAttribute('data-over', 'true');
    expect(box).toHaveAccessibleDescription('escape to cancel · enter to save -2 left');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'save' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'save' })).not.toBeDisabled();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><MessageEditor label="edit your message" value="x" onChange={() => {}} onSave={() => {}}
      onCancel={() => {}} hint="escape to cancel · enter to save" saveLabel="save" cancelLabel="cancel" maxLength={4000} counterLabel={(n) => `${n} left`} /></div>);
    await expectNoAxeViolations(container);
  });
});
