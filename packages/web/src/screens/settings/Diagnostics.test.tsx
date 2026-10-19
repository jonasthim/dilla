import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { Diagnostics } from './Diagnostics.tsx';

const withCore = (fake: FakeClient, ui: React.JSX.Element) => <CoreProvider client={fake}>{ui}</CoreProvider>;

it('copies only stable codes and counts listed devices', async () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the copied value is asserted below
  const writeText = vi.fn(async (_text: string) => {});
  const data = { connection: 'online' as const, generation: '8', instance: 'home', devices: 2, errors: [{ code: 'E_CORE_INPUT', at: 1 }, { code: 'E_NOT_FOUND', at: 2 }] };
  const fake = new FakeClient();
  const view = render(withCore(fake, <Diagnostics data={data} instanceName="dilla.test" writeText={writeText} />));
  expect(fake.callsOf('refreshDevices')).toEqual([{ m: 'refreshDevices' }]);
  // W-05: the field label is "devices" and the count its value; the instance is its name, not the hex id.
  expect(Array.from(view.container.querySelectorAll('dt'), dt => dt.textContent)).toEqual(['connection', 'generation', 'instance', 'devices']);
  expect(Array.from(view.container.querySelectorAll('dd'), dd => dd.textContent)).toEqual(['online', '8', 'dilla.test', '2']);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Copy codes' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith('E_CORE_INPUT\nE_NOT_FOUND');
  expect(document.body).not.toHaveTextContent('detail');
});

it('says when no error is recorded', () => {
  render(withCore(new FakeClient(), <Diagnostics data={{ connection: 'online', generation: '8', instance: 'ab'.repeat(16), devices: 1, errors: [] }} instanceName={null} writeText={vi.fn(async () => {})} />));
  expect(screen.getByText('No errors recorded')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('ab'.repeat(16));
});
