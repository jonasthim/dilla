import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemberList } from '../MemberList/MemberList.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
import { ProfileCard, type ProfileCardProps } from './ProfileCard.tsx';

const actions = [{ id: 'message', label: 'message' }, { id: 'safety', label: 'compare safety numbers' }, { id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }];
const groups = [
  { id: 'mods', kind: 'role' as const, title: 'moderators', color: 0xe74c3c, members: [{ id: 'u1', name: 'Astrid', isOwner: true, color: 0xe74c3c, presence: 'online' as const }] },
  { id: 'online', kind: 'online' as const, title: 'online', members: [
    { id: 'u2', name: 'Bjorn', color: 0x3498db, presence: 'online' as const },
    { id: 'u3', name: 'Sigrid', presence: 'idle' as const },
  ] },
  { id: 'offline', kind: 'offline' as const, title: 'offline', members: [{ id: 'u5', name: 'Cleo', presence: 'offline' as const }] },
];

/** The member list on the right of the screen with Astrid's card open beside her row, as the shell mounts it. */
function Beside(props: Omit<ProfileCardProps, 'anchor'>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => { setAnchor(document.querySelector<HTMLElement>('[data-focus-key="member:u1"]')); }, []);
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ width: '16rem' }}><MemberList label="members" groups={groups} loading={false} loadingLabel="Loading members…" emptyLabel="No members yet." onOpen={() => {}} /></div>
      {anchor !== null ? <ProfileCard {...props} anchor={anchor} /> : null}
    </div>
  );
}

const meta = {
  title: 'Shell/ProfileCard', component: ProfileCard,
  args: {
    name: 'Astrid', username: 'astrid', presence: 'online', isOwner: true, isYou: true, status: 'writing the release notes', bio: 'Maintainer of dilla.\nAsk me about releases.',
    roles: [{ name: 'moderators', color: 0xe74c3c }, { name: 'builders', color: 0x3498db }, { name: 'members', color: null }],
    actions, onAction: () => {}, onClose: () => {},
  },
} satisfies Meta<typeof ProfileCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Waits (up to 3s) for the card to be mounted and placed, never a fixed delay. */
async function settled(root: HTMLElement): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const card = root.querySelector<HTMLElement>('.d-profile-card');
    if (card !== null && (card.dataset.layout === 'sheet' || card.style.left !== '')) { await new Promise(r => setTimeout(r, 30)); return; }
    await new Promise(r => setTimeout(r, 50));
  }
}
/** P3: a popover beside the row (left of the list), focus inside, not over the row it opened from. */
async function expectPopover(root: HTMLElement, story: string): Promise<void> {
  await settled(root);
  const card = root.querySelector<HTMLElement>('.d-profile-card');
  const row = root.querySelector<HTMLElement>('[data-focus-key="member:u1"]');
  if (card === null || row === null) throw new Error(`${story}: no card or no row`);
  const c = card.getBoundingClientRect(); const r = row.getBoundingClientRect();
  if (c.right > r.left + 0.5) throw new Error(`${story}: the card (right ${String(c.right)}) overlaps the row (left ${String(r.left)})`);
  if (c.left < 0 || c.top < 0 || c.bottom > window.innerHeight + 0.5) throw new Error(`${story}: the card is outside the viewport`);
  if (!card.contains(document.activeElement)) throw new Error(`${story}: focus is not inside the card`);
  if (card.getAttribute('role') !== 'dialog') throw new Error(`${story}: not a dialog`);
}
/** P3: a sheet pinned to the bottom of the screen at phone width, 44px targets, focus inside. */
async function expectSheet(root: HTMLElement, story: string): Promise<void> {
  await settled(root);
  const card = root.querySelector<HTMLElement>('.d-profile-card');
  if (card === null) throw new Error(`${story}: no card`);
  const c = card.getBoundingClientRect();
  if (Math.abs(c.bottom - window.innerHeight) > 0.5) throw new Error(`${story}: the sheet's bottom is ${String(c.bottom)}, not the screen's ${String(window.innerHeight)}`);
  if (Math.abs(c.width - window.innerWidth) > 0.5) throw new Error(`${story}: the sheet is ${String(c.width)} wide, not full width`);
  for (const b of Array.from(card.querySelectorAll<HTMLElement>('.d-profile-card__action, .d-profile-card__close'))) {
    if (b.getBoundingClientRect().height < 43.5) throw new Error(`${story}: a target is ${String(b.getBoundingClientRect().height)} high, under 44`);
  }
  if (!card.contains(document.activeElement)) throw new Error(`${story}: focus is not inside the card`);
}

export const DesktopSignal: Story = {
  render: args => <Beside {...args} />, parameters: { layout: 'fullscreen' }, globals: { theme: 'signal' },
  play: ({ canvasElement }) => expectPopover(canvasElement, 'ProfileCard popover'),
};
export const DesktopLight: Story = { ...DesktopSignal, globals: { theme: 'light' } };
export const DesktopHighContrast: Story = { ...DesktopSignal, globals: { theme: 'high-contrast' } };
/** A member who is neither the owner nor the viewer, with no roles of their own beyond the default, offline. */
export const DesktopPlainMember: Story = {
  ...DesktopSignal, args: { name: 'Astrid', username: 'astrid', presence: 'offline', status: undefined, isOwner: false, isYou: false, roles: [{ name: 'members', color: null }], actions: actions.slice(0, 2) },
};

export const PhoneSheetSignal: Story = {
  render: args => <PhoneLayoutProvider value><ProfileCard {...args} /></PhoneLayoutProvider>,
  parameters: { layout: 'fullscreen' }, globals: { theme: 'signal' },
  play: ({ canvasElement }) => expectSheet(canvasElement, 'ProfileCard sheet'),
};
export const PhoneSheetLight: Story = { ...PhoneSheetSignal, globals: { theme: 'light' } };
export const PhoneSheetHighContrast: Story = { ...PhoneSheetSignal, globals: { theme: 'high-contrast' } };
