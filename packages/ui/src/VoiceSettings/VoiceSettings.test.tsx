import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { typesOrOperates, VoiceSettings, type VoiceSettingsProps } from './VoiceSettings.tsx';
import meta from './VoiceSettings.stories.tsx';

const labels: VoiceSettingsProps['labels'] = {
  input: 'input device', output: 'output device', systemDefault: 'system default',
  outputUnsupported: 'This browser plays voice on the system default device.', mode: 'input mode', vad: 'voice activity', ptt: 'push to talk',
  pttKey: 'push-to-talk key', pttNone: 'no key set', pttSet: 'set key',
  pttPrompt: 'Press the key to use. Escape cancels. It works only while dilla is the active tab.',
  pttRefused: 'That key types text, moves the focus or needs another key. Use one key on its own, such as Pause, Scroll Lock or F13 to F24.',
  noise: 'noise suppression', automatic: 'automatic', lightweight: 'lightweight', off: 'off', level: 'input level',
};
const base: VoiceSettingsProps = {
  inputs: [{ id: 'mic-1', label: 'USB microphone' }, { id: 'mic-2', label: 'Headset' }], outputs: [{ id: 'out-1', label: 'Speakers' }],
  input: '', output: '', canSelectOutput: true, mode: 'vad', pttKey: null, capturing: false, noise: 'lightweight', level: 4, labels,
  onInput: () => {}, onOutput: () => {}, onMode: () => {}, onCaptureKey: () => {}, onNoise: () => {},
};

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('VoiceSettings', () => {
  it('chooses devices with native selects that start at the system default', () => {
    const onInput = vi.fn();
    const onOutput = vi.fn();
    render(<VoiceSettings {...base} onInput={onInput} onOutput={onOutput} />);
    const input = screen.getByRole('combobox', { name: 'input device' });
    expect(input).toHaveValue('');
    expect(screen.getAllByRole('option', { name: 'system default' })).toHaveLength(2);
    fireEvent.change(input, { target: { value: 'mic-2' } });
    expect(onInput).toHaveBeenCalledWith('mic-2');
    fireEvent.change(screen.getByRole('combobox', { name: 'output device' }), { target: { value: 'out-1' } });
    expect(onOutput).toHaveBeenCalledWith('out-1');
  });

  it('says so when the browser cannot choose the output', () => {
    render(<VoiceSettings {...base} canSelectOutput={false} />);
    expect(screen.queryByRole('combobox', { name: 'output device' })).toBeNull();
    expect(screen.getByText('This browser plays voice on the system default device.')).toBeInTheDocument();
  });

  it('voice activity is the default; push to talk shows its key row; noise suppression has three choices; the level is a meter', async () => {
    const onMode = vi.fn();
    const onNoise = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} onMode={onMode} onNoise={onNoise} />);
    expect(screen.getByRole('radio', { name: 'voice activity' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: /set key/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'push to talk' }));
    expect(onMode).toHaveBeenCalledWith('ptt');
    await userEvent.click(screen.getByRole('radio', { name: 'off' }));
    expect(onNoise).toHaveBeenCalledWith('off');
    expect(screen.getByRole('meter', { name: 'input level' })).toHaveAttribute('aria-valuenow', '4');
    rerender(<VoiceSettings {...base} mode="ptt" />);
    expect(screen.getByText('no key set')).toBeInTheDocument();
    rerender(<VoiceSettings {...base} mode="ptt" pttKey="F8" />);
    expect(screen.getByText('F8')).toBeInTheDocument();
  });

  it('captures the push-to-talk key: a non-text key is saved without typing, Escape cancels', async () => {
    const onCaptureKey = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} mode="ptt" onCaptureKey={onCaptureKey} />);
    await userEvent.click(screen.getByRole('button', { name: 'set key' }));
    expect(onCaptureKey).toHaveBeenLastCalledWith('start');
    rerender(<VoiceSettings {...base} mode="ptt" capturing onCaptureKey={onCaptureKey} />);
    const capture = screen.getByRole('button', { name: 'set key' });
    expect(capture).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Press the key to use. Escape cancels.');
    const typed = fireEvent.keyDown(capture, { key: 'F13', code: 'F13' });
    expect(typed).toBe(false);
    expect(onCaptureKey).toHaveBeenLastCalledWith({ code: 'F13', ctrl: false, alt: false, meta: false, shift: false });
    fireEvent.keyDown(capture, { key: 'Escape', code: 'Escape' });
    expect(onCaptureKey).toHaveBeenLastCalledWith('cancel');
  });

  it('accepts only a non-text key on its own: F13 to F24, Pause, ScrollLock, Insert (task-8b review I2, supersedes M9)', async () => {
    const onCaptureKey = vi.fn();
    render(<VoiceSettings {...base} mode="ptt" capturing onCaptureKey={onCaptureKey} />);
    const capture = screen.getByRole('button', { name: 'set key' });
    const refused: Array<[string, string, Record<string, boolean>]> = [
      ['a', 'KeyA', {}], ['A', 'KeyA', { shiftKey: true }], [' ', 'Space', {}], ['7', 'Digit7', {}], [',', 'Comma', {}],
      ['Enter', 'Enter', {}], ['ArrowDown', 'ArrowDown', {}], ['Dead', 'Quote', {}],
      // A text or operating key stays refused with Control, Alt or Meta held (the setting stores the code alone).
      ['m', 'KeyM', { ctrlKey: true, shiftKey: true }], ['v', 'KeyV', { metaKey: true }], ['x', 'KeyX', { altKey: true }],
      // Function keys the browser uses (help, find, reload, caret browsing, fullscreen, devtools) are refused.
      ['F1', 'F1', {}], ['F5', 'F5', {}], ['F8', 'F8', {}], ['F12', 'F12', {}],
      // An allowed key held with a modifier is a combination, which the setting cannot store.
      ['Pause', 'Pause', { ctrlKey: true }], ['F13', 'F13', { shiftKey: true }],
    ];
    for (const [key, code, mods] of refused) {
      const typed = fireEvent.keyDown(capture, { key, code, ...mods });
      expect(typed).toBe(false);
    }
    expect(onCaptureKey).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('That key types text, moves the focus or needs another key.'));
    fireEvent.keyDown(capture, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect(onCaptureKey).not.toHaveBeenCalled();
    for (const code of ['F13', 'F24', 'Pause', 'ScrollLock', 'Insert']) {
      fireEvent.keyDown(capture, { key: code, code });
      expect(onCaptureKey).toHaveBeenLastCalledWith({ code, ctrl: false, alt: false, meta: false, shift: false });
    }
    expect(onCaptureKey).toHaveBeenCalledTimes(5);
  });

  // WB a11y m7: a second refused key says the refusal again (the region is emptied, then set), so the prompt never looks
  // frozen to a screen reader user.
  it('says the refusal again for a second refused key', async () => {
    render(<VoiceSettings {...base} mode="ptt" capturing onCaptureKey={vi.fn()} />);
    const capture = screen.getByRole('button', { name: 'set key' });
    const status = screen.getByRole('status');
    fireEvent.keyDown(capture, { key: 'a', code: 'KeyA' });
    expect(status).toHaveTextContent('That key types text');
    fireEvent.keyDown(capture, { key: 'b', code: 'KeyB' });
    expect(status).toHaveTextContent('');
    await waitFor(() => expect(status).toHaveTextContent('That key types text'));
  });

  it('refuses a key typed with AltGr, which browsers report as Control plus Alt (task 8b ruling)', () => {
    const onCaptureKey = vi.fn();
    render(<VoiceSettings {...base} mode="ptt" capturing onCaptureKey={onCaptureKey} />);
    const capture = screen.getByRole('button', { name: 'set key' });
    fireEvent.keyDown(capture, { key: '@', code: 'Digit2', ctrlKey: true, altKey: true, modifierAltGraph: true });
    fireEvent.keyDown(capture, { key: '€', code: 'KeyE', altKey: true, modifierAltGraph: true });
    fireEvent.keyDown(capture, { key: 'Insert', code: 'Insert', modifierAltGraph: true });
    expect(onCaptureKey).not.toHaveBeenCalled();
    expect(typesOrOperates({ key: '@', code: 'Digit2', ctrlKey: true, altKey: true, metaKey: false, getModifierState: (k) => k === 'AltGraph' })).toBe(true);
    expect(typesOrOperates({ key: 'Pause', code: 'Pause', ctrlKey: false, altKey: false, metaKey: false, getModifierState: () => false })).toBe(false);
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceSettings {...(meta.args as VoiceSettingsProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
