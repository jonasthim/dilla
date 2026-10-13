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

// W-05: a time is readable and machine-readable; an empty list says so instead of leaving Copy to copy nothing silently.
it('formats error times and says when there are none', () => {
  const at = Date.UTC(2026, 9, 13, 8, 5, 9);
  const data = { connection: 'online', generation: '4', instance: 'home', devices: 2, errors: [{ code: 'E_X', at }] };
  const view = render(<DiagnosticsPanel data={data} labels={{ ...labels, empty: 'No errors recorded' }} onCopy={vi.fn()} />);
  const time = view.container.querySelector('time');
  expect(time).toHaveAttribute('dateTime', '2026-10-13T08:05:09.000Z');
  expect(time).toHaveTextContent('08:05:09');
  expect(view.container).not.toHaveTextContent(String(at));
  view.rerender(<DiagnosticsPanel data={{ ...data, errors: [] }} labels={{ ...labels, empty: 'No errors recorded' }} onCopy={vi.fn()} formatTime={() => 'x'} />);
  expect(screen.getByText('No errors recorded')).toBeInTheDocument();
});
