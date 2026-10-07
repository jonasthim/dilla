import './ChannelHeader.css';

export interface ChannelHeaderProps {
  name: string;
  topic?: string;
  readable?: boolean;
  readableLabel?: string;
  kind?: 'channel' | 'dm';
}

/**
 * The main pane's header: `[ # name ]` for a channel and `[ @ name ]` for a direct message, with
 * decorative brackets (the heading is named by the name alone), the readable glyph when the server
 * can read the channel, and the topic. Holds no control.
 */
export function ChannelHeader({ name, topic, readable, readableLabel, kind = 'channel' }: ChannelHeaderProps) {
  return (
    <header className="d-channel-header">
      <h2 className="d-channel-header__name">
        <span className="d-channel-header__bracket" aria-hidden="true">{kind === 'dm' ? '[ @ ' : '[ # '}</span>{name}<span className="d-channel-header__bracket" aria-hidden="true"> ]</span>
      </h2>
      {readable ? <span className="d-channel-header__readable" role="img" aria-label={readableLabel ?? 'Readable by this server'}>◌</span> : null}
      {topic ? <p className="d-channel-header__topic">{topic}</p> : null}
    </header>
  );
}
