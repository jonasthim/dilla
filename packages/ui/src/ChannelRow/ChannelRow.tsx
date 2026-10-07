import { Pill } from '../Pill/Pill.tsx';
import { Tag } from '../Tag/Tag.tsx';
import './ChannelRow.css';

export type ChannelRowProps = {
  name: string; kind: 'text' | 'voice' | 'dm'; active?: boolean; unread?: number; mentions?: number;
  muted?: boolean; readable?: boolean; private?: boolean; onSelect: () => void;
  ariaLabel?: string;
};

export function ChannelRow({ name, kind, active, unread = 0, mentions = 0, muted, readable, private: isPrivate, onSelect, ariaLabel }: ChannelRowProps) {
  // A muted channel hides its unread count; its mention count still shows (ruling 15).
  const shown = muted ? 0 : unread;
  return (
    <button type="button" className="d-chrow" data-kind={kind} data-unread={String(shown)} data-mentions={String(mentions)}
      data-muted={muted ? 'true' : undefined} aria-current={active ? 'page' : undefined} aria-label={ariaLabel} onClick={onSelect}>
      <span className="d-chrow__glyph" aria-hidden="true">{kind === 'text' ? '#' : kind === 'voice' ? '♪' : <span className="d-chrow__dot" />}</span>
      <span className="d-chrow__name">{name}</span>
      {readable ? <Tag kind="readable" /> : null}
      {isPrivate ? <span className="d-chrow__lock" role="img" aria-label="Private">🔒</span> : null}
      <span className="d-chrow__spacer" />
      {mentions > 0 ? <Pill kind="mention" count={mentions} /> : shown > 0 ? <Pill kind="unread" count={shown} /> : null}
    </button>
  );
}
