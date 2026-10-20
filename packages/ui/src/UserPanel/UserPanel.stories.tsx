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
  play: ({ canvasElement }) => { expectPanelTargets(canvasElement, 'UserPanel'); expectOneLine(canvasElement, 'UserPanel'); },
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
