import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { typesOrOperates, VoiceSettings, type VoiceSettingsProps } from './VoiceSettings.tsx';
import meta from './VoiceSettings.stories.tsx';
import { VOICE_HANDLERS, VOICE_LABELS } from './VoiceSettings.fixture.ts';

const labels: VoiceSettingsProps['labels'] = {
  input: 'input device', output: 'output device', systemDefault: 'system default',
  outputUnsupported: 'This browser plays voice on the system default device.', mode: 'input mode', vad: 'voice activity', ptt: 'push to talk',
  pttKey: 'push-to-talk key', pttNone: 'no key set', pttSet: 'set key',
  pttPrompt: 'Press the key to use. Escape cancels. It works only while dilla is the active tab.',
  pttRefused: 'That key types text, moves the focus or needs another key. Use one key on its own, such as Pause, Scroll Lock or F13 to F24.',
  noise: 'noise suppression', automatic: 'automatic', lightweight: 'lightweight', off: 'off',
  volume: VOICE_LABELS.volume, inputVolume: 'input volume', outputVolume: 'output volume', testStart: 'Let’s check', testStop: 'Stop testing',
  testHint: 'hint', testUnavailable: 'unavailable in a call', heard: 'You’re being heard', tooQuiet: 'Too quiet to send', notTesting: 'Not testing',
  levelValue: 'level {value}', thresholdValue: 'threshold {value}', noLevel: '—', threshold: 'sensitivity threshold',
  auto: 'set sensitivity automatically', autoHintOn: 'auto on', autoHintOff: 'drag the line', release: 'release delay', releaseHint: 'keeps sending',
  echo: 'echo cancellation', echoHint: 'no feedback', agc: 'automatic gain control', agcHint: 'evens out',
};
const prompt = () => document.querySelector('.d-voice-settings__prompt') as HTMLElement;
const base: VoiceSettingsProps = {
  inputs: [{ id: 'mic-1', label: 'USB microphone' }, { id: 'mic-2', label: 'Headset' }], outputs: [{ id: 'out-1', label: 'Speakers' }],
  input: '', output: '', canSelectOutput: true, inputVolume: 100, outputVolume: 100, mode: 'vad', pttKey: null, capturing: false, pttReleaseMs: 200,
  noise: 'lightweight', echo: true, agc: true, micTest: { testing: false, available: true, levelDb: -100, thresholdDb: -48, auto: true }, labels,
  ...VOICE_HANDLERS,
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

  it('voice activity is the default; push to talk shows its key row; noise suppression has three choices', async () => {
    const onMode = vi.fn();
    const onNoise = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} onMode={onMode} onNoise={onNoise} />);
    expect(screen.getByRole('radio', { name: 'voice activity' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: /set key/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'push to talk' }));
    expect(onMode).toHaveBeenCalledWith('ptt');
    await userEvent.click(screen.getByRole('radio', { name: 'off' }));
    expect(onNoise).toHaveBeenCalledWith('off');
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
    expect(prompt()).toHaveTextContent('Press the key to use. Escape cancels.');
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
    await waitFor(() => expect(prompt()).toHaveTextContent('That key types text, moves the focus or needs another key.'));
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
    const status = prompt();
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

  // Task 10b
  it('input and output volume are named ranges 0–200 % with their value', () => {
    const onInputVolume = vi.fn();
    const onOutputVolume = vi.fn();
    render(<VoiceSettings {...base} inputVolume={57} onInputVolume={onInputVolume} onOutputVolume={onOutputVolume} />);
    const input = screen.getByRole('slider', { name: 'input volume' });
    expect(input).toHaveAttribute('max', '200');
    expect(input).toHaveAttribute('aria-valuetext', '57%');
    expect(input.style.getPropertyValue('--d-fill')).toBe('28.5%');
    fireEvent.change(input, { target: { value: '140' } });
    expect(onInputVolume).toHaveBeenCalledWith(140);
    fireEvent.change(screen.getByRole('slider', { name: 'output volume' }), { target: { value: '0' } });
    expect(onOutputVolume).toHaveBeenCalledWith(0);
  });

  it('the output volume stays where the browser cannot choose the output device', () => {
    render(<VoiceSettings {...base} canSelectOutput={false} />);
    expect(screen.getByRole('slider', { name: 'output volume' })).toBeInTheDocument();
  });

  it('Mic test: Let’s check / Stop testing, the pill as live text, the readouts, and automatic sensitivity', async () => {
    const onMicTest = vi.fn();
    const onAuto = vi.fn();
    const onThreshold = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} onMicTest={onMicTest} onAuto={onAuto} onThreshold={onThreshold} />);
    const pill = () => document.querySelector('.d-voice-settings__pill') as HTMLElement;
    expect(pill()).toHaveAttribute('role', 'status');
    expect(pill()).toHaveTextContent('Not testing');
    expect(screen.getByText('level —')).toBeInTheDocument();
    expect(screen.getByText('threshold -48 dB')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'sensitivity threshold' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Let’s check' }));
    expect(onMicTest).toHaveBeenCalledTimes(1);
    rerender(<VoiceSettings {...base} micTest={{ testing: true, available: true, levelDb: -30.4, thresholdDb: -48, auto: true }} onAuto={onAuto} />);
    expect(screen.getByRole('button', { name: 'Stop testing' })).toHaveAttribute('data-testing', 'true');
    expect(pill()).toHaveTextContent('You’re being heard');
    expect(screen.getByText('level -30 dB')).toBeInTheDocument();
    rerender(<VoiceSettings {...base} micTest={{ testing: true, available: true, levelDb: -60, thresholdDb: -48, auto: true }} onAuto={onAuto} />);
    expect(pill()).toHaveTextContent('Too quiet to send');
    await userEvent.click(screen.getByRole('switch', { name: 'set sensitivity automatically' }));
    expect(onAuto).toHaveBeenCalledWith(false);
    rerender(<VoiceSettings {...base} micTest={{ testing: false, available: true, levelDb: -100, thresholdDb: -35, auto: false }} onThreshold={onThreshold} />);
    expect(screen.getByText('drag the line')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'sensitivity threshold' }), { target: { value: '-20' } });
    expect(onThreshold).toHaveBeenCalledWith(-20);
  });

  it('Let’s check is disabled while a call holds the microphone, and says so', () => {
    render(<VoiceSettings {...base} micTest={{ testing: false, available: false, levelDb: -100, thresholdDb: -48, auto: true }} />);
    expect(screen.getByRole('button', { name: 'Let’s check' })).toBeDisabled();
    expect(screen.getByText('unavailable in a call')).toBeInTheDocument();
  });

  it('push to talk shows the release delay: 0–1000 ms in steps of 20', () => {
    const onPttRelease = vi.fn();
    render(<VoiceSettings {...base} mode="ptt" pttReleaseMs={200} onPttRelease={onPttRelease} />);
    const range = screen.getByRole('slider', { name: 'release delay' });
    expect(range).toHaveAttribute('step', '20');
    expect(range).toHaveAttribute('max', '1000');
    expect(range).toHaveAttribute('aria-valuetext', '200 ms');
    expect(range).toHaveAccessibleDescription('keeps sending');
    fireEvent.change(range, { target: { value: '340' } });
    expect(onPttRelease).toHaveBeenCalledWith(340);
  });

  it('echo cancellation and automatic gain are switches; a switch the browser cannot apply is not shown (Ruling AR)', async () => {
    const onEcho = vi.fn();
    const onAgc = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} onEcho={onEcho} onAgc={onAgc} />);
    await userEvent.click(screen.getByRole('switch', { name: 'echo cancellation' }));
    expect(onEcho).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole('switch', { name: 'automatic gain control' }));
    expect(onAgc).toHaveBeenCalledWith(false);
    expect(screen.getByRole('switch', { name: 'echo cancellation' })).toHaveAccessibleDescription('no feedback');
    rerender(<VoiceSettings {...base} agc={undefined} echo={undefined} />);
    expect(screen.queryByRole('switch', { name: 'automatic gain control' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'echo cancellation' })).toBeNull();
  });

  it.each(['signal', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceSettings {...(meta.args as VoiceSettingsProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
