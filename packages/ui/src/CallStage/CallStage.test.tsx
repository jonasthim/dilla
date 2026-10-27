import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CallStage, stageColumns, type CallStageProps } from './CallStage.tsx';
import type { CallTileProps } from '../CallTile/CallTile.tsx';
import meta from './CallStage.stories.tsx';

if (typeof globalThis.MediaStream === 'undefined') {
  (globalThis as { MediaStream?: unknown }).MediaStream = class MediaStream {};
}

const stateLabels: CallTileProps['labels']['state'] = {
  speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream',
  connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot', noSound: 'no sound',
};
function tile(name: string, media: MediaStream | null): CallTileProps {
  return {
    view: { deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok', speaking: false, muted: false, deafened: false,
      video: media !== null, screen: false, web: true, bot: false },
    own: false, volume: 100, media, labels: { state: stateLabels, volume: `volume for ${name}`, volumeValue: '{n} %' }, onVolume: () => {},
  };
}
const labels: CallStageProps['labels'] = {
  code: 'call code', codeHelp: 'The code changes whenever someone joins or leaves.', empty: 'Nobody is in voice yet.', tiles: 'people in voice',
};
const base: CallStageProps = {
  title: 'voice harbour', tiles: [tile('ada', new MediaStream()), tile('bo', new MediaStream())], code: '012345678901234567890123456789',
  notice: null, controls: <button type="button">mute</button>, outgoing: null, labels,
};
const pausedText = 'ada’s identity changed, so this call is paused for you: nothing you say is sent and nothing is played.';

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('CallStage', () => {
  it('CallStage with the pause notice (RV-3) shows its action, focuses it once, and renders no media element', async () => {
    const onAction = vi.fn();
    const notice = { kind: 'paused' as const, text: pausedText, action: { label: 'compare safety numbers', onAction }, focusOnce: true };
    const { container, rerender } = render(<CallStage {...base} notice={notice} />);
    expect(container.querySelector('video, audio')).toBeNull();
    const action = screen.getByRole('button', { name: 'compare safety numbers' });
    expect(action).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(pausedText);
    screen.getByRole('button', { name: 'mute' }).focus();
    rerender(<CallStage {...base} notice={{ ...notice }} />);
    expect(action).not.toHaveFocus();
    expect(container.querySelector('video, audio')).toBeNull();
    await userEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('without a notice the tiles show their verified video, as a list named for the people', () => {
    const { container } = render(<CallStage {...base} />);
    expect(container.querySelectorAll('video')).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'people in voice' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'voice harbour' })).toBeInTheDocument();
  });

  it('keeps the call code behind a closed disclosure, in six groups of five; Escape closes it and returns focus', async () => {
    const { container } = render(<CallStage {...base} />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    const summary = container.querySelector('summary')!;
    expect(summary).toHaveTextContent('call code');
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText('01234 56789 01234 56789 01234 56789')).toBeInTheDocument();
    expect(screen.getByText('The code changes whenever someone joins or leaves.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(details.open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it('says so when nobody is in voice, shows the outgoing ring, and a notice without an action takes focus once', () => {
    const { rerender } = render(<CallStage {...base} tiles={[]} code={null} outgoing={{ text: 'ringing ada' }} />);
    expect(screen.getByText('Nobody is in voice yet.')).toBeInTheDocument();
    expect(screen.getByText('ringing ada')).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
    rerender(<CallStage {...base} notice={{ kind: 'info', text: 'This voice is full.', action: null, focusOnce: true }} />);
    expect(screen.getByRole('status')).toHaveFocus();
  });

  it('hides media for the pause and blocked notices only; a transient notice keeps the video (ruling)', () => {
    const { container, rerender } = render(<CallStage {...base} notice={{ kind: 'info', text: 'This voice is full.', action: null, focusOnce: false }} />);
    expect(container.querySelectorAll('video')).toHaveLength(2);
    rerender(<CallStage {...base} notice={{ kind: 'blocked', text: 'A device in this voice failed the identity check, so you left.', action: null, focusOnce: false }} />);
    expect(container.querySelector('video, audio')).toBeNull();
    rerender(<CallStage {...base} notice={{ kind: 'paused', text: pausedText, action: null, focusOnce: false }} />);
    expect(container.querySelector('video, audio')).toBeNull();
  });

  it('never says nobody is in voice while a notice explains the stage (M1)', () => {
    const { rerender } = render(<CallStage {...base} tiles={[]} notice={{ kind: 'blocked', text: 'A device in this voice failed the identity check. Joining is paused until it is removed.', action: null, focusOnce: false }} />);
    expect(screen.queryByText('Nobody is in voice yet.')).toBeNull();
    rerender(<CallStage {...base} tiles={[]} notice={null} />);
    expect(screen.getByText('Nobody is in voice yet.')).toBeInTheDocument();
  });

  it.each(['signal', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><CallStage {...(meta.args as CallStageProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('the header slot renders before the title and the tiles, as the stage\'s 48 bar (C4)', () => {
    const { container } = render(<CallStage {...base} header={<header data-testid="bar">voice harbour</header>} />);
    const bar = screen.getByTestId('bar');
    const section = container.querySelector('.d-call-stage')!;
    expect(bar.parentElement).toHaveClass('d-call-stage__bar');
    expect(section.firstElementChild).toBe(bar.parentElement);
    expect(bar.parentElement!.compareDocumentPosition(container.querySelector('.d-call-stage__tiles')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The section keeps its name, from a visually hidden title: the slot's own heading is not a second visible title.
    expect(screen.getByRole('region', { name: 'voice harbour' })).toBeInTheDocument();
    expect(container.querySelector('h2.d-call-stage__title')).toBeNull();
  });

  it('without a header slot the stage keeps its visible title', () => {
    const { container } = render(<CallStage {...base} />);
    expect(container.querySelector('.d-call-stage__bar')).toBeNull();
    expect(container.querySelector('h2.d-call-stage__title')).not.toBeNull();
  });

  describe('stage (grid, focus, full screen)', () => {
    function src(name: string, source: 'camera' | 'screen' | 'avatar', media: MediaStream | null, more: Partial<CallTileProps> = {}): CallTileProps {
      const t = tile(name, media);
      return { ...t, id: `d-${name}:${source}`, source, title: source === 'screen' ? `${name} screen` : name, fullscreenLabel: `full screen ${source === 'screen' ? name + ' screen' : name}`, ...more };
    }
    const sA = new MediaStream();
    const sB = new MediaStream();
    function Harness({ initial = null, onFocus, ...rest }: Partial<CallStageProps> & { initial?: string | null }) {
      const [f, setF] = useState<string | null>(initial);
      return <CallStage {...base} tiles={[src('ada', 'camera', sA), src('bo', 'screen', sB), src('bo', 'camera', null)]} {...rest}
        focusedId={f} onFocus={id => { onFocus?.(id); setF(id); }} />;
    }
    const focusBtn = (name: string) => screen.getByRole('button', { name });
    function setFullscreen(enabled: boolean, element: Element | null = null) {
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: enabled });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
    }
    afterEach(() => {
      Reflect.deleteProperty(document, 'fullscreenEnabled');
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(document, 'exitFullscreen');
      Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
      Reflect.deleteProperty(HTMLMediaElement.prototype, 'srcObject');
      vi.restoreAllMocks();
    });

    it.each([
      [1, 1200, 700, 1], [2, 1400, 600, 2], [2, 1200, 700, 1], [3, 1200, 700, 2], [2, 1024, 600, 2],
      // D2 boundary (NARROW_STAGE_PX 1100, NEAR_TIE 0.95): 1099x640 is a 97 % near tie, so two columns; 1100 is not narrow, so the old rule keeps one;
      // 1099x660 is a 94.5 % gap, outside the tie.
      [2, 1099, 640, 2], [2, 1100, 640, 1], [2, 1099, 660, 1], [2, 1099, 700, 1], [4, 1200, 700, 2], [9, 1600, 900, 3], [2, 400, 900, 1], [5, 1200, 300, 3],
    ])('stageColumns picks the column count that maximises the 16:9 tile: n=%i in %ix%i is %i', (n, w, h, cols) => {
      expect(stageColumns(n, w, h, 12)).toBe(cols);
    });

    it('focus sets data-focused on the tile and data-focused-stage on the stage; a click on the focused tile unfocuses', async () => {
      const onFocus = vi.fn();
      const { container } = render(<Harness onFocus={onFocus} />);
      const stage = container.querySelector('.d-call-stage')!;
      expect(stage).not.toHaveAttribute('data-focused-stage');
      await userEvent.click(focusBtn('bo screen'));
      expect(onFocus).toHaveBeenLastCalledWith('d-bo:screen');
      expect(stage).toHaveAttribute('data-focused-stage');
      const lis = container.querySelectorAll('li.d-call-stage__tile');
      expect([...lis].map(l => l.getAttribute('data-focused'))).toEqual(['false', 'true', 'false']);
      expect(focusBtn('bo screen')).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(focusBtn('bo screen'));
      expect(onFocus).toHaveBeenLastCalledWith(null);
      expect(stage).not.toHaveAttribute('data-focused-stage');
    });

    it('Enter and Space on a focus button focus its tile', async () => {
      const onFocus = vi.fn();
      render(<Harness onFocus={onFocus} />);
      focusBtn('ada').focus();
      await userEvent.keyboard('{Enter}');
      expect(onFocus).toHaveBeenLastCalledWith('d-ada:camera');
      await userEvent.keyboard(' ');
      expect(onFocus).toHaveBeenLastCalledWith(null);
    });

    it('Escape unfocuses and is consumed; Escape in full screen, or with nothing focused, does nothing', async () => {
      const onFocus = vi.fn();
      const outer = vi.fn();
      const { container } = render(<div onKeyDown={outer}><Harness initial="d-ada:camera" onFocus={onFocus} /></div>);
      setFullscreen(true, container.querySelector('li'));
      focusBtn('ada').focus();
      await userEvent.keyboard('{Escape}');
      expect(onFocus).not.toHaveBeenCalled();
      setFullscreen(true, null);
      outer.mockClear();
      await userEvent.keyboard('{Escape}');
      expect(onFocus).toHaveBeenCalledWith(null);
      expect(outer).not.toHaveBeenCalled();
      onFocus.mockClear();
      outer.mockClear();
      await userEvent.keyboard('{Escape}');
      expect(onFocus).not.toHaveBeenCalled();
      expect(outer).toHaveBeenCalled();
    });

    it('a focusedId that names no tile renders a grid', () => {
      const { container } = render(<Harness initial="d-nobody:camera" />);
      expect(container.querySelector('.d-call-stage')).not.toHaveAttribute('data-focused-stage');
      expect(container.querySelector('[data-focused="true"]')).toBeNull();
    });

    it('the same video elements survive focus, swap and unfocus, and srcObject is set once per stream (R27)', async () => {
      const set = vi.fn();
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return null; }, set });
      const { container } = render(<Harness />);
      const before = [...container.querySelectorAll('video')];
      expect(before).toHaveLength(2);
      const items = [...container.querySelectorAll('li')];
      await userEvent.click(focusBtn('bo screen'));
      await userEvent.click(focusBtn('ada'));
      await userEvent.click(focusBtn('ada'));
      const after = [...container.querySelectorAll('video')];
      after.forEach((v, i) => expect(v).toBe(before[i]));
      [...container.querySelectorAll('li')].forEach((l, i) => expect(l).toBe(items[i]));
      expect(set).toHaveBeenCalledTimes(2);
    });

    it('the focus button holds no button, input or link (R28); the volume and full screen are its siblings', () => {
      const { container } = render(<Harness />);
      const buttons = container.querySelectorAll('.d-call-tile__focus');
      expect(buttons).toHaveLength(3);
      buttons.forEach(b => expect(b.querySelector('button, input, a, [tabindex]')).toBeNull());
      const li = buttons[0].closest('li')!;
      expect(li.querySelector('input[type="range"]')!.closest('.d-call-tile__focus')).toBeNull();
    });

    it('data-source is on the li and on .d-call-tile, and one device with two sources has distinct keys', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { container } = render(<Harness />);
      const lis = [...container.querySelectorAll('li.d-call-stage__tile')];
      expect(lis.map(l => l.getAttribute('data-source'))).toEqual(['camera', 'screen', 'camera']);
      expect(lis.map(l => l.querySelector('.d-call-tile')!.getAttribute('data-source'))).toEqual(['camera', 'screen', 'camera']);
      expect(err.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/);
    });

    it('a screen tile has no volume and no state glyphs; a person tile keeps both', () => {
      const t = src('bo', 'screen', sB, { view: { ...tile('bo', sB).view, muted: true, screen: true } });
      const { container } = render(<CallStage {...base} tiles={[t, src('bo', 'camera', null, { view: { ...tile('bo', null).view, muted: true } })]} focusedId={null} onFocus={() => {}} />);
      const [screenLi, personLi] = container.querySelectorAll('li');
      expect(screenLi.querySelector('input[type="range"]')).toBeNull();
      expect(screenLi.querySelector('[data-state]')).toBeNull();
      expect(personLi.querySelector('input[type="range"]')).not.toBeNull();
      expect(personLi.querySelector('[data-state="muted"]')).not.toBeNull();
    });

    it('a tile without media shows the avatar; an unverified screen tile renders no video', () => {
      const bad = src('bo', 'screen', sB, { view: { ...tile('bo', sB).view, state: 'unverified' } });
      const { container } = render(<CallStage {...base} tiles={[bad, src('cy', 'avatar', null)]} focusedId={null} onFocus={() => {}} />);
      expect(container.querySelector('video')).toBeNull();
      expect(container.querySelectorAll('.d-avatar')).toHaveLength(2);
    });

    it('with a pause notice no screen tile renders and onFocus(null) is called once', () => {
      const onFocus = vi.fn();
      const notice = { kind: 'paused' as const, text: pausedText, action: null, focusOnce: false };
      const { container, rerender } = render(<Harness initial="d-bo:screen" onFocus={onFocus} />);
      expect(container.querySelectorAll('li')).toHaveLength(3);
      rerender(<Harness initial="d-bo:screen" onFocus={onFocus} notice={notice} />);
      expect(container.querySelectorAll('li')).toHaveLength(2);
      expect(container.querySelector('[data-source="screen"]')).toBeNull();
      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onFocus).toHaveBeenCalledWith(null);
      expect(container.querySelector('.d-call-stage')).not.toHaveAttribute('data-focused-stage');
    });

    it('the full-screen button requests full screen on the tile li, exits it when that li is full screen, and follows fullscreenchange', async () => {
      const request = vi.fn(() => Promise.resolve());
      const exit = vi.fn(() => Promise.resolve());
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
      setFullscreen(true);
      const { container } = render(<Harness />);
      const btn = screen.getByRole('button', { name: 'full screen bo screen' });
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      const li = container.querySelector('li[data-source="screen"]')!;
      await userEvent.click(screen.getByRole('button', { name: 'full screen bo screen' }));
      expect(request.mock.contexts[0]).toBe(li);
      setFullscreen(true, li);
      fireEvent(document, new Event('fullscreenchange'));
      expect(screen.getByRole('button', { name: 'full screen bo screen' })).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(screen.getByRole('button', { name: 'full screen bo screen' }));
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('a double-click on the focus button toggles full screen', async () => {
      const request = vi.fn(() => Promise.resolve());
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
      setFullscreen(true);
      render(<Harness />);
      await userEvent.dblClick(focusBtn('ada'));
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('web3.8 FX m8: an avatar-only tile has no full-screen button and no double-click full screen; a tile with media has', async () => {
      const request = vi.fn(() => Promise.resolve());
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
      setFullscreen(true);
      render(<CallStage {...base} tiles={[src('ada', 'camera', sA), src('bo', 'camera', null), src('cy', 'avatar', null)]}
        focusedId={null} onFocus={() => {}} />);
      expect(screen.getByRole('button', { name: 'full screen ada' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'full screen bo' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'full screen cy' })).toBeNull();
      await userEvent.dblClick(focusBtn('bo'));
      await userEvent.dblClick(focusBtn('cy'));
      expect(request).not.toHaveBeenCalled();
    });

    it('web3.8 FX: the stage list says when it holds more than two tiles (the phone lays those out in two columns)', () => {
      const { container, rerender } = render(<CallStage {...base} tiles={[src('ada', 'camera', sA), src('bo', 'avatar', null)]}
        focusedId={null} onFocus={() => {}} />);
      expect(container.querySelector('ul')).not.toHaveAttribute('data-many');
      rerender(<CallStage {...base} tiles={[src('ada', 'camera', sA), src('bo', 'avatar', null), src('cy', 'avatar', null)]}
        focusedId={null} onFocus={() => {}} />);
      expect(container.querySelector('ul')).toHaveAttribute('data-many', 'true');
    });

    it('there is no full-screen button when the document cannot do full screen', () => {
      setFullscreen(false);
      render(<Harness />);
      expect(screen.queryByRole('button', { name: /^full screen/ })).toBeNull();
    });

    it('a refused full-screen request or exit is caught', async () => {
      const caught = vi.fn();
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: vi.fn(() => ({ catch: caught })) });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(() => ({ catch: caught })) });
      setFullscreen(true);
      const { container } = render(<Harness />);
      await userEvent.click(screen.getByRole('button', { name: 'full screen ada' }));
      setFullscreen(true, container.querySelector('li'));
      await userEvent.click(screen.getByRole('button', { name: 'full screen ada' }));
      expect(caught).toHaveBeenCalledTimes(2);
    });

    it('the focus button is described by the states in the caption, the stream states included', () => {
      const bad = src('cy', 'camera', null, { view: { ...tile('cy', null).view, muted: true, deafened: true, state: 'unverified' } });
      render(<CallStage {...base} tiles={[bad]} focusedId={null} onFocus={() => {}} />);
      const button = focusBtn('cy');
      // jsdom does not fold a child image's aria-label into a description; a browser does, so the glyphs are pinned by id.
      const states = document.getElementById(button.getAttribute('aria-describedby') ?? '')!;
      expect(states).toContainElement(screen.getByRole('img', { name: 'muted' }));
      expect(states).toContainElement(screen.getByRole('img', { name: 'deafened' }));
      expect(button).toHaveAccessibleDescription(/unverified stream/);
    });

    it('focusing the only tile leaves the grid layout: no focused stage, so no empty filmstrip row', () => {
      const { container } = render(<CallStage {...base} tiles={[src('ada', 'camera', sA)]} focusedId="d-ada:camera" onFocus={() => {}} />);
      expect(container.querySelector('li')).toHaveAttribute('data-focused', 'true');
      expect(container.querySelector('.d-call-stage')).not.toHaveAttribute('data-focused-stage');
      expect(container.querySelector('.d-call-stage__tiles')).not.toHaveAttribute('style', expect.stringContaining('--d-strip-n'));
    });

    describe('stage mode is on only when onFocus is given (pre-flight C-2)', () => {
      class FakeObserver { observe() {} disconnect() {} }
      beforeEach(() => {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
      });
      afterEach(() => {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
        Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
        Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
      });

      it('with onFocus the tiles area is a stage grid and its columns and width are written', () => {
        const { container } = render(<CallStage {...base} focusedId={null} onFocus={() => {}} />);
        const ul = container.querySelector<HTMLElement>('.d-call-stage__tiles')!;
        expect(ul).toHaveAttribute('data-tiles', 'stage');
        expect(ul.style.getPropertyValue('--d-stage-cols')).toBe('1');
        expect(ul.style.getPropertyValue('--d-tile-w')).not.toBe('');
      });

      it('D1: the last tile of a partial row is the orphan; full rows and a single column have none', () => {
        const three = [src('ada', 'camera', sA), src('bo', 'camera', sB), src('cy', 'camera', null)];
        const { container, rerender } = render(<CallStage {...base} tiles={three} focusedId={null} onFocus={() => {}} />);
        const ul = container.querySelector<HTMLElement>('.d-call-stage__tiles')!;
        expect(ul.style.getPropertyValue('--d-stage-cols')).toBe('2');
        const lis = () => [...container.querySelectorAll('li.d-call-stage__tile')];
        expect(lis().map(l => l.hasAttribute('data-orphan'))).toEqual([false, false, true]);
        rerender(<CallStage {...base} tiles={[...three, src('di', 'camera', null)]} focusedId={null} onFocus={() => {}} />);
        expect(lis().some(l => l.hasAttribute('data-orphan'))).toBe(false);
        rerender(<CallStage {...base} tiles={three.slice(0, 2)} focusedId={null} onFocus={() => {}} />);
        expect(ul.style.getPropertyValue('--d-stage-cols')).toBe('1');
        expect(lis().some(l => l.hasAttribute('data-orphan'))).toBe(false);
      });

      it('without onFocus nothing is written and the area keeps the old layout', () => {
        const { container } = render(<CallStage {...base} />);
        const ul = container.querySelector<HTMLElement>('.d-call-stage__tiles')!;
        expect(ul).not.toHaveAttribute('data-tiles');
        expect(ul.style.getPropertyValue('--d-stage-cols')).toBe('');
        expect(ul.style.getPropertyValue('--d-tile-w')).toBe('');
      });
    });
  });
});
