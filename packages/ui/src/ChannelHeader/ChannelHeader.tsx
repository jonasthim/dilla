import type { ReactNode } from 'react';
import './ChannelHeader.css';
import { Icon } from '../Icon/Icon.tsx';
import { PhoneHeader } from '../PhoneHeader/PhoneHeader.tsx';

export interface ChannelHeaderProps {
  name: string;
  topic?: string;
  readable?: boolean;
  readableLabel?: string;
  kind?: 'channel' | 'dm';
  actions?: ReactNode;
  /** On a phone: a PhoneHeader in place of the desktop header, with a back control and `menu` as its action. */
  phone?: { backLabel: string; onBack(): void; menu?: ReactNode };
}

/**
 * The main pane's header: `[ # name ]` for a channel and `[ @ name ]` for a direct message, with
 * decorative brackets (the heading is named by the name alone), the readable glyph when the server
 * can read the channel, and the topic. Holds no control of its own; `actions` are the caller's (the
 * pins button), at the end of the header.
 */
export function ChannelHeader({ name, topic, readable, readableLabel, kind = 'channel', actions, phone }: ChannelHeaderProps) {
  if (phone !== undefined) {
    return (
      <PhoneHeader backLabel={phone.backLabel} onBack={phone.onBack} actions={phone.menu}
        title={<><span className="d-channel-header__bracket" aria-hidden="true">{kind === 'dm' ? '[ @ ' : '[ # '}</span>{name}<span className="d-channel-header__bracket" aria-hidden="true"> ]</span></>} />
    );
  }
  return (
    <header className="d-channel-header">
      <h2 className="d-channel-header__name">
        <span className="d-channel-header__bracket" aria-hidden="true">{kind === 'dm' ? '[ @ ' : '[ # '}</span><span className="d-channel-header__text">{name}</span><span className="d-channel-header__bracket" aria-hidden="true"> ]</span>
      </h2>
      {readable ? <span className="d-channel-header__readable" role="img" aria-label={readableLabel ?? 'Readable by this server'}><Icon name="eye" size={14} /></span> : null}
      {topic ? <p className="d-channel-header__topic">{topic}</p> : null}
      {actions !== undefined ? <div className="d-channel-header__actions">{actions}</div> : null}
    </header>
  );
}
