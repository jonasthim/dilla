import { fireEvent, render, screen } from '@testing-library/react';
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

  // J1: on a desktop the palette is a centred overlay of at most 40rem over the app, not a replacement: the shell stays in the DOM.
  it('opens over the app: the shell behind it stays mounted and is not made inert', () => {
    const props = { query: '', scope: 'all' as const, hits: [], labels, onQuery: vi.fn(), onScope: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    const shell = <main data-testid="shell"><button type="button">channel</button></main>;
    const view = render(<div>{shell}<SearchPalette open {...props} /></div>);
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(screen.getByTestId('shell')).not.toHaveAttribute('inert');
    expect(screen.getByRole('search')).not.toHaveAttribute('data-layout');
    view.rerender(<div>{shell}<SearchPalette open={false} {...props} /></div>);
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(screen.queryByRole('search')).toBeNull();
  });
  it('focuses the textbox on open, and Escape returns focus to the opener', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>open search</button>
        <SearchPalette open={open} query="" scope="all" hits={[]} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={() => setOpen(false)} /></>;
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'open search' });
    await user.click(opener);
    expect(screen.getByRole('combobox', { name: labels.search })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('search')).toBeNull();
    expect(opener).toHaveFocus();
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
    it('a desktop palette is fixed, centred and at most 40rem wide', () => {
      const r = /\.d-search-palette:not\(\[data-layout="phone"\]\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(r).toMatch(/position: fixed;/);
      expect(r).toMatch(/width: min\(calc\(100vw - 2rem\), 40rem\);/);
      expect(r).toMatch(/left: 50%;/);
    });
  });
});
