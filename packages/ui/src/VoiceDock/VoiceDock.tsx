import type { ReactNode } from 'react';
import { VOICE_ICONS, VOICE_SHORTCUTS, VoiceToolbar, type ToolbarControl } from '../CallControls/CallControls.tsx';
import './VoiceDock.css';

export interface VoiceDockProps {
  phase: 'connecting' | 'connected' | 'reconnecting' | 'paused';
  /** The voice channel's or the DM's name, filled into `{where}`. */
  where: string;
  muted: boolean;
  deafened: boolean;
  /** The camera is live (a pressed toggle). Shown only with `onCamera`. */
  camera?: boolean;
  /** This device shares its screen (a pressed toggle). Shown only with `onShare`. */
  sharing?: boolean;
  /** False while the call is paused or held (RV-3): the camera control is aria-disabled. (No caller checks for a camera device yet.) */
  canCamera?: boolean;
  /** False without screen capture, or while the call is paused (RV-3): the share control is aria-disabled. */
  canShare?: boolean;
  /** True while joining (the stage's `busy`): camera and share are aria-disabled. Mute, deafen and leave stay live. */
  busy?: boolean;
  /** Optional: the mute and deafen shortcuts as the tooltips show them, formatted per platform by the caller. */
  shortcuts?: { mute: string; deafen: string };
  /** The latest polite announcement (join, leave, mute, deafen, the end of a pause, the outgoing ring); '' for none. */
  announcement: string;
  labels: {
    /** `voice.dock.region`: the toolbar's name. */
    region: string;
    connecting: string;
    /** `voice.dock.connected`, with `{where}`. */
    connected: string;
    reconnecting: string;
    /** `voice.dock.paused`, with `{where}`. */
    paused: string;
    mute: string; deafen: string; leave: string;
    /** `voice.cameraOn`; needed with `onCamera`. */
    camera?: string;
    /** `voice.shareOn`; needed with `onShare`. */
    share?: string;
  };
  /** Optional: the input meter (an `AudioMeter`), shown under the status line. */
  meter?: ReactNode;
  onMute(): void;
  onDeafen(): void;
  /** Toggles the camera, as the stage's control does. Without it (or `labels.camera`) the dock shows no camera control. */
  onCamera?(): void;
  /** Toggles screen sharing, as the stage's control does. Without it (or `labels.share`) the dock shows no share control. */
  onShare?(): void;
  onLeave(): void;
}

const PHASE_GLYPH = { connecting: '◌', connected: '●', reconnecting: '◌', paused: '‖' } as const;

/**
 * The voice dock above the user panel while this device is in voice: where it is (a glyph plus the words), the
 * optional meter, then mute, deafen, camera, share screen and leave as one toolbar of icon buttons with roving focus
 * (`voice.dock.region`), the stage's controls under the stage's rules. Its one `role="status"` region announces join,
 * leave, mute, deafen and the end of a pause (flow 06).
 */
export function VoiceDock({
  phase, where, muted, deafened, camera = false, sharing = false, canCamera = true, canShare = true, busy = false, shortcuts,
  announcement, labels, meter, onMute, onDeafen, onCamera, onShare, onLeave,
}: VoiceDockProps) {
  const text = {
    connecting: labels.connecting,
    connected: labels.connected.replaceAll('{where}', where),
    reconnecting: labels.reconnecting,
    paused: labels.paused.replaceAll('{where}', where),
  }[phase];
  const controls: ToolbarControl[] = [
    { id: 'mute', label: labels.mute, on: muted, keys: VOICE_SHORTCUTS.mute, shortcut: shortcuts?.mute, ...VOICE_ICONS.mute, onAction: onMute },
    { id: 'deafen', label: labels.deafen, on: deafened, keys: VOICE_SHORTCUTS.deafen, shortcut: shortcuts?.deafen, ...VOICE_ICONS.deafen, onAction: onDeafen },
  ];
  if (onCamera !== undefined && labels.camera !== undefined) {
    controls.push({ id: 'camera', label: labels.camera, on: camera, inert: busy || !canCamera, ...VOICE_ICONS.camera, onAction: onCamera });
  }
  if (onShare !== undefined && labels.share !== undefined) {
    controls.push({ id: 'share', label: labels.share, on: sharing, inert: busy || !canShare, ...VOICE_ICONS.share, onAction: onShare });
  }
  controls.push({ id: 'leave', label: labels.leave, danger: true, ...VOICE_ICONS.leave, onAction: onLeave });
  return (
    <div className="d-voice-dock" data-phase={phase}>
      <p className="d-voice-dock__where">
        <span className="d-voice-dock__glyph" aria-hidden="true">{PHASE_GLYPH[phase]}</span>
        <span className="d-voice-dock__text">{text}</span>
      </p>
      {meter !== undefined ? <div className="d-voice-dock__meter">{meter}</div> : null}
      <VoiceToolbar label={labels.region} controls={controls} className="d-voice-dock__controls" />
      <p className="d-sr-only" role="status">{announcement}</p>
    </div>
  );
}
