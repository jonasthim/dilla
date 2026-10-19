// The shell's layout rules that jsdom cannot lay out (product walk I4, I5; WB a11y m4 ruling): read from app.css, as
// SettingsFrame.test reads its container query. The voice e2e and the docs shoot check the same in a real browser.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8');
/** The body of the shell's phone container query (`@container d-shell (max-width: 47.99rem)`). */
const phone = /@container d-shell \(max-width: 47\.99rem\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const rule = (block: string, selector: string) => new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(block)?.[2] ?? '';

describe('the phone layout of voice (360 px)', () => {
  it('I4: the dock is pinned to the bottom of the sidebar column, so it stays on screen while a text channel is read', () => {
    expect(phone).not.toBe('');
    expect(rule(phone, '.d-app-shell:not([data-layout="phone"]) .dw-sidebar > .dw-voice-dock')).toMatch(/position:\s*sticky;\s*bottom:\s*0/);
  });

  it('I5: no stage toolbar floats over the tiles: the controls are in normal flow', () => {
    expect(rule(phone, '.dw-voice-stage .d-call-stage__controls')).toMatch(/position:\s*static/);
    expect(rule(phone, '.dw-dm-call .d-call-stage__controls')).toMatch(/position:\s*static/);
    expect(phone).not.toMatch(/d-call-stage__controls\s*\{[^}]*position:\s*(sticky|fixed|absolute)/);
  });
});

describe('the desktop stage toolbar is pinned (web3.8, VOICE-W)', () => {
  const stage = '.d-app-shell:not([data-layout="phone"]) .dw-voice-stage:not(.dw-dm-call .dw-voice-stage)';
  it('fills the stage and sticks the toolbar to its bottom', () => {
    expect(rule(css, `${stage} .d-call-stage`)).toMatch(/min-height:\s*100%;\s*box-sizing:\s*border-box/);
    expect(rule(css, `${stage} .d-call-stage__controls`)).toMatch(/position:\s*sticky;\s*bottom:\s*0;\s*margin-top:\s*auto;\s*padding-block:\s*0\.5rem;\s*background:\s*var\(--bg\)/);
  });
});

describe('a focused tile control clears the pinned toolbar (WCAG 2.4.11)', () => {
  it('the stage scrolls a focused control above the toolbar', () => {
    expect(rule(css, '.dw-voice-stage')).toMatch(/scroll-padding-bottom:\s*4\.5rem/);
  });
});

describe('the one channel list (web3.8 item 12)', () => {
  it('has no voice-section rules left, and the join and the "+" are 44 px targets on a phone', () => {
    expect(css).not.toContain('dw-voice-section');
    expect(css).not.toContain('dw-new-channel');
    expect(css).toMatch(/\[data-layout="phone"\] \.d-channel-list__join, \[data-layout="phone"\] \.dw-call-strip \.d-btn \{ min-height: 2\.75rem; \}/);
    expect(css).toMatch(/@container d-shell \(max-width: 47\.99rem\) \{\s*\.d-channel-list__join, \.dw-call-strip \.d-btn \{ min-height: 2\.75rem; \}/);
    expect(rule(css, '[data-layout="phone"] .dw-channel-add')).toMatch(/min-width:\s*2\.75rem;\s*min-height:\s*2\.75rem/);
  });
});

describe('a long chosen name never widens the page (product walk I2)', () => {
  it('the direct-message picker wraps a long name inside its row and keeps the open button whole', () => {
    expect(rule(css, '.dw-dm-picker__name')).toMatch(/min-width:\s*0/);
    expect(rule(css, '.dw-dm-picker__name')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(css, '.dw-dm-picker__row > .d-btn')).toMatch(/flex-shrink:\s*0/);
  });
});
