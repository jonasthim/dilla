import type { Meta, StoryObj } from '@storybook/react-vite';
import { UserPanel } from './UserPanel.tsx';

/** Every button is at least 32 × 32 CSS px (flow 13), above WCAG 2.5.8's 24. */
function expectPanelTargets(root: HTMLElement, story: string): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('button'))) {
    const r = el.getBoundingClientRect();
    if (r.width < 32 || r.height < 32) {
      throw new Error(`${story}: "${el.getAttribute('aria-label') ?? el.textContent ?? ''}" is ${String(r.width)} × ${String(r.height)}, under 32 px`);
    }
  }
}
/** The row stays one line at the sidebar's width: the controls do not wrap and the name block gives way. */
function expectOneLine(root: HTMLElement, story: string): void {
  const panel = root.querySelector<HTMLElement>('.d-user-panel');
  if (panel === null) throw new Error(`${story}: no panel`);
  const tops = Array.from(panel.querySelectorAll<HTMLElement>('.d-user-panel__who, .d-user-panel__controls, .d-user-panel__settings')).map(e => Math.round(e.getBoundingClientRect().top));
  if (Math.max(...tops) - Math.min(...tops) > 4) throw new Error(`${story}: the panel wraps (tops ${tops.join(', ')})`);
  if (panel.scrollWidth > panel.clientWidth + 1) throw new Error(`${story}: the panel overflows sideways`);
}

/**
 * Left-aligned, as in Discord: the avatar sits on the panel's left padding edge (inside the status button's own padding),
 * the gear on its right padding edge, and the name block takes the free width between them.
 */
function expectEdges(root: HTMLElement, story: string): void {
  const panel = root.querySelector<HTMLElement>('.d-user-panel');
  const who = root.querySelector<HTMLElement>('.d-user-panel__who');
  const avatar = root.querySelector<HTMLElement>('.d-user-panel__who .d-avatar');
  const gear = root.querySelector<HTMLElement>('.d-user-panel__settings');
  if (panel === null || who === null || avatar === null || gear === null) throw new Error(`${story}: no panel, avatar or gear`);
  const box = panel.getBoundingClientRect();
  const style = getComputedStyle(panel);
  const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
  const whoStyle = getComputedStyle(who);
  const inner = left + parseFloat(whoStyle.borderLeftWidth) + parseFloat(whoStyle.paddingLeft);
  const a = avatar.getBoundingClientRect().left;
  if (Math.abs(a - inner) > 1) throw new Error(`${story}: the avatar starts at ${String(a)}, not at ${String(inner)} (the panel's left padding edge)`);
  const g = gear.getBoundingClientRect().right;
  if (Math.abs(g - right) > 1) throw new Error(`${story}: the gear ends at ${String(g)}, not at the panel's right padding edge ${String(right)}`);
}

const meta = {
  title: 'Shell/UserPanel', component: UserPanel,
  excludeStories: [],
  args: {
    name: 'Ada Lovelace', username: 'ada', muted: false, deafened: false,
    shortcuts: { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' },
    labels: { region: 'your account', mute: 'mute', deafen: 'deafen', settings: 'settings' },
    status: {
      current: 'online', label: 'your status: Online',
      items: [{ id: 'online', label: 'Online' }, { id: 'idle', label: 'Idle' }, { id: 'dnd', label: 'Do Not Disturb' }, { id: 'invisible', label: 'Invisible' }],
      onChoose: () => {},
    },
    onMute: () => {}, onDeafen: () => {}, onSettings: () => {},
  },
  // The sidebar's default width.
  decorators: [Story => <div style={{ width: 240 }}><Story /></div>],
  play: ({ canvasElement }) => { expectPanelTargets(canvasElement, 'UserPanel'); expectOneLine(canvasElement, 'UserPanel'); expectEdges(canvasElement, 'UserPanel'); },
} satisfies Meta<typeof UserPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { globals: { theme: 'mesh' } };
export const Light: Story = { globals: { theme: 'light' } };
export const HighContrast: Story = { globals: { theme: 'high-contrast' } };
/** Muted and deafened: the glyphs swap and the toggles are pressed, in every theme. */
export const MutedAndDeafened: Story = { args: { muted: true, deafened: true }, globals: { theme: 'mesh' } };
export const MutedAndDeafenedLight: Story = { args: { muted: true, deafened: true }, globals: { theme: 'light' } };
export const MutedAndDeafenedHighContrast: Story = { args: { muted: true, deafened: true }, globals: { theme: 'high-contrast' } };
/** A long name truncates; the controls keep their size. */
export const LongName: Story = { args: { name: 'Augusta Ada King-Noel, Countess of Lovelace', username: 'countess.of.lovelace' } };

/** The sidebar dragged wide: the avatar stays on the left edge and the gear on the right. */
export const WideSidebar: Story = {
  decorators: [Story => <div style={{ width: 360 }}><Story /></div>],
  globals: { theme: 'mesh' },
};
