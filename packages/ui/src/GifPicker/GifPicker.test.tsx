import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { GifPicker, tileRatio, tileSpan, type GifPickerProps } from './GifPicker.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const ITEMS = [
  { id: 'a1', title: 'cat typing', width: 200, height: 113, src: 'blob:cat' },
  { id: 'b2', title: '', width: 200, height: 200, src: null },
  { id: 'c3', title: 'dog', width: 200, height: 150, src: 'blob:dog' },
  { id: 'd4', title: 'fish', width: 200, height: 150, src: 'blob:fish' },
];

function picker(over: Partial<GifPickerProps> = {}) {
  const props: GifPickerProps = {
    label: 'gifs', searchLabel: 'search gifs', searchPlaceholder: 'search giphy', query: '', onQuery: vi.fn(),
    items: ITEMS, status: null, poweredBy: 'Powered by GIPHY', untitled: 'gif', moreLabel: 'more',
    hasMore: false, onMore: vi.fn(), pickingId: null, onPick: vi.fn(), onClose: vi.fn(), ...over,
  };
  const r = render(<div><button type="button" data-gif-toggle="">gif</button><GifPicker {...props} /></div>);
  return { ...r, props };
}

describe('GifPicker', () => {
  it('is a non-modal dialog with a labelled search box focused first, a grid of named buttons and the attribution', () => {
    picker();
    const dialog = screen.getByRole('dialog', { name: 'gifs' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(screen.getByRole('searchbox', { name: 'search gifs' })).toHaveFocus();
    const grid = screen.getAllByRole('button').filter(b => b.hasAttribute('data-gif-id'));
    expect(grid.map(b => b.getAttribute('aria-label'))).toEqual(['cat typing', 'gif', 'dog', 'fish']);
    expect(screen.getByText('Powered by GIPHY')).toBeInTheDocument();
  });

  it('shows a loaded preview as a decorative image and an unloaded one as a placeholder with no image', () => {
    const { container } = picker();
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(3);
    for (const img of imgs) expect(img).toHaveAttribute('alt', '');
    expect(imgs[0]).toHaveAttribute('src', 'blob:cat');
    const second = container.querySelector('[data-gif-id="b2"]')!;
    expect(second.querySelector('img')).toBeNull();
    expect(second.querySelector('[data-loading]')).not.toBeNull();
  });

  it('reports the typed query and picks by click, Enter and Space', async () => {
    const user = userEvent.setup();
    const { props } = picker();
    await user.type(screen.getByRole('searchbox'), 'c');
    expect(props.onQuery).toHaveBeenCalledWith('c');
    await user.click(screen.getByRole('button', { name: 'dog' }));
    screen.getByRole('button', { name: 'fish' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'cat typing' }).focus();
    await user.keyboard(' ');
    expect((props.onPick as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual(['c3', 'd4', 'a1']);
  });

  it('moves from the search box into the grid with ArrowDown, and back with ArrowUp from the first result', () => {
    picker();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    const first = screen.getByRole('button', { name: 'cat typing' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('keeps one tab stop in the grid that follows focus; arrows, Home and End move without wrapping', () => {
    picker();
    const grid = () => screen.getAllByRole('button').filter(b => b.hasAttribute('data-gif-id'));
    expect(grid().filter(b => b.tabIndex === 0)).toEqual([grid()[0]]);
    const key = (from: number, k: string) => { fireEvent.keyDown(grid()[from]!, { key: k }); return grid().indexOf(document.activeElement as HTMLButtonElement); };
    expect(key(0, 'ArrowRight')).toBe(1);
    expect(key(0, 'ArrowDown')).toBe(3);
    expect(key(3, 'ArrowRight')).toBe(3);
    expect(key(3, 'ArrowDown')).toBe(3);
    expect(key(3, 'ArrowLeft')).toBe(2);
    expect(key(2, 'End')).toBe(3);
    expect(key(3, 'ArrowUp')).toBe(0);
    expect(key(3, 'Home')).toBe(0);
    expect(key(0, 'ArrowLeft')).toBe(0);
    expect(grid().filter(b => b.tabIndex === 0)).toEqual([grid()[0]]);
  });

  it('closes on Escape without letting it reach the row, and on a pointer down outside but not on the opener', () => {
    const outer = vi.fn();
    const onClose = vi.fn();
    render(<div onKeyDown={outer}><button type="button">elsewhere</button><button type="button" data-gif-toggle="">gif</button>
      <GifPicker label="gifs" searchLabel="s" searchPlaceholder="p" query="" onQuery={() => {}} items={ITEMS} status={null}
        poweredBy="Powered by GIPHY" untitled="gif" moreLabel="more" hasMore={false} onMore={() => {}} pickingId={null}
        onPick={() => {}} onClose={onClose} /></div>);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenLastCalledWith('escape');
    expect(outer).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith('outside');
    fireEvent.pointerDown(document.querySelector('[data-gif-toggle]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'dog' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('says a status politely, and offers more only when there is more', async () => {
    const user = userEvent.setup();
    const { props, rerender } = picker({ status: { kind: 'empty', text: 'no gifs for that' }, items: [] });
    expect(screen.getByRole('status')).toHaveTextContent('no gifs for that');
    expect(screen.queryByRole('button', { name: 'more' })).toBeNull();
    rerender(<div><GifPicker {...props} items={ITEMS} status={null} hasMore /></div>);
    await user.click(screen.getByRole('button', { name: 'more' }));
    expect(props.onMore).toHaveBeenCalledTimes(1);
  });

  it('marks the picked GIF busy and refuses a second pick meanwhile', async () => {
    const user = userEvent.setup();
    const { props } = picker({ pickingId: 'c3', status: { kind: 'busy', text: 'adding gif' } });
    expect(screen.getByRole('button', { name: 'dog' })).toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByRole('button', { name: 'cat typing' }));
    expect(props.onPick).not.toHaveBeenCalled();
  });

  it('has no serious axe violations', async () => {
    const { container } = picker({ hasMore: true });
    await expectNoAxeViolations(container);
  });

  describe('masonry tiles', () => {
    const cell = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`button[data-gif-id="${id}"]`)!;
    it('sizes each tile from its own GIF: a tall and a wide result get different proportions and different heights', () => {
      const { container } = picker({ items: [
        { id: 'tall', title: 'tall', width: 100, height: 300, src: null }, { id: 'wide', title: 'wide', width: 300, height: 100, src: null },
      ] });
      expect(cell(container, 'tall').style.aspectRatio).toBe('100 / 300');
      expect(cell(container, 'wide').style.aspectRatio).toBe('300 / 100');
      const rows = (id: string) => Number(/span (\d+)/.exec(cell(container, id).style.gridRowEnd)![1]);
      expect(rows('tall')).toBeGreaterThan(rows('wide'));
      expect(rows('tall') - 4).toBeGreaterThan(8 * (rows('wide') - 4));
    });
    it('reserves the box before the preview loads: the placeholder tile has the same proportions and span as the loaded one', () => {
      const a = { id: 'x', title: 'x', width: 200, height: 113 };
      const { container, rerender } = picker({ items: [{ ...a, src: null }] });
      const before = [cell(container, 'x').style.aspectRatio, cell(container, 'x').style.gridRowEnd];
      expect(container.querySelector('img')).toBeNull();
      rerender(<div><GifPicker label="gifs" searchLabel="search gifs" searchPlaceholder="search giphy" query="" onQuery={vi.fn()}
        items={[{ ...a, src: 'blob:x' }]} status={null} poweredBy="Powered by GIPHY" untitled="gif" moreLabel="more" hasMore={false}
        onMore={vi.fn()} pickingId={null} onPick={vi.fn()} onClose={vi.fn()} /></div>);
      expect([cell(container, 'x').style.aspectRatio, cell(container, 'x').style.gridRowEnd]).toEqual(before);
    });
    it('never crops: the image is contained, and a size the instance did not give is a square, not a guess at a crop', () => {
      expect(tileRatio({ width: 0, height: 0 })).toBe('1 / 1');
      expect(tileRatio({ width: 200, height: 113 })).toBe('200 / 113');
      expect(tileSpan({ width: 100, height: 200 }, 100)).toBe(204);
      expect(tileSpan({ width: 0, height: 0 }, 100)).toBe(104);
      expect(tileSpan({ width: 400, height: 20 }, 100, 44)).toBe(48);
    });
    it('keeps reading order: the DOM order is the item order and Right then Down walk it', async () => {
      const user = userEvent.setup();
      const { container } = picker();
      await user.click(screen.getByRole('searchbox', { name: 'search gifs' }));
      await user.keyboard('{ArrowDown}');
      expect(cell(container, 'a1')).toHaveFocus();
      await user.keyboard('{ArrowRight}{ArrowRight}');
      expect(cell(container, 'c3')).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(cell(container, 'c3')).toHaveFocus();
    });
    it('Down from a tile with nothing below goes to the more button', async () => {
      const user = userEvent.setup();
      const { container } = picker({ hasMore: true });
      await user.click(screen.getByRole('searchbox', { name: 'search gifs' }));
      await user.keyboard('{ArrowDown}{ArrowRight}{ArrowRight}{ArrowDown}');
      expect(screen.getByRole('button', { name: 'more' })).toHaveFocus();
      expect(cell(container, 'c3')).not.toHaveFocus();
    });
  });
});
