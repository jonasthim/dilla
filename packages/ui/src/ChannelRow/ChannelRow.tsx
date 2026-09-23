import { Pill } from '../Pill/Pill.tsx';
import { Tag } from '../Tag/Tag.tsx';
import './ChannelRow.css';

export type ChannelRowProps = {
  name: string; kind: 'text' | 'voice'; active?: boolean; unread?: number; mentions?: number;
  muted?: boolean; readable?: boolean; private?: boolean; onSelect: () => void;
};

export function ChannelRow({ name, kind, active, unread = 0, mentions = 0, muted, readable, private: isPrivate, onSelect }: ChannelRowProps) {
  return (
    <button type="button" className="d-chrow" data-kind={kind} data-muted={muted ? 'true' : undefined}
      data-unread={unread > 0 || mentions > 0 ? 'true' : undefined} aria-current={active ? 'page' : undefined} onClick={onSelect}>
      <span className="d-chrow__glyph" aria-hidden="true">{kind === 'text' ? '#' : '♪'}</span>
      <span className="d-chrow__name">{name}</span>
      {readable ? <Tag kind="readable" /> : null}
      {isPrivate ? <span className="d-chrow__lock" role="img" aria-label="Private">🔒</span> : null}
      <span className="d-chrow__spacer" />
      {mentions > 0 ? <Pill kind="mention" count={mentions} /> : unread > 0 ? <Pill kind="unread" count={unread} /> : null}
    </button>
  );
}
