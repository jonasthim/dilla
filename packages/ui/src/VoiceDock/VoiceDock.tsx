import type { ReactNode } from 'react';
import { VOICE_SHORTCUTS, VoiceToolbar, type ToolbarControl } from '../CallControls/CallControls.tsx';
import './VoiceDock.css';

export interface VoiceDockProps {
  phase: 'connecting' | 'connected' | 'reconnecting' | 'paused';
  /** The voice channel's or the DM's name, filled into `{where}`. */
  where: string;
  muted: boolean;
  deafened: boolean;
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
    mute: string; unmute: string; deafen: string; undeafen: string; leave: string;
  };
  /** Optional: the input meter (an `AudioMeter`), shown under the status line. */
  meter?: ReactNode;
  onMute(): void;
  onDeafen(): void;
  onLeave(): void;
}

const PHASE_GLYPH = { connecting: '◌', connected: '●', reconnecting: '◌', paused: '‖' } as const;

/**
 * The voice dock above the user panel while this device is in voice: where it is (a glyph plus the words), the
 * optional meter, then mute, deafen and leave as one toolbar with roving focus (`voice.dock.region`). Its one
 * `role="status"` region announces join, leave, mute, deafen and the end of a pause (flow 06).
 */
export function VoiceDock({ phase, where, muted, deafened, announcement, labels, meter, onMute, onDeafen, onLeave }: VoiceDockProps) {
  const text = {
    connecting: labels.connecting,
    connected: labels.connected.replaceAll('{where}', where),
    reconnecting: labels.reconnecting,
    paused: labels.paused.replaceAll('{where}', where),
  }[phase];
  const controls: ToolbarControl[] = [
    { id: 'mute', label: labels.mute, onLabel: labels.unmute, on: muted, keys: VOICE_SHORTCUTS.mute, onAction: onMute },
    { id: 'deafen', label: labels.deafen, onLabel: labels.undeafen, on: deafened, keys: VOICE_SHORTCUTS.deafen, onAction: onDeafen },
    { id: 'leave', label: labels.leave, danger: true, onAction: onLeave },
  ];
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
