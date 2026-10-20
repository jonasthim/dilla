import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { SearchPalette } from './SearchPalette.tsx';

const hits = [{ id: 'hit-1', snippet: 'lamp one', location: 'general' }, { id: 'hit-2', snippet: 'lamp two', location: 'loot' }];
const labels = { search: 'Search your messages', empty: 'No results in this scope', close: 'Close', scope: { channel: 'this conversation', community: 'this community', all: 'everything' } };

describe('SearchPalette', () => {
  it('keeps textbox focus while arrows and Enter choose a result', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const view = render(<SearchPalette open query="lamp" scope="all" hits={hits} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: labels.search });
    input.focus();
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-activedescendant', hits[1].id);
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith('hit-2');
    expect(screen.getByRole('listbox').querySelectorAll('[role="option"]')).toHaveLength(2);
    await expectNoAxeViolations(view.container);
  });
  it('announces one empty status, changes scope and closes on Escape', async () => {
    const user = userEvent.setup();
    const onScope = vi.fn();
    const onClose = vi.fn();
    render(<SearchPalette open query="absent" scope="channel" hits={[]} labels={labels} onQuery={vi.fn()} onScope={onScope} onPick={vi.fn()} onClose={onClose} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(labels.empty);
    await user.click(screen.getByRole('button', { name: labels.scope.all }));
    expect(onScope).toHaveBeenCalledWith('all');
    screen.getByRole('combobox', { name: labels.search }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('keeps selection, active descendant, arrows and Enter aligned after hits shrink', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const props = { open: true, query: 'lamp', scope: 'all' as const, labels, onQuery: vi.fn(), onScope: vi.fn(), onPick, onClose: vi.fn() };
    const view = render(<SearchPalette {...props} hits={hits} />);
    const input = screen.getByRole('combobox', { name: labels.search });
    input.focus();
    await user.keyboard('{ArrowDown}');
    const replacement = [{ id: 'fresh', snippet: 'new result', location: 'general' }];
    view.rerender(<SearchPalette {...props} hits={replacement} />);
    expect(input).toHaveAttribute('aria-activedescendant', 'fresh');
    expect(screen.getByRole('option', { name: /new result/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith('fresh');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /new result/ })).toHaveAttribute('aria-selected', 'true');
  });
  // W-07: Enter and Escape that commit or cancel an IME candidate belong to the IME; the textbox is a combobox.
  it('leaves Enter and Escape to IME composition, and exposes combobox semantics', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<SearchPalette open query="lamp" scope="all" hits={hits} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={onPick} onClose={onClose} />);
    const input = screen.getByRole('combobox', { name: labels.search });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledOnce();
  });
  // W-06: Escape closes from any control of the palette, not only the textbox; Close is the ui Button with its esc hint.
  it('closes on Escape from a scope button, with a Close that shows its key', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SearchPalette open query="" scope="all" hits={[]} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={onClose} />);
    screen.getByRole('button', { name: labels.scope.channel }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: labels.close })).toHaveClass('d-btn');
    expect(screen.getByRole('button', { name: labels.close })).toHaveTextContent('esc');
  });
  // M-03: one status node stays mounted and only its text changes, so a new message is announced.
  it('keeps one status mounted, with or without results', () => {
    const props = { open: true, query: 'lamp', scope: 'all' as const, labels, onQuery: vi.fn(), onScope: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    const view = render(<SearchPalette {...props} hits={hits} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');
    view.rerender(<SearchPalette {...props} hits={hits} status="That message is no longer available" />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('That message is no longer available');
    view.rerender(<SearchPalette {...props} hits={[]} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent(labels.empty);
  });

  // J1, R-S1: on a desktop the palette is a modal native dialog (focus trapped by the browser, shell inert, ::backdrop scrim); the shell stays mounted.
  it('opens as a modal dialog over the app: showModal is called and the shell stays mounted', () => {
    const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const props = { query: '', scope: 'all' as const, hits: [], labels, onQuery: vi.fn(), onScope: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    const shell = <main data-testid="shell"><button type="button">channel</button></main>;
    const view = render(<div>{shell}<SearchPalette modal open {...props} /></div>);
    expect(modal).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: labels.search });
    expect(dialog).toHaveClass('d-search-palette-dialog');
    expect(within(dialog).getByRole('search')).not.toHaveAttribute('data-layout');
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    view.rerender(<div>{shell}<SearchPalette modal open={false} {...props} /></div>);
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    modal.mockRestore();
  });
  it('closes on the native cancel and on a click on the scrim, but not on a click inside', () => {
    const onClose = vi.fn();
    render(<SearchPalette modal open query="" scope="all" hits={[]} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: labels.search });
    fireEvent.click(screen.getByRole('search'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('a pick that moves focus deliberately is not overridden by the restore (M4)', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>open search</button><button type="button">message</button>
        <SearchPalette modal open={open} query="" scope="all" hits={hits} labels={labels} onQuery={vi.fn()} onScope={vi.fn()}
          onPick={() => { setOpen(false); setTimeout(() => screen.getByRole('button', { name: 'message' }).focus(), 0); }} onClose={() => setOpen(false)} /></>;
    }
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'open search' }));
    await user.keyboard('{Enter}');
    await new Promise(r => setTimeout(r, 5));
    expect(screen.getByRole('button', { name: 'message' })).toHaveFocus();
  });
  it('focuses the textbox on open, and Escape returns focus to the opener', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>open search</button>
        <SearchPalette modal open={open} query="" scope="all" hits={[]} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={() => setOpen(false)} /></>;
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'open search' });
    await user.click(opener);
    expect(screen.getByRole('combobox', { name: labels.search })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('search')).toBeNull();
    expect(opener).toHaveFocus();
  });
  it('without modal there is no dialog: the inline section, as before (R-S4)', () => {
    const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    render(<SearchPalette open query="" scope="all" hits={[]} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('search').parentElement?.tagName).not.toBe('DIALOG');
    expect(modal).not.toHaveBeenCalled();
    modal.mockRestore();
  });
  it('a phone layout keeps today’s inline palette (data-layout=phone)', () => {
    render(<PhoneLayoutProvider value><SearchPalette open query="" scope="all" hits={[]} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={vi.fn()} /></PhoneLayoutProvider>);
    expect(screen.getByRole('search')).toHaveAttribute('data-layout', 'phone');
  });
  describe('overlay rules', () => {
    let css = '';
    beforeAll(async () => {
      const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(path: string, encoding: 'utf8'): string };
      const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
      css = fs.readFileSync(`${cwd}/src/SearchPalette/SearchPalette.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    });
    it('a desktop palette is a modal dialog box: centred, at most 40rem wide, with a scrim', () => {
      const r = /\.d-search-palette-dialog \{([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(r).toMatch(/width: min\(calc\(100vw - 2rem\), 40rem\);/);
      expect(r).toMatch(/margin: 12vh auto auto;/);
      expect(css).toMatch(/\.d-search-palette-dialog::backdrop \{[^}]*background: color-mix/);
    });
  });
  // J1: a result names its place, its author and its time, and a footer lists the three keys.
  it('shows #channel, author and time on a result, and a KeyHint footer', async () => {
    const withMeta = [{ id: 'm1', snippet: 'lamp one', location: '#general', author: 'Mira', time: '14:02' }, { id: 'm2', snippet: 'lamp two', location: 'Ada' }];
    const hinted = { ...labels, hints: { move: 'to move', open: 'to open', close: 'to close' } };
    const view = render(<SearchPalette open query="lamp" scope="all" hits={withMeta} labels={hinted} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={vi.fn()} />);
    const first = screen.getByRole('option', { name: /lamp one/ });
    expect(first).toHaveTextContent('#general');
    expect(first).toHaveTextContent('Mira');
    expect(first).toHaveTextContent('14:02');
    expect(screen.getByRole('option', { name: /lamp two/ })).not.toHaveTextContent('Mira');
    const foot = view.container.querySelector('.d-search-palette__hints')!;
    expect(Array.from(foot.querySelectorAll('.d-keyhint')).map(k => k.textContent)).toEqual(['↑↓to move', '↵to open', 'escto close']);
    // The footer carries the esc hint, so the Close button does not repeat it.
    expect(screen.getByRole('button', { name: labels.close })).not.toHaveTextContent('esc');
    await expectNoAxeViolations(view.container);
  });
});
