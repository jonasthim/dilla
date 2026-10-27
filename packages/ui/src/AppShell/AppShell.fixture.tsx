import { useState, type ReactNode } from 'react';
import { AppShell, type AppShellProps } from './AppShell.tsx';
import { CommunityRail } from '../CommunityRail/CommunityRail.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { MessageLog } from '../MessageLog/MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { GeneralLog, SignalComposer } from '../MessageRow/conversation.fixture.tsx';
import { Banner } from '../Banner/Banner.tsx';
import { TopBar } from '../TopBar/TopBar.tsx';
import { Button } from '../Button/Button.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Tooltip } from '../Tooltip/Tooltip.tsx';
import { UserPanel } from '../UserPanel/UserPanel.tsx';
import { MemberList } from '../MemberList/MemberList.tsx';

const noop = () => {};

/** Signal task 5: the desktop top bar; a story or a test that wants it passes this as `shell.topBar`. */
export const fixtureTopBar = (
  <TopBar searchLabel="Search or jump to…" searchShortcut="⌘K" onSearch={noop} remindersDue={0} onReminders={noop} onSettings={noop}
    labels={{ reminders: 'Reminders', settings: 'Open settings', voice: 'open the call in harbour' }} />
);

const rowLabel = (c: { name: string; unread: number; mentions: number; muted: boolean }) =>
  c.muted ? `${c.name}, muted, mentions ${c.mentions}` : `${c.name}, unread ${c.unread}, mentions ${c.mentions}`;
const itemLabel = (i: { name: string; unread: number; mentions: number }) => `${i.name}, unread ${i.unread}, mentions ${i.mentions}`;

