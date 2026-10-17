import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Icon } from './Icon.tsx';
import { ICONS, type IconName } from './icons.ts';

const NAMES = ['mic', 'mic-off', 'headphones', 'headphone-off', 'video', 'video-off', 'monitor-up', 'monitor-x', 'phone-off'] as const;

const SHELL_NAMES = [
  'server', 'message-square', 'activity', 'user', 'chevron-left', 'chevron-right', 'chevron-down', 'x', 'check',
  'triangle-alert', 'pause', 'ellipsis-vertical', 'hash', 'volume-2', 'megaphone', 'messages-square', 'file', 'play', 'eye', 'settings', 'plus', 'maximize', 'minimize',
] as const;

describe('Icon', () => {
  it('vendors exactly the voice icons and the shell icons', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...NAMES, ...SHELL_NAMES].sort());
  });

  it.each(SHELL_NAMES)('%s renders its geometry', (name: IconName) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('data-icon', name);
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s renders one hidden, unfocusable, monoline svg with its geometry', (name: IconName) => {
    const { container } = render(<Icon name={name} />);
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    const svg = svgs[0];
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '2');
    expect(svg).toHaveAttribute('stroke-linecap', 'round');
    expect(svg).toHaveAttribute('stroke-linejoin', 'round');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg.children.length).toBe(ICONS[name].length);
    for (const p of Array.from(svg.querySelectorAll('path'))) expect(p.getAttribute('d')).toMatch(/^[Mm]/);
  });

  it('the element count of each icon stays as vendored', () => {
    const counts = Object.fromEntries(NAMES.map(n => [n, render(<Icon name={n} />).container.querySelector('svg')?.children.length]));
    expect(counts).toMatchInlineSnapshot(`
      {
        "headphone-off": 5,
        "headphones": 1,
        "mic": 3,
        "mic-off": 6,
        "monitor-up": 5,
        "monitor-x": 5,
        "phone-off": 3,
        "video": 2,
        "video-off": 3,
      }
    `);
  });

  it('takes a size in CSS px', () => {
    const { container } = render(<Icon name="mic" size={16} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '16');
    expect(container.querySelector('svg')).toHaveAttribute('height', '16');
  });
});
