import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemberList } from './MemberList.tsx';

const kickBan = [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }];
const meta = {
  title: 'Shell/MemberList', component: MemberList,
  args: {
    label: 'members', loading: false, loadingLabel: 'Loading members…', emptyLabel: 'No members yet.', onAction: () => {},
    groups: [
      { id: 'mods', kind: 'role', title: 'moderators', color: 0xe74c3c, members: [{ id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: [], color: 0xe74c3c, presence: 'online' }] },
      { id: 'online', kind: 'online', title: 'online', members: [
        { id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: kickBan, color: 0x3498db, presence: 'online' },
        { id: 'u3', name: 'Sigrid', tags: ['you'], actionsLabel: 'actions for Sigrid', actions: [], presence: 'idle' },
        { id: 'u4', name: 'Dag', tags: ['bot'], actionsLabel: 'actions for Dag', actions: [], presence: 'dnd' },
      ] },
      { id: 'offline', kind: 'offline', title: 'offline', members: [
        { id: 'u5', name: 'Cleo', tags: [], actionsLabel: 'actions for Cleo', actions: kickBan, presence: 'offline' },
        { id: 'u6', name: 'Erik', tags: [], actionsLabel: 'actions for Erik', actions: [], presence: 'offline' },
      ] },
    ],
  },
  decorators: [Story => <div style={{ width: '16rem', minHeight: '14rem' }}><Story /></div>],
} satisfies Meta<typeof MemberList>;
export default meta;
type Story = StoryObj<typeof meta>;

/** R28, R12, F1: the 48 bar (its hairline at y=48), three sections with counts, two-line rows at --row-h-2, offline rows dimmed. */
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
  }
  const xs = new Set(rows.map(r => Math.round(r.querySelector<HTMLElement>('.d-member-list__name')!.getBoundingClientRect().left)));
  if (xs.size > 1) throw new Error(`${story}: the names start at ${[...xs].join(', ')}, not at one x`);
  const off = root.querySelector<HTMLElement>('[data-kind="offline"] [data-row] .d-member-list__text');
  if (off !== null && getComputedStyle(off).opacity !== '0.8') throw new Error(`${story}: an offline row is not dimmed (${getComputedStyle(off).opacity})`);
}
export const Default: Story = { play: ({ canvasElement }) => { expectMembers(canvasElement, 'MemberList'); } };
export const ThreeSections: Story = { ...Default, globals: { theme: 'light' } };
export const ThreeSectionsHighContrast: Story = { ...Default, globals: { theme: 'high-contrast' } };
export const Loading: Story = { args: { loading: true } };
/** Inside the shell's aside, which names the list itself: no bar. */
export const NoBar: Story = { args: { label: undefined } };
export const Empty: Story = { args: { groups: [] } };
