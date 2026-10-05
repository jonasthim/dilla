import './ChannelHeader.css';

export interface ChannelHeaderProps {
  name: string;
  topic?: string;
  readable?: boolean;
  readableLabel?: string;
}

/**
 * The main pane's header: `[ # name ]` with decorative brackets, the readable
 * glyph when the server can read the channel, and the topic. Holds no control
 * in web-1.
 */
export function ChannelHeader({ name, topic, readable, readableLabel }: ChannelHeaderProps) {
  return (
    <header className="d-channel-header">
      <h2 className="d-channel-header__name">
        <span className="d-channel-header__bracket" aria-hidden="true">[ # </span>{name}<span className="d-channel-header__bracket" aria-hidden="true"> ]</span>
      </h2>
      {readable ? <span className="d-channel-header__readable" role="img" aria-label={readableLabel ?? 'Readable by this server'}>◌</span> : null}
      {topic ? <p className="d-channel-header__topic">{topic}</p> : null}
    </header>
  );
}
