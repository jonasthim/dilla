import { Avatar } from '../Avatar/Avatar.tsx';
import { VOICE_ICONS, VOICE_SHORTCUTS, VoiceToolbar, type ToolbarControl } from '../CallControls/CallControls.tsx';
import { Icon } from '../Icon/Icon.tsx';
import './UserPanel.css';

export interface UserPanelProps {
  name: string;
  username: string;
  muted: boolean;
  deafened: boolean;
  /** The mute and deafen shortcuts as the tooltips show them, formatted per platform by the caller. */
  shortcuts?: { mute: string; deafen: string };
  /** `region` is `panel.region` (the toolbar's name), `mute` and `deafen` are `voice.mute` and `voice.deafen`, `settings` is the gear's name. */
  labels: { region: string; mute: string; deafen: string; settings: string };
  onMute(): void;
  onDeafen(): void;
  onSettings(): void;
  /** A click on the name block (a pointer target only: no role and no tab stop; the gear is the keyboard path, R24). */
  onOpenSelf(): void;
}

/**
 * The desktop user panel at the bottom left (web3.8, item 13): the avatar, the name with `@username`, mute and deafen
 * as one voice toolbar that owns the shortcuts (`aria-keyshortcuts`), and the settings gear. A plain div with no role
 * and no name: "your account" is named once, by its toolbar.
 */
export function UserPanel({ name, username, muted, deafened, shortcuts, labels, onMute, onDeafen, onSettings, onOpenSelf }: UserPanelProps) {
  const controls: ToolbarControl[] = [
    { id: 'mute', label: labels.mute, on: muted, keys: VOICE_SHORTCUTS.mute, shortcut: shortcuts?.mute, ...VOICE_ICONS.mute, onAction: onMute },
    { id: 'deafen', label: labels.deafen, on: deafened, keys: VOICE_SHORTCUTS.deafen, shortcut: shortcuts?.deafen, ...VOICE_ICONS.deafen, onAction: onDeafen },
  ];
  return (
    <div className="d-user-panel">
      <Avatar name={name} size="md" />
      {/* A pointer target only (R24): the gear is the keyboard path, so the block is no role and no tab stop. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="d-user-panel__who" onClick={() => onOpenSelf()}>
        <span className="d-user-panel__name" title={name}>{name}</span>
        <span className="d-user-panel__username" title={`@${username}`}>@{username}</span>
      </div>
      <VoiceToolbar label={labels.region} controls={controls} className="d-user-panel__controls" />
      <button type="button" className="d-user-panel__settings" aria-label={labels.settings} title={labels.settings} onClick={() => onSettings()}>
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
