import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemberList } from './MemberList.tsx';

const meta = {
  title: 'Shell/MemberList', component: MemberList,
  args: {
    label: 'members', loading: false, loadingLabel: 'Loading members…', emptyLabel: 'No members yet.', onOpen: () => {},
    groups: [
      { id: 'mods', kind: 'role', title: 'moderators', color: 0xe74c3c, members: [{ id: 'u1', name: 'Astrid', isOwner: true, color: 0xe74c3c, presence: 'online' }] },
      { id: 'online', kind: 'online', title: 'online', members: [
        { id: 'u2', name: 'Bjorn', color: 0x3498db, presence: 'online' },
        { id: 'u3', name: 'Sigrid', presence: 'idle' },
        { id: 'u4', name: 'Maximilian-Alexander von Hohenzollern-Sigmaringen the Third', color: 0xf1c40f, presence: 'dnd' },
        { id: 'u7', name: 'Dag', status: 'in a meeting', presence: 'dnd' },
      ] },
      { id: 'offline', kind: 'offline', title: 'offline', members: [
        { id: 'u5', name: 'Cleo', color: 0x9b59b6, presence: 'offline' },
        { id: 'u6', name: 'Erik', presence: 'offline' },
      ] },
    ],
  },
  decorators: [Story => <div style={{ width: '16rem', minHeight: '14rem' }}><Story /></div>],
} satisfies Meta<typeof MemberList>;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * R28, R12, F1, P4: the 48 bar (its hairline at y=48), three sections with counts, rows at --row-h-2, offline rows dimmed. A row with
 * no status line has its name centred in the row (±1px); no row draws a tag, a role dot or a "…" trigger; the owner has a crown.
 */
function expectMembers(root: HTMLElement, story: string): void {
  const bar = root.querySelector<HTMLElement>('.d-member-list__bar');
  if (bar === null) throw new Error(`${story}: no bar`);
  const top = root.querySelector<HTMLElement>('.d-member-list')!.getBoundingClientRect().top;
  const edge = bar.getBoundingClientRect().bottom - top;
  if (Math.abs(edge - 48) > 0.5) throw new Error(`${story}: the bar's hairline is at y=${String(edge)}, not 48`);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-row]'));
  if (rows.length === 0) throw new Error(`${story}: no rows`);
  for (const row of rows) {
    const h = row.getBoundingClientRect().height;
    if (h < 2.75 * rem - 0.5) throw new Error(`${story}: a row is ${String(h)} high, under var(--row-h-2)`);
    const a = row.querySelector<HTMLElement>('.d-avatar')!.getBoundingClientRect();
    if (Math.abs(a.width - 32) > 0.5) throw new Error(`${story}: the avatar is ${String(a.width)} wide, not 32`);
    if (row.querySelector('.d-member-list__line2') === null) {
      const r = row.getBoundingClientRect();
      const n = row.querySelector<HTMLElement>('.d-member-list__name')!.getBoundingClientRect();
      const off = Math.abs((n.top + n.height / 2) - (r.top + r.height / 2));
      if (off > 1) throw new Error(`${story}: the name's centre is ${String(off)}px off the row's centre`);
    }
  }
  if (root.querySelector('.d-role-dot, .d-member-list__tag, .d-action-menu') !== null) throw new Error(`${story}: a row still draws a dot, a tag or a "…" trigger`);
  if (root.querySelectorAll('[data-icon="crown"]').length !== 1) throw new Error(`${story}: expected exactly one crown`);
  const xs = new Set(rows.map(r => Math.round(r.querySelector<HTMLElement>('.d-member-list__name')!.getBoundingClientRect().left)));
  if (xs.size > 1) throw new Error(`${story}: the names start at ${[...xs].join(', ')}, not at one x`);
  const off = root.querySelector<HTMLElement>('[data-kind="offline"] [data-row] .d-member-list__text');
  if (off !== null && getComputedStyle(off).opacity !== '0.8') throw new Error(`${story}: an offline row is not dimmed (${getComputedStyle(off).opacity})`);
  // The long name takes the room it has (an ellipsis only at the very end), never a tag's.
  const long = Array.from(root.querySelectorAll<HTMLElement>('.d-member-list__name')).find(n => n.textContent?.startsWith('Maximilian'));
  if (long !== undefined && long.clientWidth < 100) throw new Error(`${story}: the long name is squeezed to ${String(long.clientWidth)}px`);
}
export const Default: Story = { play: ({ canvasElement }) => { expectMembers(canvasElement, 'MemberList'); } };
export const ThreeSections: Story = { ...Default, globals: { theme: 'light' } };
export const ThreeSectionsHighContrast: Story = { ...Default, globals: { theme: 'high-contrast' } };
export const Loading: Story = { args: { loading: true } };
/** Inside the shell's aside, which names the list itself: no bar. */
export const NoBar: Story = { args: { label: undefined } };
export const Empty: Story = { args: { groups: [] } };
