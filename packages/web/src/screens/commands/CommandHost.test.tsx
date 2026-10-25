import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { CommandHost } from './CommandHost.tsx';

function hostHarness(fake = new FakeClient()) {
  let ordinary = '';
  const literals: string[] = [];
  function Harness() {
    const [mode, setMode] = useState(false);
    const [, rerender] = useState(0);
    return <>
      <textarea aria-label="message" value={ordinary} onChange={event => {
        ordinary = event.currentTarget.value; rerender(n => n + 1);
      }} />
      <CommandHost communityId={null} channelId={'11'.repeat(16)} items={[]} selfId={'22'.repeat(16)}
        draft={ordinary} onDraft={text => { ordinary = text; rerender(n => n + 1); }} onSendLiteral={text => literals.push(text)} encodeMessage={text => text} openGif={() => undefined} gifsEnabled
        onModeChange={setMode} />
      <output>{mode ? 'command mode' : 'chat mode'}</output>
    </>;
  }
  const user = userEvent.setup();
  const view = render(<CoreProvider client={fake}><Harness /></CoreProvider>);
  return { user, view, fake, literals };
}

describe('CommandHost', () => {
  it('routes a slash draft into the production built-in handler and publishes the resulting message', async () => {
    const { user, fake } = hostHarness();
    fireEvent.change(screen.getByRole('textbox', { name: 'message' }), { target: { value: '/me' } });
    expect(screen.getByText('command mode')).toBeInTheDocument();
    const field = screen.getByRole('combobox', { name: 'text' });
    await user.type(field, 'waves');
    await user.click(screen.getByRole('button', { name: /run/i }));
    await screen.findByText('Sent.');
    expect(fake.callsOf('send')).toEqual([{ m: 'send', channelId: '11'.repeat(16), text: '_waves_' }]);
  });

  it('keeps keyboard focus in the command picker after the first slash', async () => {
    const { user } = hostHarness();
    fireEvent.change(screen.getByRole('textbox', { name: 'message' }), { target: { value: '/' } });
    const picker = await screen.findByRole('combobox', { name: 'Command' });
    expect(picker).toHaveFocus();
    await user.type(picker, 'me');
    expect(screen.getByRole('option', { name: /\/me/ })).toBeInTheDocument();
  });

  it('keeps an unknown slash draft private until the explicit send as text action', async () => {
    const { user, fake, literals } = hostHarness();
    fireEvent.change(screen.getByRole('textbox', { name: 'message' }), { target: { value: '/not-a-command' } });
    expect(fake.calls).toEqual([]);
    await user.click(screen.getByRole('button', { name: /send as text/i }));
    expect(literals).toEqual(['/not-a-command']);
    expect(fake.calls).toEqual([]);
  });
});
