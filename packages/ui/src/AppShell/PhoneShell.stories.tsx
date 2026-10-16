import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { AppShell } from './AppShell.tsx';
import { CommunityRail } from '../CommunityRail/CommunityRail.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { MessageLog } from '../MessageLog/MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { MemberList } from '../MemberList/MemberList.tsx';
import { Button } from '../Button/Button.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { ActionMenu } from '../ActionMenu/ActionMenu.tsx';
import { StateDot } from '../StateDot/StateDot.tsx';
import { TabBar, type TabBarItem } from '../TabBar/TabBar.tsx';
import { CallBar } from '../CallBar/CallBar.tsx';
import { LinkBanner } from '../LinkBanner/LinkBanner.tsx';

// A 390 × 844 phone (an iPhone 14). Switch the theme in the toolbar (mesh, light, high-contrast). The decorator's 16px
// padding is taken back so the shell fills the frame exactly.
const meta = { title: 'Shell/Phone', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const frame: CSSProperties = { width: 390, margin: -16, ['--d-shell-h' as string]: '844px' };
const Phone = ({ children }: { children: ReactNode }) => <div style={frame}>{children}</div>;

type TabId = 'servers' | 'dms' | 'activity' | 'you';
const tabs = (current: TabId): TabBarItem[] => [
  { id: 'servers', label: 'servers', href: '#servers', icon: 'server', current: current === 'servers' },
  { id: 'dms', label: 'dms', href: '#dms', icon: 'message-square', current: current === 'dms', count: 3, countLabel: 'dms, 3 unread' },
  { id: 'activity', label: 'activity', href: '#activity', icon: 'activity', current: current === 'activity', count: 120, countLabel: 'activity, 120 unread' },
  { id: 'you', label: 'you', href: '#you', icon: 'user', current: current === 'you' },
];
const tabBar = (current: TabId) => <TabBar label="main" items={tabs(current)} onSelect={noop} />;

const rowLabel = (c: { name: string; unread: number; mentions: number; muted: boolean }) =>
  c.muted ? `${c.name}, muted, mentions ${c.mentions}` : `${c.name}, unread ${c.unread}, mentions ${c.mentions}`;
const itemLabel = (i: { name: string; unread: number; mentions: number }) => `${i.name}, unread ${i.unread}, mentions ${i.mentions}`;

const rail = (
  <CommunityRail label="servers" activeId="a1" onSelect={noop} joinLabel="join a server" onJoin={noop} settingsLabel="settings" onSettings={noop}
    itemLabel={itemLabel}
    items={[{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls', unread: 4 }, { id: 'c3', name: 'raid planning', unread: 2, mentions: 2 }]} />
);

function ServerMenu() {
  const [open, setOpen] = useState(false);
  return (
    <ActionMenu label="server menu" icon="ellipsis-vertical" open={open} onOpenChange={setOpen} onSelect={noop}
      items={[{ id: 'invite', label: 'invite people' }, { id: 'channel', label: 'new channel' }, { id: 'settings', label: 'server settings' }, { id: 'leave', label: 'leave server', danger: true }]} />
  );
}

const serverChannels = (
  <ChannelList label="channels" title="Midgard Crew" headerAction={<ServerMenu />} activeId="g" onSelect={noop} emptyLabel="No channels yet." rowLabel={rowLabel}
    channels={[
      { id: 'g', name: 'general', kind: 'text', readable: false }, { id: 'l', name: 'lfg', kind: 'text', readable: true, unread: 3 },
      { id: 't', name: 'loot', kind: 'text', readable: false, unread: 12, mentions: 2 }, { id: 'r', name: 'random', kind: 'text', readable: false, unread: 7, muted: true },
      { id: 'v', name: 'longhouse', kind: 'voice', readable: false },
    ]} />
);

const dmChannels = (
  <ChannelList label="direct messages" title="direct messages" activeId={null} onSelect={noop} emptyLabel="No conversations yet." rowLabel={rowLabel}
    footer={<div style={{ padding: '0.5rem 0.75rem' }}><Button variant="ghost">message someone</Button></div>}
    channels={[
      { id: 'd1', name: 'ada', kind: 'dm', readable: false, unread: 2 }, { id: 'd2', name: 'björn', kind: 'dm', readable: false, unread: 1 },
      { id: 'd3', name: 'mira', kind: 'dm', readable: false }, { id: 'd4', name: 'loot-bot', kind: 'dm', readable: false, muted: true },
    ]} />
);

// Static rows for the Activity and You tabs: the same row grammar as the channel list, at the phone's 44px target.
const pane: CSSProperties = { height: '100%', overflowY: 'auto', background: 'var(--bg)' };
const heading: CSSProperties = { margin: 0, padding: '0.75rem var(--row-pad-x) 0.5rem', fontFamily: 'var(--font-serif-italic)', fontStyle: 'italic', fontWeight: 400, fontSize: 'var(--text-xl)', color: 'var(--fg)' };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', minHeight: '2.75rem', padding: '0.5rem var(--row-pad-x)', font: 'inherit',
  fontSize: 'var(--text-sm)', color: 'var(--fg)', textAlign: 'left', background: 'transparent', border: 0, borderBottom: '1px solid var(--hairline)', cursor: 'pointer',
};
const rowText: CSSProperties = { flex: 1, minWidth: 0, display: 'grid', gap: '0.125rem' };
const rowMeta: CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const activity = (
  <section style={pane} aria-label="activity">
    <h1 style={heading}>activity</h1>
    <ul style={list}>
      {[
        { id: 'a', who: 'ada', where: '#loot · Midgard Crew', text: 'can you bring the tank gear tonight?', when: '21:02', mention: true },
        { id: 'b', who: 'björn', where: '#general · Midgard Crew', text: 'after nine, still on the boat', when: '20:48', mention: true },
        { id: 'c', who: 'mira', where: 'reply in #lfg · Midgard Crew', text: 'count me in for the raid', when: '19:30', mention: false },
        { id: 'd', who: 'loot-bot', where: '#random · Night Owls', text: 'weekly reset in 2 h', when: '18:05', mention: false },
      ].map(r => (
        <li key={r.id}>
          <button type="button" style={row}>
            <span style={rowText}>
              <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}><strong style={{ fontWeight: 'var(--weight-display)' }}>{r.who}</strong><span style={rowMeta}>{r.when}</span></span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.text}</span>
              <span style={rowMeta}>{r.where}</span>
            </span>
            {r.mention ? <Pill kind="mention" count={1} /> : null}
            <Icon name="chevron-right" size={18} />
          </button>
        </li>
      ))}
    </ul>
  </section>
);

const card: CSSProperties = { margin: '0 var(--row-pad-x) 1rem', background: 'var(--surface-2)', border: '1px solid var(--hairline-2)', borderRadius: 'var(--r-md)' };
const cardHead: CSSProperties = { margin: 0, padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--hairline-2)' };
const status = (k: string, v: ReactNode) => (
  <li key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', minHeight: '2.25rem', padding: '0 0.75rem', fontSize: 'var(--text-sm)' }}>
    <span className="d-label">{k}</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>{v}</span>
  </li>
);
const you = (
  <section style={pane} aria-label="you">
    <h1 style={heading}>you</h1>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem var(--row-pad-x) 1rem' }}>
      <Avatar name="mira" size="md" />
      <div style={{ display: 'grid', gap: '0.125rem', minWidth: 0 }}>
        <strong style={{ fontWeight: 'var(--weight-display)', fontSize: 'var(--text-md)' }}>mira</strong>
        <span style={rowMeta}>dilla.thim.dev</span>
      </div>
    </div>
    <section style={card} aria-labelledby="you-status">
      <h2 id="you-status" className="d-label" style={cardHead}>this device</h2>
      <ul style={list}>
        {status('node', 'dilla.thim.dev')}
        {status('link', <><StateDot tone="ok" /><span>online</span></>)}
        {status('gen', '3')}
        {status('devices', '3')}
      </ul>
    </section>
    <h2 className="d-label" style={{ margin: 0, padding: '0.25rem var(--row-pad-x) 0.5rem' }}>settings</h2>
    <ul style={{ ...list, borderTop: '1px solid var(--hairline)' }}>
      {[
        { id: 'd', icon: 'server', label: 'devices' },
        { id: 's', icon: 'user', label: 'sign-in' },
        { id: 'n', icon: 'megaphone', label: 'notifications' },
        { id: 'a', icon: 'eye', label: 'appearance' },
        { id: 'v', icon: 'volume-2', label: 'voice' },
        { id: 'p', icon: 'check', label: 'privacy' },
        { id: 'k', icon: 'hash', label: 'keyboard' },
        { id: 'g', icon: 'activity', label: 'diagnostics' },
      ].map(r => (
        <li key={r.id}>
          <button type="button" style={row}>
            <Icon name={r.icon as 'user'} size={20} />
            <span style={rowText}><span>{r.label}</span></span>
            <Icon name="chevron-right" size={18} />
          </button>
        </li>
      ))}
      <li><button type="button" style={{ ...row, color: 'var(--danger)' }}><span style={rowText}><span>sign out</span></span></button></li>
    </ul>
  </section>
);

const log = (
  <MessageLog label="messages in #general" emptyLabel="No messages yet.">
    <MessageRow author="ada" time="21:02" body="anyone up for a round tonight?" state="ok" />
    <MessageRow author="björn" time="21:03" body="after nine, still on the boat" state="ok" tag="web" />
    <MessageRow author="mira" time="21:04" body="count me in" state="ok" own />
    <MessageRow author="loot-bot" time="21:05" body="weekly reset in 2 h" state="ok" tag="bot" />
    <MessageRow author="ada" time="21:06" body="bring the tank gear, the second boss hits hard" state="ok" />
  </MessageLog>
);
const composer = (
  <Composer label="message #general" placeholder="message #general" maxLength={4000} value="" onChange={noop} onSend={noop} sendLabel="send" counterLabel={n => `${n} left`} />
);
const menu = <Button variant="ghost" aria-label="members"><Icon name="ellipsis-vertical" size={22} /></Button>;
const header = <ChannelHeader name="general" phone={{ backLabel: 'back to channels', onBack: noop, menu }} />;

const members = (
  <MemberList label="members" loading={false} loadingLabel="Loading members…" emptyLabel="No members yet." onAction={noop}
    groups={[
      { id: 'mods', title: 'moderators', members: [{ id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: [] }] },
      { id: 'members', title: 'members', members: [
        { id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: [{ id: 'kick', label: 'kick' }] },
        { id: 'u3', name: 'Mira', tags: [], actionsLabel: 'actions for Mira', actions: [] },
      ] },
    ]} />
);

const callBar = <CallBar phase="connected" where="longhouse" muted={false} labels={{ open: 'open call in longhouse', mute: 'mute', leave: 'leave call', region: 'call' }} onOpen={noop} onMute={noop} onLeave={noop} />;

const common = { skipLabel: 'skip to content', statusBar: null, header: null, composer: null } as const;

export const ServersList: Story = {
  render: () => <Phone><AppShell {...common} layout="phone" phonePane="list" rail={rail} sidebar={serverChannels} tabBar={tabBar('servers')}>{null}</AppShell></Phone>,
};
export const ChannelView: Story = {
  render: () => (
    <Phone><AppShell {...common} layout="phone" phonePane="view" rail={rail} sidebar={serverChannels} header={header} composer={composer}>{log}</AppShell></Phone>
  ),
};
export const DmsList: Story = {
  render: () => <Phone><AppShell {...common} layout="phone" phonePane="list" rail={null} sidebar={dmChannels} tabBar={tabBar('dms')}>{null}</AppShell></Phone>,
};
export const Activity: Story = {
  render: () => <Phone><AppShell {...common} layout="phone" phonePane="list" rail={null} sidebar={activity} tabBar={tabBar('activity')}>{null}</AppShell></Phone>,
};
export const You: Story = {
  render: () => <Phone><AppShell {...common} layout="phone" phonePane="list" rail={null} sidebar={you} tabBar={tabBar('you')}>{null}</AppShell></Phone>,
};
export const Offline: Story = {
  render: () => (
    <Phone>
      <AppShell {...common} layout="phone" phonePane="list" rail={rail} sidebar={serverChannels} tabBar={tabBar('servers')}
        banner={<LinkBanner status="offline" labels={{ offline: 'offline · reconnecting to dilla.thim.dev', connecting: 'connecting to dilla.thim.dev' }} />}>{null}</AppShell>
    </Phone>
  ),
};
export const CallBarOnList: Story = {
  name: 'CallBar',
  render: () => <Phone><AppShell {...common} layout="phone" phonePane="list" rail={rail} sidebar={serverChannels} tabBar={tabBar('servers')} callBar={callBar}>{null}</AppShell></Phone>,
};
export const MembersSheet: Story = {
  render: () => (
    <Phone>
      <AppShell {...common} layout="phone" phonePane="view" rail={rail} sidebar={serverChannels} header={header} composer={composer}
        aside={members} asideLabel="members" asideOpen onAsideClose={noop} asideCloseLabel="back">{log}</AppShell>
    </Phone>
  ),
};
