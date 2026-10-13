import { useId } from 'react';
import { voiceStateWords, type VoiceParticipantView, type VoiceStateLabels } from '../CallTile/CallTile.tsx';
import './VoiceChannelRow.css';

export interface VoiceChannelRowProps {
  name: string;
  /** The voice the main pane shows (aria-current). */
  current: boolean;
  /** This device is in this voice. */
  joined: boolean;
  participants: readonly VoiceParticipantView[];
  /** `open` is `voice.open` ('voice {name}'), `count` is `voice.count` ('{n} in voice'); both are filled here. */
  labels: { open: string; count: string; state: VoiceStateLabels };
  onOpen(): void;
}

/**
 * A voice channel in the sidebar: one button (the only tab stop; inside a roving list its tab index is the list's)
 * named `voice {name}` and described by `{n} in voice`, then one text sub-row per person in it with their state
 * words. Nobody in it: no count and no sub-rows. The row and its sub-rows are siblings, so the button stays the
 * first element of a list item (the roving lists find it there).
 */
export function VoiceChannelRow({ name, current, joined, participants, labels, onOpen }: VoiceChannelRowProps) {
  const countId = useId();
  const n = participants.length;
  return (
    <>
      <button type="button" className="d-voice-row" aria-label={labels.open.replaceAll('{name}', name)}
        aria-describedby={n > 0 ? countId : undefined} aria-current={current ? 'page' : undefined}
        data-joined={joined ? 'true' : undefined} data-live={n > 0 ? 'true' : undefined} onClick={() => onOpen()}>
        <span className="d-voice-row__glyph" aria-hidden="true">{n > 0 ? '◉' : '○'}</span>
        <span className="d-voice-row__name">{name}</span>
        {n > 0 ? (
          <>
            <span className="d-voice-row__count" aria-hidden="true">{n}</span>
            <span id={countId} className="d-sr-only">{labels.count.replaceAll('{n}', String(n))}</span>
          </>
        ) : null}
      </button>
      {n > 0 ? (
        <ul role="list" className="d-voice-row__people">
          {participants.map(p => (
            <li key={p.deviceId} className="d-voice-row__person" data-speaking={p.speaking ? 'true' : undefined}>
              <span className="d-voice-row__person-name">{p.name}</span>
              {voiceStateWords(p, labels.state).map(w => (
                <span key={w.key} className="d-voice-row__state" data-state={w.key}>{' '}{w.text}</span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
