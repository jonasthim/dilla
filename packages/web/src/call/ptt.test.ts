import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceGate } from '@dilla/media';
import { bindPushToTalk } from './ptt.ts';

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { code, key: code === 'KeyV' ? 'v' : code, bubbles: true, cancelable: true, ...init });
}

describe('push to talk (decision 2, flow 06)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) c();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function bind(hasFocus = () => true) {
    const gate = new VoiceGate({ mode: 'ptt' });
    const changes: boolean[] = [];
    vi.spyOn(document, 'hasFocus').mockImplementation(hasFocus);
    cleanup.push(bindPushToTalk({ code: 'KeyV', onChange: (down) => { changes.push(down); gate.setPtt(down); } }));
    const open = () => gate.update(0, 0);
    return { gate, changes, open };
  }

  it('push-to-talk opens the gate only while held and never types into a field', () => {
    let focused = true;
    const { open, changes } = bind(() => focused);
    const down = key('keydown', 'KeyV');
    document.dispatchEvent(down);
    expect(open()).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    const repeat = key('keydown', 'KeyV', { repeat: true });
    document.dispatchEvent(repeat);
    expect(changes).toEqual([true]);
    expect(repeat.defaultPrevented).toBe(true);
    const up = key('keyup', 'KeyV');
    document.dispatchEvent(up);
    expect(open()).toBe(false);
    expect(up.defaultPrevented).toBe(true);
    focused = false;
    document.dispatchEvent(key('keydown', 'KeyV'));
    expect(open()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('never fires while focus is in an editable field, so the key types there as usual', () => {
    const { open, changes } = bind();
    for (const el of [document.createElement('input'), document.createElement('textarea'), (() => {
      const d = document.createElement('div');
      d.setAttribute('contenteditable', 'true');
      return d;
    })()]) {
      document.body.append(el);
      el.focus();
      const down = key('keydown', 'KeyV');
      el.dispatchEvent(down);
      expect(open()).toBe(false);
      expect(down.defaultPrevented).toBe(false);
      el.remove();
    }
    expect(changes).toEqual([]);
  });

  it('a field inside a contenteditable host counts as editable too', () => {
    const { changes } = bind();
    const host = document.createElement('div');
    host.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    host.append(inner);
    document.body.append(host);
    inner.dispatchEvent(key('keydown', 'KeyV'));
    expect(changes).toEqual([]);
  });

  it('other keys pass untouched', () => {
    const { changes } = bind();
    const other = key('keydown', 'KeyB');
    document.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(changes).toEqual([]);
  });

  it('closes when the tab loses focus or is hidden while the key is held', () => {
    const { open, changes } = bind();
    document.dispatchEvent(key('keydown', 'KeyV'));
    window.dispatchEvent(new Event('blur'));
    expect(open()).toBe(false);
    document.dispatchEvent(key('keydown', 'KeyV'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
    expect(changes).toEqual([true, false, true, false]);
  });

  it('dispose removes the listeners and releases a held key', () => {
    const gate = new VoiceGate({ mode: 'ptt' });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const changes: boolean[] = [];
    const dispose = bindPushToTalk({ code: 'KeyV', onChange: (d) => { changes.push(d); gate.setPtt(d); } });
    document.dispatchEvent(key('keydown', 'KeyV'));
    dispose();
    document.dispatchEvent(key('keydown', 'KeyV'));
    expect(changes).toEqual([true, false]);
  });
});
