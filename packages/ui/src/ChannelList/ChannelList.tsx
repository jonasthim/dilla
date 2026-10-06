import { ChannelRow } from '../ChannelRow/ChannelRow.tsx';
import { useRovingFocus } from '../internal/roving.ts';
import './ChannelList.css';

export interface ChannelListProps {
  label: string;
  title: string;
  channels: readonly { id: string; name: string; kind: 'text' | 'voice'; readable: boolean }[];
  activeId: string | null;
  onSelect(id: string): void;
  emptyLabel: string;
}

/**
 * The sidebar: the server name as the shell's <h1> (pre-flight ruling (e)), in
 * serif italic and never case-transformed, then the channels as the existing
 * ChannelRow buttons. One tab stop with roving focus.
 */
export function ChannelList({ label, title, channels, activeId, onSelect, emptyLabel }: ChannelListProps) {
  const activeIndex = channels.findIndex(c => c.id === activeId);
  const roving = useRovingFocus(activeIndex);
  return (
    <nav className="d-channel-list" aria-label={label}>
      <h1 className="d-channel-list__title">{title}</h1>
      {channels.length === 0 ? (
        <p className="d-channel-list__empty">{emptyLabel}</p>
      ) : (
        <ul role="list" className="d-channel-list__list" ref={roving.ref} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
          {channels.map(c => (
            <li key={c.id}>
              <ChannelRow name={c.name} kind={c.kind} readable={c.readable} active={c.id === activeId} onSelect={() => onSelect(c.id)} />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
