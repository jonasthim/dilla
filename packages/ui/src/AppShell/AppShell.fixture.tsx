import { useState } from 'react';
import { AppShell } from './AppShell.tsx';
import { CommunityRail } from '../CommunityRail/CommunityRail.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { MessageLog } from '../MessageLog/MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { Banner } from '../Banner/Banner.tsx';
import { StatusBar, StatusChunk } from '../StatusBar/StatusBar.tsx';

const noop = () => {};

// The composed shell for the stories and the focus-order test; every string is a story string.
// The Composer is controlled (L-UI-13): the fixture holds its text and clears it on send, as the
// shell (task 24) does once a send resolves.
export function ComposedShell({ banner = false }: { banner?: boolean }) {
  const [draft, setDraft] = useState('');
  return (
    <AppShell
      skipLabel="skip to messages"
      banner={banner ? <Banner tone="warn" action={{ label: 'retry now', onAction: noop }}>offline · reconnecting to dilla.thim.dev</Banner> : undefined}
      rail={<CommunityRail label="servers" items={[{ id: 'a1', name: 'Midgard Crew' }, { id: 'b2', name: 'Night Owls' }, { id: 'c3', name: 'raid planning' }]}
        activeId="a1" onSelect={noop} joinLabel="join a server" onJoin={noop} />}
      sidebar={<ChannelList label="channels" title="Midgard Crew" activeId="g" onSelect={noop} emptyLabel="No channels yet."
        channels={[{ id: 'g', name: 'general', kind: 'text', readable: false }, { id: 'l', name: 'lfg', kind: 'text', readable: true },
          { id: 't', name: 'loot', kind: 'text', readable: false }, { id: 'v', name: 'longhouse', kind: 'voice', readable: false }]} />}
      header={<ChannelHeader name="general" topic="evening plans, screenshots and the odd argument" />}
      composer={<Composer label="message #general" placeholder="message #general" maxLength={4000} value={draft} onChange={setDraft}
        onSend={() => setDraft('')} sendLabel="send" counterLabel={n => `${n} left`} />}
      statusBar={
        <StatusBar position="bottom" label="status">
          <StatusChunk label="server">dilla.thim.dev</StatusChunk>
          <StatusChunk label="connection" tone="ok" onClick={noop}>online</StatusChunk>
          <StatusChunk label="gen">3</StatusChunk>
        </StatusBar>
      }
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
