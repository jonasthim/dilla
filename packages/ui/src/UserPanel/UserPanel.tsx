import { ActionMenu, type ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import { Avatar, type Presence } from '../Avatar/Avatar.tsx';
import { VOICE_ICONS, VOICE_SHORTCUTS } from '../CallControls/CallControls.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { useId, useState } from 'react';
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

/** A shortcut as the platform formats it ('Ctrl+Shift+M' or '⌘⇧M') to the chips the tooltip draws; none without one. */
function chord(text: string | undefined): string[] | undefined {
  if (text === undefined || text === '') return undefined;
  return text.includes('+') ? text.split('+') : Array.from(text);
}

const DOT: Record<UserPanelProps['status']['current'], Presence> = { online: 'online', idle: 'idle', dnd: 'dnd', invisible: 'offline' };

/**
 * The desktop user panel at the bottom left (web3.8, item 13), 52 high (web3.9): the avatar, the name with `@username`,
 * mute and deafen as pressed toggles that own the shortcuts (`aria-keyshortcuts`), and the settings gear, all three the
 * same 32px `IconButton`s as the voice dock (E3). A plain div with no role and no name: "your account" is named once, by
 * the group of its toggles. The avatar and name block is a menu button for the status
 * (Discord-style), with the current status as a dot on the avatar.
 */
export function UserPanel({ name, username, muted, deafened, shortcuts, labels, onMute, onDeafen, onSettings, status }: UserPanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const nameId = useId();
  return (
    <div className="d-user-panel">
      <ActionMenu label={status.label} className="d-user-panel__menu" triggerClassName="d-user-panel__who" open={menuOpen} onOpenChange={setMenuOpen}
        labelledBy={nameId}
        items={status.items.map(item => ({ ...item, checked: item.id === status.current }))} onSelect={status.onChoose}
        triggerContent={<>
          {/* WCAG 2.5.3: the button's name holds its visible text, then the status. */}
          <span id={nameId} className="d-sr-only">{`${name} @${username}, ${status.label}`}</span>
          <Avatar name={name} size="md" presence={DOT[status.current]} />
          <span className="d-user-panel__text">
            <span className="d-user-panel__name" title={name}>{name}</span>
            <span className="d-user-panel__username" title={`@${username}`}>@{username}</span>
          </span>
        </>} />
      <div role="group" aria-label={labels.region} className="d-user-panel__controls">
        <IconButton icon={muted ? VOICE_ICONS.mute.iconOn : VOICE_ICONS.mute.icon} label={labels.mute} pressed={muted}
          keys={chord(shortcuts?.mute)} aria-keyshortcuts={VOICE_SHORTCUTS.mute} onClick={onMute} />
        <IconButton icon={deafened ? VOICE_ICONS.deafen.iconOn : VOICE_ICONS.deafen.icon} label={labels.deafen} pressed={deafened}
          keys={chord(shortcuts?.deafen)} aria-keyshortcuts={VOICE_SHORTCUTS.deafen} onClick={onDeafen} />
      </div>
      <IconButton icon="settings" label={labels.settings} onClick={onSettings} />
    </div>
  );
}
