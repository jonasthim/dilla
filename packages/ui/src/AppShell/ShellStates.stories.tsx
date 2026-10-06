import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell.tsx';
import { CommunityRail } from '../CommunityRail/CommunityRail.tsx';
import { ChannelList } from '../ChannelList/ChannelList.tsx';
import { ChannelHeader } from '../ChannelHeader/ChannelHeader.tsx';
import { MessageLog } from '../MessageLog/MessageLog.tsx';
import { MessageRow, type MessageRowProps } from '../MessageRow/MessageRow.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { EmptyState } from '../EmptyState/EmptyState.tsx';
import { Banner } from '../Banner/Banner.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { TextField } from '../TextField/TextField.tsx';
import { Button } from '../Button/Button.tsx';
import { StatusBar, StatusChunk } from '../StatusBar/StatusBar.tsx';
// The shipped copy of @dilla/web, so the F16 screenshots show exactly what the app says.
import { t, formatTime } from '../../../web/src/strings/index.ts';

const meta = { title: 'Screens/Shell', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const time = formatTime(1_790_000_000);
const SERVERS = [{ id: 'a', name: 'Midgard' }, { id: 'b', name: 'Valhalla' }];
const CHANNELS = [
  { id: 'lounge', name: 'lounge', kind: 'voice' as const, readable: false },
  { id: 'general', name: 'general', kind: 'text' as const, readable: false },
  { id: 'random', name: 'random', kind: 'text' as const, readable: false },
  { id: 'lobby', name: 'lobby', kind: 'text' as const, readable: true },
];
const ROWS: MessageRowProps[] = [
  { author: 'bob', time, body: 'anyone up for a round tonight?', state: 'ok' },
  { author: 'Helper', time, body: 'Reminder: the server restarts at 22:00.', tag: 'bot', state: 'ok' },
  { author: 'Ada L', time, body: 'in ten, setting up', own: true, tag: 'web', state: 'ok' },
  { author: t('shell.message.unknownAuthor', { id: '29292929' }), time, body: '', state: 'cannot-read', stateLabel: t('shell.message.cannotRead'), detail: 'E_SENDER_MISMATCH' },
  { author: 'Ada L', time, body: 'bringing snacks', own: true, tag: 'web', state: 'pending', stateLabel: t('shell.message.pending') },
  { author: 'Ada L', time, body: 'and the spare headset', own: true, tag: 'web', state: 'failed', stateLabel: t('shell.message.failed'), detail: 'E_NETWORK',
    actions: [{ label: t('shell.message.retry'), onAction: noop }, { label: t('shell.message.discard'), onAction: noop }] },
];

function Screen(p: { active?: string | null; servers?: { id: string; name: string }[]; main: ReactNode; reason?: string | null;
  banner?: ReactNode; status?: 'online' | 'connecting' | 'offline'; after?: ReactNode }) {
  const servers = p.servers ?? SERVERS;
  const active = p.active === undefined ? 'general' : p.active;
  const channel = CHANNELS.find(c => c.id === active) ?? null;
  const status = p.status ?? 'online';
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'warn' : 'danger';
  // 800px less the preview decorator's 16px padding on each side, as the Shell/AppShell stories do, so
  // the status bar is in the 1280×800 screenshots.
  return (
    <div style={{ ['--d-shell-h' as string]: '768px' }}>
      <AppShell
        skipLabel={t('shell.skip')}
        rail={<CommunityRail label={t('shell.rail.label')} items={servers} activeId={servers[0]?.id ?? null} onSelect={noop} joinLabel={t('shell.rail.join')} onJoin={noop} />}
        sidebar={servers.length ? <ChannelList label={t('shell.channels.label')} title="Midgard" channels={CHANNELS} activeId={active} onSelect={noop} emptyLabel={t('shell.channels.empty')} /> : null}
        header={channel ? <ChannelHeader name={channel.name} topic={channel.id === 'general' ? 'say hi' : undefined} readable={channel.readable} readableLabel={t('shell.readable')} /> : null}
        // The Composer is controlled (task 21); a story holds no text, so it passes an empty value.
        composer={channel ? <Composer label={t('shell.composer.label', { channel: channel.name })} placeholder={t('shell.composer.placeholder', { channel: channel.name })}
          maxLength={4000} value="" onChange={noop} disabled={Boolean(p.reason)} disabledReason={p.reason ?? undefined} onSend={noop} sendLabel={t('shell.composer.send')}
          counterLabel={n => (n < 0 ? t('shell.composer.over', { n: -n }) : t('shell.composer.remaining', { n }))} /> : null}
        statusBar={
          <StatusBar position="bottom" label={t('shell.status.label')}>
            <StatusChunk label={t('shell.status.node')}>dilla.test</StatusChunk>
            <StatusChunk label={t('shell.status.link')} tone={tone}>{t(`shell.status.${status}`)}</StatusChunk>
            <StatusChunk label={t('shell.status.gen')}>7</StatusChunk>
          </StatusBar>
        }
        banner={p.banner}
      >
        {p.main}
      </AppShell>
      {p.after}
    </div>
  );
}
const conversation = (
  <MessageLog label={t('shell.log.label', { channel: 'general' })} emptyLabel={t('shell.log.empty')} earlier={{ label: t('shell.log.earlier'), onLoad: noop }}>
    {ROWS.map((r, i) => <MessageRow key={i} {...r} />)}
  </MessageLog>
);
const empty = <MessageLog label={t('shell.log.label', { channel: 'general' })} emptyLabel={t('shell.log.empty')}>{null}</MessageLog>;

export const Conversation: Story = { render: () => <Screen main={conversation} /> };
export const Joining: Story = { render: () => <Screen main={empty} reason={t('shell.composer.joining')} /> };
export const NotMember: Story = { render: () => <Screen main={conversation} reason={t('shell.composer.notMember')} /> };
export const VoiceChannel: Story = {
  render: () => <Screen active="lounge" reason={t('shell.composer.unsupported')}
    main={<EmptyState title={t('shell.unsupported.title')} body={t('shell.unsupported.voice')} />} />,
};
export const NoServer: Story = {
  render: () => <Screen servers={[]} active={null}
    main={<EmptyState title={t('shell.noServer.title')} body={t('shell.noServer.body')} action={{ label: t('shell.noServer.action'), onAction: noop }} />} />,
};
export const Offline: Story = {
  render: () => <Screen main={conversation} status="offline" banner={<Banner tone="warn">{t('shell.banner.offline')}</Banner>} />,
};
export const CommandError: Story = {
  render: () => <Screen main={conversation}
    banner={<Banner tone="danger" action={{ label: t('shell.banner.dismiss'), onAction: noop }}>{t('shell.banner.commandError', { code: 'E_NOT_READY' })}</Banner>} />,
};
export const JoinDialog: Story = {
  render: () => <Screen main={conversation} after={
    <Dialog open title={t('join.title')} onClose={noop}
      footer={<Button variant="accent" type="submit" form="story-join">{t('join.submit')}</Button>}>
      <form id="story-join" noValidate onSubmit={e => e.preventDefault()}>
        <TextField id="story-join-invite" label={t('join.invite')} value="https://dilla.test/i/ABCD-EFGH" onChange={noop}
          hint={t('join.inviteHint')} error={t('join.error.notCommunity')} />
      </form>
    </Dialog>} />,
};
