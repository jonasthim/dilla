import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Composer, type ComposerProps } from './Composer.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// The Composer is controlled (pre-flight ruling (a), L-UI-13): its owner holds the text. The owner below
// stands in for the shell (task 24): it keeps every edit and, by default, clears the text once a send
// resolves; with clearOnSend false it behaves like a shell whose send was refused, and keeps the text.
type Owner = { clearOnSend?: boolean; initial?: string };
type Over = Partial<Omit<ComposerProps, 'value' | 'onChange' | 'onSend'>>;

function setup(over: Over = {}, owner: Owner = {}) {
  const onSend = vi.fn<(text: string) => void>();
  const onChange = vi.fn<(value: string) => void>();
  const base = { label: 'message #general', placeholder: 'message #general', maxLength: 4000,
    sendLabel: 'send', counterLabel: (n: number) => `${n} left`, ...over };
  function Shell() {
    const [value, setValue] = useState(owner.initial ?? '');
    return <Composer {...base} value={value}
      onChange={v => { onChange(v); setValue(v); }}
      onSend={t => { onSend(t); if (owner.clearOnSend ?? true) setValue(''); }} />;
  }
  render(<Shell />);
  return { props: { ...base, onSend, onChange }, textarea: screen.getByRole('textbox', { name: 'message #general' }) as HTMLTextAreaElement };
}
// The visible counter; its polite status (A11Y-DESIGN-04) may hold the same words.
const counterText = (text: string) => screen.getByText(text, { selector: '.d-composer__counter' });

