import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateChannel, type CreateChannelProps } from './CreateChannel.tsx';
import meta from './CreateChannel.stories.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const labels: CreateChannelProps['labels'] = meta.args.labels;
const HINT = 'Shown as #ship-talk. Up to 100 bytes.';

function props(over: Partial<CreateChannelProps> = {}): CreateChannelProps {
  return { open: true, kind: 'text', onKind: vi.fn(), name: '', onName: vi.fn(), hint: HINT, error: null, busy: false, labels,
    onSubmit: vi.fn(), onClose: vi.fn(), ...over };
}

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('CreateChannel', () => {
  it('is a dialog with a kind radio group (text, voice) and a name field, where focus starts', () => {
    render(<CreateChannel {...props()} />);
    const dialog = screen.getByRole('dialog', { name: labels.title });
    const group = within(dialog).getByRole('radiogroup', { name: labels.kind });
    expect(within(group).getAllByRole('radio').map(r => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      [labels.text, 'true'], [labels.voice, 'false'],
    ]);
    const field = screen.getByRole('textbox', { name: labels.name });
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription(HINT);
  });

  it('selection follows the arrows in the kind group; typing and Enter report to the caller', async () => {
    const user = userEvent.setup();
    const p = props({ name: 'ship' });
    render(<CreateChannel {...p} />);
    await user.click(screen.getByRole('radio', { name: labels.text }));
    await user.keyboard('{ArrowRight}');
    expect(p.onKind).toHaveBeenLastCalledWith('voice');
    await user.type(screen.getByRole('textbox', { name: labels.name }), '-talk{Enter}');
    expect(p.onName).toHaveBeenCalled();
    expect(p.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal as the field’s alert; while busy the submit says so and submits nothing', async () => {
    const user = userEvent.setup();
    const p = props({ name: 'ship', busy: true, error: 'You cannot add channels to this server.' });
    render(<CreateChannel {...p} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You cannot add channels to this server.');
    const submit = screen.getByRole('button', { name: labels.busy });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await user.click(submit);
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it('a refusal moves focus back to the field, also after the submit button was pressed', async () => {
    const user = userEvent.setup();
    const p = props({ name: 'loot' });
    const { rerender } = render(<CreateChannel {...p} />);
    await user.click(screen.getByRole('button', { name: labels.submit }));
    rerender(<CreateChannel {...p} error="You cannot add channels to this server." />);
    expect(screen.getByRole('textbox', { name: labels.name })).toHaveFocus();
  });

  it('Escape calls onClose', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<CreateChannel {...p} />);
    await user.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['mesh', 'light', 'high-contrast'])('has no serious axe violations in %s, text and voice', async theme => {
    document.documentElement.dataset.theme = theme;
    for (const over of [{}, { kind: 'voice' as const, error: 'Give the channel a name.' }]) {
      const { container, unmount } = render(<div className="d-root"><CreateChannel {...props(over)} /></div>);
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});
