import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Pill } from './Pill.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Pill', () => {
  it('names unread and mention counts for assistive tech', () => {
    render(<><Pill kind="unread" count={4} /><Pill kind="mention" count={12} /></>);
    expect(screen.getByText('4')).toHaveAccessibleName('4 unread');
    expect(screen.getByText('12')).toHaveAccessibleName('12 mentions');
  });
  it('caps display at 99+', () => {
    render(<Pill kind="unread" count={140} />);
    expect(screen.getByText('99+')).toHaveAccessibleName('140 unread');
  });
  it('renders nothing for zero', () => {
    const { container } = render(<Pill kind="unread" count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Pill kind="mention" count={1} /></div>);
    await expectNoAxeViolations(container);
  });
});
