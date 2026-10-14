import { useId } from 'react';
import { VoiceChannelRow } from '../VoiceChannelRow/VoiceChannelRow.tsx';
import type { VoiceParticipantView, VoiceStateLabels } from '../CallTile/CallTile.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './ActiveVoice.css';

export interface ActiveVoiceProps {
  /** The community's live voice channels, in channel order. */
  channels: readonly { id: string; name: string; current: boolean; joined: boolean; participants: readonly VoiceParticipantView[] }[];
  /** `heading` is `voice.heading.active`; `open`, `count` and `canHear` are the voice row's (`voice.open`, `voice.count`, `voice.bot.canHear`). */
  labels: { heading: string; state: VoiceStateLabels; open: string; count: string; canHear: string };
  onOpen(id: string): void;
}

/**
 * `ACTIVE VOICE` above the channel list (flow 06): a section headed `voice.heading.active` (shown in caps by the
 * label style) listing each live voice as a VoiceChannelRow with its people, as one roving tab stop. Renders
 * nothing when no voice is live.
 */
export function ActiveVoice({ channels, labels, onOpen }: ActiveVoiceProps) {
  const headingId = useId();
  const roving = useRovingFocus(channels.findIndex(c => c.current));
  if (channels.length === 0) return null;
  return (
    <section className="d-active-voice" aria-labelledby={headingId}>
      <h2 id={headingId} className="d-active-voice__heading d-label">{labels.heading}</h2>
      <ul role="list" className="d-active-voice__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {channels.map(c => (
          <li key={c.id}>
            <VoiceChannelRow name={c.name} current={c.current} joined={c.joined} participants={c.participants}
              labels={{ open: labels.open, count: labels.count, canHear: labels.canHear, state: labels.state }} onOpen={() => onOpen(c.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
