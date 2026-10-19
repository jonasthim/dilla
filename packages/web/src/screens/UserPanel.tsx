// The desktop user panel at the bottom left (web3.8, item 13; R23-R25): composition only. The ui UserPanel draws it;
// the mute and deafen are the call's `selfMute`/`selfDeafen` (the session's in a call, the `voice.self` setting outside one).
import { UserPanel as UiUserPanel } from '@dilla/ui';
import { t } from '../strings/index.ts';
import { voiceShortcutText } from './voice/shortcuts.ts';
import type { CallView } from './voice/useCall.tsx';

/** The mute and deafen shortcuts as the tooltips write them; the platform cannot change during a session. */
const SHORTCUTS = voiceShortcutText();

export function UserPanel({ name, username, call, onSettings }: {
  name: string; username: string; call: Pick<CallView, 'selfMute' | 'selfDeafen' | 'selfMuted' | 'selfDeafened'>; onSettings: () => void;
}): React.JSX.Element {
  return (
    <UiUserPanel name={name} username={username} muted={call.selfMuted} deafened={call.selfDeafened} shortcuts={SHORTCUTS}
      labels={{ region: t('panel.region'), mute: t('voice.mute'), deafen: t('voice.deafen'), settings: t('panel.settings') }}
      onMute={call.selfMute} onDeafen={call.selfDeafen} onSettings={onSettings} onOpenSelf={onSettings} />
  );
}
