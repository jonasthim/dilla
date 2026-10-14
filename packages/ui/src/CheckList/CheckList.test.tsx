import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CheckList, type CheckListItem } from './CheckList.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const ITEMS: readonly CheckListItem[] = [
  { id: 'mods', label: 'moderators', detail: '3 members', checked: true, disabled: false, color: 0x3498db },
  { id: 'devs', label: 'developers', checked: false, disabled: false, color: null },
  { id: 'boss', label: 'owners', detail: 'You cannot change this role.', checked: false, disabled: true, color: 0 },
];

function setup(over: Partial<Parameters<typeof CheckList>[0]> = {}) {
  const onToggle = vi.fn();
  const utils = render(<CheckList label="roles" items={ITEMS} busyId={null} emptyLabel="No roles yet." onToggle={onToggle} {...over} />);
  return { onToggle, ...utils };
}

describe('CheckList', () => {
  it('is a fieldset named by its legend with one native checkbox per item, in the item state', () => {
    const { container } = setup();
    const set = screen.getByRole('group', { name: 'roles' });
    expect(set.tagName).toBe('FIELDSET');
    expect(container.querySelector('legend')).toHaveTextContent('roles');
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: 'moderators' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'owners' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'developers' })).toBeEnabled();
  });

  it('calls onToggle with the id and the new state on click and on Space', async () => {
    const user = userEvent.setup();
    const { onToggle } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'developers' }));
    expect(onToggle).toHaveBeenLastCalledWith('devs', true);
    await user.tab({ shift: true });
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle.mock.calls.at(-1)).toEqual(['mods', false]);
  });

  it('does not call onToggle for a disabled item', async () => {
    const user = userEvent.setup();
    const { onToggle } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'owners' }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('marks only the busy row aria-disabled and aria-busy, and keeps it focusable', () => {
    setup({ busyId: 'devs' });
    const busy = screen.getByRole('checkbox', { name: 'developers' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toBeEnabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.closest('li')).toHaveAttribute('aria-busy', 'true');
    const other = screen.getByRole('checkbox', { name: 'moderators' });
    expect(other).not.toHaveAttribute('aria-disabled');
    expect(other).not.toHaveAttribute('aria-busy');
    expect(other.closest('li')).not.toHaveAttribute('aria-busy');
  });

  it('describes a row by its detail', () => {
    setup();
    expect(screen.getByRole('checkbox', { name: 'moderators' })).toHaveAccessibleDescription('3 members');
    expect(screen.getByRole('checkbox', { name: 'owners' })).toHaveAccessibleDescription('You cannot change this role.');
    expect(screen.getByRole('checkbox', { name: 'developers' })).not.toHaveAttribute('aria-describedby');
  });

  it('draws the colour dot (aria-hidden, through --d-swatch) for a coloured item only', () => {
    const { container } = setup();
    const dots = container.querySelectorAll<HTMLElement>('.d-role-dot');
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAttribute('aria-hidden', 'true');
    expect(dots[0].style.getPropertyValue('--d-swatch')).toBe('#3498db');
    expect(screen.getByRole('checkbox', { name: 'moderators' }).closest('li')!.contains(dots[0])).toBe(true);
  });

  it('shows the empty label as text and no checkboxes when there are no items', () => {
    setup({ items: [] });
    expect(screen.getByText('No roles yet.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('has no serious axe violations, with items, a busy row and empty', async () => {
    const full = render(<div className="d-root"><CheckList label="roles" items={ITEMS} busyId="devs" emptyLabel="none" onToggle={() => {}} /></div>);
    await expectNoAxeViolations(full.container);
    full.unmount();
    const empty = render(<div className="d-root"><CheckList label="roles" items={[]} busyId={null} emptyLabel="No roles yet." onToggle={() => {}} /></div>);
    await expectNoAxeViolations(empty.container);
  });
});

describe('CheckList busy row', () => {
  it('keeps focus and ignores a click and Space while busy', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<CheckList label="roles" items={ITEMS} busyId="devs" emptyLabel="none" onToggle={onToggle} />);
    const busy = screen.getByRole('checkbox', { name: 'developers' });
    busy.focus();
    await user.keyboard(' ');
    await user.click(busy);
    expect(busy).toHaveFocus();
    expect(busy).not.toBeChecked();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
