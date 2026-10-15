import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';
import { Button } from '../Button/Button.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Dialog', () => {
  it('opens as a modal dialog named by its title and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Leave voice?" onClose={onClose}><p>You can rejoin any time.</p></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Leave voice?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('closes only the inner dialog when Escape is pressed inside a nested one', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(<Dialog open title="Outer" onClose={outer}><Dialog open title="Inner" onClose={inner}><Button>inside</Button></Dialog></Dialog>);
    screen.getByRole('button', { name: 'inside' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
  it('is described by the element whose id describedBy names', () => {
    render(<Dialog open title="Ban Astrid?" describedBy="why" onClose={() => {}}><p id="why">They cannot join again.</p></Dialog>);
    expect(screen.getByRole('dialog', { name: 'Ban Astrid?' })).toHaveAccessibleDescription('They cannot join again.');
  });
  it('has no description when describedBy is not given', () => {
    render(<Dialog open title="Ban Astrid?" onClose={() => {}}><p>They cannot join again.</p></Dialog>);
    expect(screen.getByRole('dialog', { name: 'Ban Astrid?' })).not.toHaveAttribute('aria-describedby');
  });
  it('renders nothing visible when closed', () => {
    render(<Dialog open={false} title="Hidden" onClose={() => {}}><p>x</p></Dialog>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('has a close button in the footer by default', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Verify device" onClose={onClose}><p>Compare the code.</p></Dialog>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
  it('closes the native dialog when open flips to false, so the browser returns focus', () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const { rerender } = render(<Dialog open title="Leave voice?" onClose={() => {}}><p>You can rejoin any time.</p></Dialog>);
    expect(close).not.toHaveBeenCalled();
    rerender(<Dialog open={false} title="Leave voice?" onClose={() => {}}><p>You can rejoin any time.</p></Dialog>);
    // close() is what hands focus back to whatever opened the dialog:
    // unmounting the element instead drops it on the document body.
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });
  it('gives every dialog its own title id', () => {
    render(
      <>
        <Dialog open title="Leave voice?" onClose={() => {}}><p>You can rejoin any time.</p></Dialog>
        <Dialog open title="Compare the code" onClose={() => {}}><p>Read the six digits aloud.</p></Dialog>
      </>,
    );
    const [first, second] = screen.getAllByRole('dialog');
    const firstId = first.getAttribute('aria-labelledby');
    expect(firstId).toBeTruthy();
    expect(firstId).not.toBe(second.getAttribute('aria-labelledby'));
    expect(screen.getByRole('dialog', { name: 'Leave voice?' })).toBe(first);
    expect(screen.getByRole('dialog', { name: 'Compare the code' })).toBe(second);
  });
  it('names its close button Close when no closeLabel is given', () => {
    render(<Dialog open title="Leave voice?" onClose={() => {}}><p>You can rejoin any time.</p></Dialog>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
  it('names its close button by closeLabel, and then has no button named Close', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Lämna röst?" onClose={onClose} closeLabel="Stäng"><p>Du kan gå med igen när som helst.</p></Dialog>);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stäng' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Dialog open title="Leave voice?" onClose={() => {}} footer={<Button variant="danger">Leave</Button>}><p>You can rejoin any time.</p></Dialog></div>);
    await expectNoAxeViolations(container);
  });
});

describe('Dialog focus', () => {
  function Opener({ open }: { open: boolean }) {
    return <><button>{'opener'}</button>{open ? <Dialog open title="Edit" onClose={() => {}}><p>x</p></Dialog> : null}</>;
  }
  it('opens on the element inside marked data-autofocus', () => {
    render(<Dialog open title="Edit role" onClose={() => {}}><input aria-label="name" data-autofocus="" /></Dialog>);
    expect(screen.getByRole('textbox', { name: 'name' })).toHaveFocus();
  });
  it('skips a disabled data-autofocus element and opens on the dialog', () => {
    render(<Dialog open title="Edit role" onClose={() => {}}><input aria-label="name" disabled data-autofocus="" /></Dialog>);
    expect(screen.getByRole('dialog', { name: 'Edit role' })).toHaveFocus();
  });
  it('opens on its close button when initialFocus is close and nothing is marked', () => {
    render(<Dialog open title="Roles" closeLabel="Done" initialFocus="close" onClose={() => {}}><p>Nothing to give.</p></Dialog>);
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });
  it('keeps its real opener when a child focuses something inside before the dialog opens', () => {
    // A child's effect runs before Dialog's: the opener must be read before it can move focus into the dialog.
    function Grabby() { useEffect(() => { document.getElementById('grab')?.focus(); }, []); return <input id="grab" aria-label="grab" />; }
    function Host({ open }: { open: boolean }) {
      return <><button>{'opener'}</button>{open ? <Dialog open title="Edit" onClose={() => {}}><Grabby /></Dialog> : null}</>;
    }
    const { rerender } = render(<Host open={false} />);
    screen.getByRole('button', { name: 'opener' }).focus();
    rerender(<Host open />);
    rerender(<Host open={false} />);
    expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus();
  });
  it('returns focus to its opener when it is unmounted while open', () => {
    const { rerender } = render(<Opener open={false} />);
    screen.getByRole('button', { name: 'opener' }).focus();
    rerender(<Opener open />);
    expect(screen.getByRole('dialog', { name: 'Edit' })).toHaveFocus();
    rerender(<Opener open={false} />);
    expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus();
  });
  it('returns focus to the element carrying the opener\'s focus key when the opener was re-mounted', () => {
    // A keyed wrapper re-mounts the opener (a member row moving into another group) while the dialog is open.
    function Moving({ open, at }: { open: boolean; at: 'a' | 'b' }) {
      return <>
        <div key={at}><button data-focus-key="member:u2">{'actions for Bjorn'}</button></div>
        {open ? <Dialog open title="Roles" onClose={() => {}}><p>x</p></Dialog> : null}
      </>;
    }
    const { rerender } = render(<Moving open={false} at="a" />);
    const first = screen.getByRole('button', { name: 'actions for Bjorn' });
    first.focus();
    rerender(<Moving open at="a" />);
    rerender(<Moving open at="b" />);
    const second = screen.getByRole('button', { name: 'actions for Bjorn' });
    expect(second).not.toBe(first);
    rerender(<Moving open={false} at="b" />);
    expect(second).toHaveFocus();
  });
  it('falls back to returnFocus when its opener is gone, never to the body', () => {
    function Gone({ open, opener }: { open: boolean; opener: boolean }) {
      return <>
        <button>{'new role'}</button>
        {opener ? <button>{'delete'}</button> : null}
        {open ? <Dialog open title="Delete" onClose={() => {}} returnFocus={() => screen.getByRole('button', { name: 'new role' })}><p>x</p></Dialog> : null}
      </>;
    }
    const { rerender } = render(<Gone open={false} opener />);
    screen.getByRole('button', { name: 'delete' }).focus();
    rerender(<Gone open opener />);
    rerender(<Gone open opener={false} />);
    rerender(<Gone open={false} opener={false} />);
    expect(screen.getByRole('button', { name: 'new role' })).toHaveFocus();
  });
  it('returns focus the same way when open flips to false while it stays mounted', () => {
    function Stay({ open, at }: { open: boolean; at: 'a' | 'b' }) {
      return <>
        <div key={at}><button data-focus-key="row:1">{'edit'}</button></div>
        <Dialog open={open} title="Edit" onClose={() => {}}><p>x</p></Dialog>
      </>;
    }
    const { rerender } = render(<Stay open={false} at="a" />);
    screen.getByRole('button', { name: 'edit' }).focus();
    rerender(<Stay open at="a" />);
    rerender(<Stay open at="b" />);
    rerender(<Stay open={false} at="b" />);
    expect(screen.getByRole('button', { name: 'edit' })).toHaveFocus();
  });
});
