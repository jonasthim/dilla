import { useState, type ReactNode } from 'react';
import { AppShell, type AppShellProps } from './AppShell.tsx';
import { CommunityRail } from '../CommunityRail/CommunityRail.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { MessageLog } from '../MessageLog/MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { Banner } from '../Banner/Banner.tsx';
import { StatusBar, StatusChunk } from '../StatusBar/StatusBar.tsx';
import { Button } from '../Button/Button.tsx';

const noop = () => {};

/** web3.8 (R4): the desktop shell has no status bar; a story or a test that wants the optional row passes this as `shell.statusBar`. */
export const fixtureStatusBar = (
  <StatusBar position="bottom" label="status">
    <StatusChunk label="server">dilla.thim.dev</StatusChunk>
    <StatusChunk label="connection" tone="ok" onClick={noop}>online</StatusChunk>
    <StatusChunk label="gen">3</StatusChunk>
  </StatusBar>
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
