import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';

const labels = { title: 'Diagnostics', copy: 'Copy codes', fields: { connection: 'Connection state', generation: 'Build generation', instance: 'Server instance', devices: 'Known devices' } };

// @ts-expect-error A caller must supply every visible field name.
const incompleteLabels: Parameters<typeof DiagnosticsPanel>[0]['labels'] = { title: 'Diagnostics', copy: 'Copy codes' };
void incompleteLabels;

it('renders bounded codes and a copy action without detail', async () => {
  const user = userEvent.setup();
  const onCopy = vi.fn();
  const data = { connection: 'online', generation: '4', instance: 'home', devices: 2, errors: Array.from({ length: 21 }, (_, at) => ({ code: `E_${at}`, at })) };
  const view = render(<DiagnosticsPanel data={data} labels={labels} onCopy={onCopy} />);
  expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeInTheDocument();
  expect(view.container.querySelectorAll('[data-error-code]')).toHaveLength(20);
  expect(view.container).not.toHaveTextContent('detail');
  await user.click(screen.getByRole('button', { name: 'Copy codes' }));
  expect(onCopy).toHaveBeenCalledOnce();
  await expectNoAxeViolations(view.container);
});

it('renders every supplied field label with its diagnostic value', () => {
  const data = { connection: 'online', generation: '4', instance: 'home', devices: 2, errors: [] };
  const view = render(<DiagnosticsPanel data={data} labels={labels} onCopy={vi.fn()} />);
  expect(Array.from(view.container.querySelectorAll('dt'), item => item.textContent)).toEqual(Object.values(labels.fields));
  expect(Array.from(view.container.querySelectorAll('dd'), item => item.textContent)).toEqual(['online', '4', 'home', '2']);
});
