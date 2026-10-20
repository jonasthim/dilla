import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SettingsFooter } from './SettingsFooter.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('SettingsFooter', () => {
  it('holds its actions and a status that stays mounted, so a new message is announced', () => {
    const view = render(<SettingsFooter status="Unsaved changes"><button type="button">save</button></SettingsFooter>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Unsaved changes');
    expect(screen.getByRole('button', { name: 'save' })).toBeInTheDocument();
    view.rerender(<SettingsFooter><button type="button">save</button></SettingsFooter>);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('');
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><SettingsFooter status="Saved"><button type="button">save</button></SettingsFooter></div>);
    await expectNoAxeViolations(container);
  });
});