describe('Composer', () => {
  it('is a labelled textarea in a d-composer form with the placeholder', () => {
    const { textarea } = setup();
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.closest('form')).toHaveClass('d-composer');
    expect(textarea).toHaveAttribute('placeholder', 'message #general');
    // The channel name sits in its own span (design ruling (i), task 24), so the label is matched by its whole text.
    const label = textarea.closest('form')?.querySelector('label');
    expect(label).toHaveAttribute('for', textarea.id);
    expect(label?.textContent).toBe('message #general');
  });

  // Design ruling (i), task 24: the label part carries the label treatment; the channel name, a value,
  // is wrapped so the case transform never reaches it.
  function labelOf(label: string) {
    render(<Composer label={label} placeholder={label} maxLength={4000} value="" onChange={() => {}} onSend={() => {}}
      sendLabel="send" counterLabel={n => `${n} left`} />);
    const textarea = screen.getByRole('textbox', { name: label });
    return textarea.closest('form')?.querySelector('label') ?? null;
  }
  it('keeps the case of the channel name inside its label', () => {
    const label = labelOf('message #General Chat');
    expect(label).toHaveClass('d-label');
    expect(label?.textContent).toBe('message #General Chat');
    expect(label?.querySelector('.d-composer__target')?.textContent).toBe('#General Chat');
    // The computed case of the target is checked in a real browser by the Storybook test-runner.
  });

  it('keeps a label without a channel whole', () => {
    const label = labelOf('message');
    expect(label?.textContent).toBe('message');
    expect(label?.querySelector('.d-composer__target')).toBeNull();
  });

  it('has no native limit: the textarea carries no maxlength attribute', () => {
    const { textarea } = setup();
    expect(textarea).not.toHaveAttribute('maxlength');
  });

  it('counts the budget in UTF-8 bytes', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup({ maxLength: 10 });
    await user.type(textarea, '€€€');
    expect(counterText('1 left')).toHaveClass('d-composer__counter');
    await user.keyboard('{Enter}');
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith('€€€');
    expect(textarea).toHaveValue('');
    await user.type(textarea, '€€€€');
    expect(counterText('-2 left')).toHaveClass('d-composer__counter');
    expect(textarea).toHaveAccessibleDescription('-2 left');
    await user.keyboard('{Enter}');
    expect(props.onSend).toHaveBeenCalledTimes(1);
    // Refused but focusable (A11Y-DESIGN-04, Global Constraints line 98): aria-disabled, not the native attribute.
    expect(screen.getByRole('button', { name: 'send' })).toHaveAttribute('aria-disabled', 'true');
    expect(textarea).toHaveValue('€€€€');
  });

  it('sends on Enter and keeps focus in the field, which its owner clears', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup();
    await user.type(textarea, 'hello{Enter}');
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith('hello');
    expect(textarea).toHaveValue('');
    expect(textarea).toHaveFocus();
  });

  it('never clears itself: a send its owner refuses keeps the text', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup({}, { clearOnSend: false });
    await user.type(textarea, 'hello{Enter}');
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith('hello');
    expect(textarea).toHaveValue('hello');
    expect(textarea).toHaveFocus();
    expect(props.onChange).not.toHaveBeenCalledWith('');
    expect(props.onChange).toHaveBeenLastCalledWith('hello');
  });

  it('shows the value it is given and reports every edit through onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: string) => void>();
    const onSend = vi.fn<(text: string) => void>();
    render(<Composer label="message #general" placeholder="message #general" maxLength={4000} value="draft" onChange={onChange}
      onSend={onSend} sendLabel="send" counterLabel={n => `${n} left`} />);
    const textarea = screen.getByRole('textbox', { name: 'message #general' });
    expect(textarea).toHaveValue('draft');
    await user.type(textarea, 'x');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('draftx');
    expect(textarea).toHaveValue('draft');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('draft');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue('draft');
  });

  it('breaks the line on Shift+Enter and sends the text unchanged', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup();
    await user.type(textarea, 'one{Shift>}{Enter}{/Shift}two');
    expect(textarea).toHaveValue('one\ntwo');
    expect(props.onSend).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(props.onSend).toHaveBeenCalledWith('one\ntwo');
  });

  it('does not send on Enter while an IME is composing', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup();
    await user.type(textarea, 'nihongo');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 229 });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('nihongo');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(props.onSend).toHaveBeenCalledWith('nihongo');
  });

  // WEB-APP-01: a held Enter auto-repeats; the repeats neither send again nor insert line breaks.
  it('sends once for a held Enter and inserts no line break on its repeats', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup({}, { clearOnSend: false });
    await user.type(textarea, 'hello');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue('hello');
  });

  it('does not send whitespace and keeps it', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup();
    await user.type(textarea, '   {Enter}');
    expect(props.onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('   ');
  });

  it('sends with the send button', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup();
    await user.type(textarea, 'hi');
    await user.click(screen.getByRole('button', { name: 'send' }));
    expect(props.onSend).toHaveBeenCalledWith('hi');
    expect(textarea).toHaveValue('');
  });

  it('shows the counter, as part of the description, only near the limit, and past it', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup({ maxLength: 10 });
    await user.type(textarea, 'abcdefgh');
    expect(screen.queryByText(/ left$/)).toBeNull();
    expect(textarea).not.toHaveAttribute('aria-describedby');
    await user.type(textarea, 'i');
    expect(counterText('1 left')).toHaveClass('d-composer__counter');
    expect(textarea).toHaveAccessibleDescription('1 left');
    await user.type(textarea, 'j');
    expect(counterText('0 left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'send' })).toBeEnabled();
    await user.type(textarea, 'k');
    expect(textarea).toHaveValue('abcdefghijk');
    expect(counterText('-1 left')).toBeInTheDocument();
    // Refused but focusable (A11Y-DESIGN-04, Global Constraints line 98): aria-disabled, not the native attribute.
    expect(screen.getByRole('button', { name: 'send' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(props.onSend).not.toHaveBeenCalled();
  });

  // A11Y-DESIGN-04: the counter is a status message. A polite status speaks it when it appears and when the text
  // crosses the budget, never on every keystroke; over the budget the counter carries the danger tone and the
  // send button stays focusable (aria-disabled) with the counter as its reason.
  const words = (n: number) => (n < 0 ? `${-n} bytes over the limit` : `${n} left`);
  it('announces the counter when it appears and when the text crosses the budget', async () => {
    const user = userEvent.setup();
    setup({ maxLength: 10, counterLabel: words });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^$/);
    await user.type(screen.getByRole('textbox', { name: 'message #general' }), 'abcdefgh');
    expect(status).toHaveTextContent(/^$/);
    await user.type(screen.getByRole('textbox', { name: 'message #general' }), 'i');
    expect(status).toHaveTextContent('1 left');
    await user.type(screen.getByRole('textbox', { name: 'message #general' }), 'j');
    expect(screen.getByText('0 left')).toHaveClass('d-composer__counter');
    expect(status).toHaveTextContent('1 left');
    await user.type(screen.getByRole('textbox', { name: 'message #general' }), 'k');
    expect(status).toHaveTextContent('1 bytes over the limit');
    await user.type(screen.getByRole('textbox', { name: 'message #general' }), 'l');
    expect(screen.getByText('2 bytes over the limit')).toHaveClass('d-composer__counter');
    expect(status).toHaveTextContent('1 bytes over the limit');
    await user.keyboard('{Backspace}{Backspace}');
    expect(status).toHaveTextContent('0 left');
    await user.keyboard('{Backspace}{Backspace}{Backspace}');
    expect(screen.queryByText(/ left$/)).toBeNull();
    expect(status).toHaveTextContent(/^$/);
  });
  it('marks the counter over the budget and keeps send focusable with the counter as its reason', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup({ maxLength: 10, counterLabel: words });
    await user.type(textarea, 'abcdefghij');
    const send = screen.getByRole('button', { name: 'send' });
    expect(screen.getByText('0 left')).not.toHaveAttribute('data-over');
    expect(send).not.toHaveAttribute('aria-disabled');
    await user.type(textarea, 'xyz');
    const counter = screen.getByText('3 bytes over the limit');
    expect(counter).toHaveAttribute('data-over', 'true');
    expect(send).not.toBeDisabled();
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAccessibleDescription('3 bytes over the limit');
    await user.tab();
    expect(send).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.click(send);
    expect(props.onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('abcdefghijxyz');
  });

  it('stays focusable but sends nothing while disabled, and says why', async () => {
    const user = userEvent.setup();
    const { props, textarea } = setup({ disabled: true, disabledReason: 'joining this channel' });
    expect(textarea).toHaveAttribute('aria-disabled', 'true');
    expect(textarea).toHaveAttribute('readonly');
    expect(textarea).toHaveAccessibleDescription('joining this channel');
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
    await user.tab();
    expect(textarea).toHaveFocus();
    await user.type(textarea, 'x');
    expect(textarea).toHaveValue('');
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('has no serious axe violations, enabled or disabled', async () => {
    const base: ComposerProps = { label: 'message #general', placeholder: 'message #general', maxLength: 4000, value: '', onChange: () => {},
      onSend: () => {}, sendLabel: 'send', counterLabel: n => `${n} left` };
    const { container } = render(<div className="d-root"><Composer {...base} /><Composer {...base} label="message #loot" disabled disabledReason="joining this channel" /></div>);
    await expectNoAxeViolations(container);
  });
});
