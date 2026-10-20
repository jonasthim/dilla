import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell.tsx';
import { CommunityRail } from '../CommunityRail/CommunityRail.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { MessageLog } from '../MessageLog/MessageLog.tsx';
import { MessageRow } from '../MessageRow/MessageRow.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { Button } from '../Button/Button.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { StatusBar, StatusChunk } from '../StatusBar/StatusBar.tsx';
import { VoiceDock } from '../VoiceDock/VoiceDock.tsx';
import { CallStage, type CallStageNotice } from '../CallStage/CallStage.tsx';
import { CallControls } from '../CallControls/CallControls.tsx';
import type { CallTileProps, VoiceParticipantView } from '../CallTile/CallTile.tsx';
import { RingBanner } from '../RingBanner/RingBanner.tsx';
import { AttachmentCard } from '../AttachmentCard/AttachmentCard.tsx';
// The shipped copy and the shell's own layout of @dilla/web, so the screenshots show what the app says and draws
// (web-3 task 9: the voice view, the dock, the sidebar's voice sections, the DM call strip, the ring and the players).
import { en, formatTime, t } from '../../../web/src/strings/index.ts';
import '../../../web/src/app.css';

const meta = { title: 'Screens/Voice', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const time = formatTime(1_790_000_000);
const STATE = {
  speaking: t('voice.state.speaking'), muted: t('voice.state.muted'), deafened: t('voice.state.deafened'), notHeard: t('voice.state.notHeard'),
  unverified: t('voice.state.unverified'), connecting: t('voice.state.connecting'), video: t('voice.state.video'), screen: t('voice.state.screen'),
  web: t('voice.tag.web'), bot: t('voice.tag.bot'),
};
const ROW_LABELS = { open: en['voice.open'], count: en['voice.count'], canHear: t('voice.bot.canHear'), state: STATE };
const person = (name: string, over: Partial<VoiceParticipantView> = {}): VoiceParticipantView => ({
  deviceId: name, userId: name, name, state: 'ok', speaking: false, muted: false, deafened: false, video: false, screen: false, web: true,
  bot: false, ...over,
});
const ADA = person('ada', { speaking: true });
const BO = person('bo', { muted: true });
const HELPER = person('helper', { bot: true, web: false });
const tile = (view: VoiceParticipantView, own = false): CallTileProps => ({
  view, own, volume: 100, media: null, onVolume: noop,
  labels: { state: STATE, volume: t('voice.volume', { name: view.name }), volumeValue: en['voice.volumeValue'] },
});
const STAGE_LABELS = { code: t('voice.code'), codeHelp: t('voice.codeHelp'), empty: t('voice.empty'), tiles: t('voice.tiles') };
const CODE = '123451234512345123451234512345';

function controls(p: { paused?: boolean; busy?: boolean; dm?: boolean } = {}) {
  return (
    <CallControls muted={false} deafened={false} camera={false} sharing={false} canCamera={p.paused !== true} canShare={p.paused !== true}
      busy={p.busy === true}
      labels={{ region: t(p.dm === true ? 'voice.controls.region' : 'voice.controls.voice'), mute: t('voice.mute'), deafen: t('voice.deafen'),
        camera: t('voice.cameraOn'), share: t('voice.shareOn'), leave: t('voice.leave') }}
      onMute={noop} onDeafen={noop} onCamera={noop} onShare={noop} onLeave={noop} />
  );
}

function dock(phase: 'connected' | 'paused' | 'reconnecting' | 'connecting', announcement = '') {
  return (
    <div className="dw-voice-dock" data-doc-state="voice-dock">
      <VoiceDock phase={phase} where="harbour" muted={false} deafened={false} announcement={announcement}
        labels={{ region: t('voice.dock.region'), connecting: t('voice.dock.connecting'), connected: en['voice.dock.connected'],
          reconnecting: t('voice.dock.reconnecting'), paused: en['voice.dock.paused'], mute: t('voice.mute'),
          deafen: t('voice.deafen'), leave: t('voice.leave') }}
        onMute={noop} onDeafen={noop} onLeave={noop} />
    </div>
  );
}

const ring = (busy: boolean) => (
  <div className="dw-ring" data-doc-state="call-ring">
    <RingBanner rings={[{ callId: 'r1', busy, text: busy ? t('call.ring.busy', { name: 'eve', where: 'harbour' }) : t('call.ring.incoming', { name: 'eve' }) }]}
      labels={{ region: t('call.ring.region'), answer: t('call.ring.answer'), decline: t('call.ring.decline') }} onAnswer={noop} onDecline={noop} />
  </div>
);

function Screen(p: { main: ReactNode; header?: ReactNode; joined?: boolean; paused?: boolean; tab?: 'channels' | 'dms'; composer?: ReactNode;
  ring?: ReactNode; dock?: ReactNode }) {
  const tab = p.tab ?? 'channels';
  return (
    <div style={{ ['--d-shell-h' as string]: 'calc(100dvh - 32px)' }}>
      <AppShell skipLabel={t('shell.skip')} ring={p.ring}
        rail={<CommunityRail label={t('shell.rail.label')} items={[{ id: 'a', name: 'Midgard' }]} activeId="a" onSelect={noop}
          addLabel={t('layout.rail.add')} onAdd={noop} settingsLabel={t('shell.rail.settings')} onSettings={noop} />}
        sidebar={<div className="dw-sidebar">
          <ChannelList title="Midgard" label={t(tab === 'dms' ? 'shell.dms.label' : 'shell.channels.label')}
            channels={tab === 'dms' ? [{ id: 'bob', name: 'bob', kind: 'dm' as const, readable: false }]
              : [{ id: 'general', name: 'general', kind: 'text' as const, readable: false },
                { id: 'harbour', name: 'harbour', kind: 'voice' as const, readable: false },
                { id: 'build', name: 'build', kind: 'text' as const, readable: false },
                { id: 'workshop', name: 'workshop', kind: 'voice' as const, readable: false }]}
            voice={tab === 'dms' ? undefined : { labels: { ...ROW_LABELS, join: t('voice.join') }, onJoin: noop, rooms: {
              harbour: { joined: p.joined === true, participants: [ADA, BO, HELPER] }, workshop: { joined: false, participants: [] } } }}
            activeId={tab === 'dms' ? 'bob' : 'harbour'} onSelect={noop} emptyLabel={t('shell.channels.empty')}
            footer={tab === 'channels' ? undefined : <Button variant="ghost">{t('shell.dms.new')}</Button>} />
          {p.joined === true ? p.dock ?? dock(p.paused === true ? 'paused' : 'connected') : null}
        </div>}
        header={p.header ?? null}
        composer={p.composer ?? null}
        statusBar={<StatusBar position="bottom" label={t('shell.status.label')}>
          <StatusChunk label={t('shell.status.node')}>dilla.test</StatusChunk>
          <StatusChunk label={t('shell.status.link')} tone="ok">{t('shell.status.online')}</StatusChunk>
          <StatusChunk label={t('shell.status.gen')}>7</StatusChunk>
          <StatusChunk label={t('shell.status.devices')}>2</StatusChunk>
        </StatusBar>}>
        {p.main}
      </AppShell>
    </div>
  );
}

const stage = (p: { notice?: CallStageNotice | null; code?: string | null; outgoing?: string; title?: string; joined?: boolean; paused?: boolean; dm?: boolean }) => (
  <div className="dw-voice-stage" data-doc-state={p.notice?.kind === 'blocked' ? 'voice-blocked' : 'voice-stage'}>
    <CallStage title={p.title ?? t('voice.open', { name: 'harbour' })}
      tiles={p.joined === false ? [tile(ADA), tile(BO), tile(HELPER)] : [tile(person('you'), true), tile(ADA), tile(BO), tile(HELPER)]}
      code={p.code ?? null} notice={p.notice ?? null} outgoing={p.outgoing !== undefined ? { text: p.outgoing } : null}
      controls={p.joined === false ? <Button variant="accent">{t('voice.join')}</Button> : controls({ paused: p.paused, dm: p.dm })} labels={STAGE_LABELS} />
  </div>
);

export const Connected: Story = { render: () => <Screen joined main={stage({ code: CODE })} /> };
export const Ringing: Story = { render: () => <Screen joined ring={ring(true)} main={stage({ code: CODE })} /> };
export const Paused: Story = {
  render: () => <Screen joined paused main={stage({ paused: true, notice: { kind: 'paused', text: t('voice.paused', { name: 'bo' }), focusOnce: false,
    action: { label: t('voice.pausedAction'), onAction: noop } } })} />,
};
export const BlockedBeforeJoin: Story = {
  render: () => <Screen main={stage({ joined: false, notice: { kind: 'blocked', text: t('voice.blockedChanged', { name: 'bo' }), focusOnce: false, action: null } })} />,
};
export const LiveNotJoined: Story = { render: () => <Screen main={stage({ joined: false })} /> };

const composer = (
  <Composer label={t('shell.dm.composer', { name: 'bob' })} placeholder={t('shell.dm.composer', { name: 'bob' })} maxLength={4000} value=""
    onChange={noop} onSend={noop} sendLabel={t('shell.composer.send')}
    counterLabel={n => (n < 0 ? t('shell.composer.over', { n: -n }) : t('shell.composer.remaining', { n }))} />
);
const players = (
  <div className="dw-attachments">
    <div data-doc-state="media-player">
      <AttachmentCard kind="audio" name="voice-note.ogg" size="412 KB" thumbUrl={null} w={null} h={null} openLabel="" saveLabel={t('shell.attachment.save', { name: 'voice-note.ogg' })}
        onSave={noop} state="idle" tabbable
        player={{ src: null, state: 'idle', labels: { play: en['media.play'], loading: t('media.loading'), error: t('media.error'), save: t('media.save') }, onPlay: noop, onError: noop }} />
    </div>
    <div data-doc-state="media-player">
      <AttachmentCard kind="video" name="harbour-walk.webm" size="12.4 MB" thumbUrl={null} w={null} h={null} openLabel="" saveLabel={t('shell.attachment.save', { name: 'harbour-walk.webm' })}
        onSave={noop} state="idle" tabbable
        player={{ src: null, state: 'error', labels: { play: en['media.play'], loading: t('media.loading'), error: t('media.error'), save: t('media.save') }, onPlay: noop, onError: noop }} />
    </div>
  </div>
);
const dmLog = (
  <MessageLog label={t('shell.dm.log', { name: 'bob' })} emptyLabel={t('shell.log.empty')}>
    <MessageRow author="bob" time={time} body="here is the walk, and a note" state="ok" attachments={players} />
    <MessageRow author="Ada L" time={time} body="calling you now" own tag="web" state="ok" />
  </MessageLog>
);
export const DmCallRinging: Story = {
  render: () => <Screen tab="dms" joined header={<ChannelHeader kind="dm" name="bob" />} composer={composer}
    main={<><div className="dw-dm-call" data-view="stage">
      <div className="dw-dm-call__bar"><Button pressed={false}>{t('voice.messages')}</Button></div>
      {stage({ title: 'bob', outgoing: t('call.outgoing.ringing', { names: 'bob' }), code: null, dm: true })}
    </div><div className="dw-conversation">{dmLog}</div></>} />,
};
export const DmIncomingRing: Story = {
  render: () => <Screen tab="dms" ring={ring(false)} header={<ChannelHeader kind="dm" name="bob" actions={<IconButton icon="phone" label={t('call.start')} />} />} composer={composer}
    main={dmLog} />,
};

// WB a11y m8: the rest of flow 06's states as screens.
const infoNotice = (key: Parameters<typeof t>[0]): CallStageNotice => ({ kind: 'info', text: t(key), action: null, focusOnce: false });
/** A failed join: the stage shows the notice and the join button again. */
export const JoinFailed: Story = { render: () => <Screen main={stage({ joined: false, notice: infoNotice('voice.failed') })} /> };
/** The connection was lost (WB client I3): the notice where the stage was, the join offered again. */
export const Disconnected: Story = { render: () => <Screen main={stage({ joined: false, notice: infoNotice('voice.disconnected') })} /> };
/** The hold after a refused rekey (WB security I1). */
export const Held: Story = {
  render: () => <Screen joined paused main={stage({ paused: true, notice: { kind: 'paused', text: t('voice.held'), focusOnce: false, action: null } })} />,
};
/** Reconnecting: the dock says so; the tiles keep their last state. */
export const Reconnecting: Story = { render: () => <Screen joined dock={dock('reconnecting')} main={stage({ code: CODE })} /> };
/** Rejoining: the dock stays at connecting and its status says why, once. */
export const Rejoining: Story = {
  render: () => <Screen joined dock={dock('connecting', t('voice.announce.rejoining', { where: 'harbour' }))} main={stage({ code: null })} />,
};
/** The phone DM call with `messages` pressed: the log and composer in the stage's place (flow 06 § 360×740). */
export const DmCallMessages: Story = {
  render: () => <Screen tab="dms" joined header={<ChannelHeader kind="dm" name="bob" />} composer={composer}
    main={<><div className="dw-dm-call" data-view="messages">
      <div className="dw-dm-call__bar"><Button pressed>{t('voice.messages')}</Button></div>
      {stage({ title: 'bob', code: null, dm: true })}
    </div><div className="dw-conversation">{dmLog}</div></>} />,
};
/** An info notice at 360 CSS px. */
export const InfoPhone: Story = {
  render: () => <div style={{ width: 360 }}><Screen main={stage({ joined: false, notice: infoNotice('voice.full') })} /></div>,
};

