// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const shell = read('./AppShell.css');
const base = read('../styles/base.css');

// web3.8 (U3, R23, pre-flight C-22): the bottom-left panel spans under the rail and the sidebar; a shell that still
// passes a statusBar keeps a status row, so its wrapper must still sit in a grid area.
describe('AppShell grid areas', () => {
  it('the desktop grid has a panel area under the rail and sidebar, main spanning both rows', () => {
    expect(shell).toMatch(/\.d-app-shell__grid \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;[^}]*grid-template-areas: "banner banner banner" "rail sidebar main" "panel panel main";/);
  });
  it('the panel wrapper is the panel area', () => {
    expect(shell).toMatch(/\.d-app-shell__panel \{[^}]*grid-area: panel;/);
  });
  it('a shell with a status bar keeps a status row below the panel', () => {
    expect(shell).toMatch(/\.d-app-shell__grid:has\(> \.d-app-shell__status\) \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;[^}]*grid-template-areas: "banner banner banner" "rail sidebar main" "panel panel main" "status status status";/);
    expect(shell).toMatch(/\.d-app-shell__status \{ grid-area: status;/);
  });
  it('the aside grid has the panel area under the rail and sidebar, and the same with-status variant', () => {
    expect(base).toMatch(/\.d-app-shell__grid--aside \{[^}]*grid-template-areas: "banner banner banner banner" "rail sidebar main aside" "panel panel main aside";/);
    expect(base).toMatch(/__grid--aside:has\(> \.d-app-shell__status\) \{[^}]*grid-template-areas: "banner banner banner banner" "rail sidebar main aside" "panel panel main aside" "status status status status";/);
  });
});
