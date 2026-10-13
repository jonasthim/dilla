import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { VoiceSettings, type VoiceSettingsProps } from './VoiceSettings.tsx';
import meta from './VoiceSettings.stories.tsx';

const labels: VoiceSettingsProps['labels'] = {
  input: 'input device', output: 'output device', systemDefault: 'system default',
  outputUnsupported: 'This browser plays voice on the system default device.', mode: 'input mode', vad: 'voice activity', ptt: 'push to talk',
  pttKey: 'push-to-talk key', pttNone: 'no key set', pttSet: 'set key',
  pttPrompt: 'Press the key to use. Escape cancels. It works only while dilla is the active tab.', noise: 'noise suppression', level: 'input level',
};
const base: VoiceSettingsProps = {
  inputs: [{ id: 'mic-1', label: 'USB microphone' }, { id: 'mic-2', label: 'Headset' }], outputs: [{ id: 'out-1', label: 'Speakers' }],
  input: '', output: '', canSelectOutput: true, mode: 'vad', pttKey: null, capturing: false, noise: true, level: 4, labels,
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

  it('voice activity is the default; push to talk shows its key row; noise suppression is a switch; the level is a meter', async () => {
    const onMode = vi.fn();
    const onNoise = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} onMode={onMode} onNoise={onNoise} />);
    expect(screen.getByRole('radio', { name: 'voice activity' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: /set key/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'push to talk' }));
    expect(onMode).toHaveBeenCalledWith('ptt');
    await userEvent.click(screen.getByRole('switch', { name: 'noise suppression' }));
    expect(onNoise).toHaveBeenCalledWith(false);
    expect(screen.getByRole('meter', { name: 'input level' })).toHaveAttribute('aria-valuenow', '4');
    rerender(<VoiceSettings {...base} mode="ptt" />);
    expect(screen.getByText('no key set')).toBeInTheDocument();
    rerender(<VoiceSettings {...base} mode="ptt" pttKey="F8" />);
    expect(screen.getByText('F8')).toBeInTheDocument();
  });

  it('captures the push-to-talk key: any key but Escape is saved without typing, Escape cancels', async () => {
    const onCaptureKey = vi.fn();
    const { rerender } = render(<VoiceSettings {...base} mode="ptt" onCaptureKey={onCaptureKey} />);
    await userEvent.click(screen.getByRole('button', { name: 'set key' }));
    expect(onCaptureKey).toHaveBeenLastCalledWith('start');
    rerender(<VoiceSettings {...base} mode="ptt" capturing onCaptureKey={onCaptureKey} />);
    const capture = screen.getByRole('button', { name: 'set key' });
    expect(capture).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Press the key to use. Escape cancels.');
    const typed = fireEvent.keyDown(capture, { key: 'F8', code: 'F8' });
    expect(typed).toBe(false);
    expect(onCaptureKey).toHaveBeenLastCalledWith({ code: 'F8' });
    fireEvent.keyDown(capture, { key: 'Escape', code: 'Escape' });
    expect(onCaptureKey).toHaveBeenLastCalledWith('cancel');
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><VoiceSettings {...(meta.args as VoiceSettingsProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
