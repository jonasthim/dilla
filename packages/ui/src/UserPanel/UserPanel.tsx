import { ActionMenu, type ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import { Avatar, type Presence } from '../Avatar/Avatar.tsx';
import { VOICE_ICONS, VOICE_SHORTCUTS, VoiceToolbar, type ToolbarControl } from '../CallControls/CallControls.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { useState } from 'react';
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
  /**
   * The status menu behind the avatar and name block. `label` names the button and the menu with the current status
   * (`panel.status`); `current` is the chosen status and draws the avatar's dot ("invisible" as the ring that stands for
   * offline); `items` are the statuses in order.
   */
  status: { current: 'online' | 'idle' | 'dnd' | 'invisible'; label: string; items: readonly ActionMenuItem[]; onChoose(id: string): void };
}

const DOT: Record<UserPanelProps['status']['current'], Presence> = { online: 'online', idle: 'idle', dnd: 'dnd', invisible: 'offline' };

/**
 * The desktop user panel at the bottom left (web3.8, item 13): the avatar, the name with `@username`, mute and deafen
 * as one voice toolbar that owns the shortcuts (`aria-keyshortcuts`), and the settings gear. A plain div with no role
 * and no name: "your account" is named once, by its toolbar. The avatar and name block is a menu button for the status
 * (Discord-style), with the current status as a dot on the avatar.
 */
export function UserPanel({ name, username, muted, deafened, shortcuts, labels, onMute, onDeafen, onSettings, status }: UserPanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const controls: ToolbarControl[] = [
    { id: 'mute', label: labels.mute, on: muted, keys: VOICE_SHORTCUTS.mute, shortcut: shortcuts?.mute, ...VOICE_ICONS.mute, onAction: onMute },
    { id: 'deafen', label: labels.deafen, on: deafened, keys: VOICE_SHORTCUTS.deafen, shortcut: shortcuts?.deafen, ...VOICE_ICONS.deafen, onAction: onDeafen },
  ];
  return (
    <div className="d-user-panel">
      <ActionMenu label={status.label} className="d-user-panel__menu" triggerClassName="d-user-panel__who" open={menuOpen} onOpenChange={setMenuOpen}
        items={status.items.map(item => ({ ...item, current: item.id === status.current }))} onSelect={status.onChoose}
        triggerContent={<>
          <Avatar name={name} size="md" presence={DOT[status.current]} />
          <span className="d-user-panel__text">
            <span className="d-user-panel__name" title={name}>{name}</span>
            <span className="d-user-panel__username" title={`@${username}`}>@{username}</span>
          </span>
        </>} />
      <VoiceToolbar label={labels.region} controls={controls} className="d-user-panel__controls" />
      <button type="button" className="d-user-panel__settings" aria-label={labels.settings} title={labels.settings} onClick={() => onSettings()}>
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