// The composed shell for the stories and the focus-order test; every string is a story string.
// The Composer is controlled (L-UI-13): the fixture holds its text and clears it on send, as the
// shell (task 24) does once a send resolves.
export function ComposedShell({ banner = false, ring, shell }: { banner?: boolean; ring?: ReactNode; shell?: Partial<AppShellProps> }) {
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState('channels');
  return (
    <AppShell
      skipLabel="skip to messages"
      ring={ring}
      {...shell}
      banner={banner ? <Banner tone="warn" action={{ label: 'retry now', onAction: noop }}>offline · reconnecting to dilla.thim.dev</Banner> : shell?.banner}
      rail={<CommunityRail label="servers" activeId={tab === 'dms' ? null : 'a1'} onSelect={() => setTab('channels')}
        home={{ label: 'direct messages', itemLabel: 'direct messages, unread 2, mentions 0', selected: tab === 'dms', unread: 2, mentions: 0,
          onSelect: () => setTab('dms') }} addLabel="add a server" onAdd={noop}
        settingsLabel="settings" onSettings={noop} itemLabel={itemLabel}
        items={[{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls', unread: 4 }, { id: 'c3', name: 'raid planning', unread: 2, mentions: 2 }]} />}
      sidebar={<ChannelList label={tab === 'channels' ? 'channels' : 'direct messages'} title="Midgard Crew"
        activeId={tab === 'channels' ? 'g' : null} onSelect={noop} emptyLabel="No channels yet." rowLabel={rowLabel}
        footer={tab === 'dms' ? <Button variant="ghost" size="sm">message someone</Button> : undefined}
        channels={tab === 'channels'
          ? [{ id: 'g', name: 'general', kind: 'text', readable: false }, { id: 'l', name: 'lfg', kind: 'text', readable: true, unread: 3 },
            { id: 't', name: 'loot', kind: 'text', readable: false, unread: 12, mentions: 2 }, { id: 'r', name: 'random', kind: 'text', readable: false, unread: 7, muted: true },
            { id: 'v', name: 'longhouse', kind: 'voice', readable: false }]
          : [{ id: 'd1', name: 'ada', kind: 'dm', readable: false, unread: 2 }, { id: 'd2', name: 'björn', kind: 'dm', readable: false }]} />}
      header={<ChannelHeader name="general" topic="evening plans, screenshots and the odd argument" />}
      composer={<Composer label="message #general" placeholder="message #general" maxLength={4000} value={draft} onChange={setDraft}
        onSend={() => setDraft('')} sendLabel="send" counterLabel={n => `${n} left`} />}
    >
      <MessageLog label="messages in #general" emptyLabel="No messages yet.">
        <MessageRow author="ada" time="21:02" body="anyone up for a round tonight?" state="ok" />
        <MessageRow author="björn" time="21:03" body="after nine, still on the boat" state="ok" tag="web" />
        <MessageRow author="mira" time="21:04" body="count me in" state="ok" own />
        <MessageRow author="loot-bot" time="21:05" body="weekly reset in 2 h" state="ok" tag="bot" />
      </MessageLog>
    </AppShell>
  );
}

/**
 * Task 6b fix round 2 (restyle rule 3d): the whole desktop frame composed the way packages/web/src/screens/Shell.tsx composes it
 * in Signal: the rail with the @ home tile, the server list (the 26px ⌄ head, the stat line, categories, the voice rows, AFK),
 * the channel header with Threads and Members (with the count, Ruling X), the user panel without a gear (its line under the
 * name), and the members aside. The messages, the composer and the member list are later tasks' (7, 9) and the people are
 * sample data (Task 11).
 */
export function SignalShell({ shell }: { shell?: Partial<AppShellProps> }) {
  const membersOpen = shell?.asideOpen === true;
  return (
    <AppShell
      skipLabel="skip to messages"
      {...shell}
      rail={<CommunityRail label="servers" activeId="a1" onSelect={noop}
        home={{ label: 'direct messages', itemLabel: 'direct messages, unread 0, mentions 0', selected: false, unread: 0, mentions: 0, onSelect: noop }}
        addLabel="add a server" onAdd={noop} itemLabel={itemLabel}
        items={[{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Valhalla Kitchen', unread: 2, mentions: 2 }]} />}
      sidebar={<ChannelList label="channels" title="Midgard Crew" activeId="general" onSelect={noop} emptyLabel="No channels yet." rowLabel={rowLabel}
        headerAction={<Button variant="ghost" className="d-channel-list__head-btn" aria-label="server settings"><Icon name="chevron-down" size={15} /></Button>}
        stats={[{ text: '3 online', live: true }, { text: '5 in voice' }]} newLabel={n => `${n} new`}
        categories={[{ id: 'raids', name: 'raids', collapsed: false }, { id: 'boats', name: 'boats', collapsed: false }]} onToggleCategory={noop}
        voice={{ labels: { open: 'voice {name}', count: '{n} in voice', playbackOnly: 'playback only', join: 'join voice', joined: 'connected',
          state: { speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream', connecting: 'connecting',
            video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot', noSound: 'no sound' } },
          rooms: { hv: { joined: false, participants: [] }, harbour: { joined: false, participants: [] }, afk: { joined: false, participants: [] } } }}
        channels={[
          { id: 'general', name: 'general', kind: 'text', readable: false }, { id: 'hv', name: 'general', kind: 'voice', readable: false },
          { id: 'loot', name: 'loot', kind: 'text', readable: false, parentId: 'raids', unread: 1 },
          { id: 'harbour', name: 'harbour', kind: 'voice', readable: false, parentId: 'boats' }, { id: 'afk', name: 'AFK', kind: 'voice', readable: false, afk: true },
        ]} />}
      header={<ChannelHeader name="general" topic="raids, plans and the bridge troll" actions={<>
        <Button variant="ghost" mark={false} data-thread-list-toggle="" pressed={false}><Icon name="messages-square" size={14} />Threads</Button>
        <Tooltip label="Members">
          <Button variant="ghost" mark={false} data-members-toggle="" aria-label="Members, 6" pressed={membersOpen}><Icon name="users" size={14} /><span aria-hidden="true">6</span></Button>
        </Tooltip>
      </>} />}
      bottom={<UserPanel name="Mira" username="mira" line="online" muted={false} deafened={false} onMute={noop} onDeafen={noop}
        labels={{ region: 'your account', mute: 'mute', deafen: 'deafen' }} shortcuts={{ mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' }}
        status={{ current: 'online', label: 'your status: online', onChoose: noop,
          items: [{ id: 'online', label: 'online' }, { id: 'idle', label: 'idle' }, { id: 'dnd', label: 'do not disturb' }, { id: 'invisible', label: 'invisible' }] }} />}
      composer={<SignalComposer gif={{ label: 'add a gif', open: false, onToggle: noop }} />}
      aside={shell?.aside === undefined ? undefined : (
        <MemberList label="members" loading={false} loadingLabel="Loading members…" emptyLabel="No members yet."
          groups={[
            { id: 'mods', kind: 'role', title: 'raid leads', members: [{ id: 'u1', name: 'Ada', isOwner: true, presence: 'online' }] },
            { id: 'online', kind: 'online', title: 'online', members: [{ id: 'u2', name: 'Björn', presence: 'online' }, { id: 'u3', name: 'Kari', presence: 'online' }] },
            { id: 'offline', kind: 'offline', title: 'offline', members: [{ id: 'u4', name: 'Ole', presence: 'offline' }] },
          ]} />
      )}
    >
      {/* Task 7: the conversation as packages/web composes it (MessageItem, ComposerArea; conversation.fixture.tsx). */}
      <GeneralLog />
    </AppShell>
  );
}

