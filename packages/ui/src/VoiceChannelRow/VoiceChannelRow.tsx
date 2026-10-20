import { useId } from 'react';
import { voiceStateWords, VoiceStates, type VoiceParticipantView, type VoiceStateLabels } from '../CallTile/CallTile.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { Tag } from '../Tag/Tag.tsx';
import { TrailingSlot } from '../TrailingSlot/TrailingSlot.tsx';
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
   * `canHear` is `voice.bot.canHear` ('can hear'), shown with the bot tag; `join` is `voice.join`, the slot's icon button.
   */
  labels: { open: string; count: string; canHear: string; state: VoiceStateLabels; join: string };
  /** Opens the voice in the main pane (the row's own click). */
  onOpen(): void;
  /** The trailing join icon; without it, or when `joined`, the row has none. Its own click never opens the row (Shell decides, R24). */
  onJoin?(): void;
}

/** The mute and deafen glyphs sit in a participant's trailing slot; every other state stays beside the name. */
const SLOT_STATES = new Set(['muted', 'deafened']);

/**
 * A voice channel in the sidebar, on the same grammar as ChannelRow (R10-R13): the volume-2 glyph, the name with its
 * count after it (`harbour · 3`), then one trailing slot that holds the connected glyph when this device is in it. The
 * join icon is a sibling drawn over that slot (a button cannot sit inside the row's button), shown while the row is
 * hovered or focused and always on a device without hover; never both it and the connected glyph. Under the row, one
 * sub-row per person (R25, A7) at `--row-h-sub`, indented so the avatar starts at the name's x, with the speaking ring on
 * the avatar and the mute and deafen glyphs in the slot. The row and its parts are siblings, so the button stays the first
 * element of a list item (the roving lists find it there); a caller outside ChannelList wraps them in `.d-voice-item`.
 */
export function VoiceChannelRow({ name, current, joined, participants, readable, labels, onOpen, onJoin }: VoiceChannelRowProps) {
  const countId = useId();
  const n = participants.length;
  return (
    <>
      <button type="button" className="d-voice-row" data-row aria-label={labels.open.replaceAll('{name}', name)}
        aria-describedby={n > 0 ? countId : undefined} aria-current={current ? 'page' : undefined}
        data-joined={joined ? 'true' : undefined} data-live={n > 0 ? 'true' : undefined} onClick={() => onOpen()}>
        <span className="d-voice-row__glyph" aria-hidden="true"><Icon name="volume-2" size={14} /></span>
        <span className="d-voice-row__title">
          <span className="d-voice-row__name">{name}</span>
          {n > 0 ? <span className="d-voice-row__count" aria-hidden="true">{` · ${String(n)}`}</span> : null}
        </span>
        {n > 0 ? <span id={countId} className="d-sr-only">{labels.count.replaceAll('{n}', String(n))}</span> : null}
        {readable === true ? <Tag kind="readable" /> : null}
        <TrailingSlot>
          {joined ? <span className="d-voice-row__connected" aria-hidden="true"><Icon name="phone" size={14} /></span> : null}
        </TrailingSlot>
      </button>
      {onJoin !== undefined && !joined ? (
        <span className="d-voice-row__join">
          <TrailingSlot>
            <IconButton icon="phone" size={28} label={labels.join} onClick={() => onJoin()} />
          </TrailingSlot>
        </span>
      ) : null}
      {n > 0 ? (
        <ul role="list" className="d-voice-row__people">
          {participants.map(p => {
            const words = voiceStateWords(p, labels.state);
            return (
              <li key={p.deviceId} className="d-voice-row__person" data-row data-speaking={p.speaking ? 'true' : undefined}>
                <span className="d-voice-row__avatar" aria-hidden="true"><Avatar name={p.name} size="xs" /></span>
                <span className="d-voice-row__person-name">{p.name}</span>
                {p.bot ? (
                  <>
                    {' '}<span className="d-tag" data-kind="bot">{labels.state.bot}</span>
                    {' '}<span className="d-tag" data-kind="canHear">{labels.canHear}</span>
                  </>
                ) : null}
                <VoiceStates words={words.filter(w => !SLOT_STATES.has(w.key))} prefix="d-voice-row" />
                <span className="d-voice-row__spacer" />
                <TrailingSlot>
                  <VoiceStates words={words.filter(w => SLOT_STATES.has(w.key))} prefix="d-voice-row" />
                </TrailingSlot>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
