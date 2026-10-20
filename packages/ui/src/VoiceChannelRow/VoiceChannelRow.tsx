import { useId } from 'react';
import { voiceStateWords, VoiceStates, type VoiceParticipantView, type VoiceStateLabels } from '../CallTile/CallTile.tsx';
import { Tag } from '../Tag/Tag.tsx';
import './VoiceChannelRow.css';
import { Icon } from '../Icon/Icon.tsx';

export interface VoiceChannelRowProps {
  name: string;
  /** The voice the main pane shows (aria-current). */
  current: boolean;
  /** This device is in this voice. */
  joined: boolean;
  participants: readonly VoiceParticipantView[];
  /** The channel is readable by this server (joinable by public invite): the readable glyph stays on the row. */
  readable?: boolean;
  /**
   * `open` is `voice.open` ('voice {name}'), `count` is `voice.count` ('{n} in voice'), both filled here;
   * `canHear` is `voice.bot.canHear` ('can hear'), shown with the bot tag.
   */
  labels: { open: string; count: string; canHear: string; state: VoiceStateLabels };
  onOpen(): void;
}

/**
 * A voice channel in the sidebar: one button (the only tab stop; inside a roving list its tab index is the list's)
 * named `voice {name}` and described by `{n} in voice` (its marker is the volume-2 icon), then one sub-row per person
 * in it: the name, then their states in one non-wrapping line as named glyphs (muted, deafened, camera, screen,
 * speaking), then the stream-state words (`connecting`, `not heard yet`, `unverified stream`); a bot also shows the bot tag and `can hear` (the brief's trust facts), so anyone
 * deciding whether to join sees it. Nobody in it: no count and no sub-rows. The row and its sub-rows are siblings, so the button stays the
 * first element of a list item (the roving lists find it there).
 */
export function VoiceChannelRow({ name, current, joined, participants, readable, labels, onOpen }: VoiceChannelRowProps) {
  const countId = useId();
  const n = participants.length;
  return (
    <>
      <button type="button" className="d-voice-row" aria-label={labels.open.replaceAll('{name}', name)}
        aria-describedby={n > 0 ? countId : undefined} aria-current={current ? 'page' : undefined}
        data-joined={joined ? 'true' : undefined} data-live={n > 0 ? 'true' : undefined} onClick={() => onOpen()}>
        <span className="d-voice-row__glyph" aria-hidden="true"><Icon name="volume-2" size={16} /></span>
        <span className="d-voice-row__name">{name}</span>
        {readable === true ? <Tag kind="readable" /> : null}
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
              {p.bot ? (
                <>
                  {' '}<span className="d-tag" data-kind="bot">{labels.state.bot}</span>
                  {' '}<span className="d-tag" data-kind="canHear">{labels.canHear}</span>
                </>
              ) : null}
              <VoiceStates words={voiceStateWords(p, labels.state)} prefix="d-voice-row" />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
