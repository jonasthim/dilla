import { Icon } from '../Icon/Icon.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { Tag } from '../Tag/Tag.tsx';
import { TrailingSlot } from '../TrailingSlot/TrailingSlot.tsx';
import './ChannelRow.css';

export type ChannelRowProps = {
  name: string; kind: 'text' | 'voice' | 'dm' | 'announcement'; active?: boolean; unread?: number; mentions?: number;
  muted?: boolean; readable?: boolean; private?: boolean; onSelect: () => void;
  ariaLabel?: string;
  /** A short note after the name ("slow mode"). It is part of the row's accessible name unless `ariaLabel` replaces it. */
  badge?: string;
};

/** The glyph column (16px, never shrinking): `#` as text for a text channel, a 14px icon for the others, a dot for a person. */
function Glyph({ kind }: { kind: ChannelRowProps['kind'] }) {
  return (
    <span className="d-chrow__glyph" aria-hidden="true">
      {kind === 'text' ? '#' : kind === 'voice' ? <Icon name="volume-2" size={14} /> : kind === 'announcement' ? <Icon name="megaphone" size={14} /> : <span className="d-chrow__dot" />}
    </span>
  );
}

/**
 * One row grammar (R10-R14, R18): the glyph column, the name, the lock after it, then one trailing slot holding the
 * mention pill, else the unread pill, else nothing. Selected is a fill and a 2px accent bar; unread is a bright name and
 * a 4px tick at the left edge, never bold.
 */
export function ChannelRow({ name, kind, active, unread = 0, mentions = 0, muted, readable, private: isPrivate, onSelect, ariaLabel, badge }: ChannelRowProps) {
  // A muted channel hides its unread count; its mention count still shows (ruling 15).
  const shown = muted ? 0 : unread;
  return (
    <button type="button" className="d-chrow" data-row data-kind={kind} data-unread={String(shown)} data-mentions={String(mentions)}
      data-muted={muted ? 'true' : undefined} aria-current={active ? 'page' : undefined} aria-label={ariaLabel} onClick={onSelect}>
      <Glyph kind={kind} />
      <span className="d-chrow__name">{name}</span>
      {badge !== undefined ? <span className="d-chrow__badge">{badge}</span> : null}
      {readable ? <Tag kind="readable" /> : null}
      {isPrivate ? <span className="d-chrow__lock" role="img" aria-label="Private"><Icon name="lock" size={12} /></span> : null}
      <span className="d-chrow__spacer" />
      <TrailingSlot>
        {mentions > 0 ? <Pill kind="mention" count={mentions} /> : shown > 0 ? <Pill kind="unread" count={shown} /> : null}
      </TrailingSlot>
    </button>
  );
}
