import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CodeList, type CodeListProps } from './CodeList.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const CODES = ['k3m7qw9dx2', 'rt0pnahv5c', 'j8zem4tbs6', 'yf1gkdr3wp'] as const;
const LABEL = 'Backup codes';
const LABELS = { copy: 'Copy codes', print: 'Print codes' };

function renderList(over: Partial<CodeListProps> = {}) {
  const props: CodeListProps = { codes: CODES, label: LABEL, onCopy: vi.fn(), onPrint: vi.fn(), labels: LABELS, ...over };
  return { props, ...render(<CodeList {...props} />) };
}

describe('CodeList', () => {
  it('is a real ordered list named by the label with one item per code', () => {
    const { container } = renderList();
    const list = screen.getByRole('list', { name: LABEL });
    expect(list.tagName.toLowerCase()).toBe('ol');
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(within(list).getAllByRole('listitem')).toHaveLength(CODES.length);
  });

  it('shows each code in groups of 5 characters, the last group holding the rest', () => {
    renderList({ codes: ['k3m7qw9dx2', 'abcdefgh'] });
    const items = within(screen.getByRole('list', { name: LABEL })).getAllByRole('listitem');
    expect(items.map(i => i.textContent)).toEqual(['k3m7q w9dx2', 'abcde fgh']);
  });

  it('calls back from Copy and Print, once each', async () => {
    const user = userEvent.setup();
    const { props } = renderList();
    await user.click(screen.getByRole('button', { name: LABELS.copy }));
    expect(props.onCopy).toHaveBeenCalledTimes(1);
    expect(props.onPrint).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: LABELS.print }));
    expect(props.onPrint).toHaveBeenCalledTimes(1);
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><CodeList codes={CODES} label={LABEL} onCopy={() => {}} onPrint={() => {}} labels={LABELS} /></div>);
    await expectNoAxeViolations(container);
  });
});
