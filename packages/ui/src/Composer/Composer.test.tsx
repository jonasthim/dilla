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

  // ---- web-2b (L-UI-53) ----
  it('offers attach before the textarea and renders the top slot above the box', async () => {
    const onAttach = vi.fn();
    const { textarea } = setup({ attachLabel: 'attach files', onAttach, top: <p>replying to björn</p> });
    const attach = screen.getByRole('button', { name: 'attach files' });
    expect(attach.textContent).toBe('+');
    expect(attach.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const form = textarea.closest('form')!;
    expect(form.querySelector('.d-composer__top')?.textContent).toBe('replying to björn');
    expect(form.querySelector('.d-composer__top')!.compareDocumentPosition(form.querySelector('.d-composer__box')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(attach);
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it('has no attach button without its label and handler', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'attach files' })).toBeNull();
  });

  // Pre-flight ruling F10 (controller, 2026-10-07): the textarea keeps its textbox role (no role=combobox); while the
  // list is open it carries aria-autocomplete, aria-controls and aria-activedescendant, and nothing else of the pattern.
  it('stays a textbox that points at its list only while the list is open; the keys it consumes never send', async () => {
    const onKey = vi.fn((key: string) => key !== 'Tab');
    const { textarea, props } = setup({ combobox: { expanded: true, controls: 'mentions', activeDescendant: 'mention-mira', onKey } }, { initial: '@mi' });
    const box = screen.getByRole('textbox', { name: 'message #general' });
    expect(box).toBe(textarea);
    expect(box).not.toHaveAttribute('role');
    expect(box).not.toHaveAttribute('aria-expanded');
    expect(box).toHaveAttribute('aria-autocomplete', 'list');
    expect(box).toHaveAttribute('aria-controls', 'mentions');
    expect(box).toHaveAttribute('aria-activedescendant', 'mention-mira');
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab']) fireEvent.keyDown(box, { key });
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab']);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('sends on Enter when the combobox does not consume it', () => {
    const { textarea, props } = setup({ combobox: { expanded: false, controls: 'mentions', activeDescendant: null, onKey: () => false } }, { initial: 'hello' });
    expect(screen.getByRole('textbox', { name: 'message #general' })).toBe(textarea);
    expect(textarea).not.toHaveAttribute('role');
    expect(textarea).not.toHaveAttribute('aria-expanded');
    expect(textarea).not.toHaveAttribute('aria-autocomplete');
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledWith('hello');
  });

  it('hands Escape to the page while the list is closed and sends nothing', () => {
    const onKey = vi.fn((key: string) => key === 'Escape');
    const { textarea, props } = setup({ combobox: { expanded: false, controls: 'mentions', activeDescendant: null, onKey } }, { initial: 'hello' });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onKey).toHaveBeenCalledWith('Escape');
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('ArrowUp in an empty composer with no open list asks to edit the last own message', () => {
    const onArrowUpEmpty = vi.fn();
    const { textarea } = setup({ onArrowUpEmpty });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'ArrowUp', shiftKey: true });
    expect(onArrowUpEmpty).toHaveBeenCalledTimes(1);
  });

  it('ArrowUp does not edit when the composer holds text', () => {
    const onArrowUpEmpty = vi.fn();
    const { textarea } = setup({ onArrowUpEmpty }, { initial: 'draft' });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(onArrowUpEmpty).not.toHaveBeenCalled();
  });

  it('ArrowUp does not edit while the mention list is open', () => {
    const onArrowUpEmpty = vi.fn();
    const { textarea } = setup({ onArrowUpEmpty, combobox: { expanded: true, controls: 'mentions', activeDescendant: null, onKey: () => false } });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(onArrowUpEmpty).not.toHaveBeenCalled();
  });

  it('measures the budget with the given measure', () => {
    setup({ maxLength: 10, measure: (v) => v.length * 4 }, { initial: 'abc' });
    expect(counterText('-2 left')).toHaveAttribute('data-over', 'true');
  });

  it('hands pasted files over and leaves a text paste alone', () => {
    const onPasteFiles = vi.fn();
    const { textarea } = setup({ onPasteFiles });
    const png = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const filesPaste = fireEvent.paste(textarea, { clipboardData: { files: [png], getData: () => '' } });
    expect(filesPaste).toBe(false);
    expect(onPasteFiles).toHaveBeenCalledWith([png]);
    const textPaste = fireEvent.paste(textarea, { clipboardData: { files: [], getData: () => 'words' } });
    expect(textPaste).toBe(true);
    expect(onPasteFiles).toHaveBeenCalledTimes(1);
  });

  it('sends an empty text when it may (an attachment-only message)', () => {
    const { textarea, props } = setup({ canSendEmpty: true });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledWith('');
  });

  it('reports the caret after a change and attaches textareaRef', async () => {
    const onCaret = vi.fn();
    const ref = { current: null as HTMLTextAreaElement | null };
    const { textarea } = setup({ onCaret, textareaRef: ref });
    expect(ref.current).toBe(textarea);
    await userEvent.type(textarea, '@m');
    expect(onCaret).toHaveBeenLastCalledWith(2);
  });

  it('has no serious axe violations with its mention list open', async () => {
    const { container } = render(<div className="d-root">
      <Composer label="message #general" placeholder="message #general" maxLength={4000} value="@mi" onChange={() => {}} onSend={() => {}}
        sendLabel="send" counterLabel={(n) => `${n} left`} attachLabel="attach files" onAttach={() => {}}
        combobox={{ expanded: true, controls: 'mentions', activeDescendant: 'mention-mira', onKey: () => false }}
        top={<ul role="listbox" id="mentions" aria-label="people to mention"><li role="option" id="mention-mira" aria-selected="true">mira</li></ul>} />
    </div>);
    await expectNoAxeViolations(container);
  });
});
