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
   * `canHear` is `voice.bot.canHear` ('can hear'), shown with the bot tag; `join` is `voice.join`, the slot's icon button; `joined` is `voice.row.joined` ('connected'), added to the description (after the count) of the row this device is in; the name stays 'voice {name}';
   * `away` is `afk.away` ('away'), the word beside a person of the AFK channel's away roster (AW6).
   */
  labels: { open: string; count: string; canHear: string; state: VoiceStateLabels; join: string; joined: string; away?: string };
  /** Opens the voice in the main pane (the row's own click). */
  onOpen(): void;
  /** The trailing join icon; without it, or when `joined`, the row has none. Its own click never opens the row (Shell decides, R24). */
  onJoin?(): void;
}

/** The mute and deafen glyphs sit in a participant's trailing slot; every other state stays beside the name. */
const SLOT_STATES = new Set(['muted', 'deafened']);

/**
 * One entry per person (A7, AUDIT-2 FA3): a person with several devices in the call is listed once, as on Discord. The
 * state is the union across their devices: speaking if any device speaks, camera or screen if any shares one, muted
 * and deafened only if every device is. State is the worst across devices (unverified, connecting, not-heard, ok); web and bot if any. The first device stands for the person (name, id); order is kept.
 */
/** Worst first: an unverified stream is a security warning and must never read as ok. */
const WORST: readonly VoiceParticipantView['state'][] = ['unverified', 'connecting', 'not-heard', 'ok'];

export function groupPeople(devices: readonly VoiceParticipantView[]): VoiceParticipantView[] {
  const byUser = new Map<string, VoiceParticipantView[]>();
  for (const d of devices) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);
  return [...byUser.values()].map(group => ({
    ...group[0],
    speaking: group.some(d => d.speaking), video: group.some(d => d.video), screen: group.some(d => d.screen),
    state: WORST.find(w => group.some(d => d.state === w)) ?? 'ok', web: group.some(d => d.web), bot: group.some(d => d.bot),
    muted: group.every(d => d.muted), deafened: group.every(d => d.deafened),
    ...(group.some(d => d.away === true) ? { away: true } : {}),
  }));
}

/**
 * A voice channel in the sidebar, on the same grammar as ChannelRow (R10-R13): the volume-2 glyph, the name with its
 * count after it (`harbour · 3`), then one trailing slot (empty when this device is in the call: the joined row shows no phone and no accent, only a bold full-strength name, as Discord's). The
 * join icon is a sibling drawn over that slot (a button cannot sit inside the row's button), shown while the row is
 * hovered or focused and always on a device without hover; never on the channel you are in. Under the row, one
 * sub-row per person (R25, A7) at `--row-h-sub`, indented so the avatar starts at the name's x, with the speaking ring on
 * the avatar (the only visible speaking mark, WEB-DOCK; the word stays for assistive technology) and the mute and deafen glyphs in the slot. The row and its parts are siblings, so the button stays the first
 * element of a list item (the roving lists find it there); a caller outside ChannelList wraps them in `.d-voice-item`.
 */
export function VoiceChannelRow({ name, current, joined, participants: devices, readable, labels, onOpen, onJoin }: VoiceChannelRowProps) {
  const countId = useId();
  const participants = groupPeople(devices);
  const n = participants.length;
  return (
    <>
      <button type="button" className="d-voice-row" data-row aria-label={labels.open.replaceAll('{name}', name)}
        aria-describedby={n > 0 || joined ? countId : undefined} aria-current={current ? 'page' : undefined}
        data-joined={joined ? 'true' : undefined} data-live={n > 0 ? 'true' : undefined} onClick={() => onOpen()}>
        <span className="d-voice-row__glyph" aria-hidden="true"><Icon name="volume-2" size={14} /></span>
        <span className="d-voice-row__title">
          <span className="d-voice-row__name">{name}</span>
          {n > 0 ? <span className="d-voice-row__count" aria-hidden="true">{` · ${String(n)}`}</span> : null}
        </span>
        {n > 0 || joined ? <span id={countId} className="d-sr-only">{[...(n > 0 ? [labels.count.replaceAll('{n}', String(n))] : []), ...(joined ? [labels.joined] : [])].join(', ')}</span> : null}
        {readable === true ? <Tag kind="readable" /> : null}
        <TrailingSlot />
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
              <li key={p.userId} className="d-voice-row__person" data-row data-speaking={p.speaking ? 'true' : undefined}
                data-away={p.away === true ? 'true' : undefined}>
                <span className="d-voice-row__avatar" aria-hidden="true"><Avatar name={p.name} size="xs" /></span>
                <span className="d-voice-row__person-name">{p.name}</span>
                <span className="d-voice-row__states">
                  {p.bot ? (
                    <>
                      {' '}<span className="d-tag" data-kind="bot">{labels.state.bot}</span>
                      {' '}<span className="d-tag" data-kind="canHear">{labels.canHear}</span>
                    </>
                  ) : null}
                  {p.away === true && labels.away !== undefined ? <>{' '}<span className="d-voice-row__state" data-state="away">{labels.away}</span></> : null}
                  <VoiceStates words={words.filter(w => !SLOT_STATES.has(w.key) && w.key !== 'speaking')} prefix="d-voice-row" />
                  {p.speaking ? <>{' '}<span className="d-sr-only">{labels.state.speaking}</span></> : null}
                </span>
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
