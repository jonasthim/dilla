import { useState, type ReactNode } from 'react';
import './ChannelHeader.css';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { PhoneHeader } from '../PhoneHeader/PhoneHeader.tsx';

export interface ChannelHeaderProps {
  name: string;
  topic?: string;
  readable?: boolean;
  readableLabel?: string;
  kind?: 'channel' | 'dm' | 'announcement';
  /** A cluster of 32px `IconButton`s (R27). A child with `data-foldable` folds into the "⋯" menu below 36rem of header width. */
  actions?: ReactNode;
  /**
   * The "⋯" menu that holds the folded actions: `label` names it (`layout.header.more`), `items` mirror the foldable
   * actions in the same order, and `onSelect` receives the picked item's id. Shown only below 36rem of header width.
   */
  overflow?: { label: string; items: readonly ActionMenuItem[]; onSelect(id: string): void };
  /** On a phone: a PhoneHeader in place of the desktop header, with a back control and `menu` as its action. */
  phone?: { backLabel: string; onBack(): void; menu?: ReactNode };
}

/**
 * The main pane's 48 bar: `[ # name ]` for a channel and `[ @ name ]` for a direct message, `[ (megaphone) name ]` for an
 * announcement channel, with decorative brackets (the heading is named by the name alone), the readable glyph when the
 * server can read the channel, the topic, and the caller's `actions` at the end. The megaphone is its own flex item, a
 * sibling of the name (C3). The title keeps 8rem and the name an ellipsis; the topic gives way first. Below 36rem of the
 * header's own width (a container query, so the aside being open counts) the `data-foldable` actions hide and `overflow`
 * shows (C1, R27).
 */
function opening(kind: 'channel' | 'dm' | 'announcement') {
  if (kind === 'announcement') return '[ ';
  return kind === 'dm' ? '[ @ ' : '[ # ';
}

export function ChannelHeader({ name, topic, readable, readableLabel, kind = 'channel', actions, overflow, phone }: ChannelHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (phone !== undefined) {
    return (
      <PhoneHeader backLabel={phone.backLabel} onBack={phone.onBack} actions={phone.menu}
        marker={readable ? <span role="img" aria-label={readableLabel ?? 'Readable by this server'}><Icon name="eye" size={14} /></span> : undefined}
        title={<><span className="d-channel-header__bracket" aria-hidden="true">{kind === 'announcement' ? <>[ <Icon name="megaphone" size={14} /></> : opening(kind)}</span>{name}<span className="d-channel-header__bracket" aria-hidden="true"> ]</span></>} />
    );
  }
  return (
    <header className="d-channel-header">
      <div className="d-channel-header__title">
        <span className="d-channel-header__bracket" aria-hidden="true">{opening(kind)}</span>
        {kind === 'announcement' ? <span className="d-channel-header__glyph" aria-hidden="true"><Icon name="megaphone" size={14} /></span> : null}
        <h2 className="d-channel-header__name">{name}</h2>
        <span className="d-channel-header__bracket" aria-hidden="true"> ]</span>
      </div>
      {readable ? <span className="d-channel-header__readable" role="img" aria-label={readableLabel ?? 'Readable by this server'}><Icon name="eye" size={14} /></span> : null}
      {topic ? <p className="d-channel-header__topic">{topic}</p> : null}
      {actions !== undefined || overflow !== undefined ? (
        <div className="d-channel-header__actions">
          {actions}
          {overflow !== undefined ? (
            <ActionMenu label={overflow.label} icon="ellipsis" className="d-channel-header__more" triggerClassName="d-channel-header__more-trigger"
              items={overflow.items} open={menuOpen} onOpenChange={setMenuOpen} onSelect={overflow.onSelect} />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
