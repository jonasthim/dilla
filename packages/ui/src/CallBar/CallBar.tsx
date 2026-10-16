import { Button } from '../Button/Button.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { StateDot } from '../StateDot/StateDot.tsx';
import './CallBar.css';

export interface CallBarProps {
  phase: 'connecting' | 'connected' | 'reconnecting' | 'paused';
  /** The voice channel's or the DM's name. */
  where: string;
  muted: boolean;
  labels: {
    /** The wide button's name, with the place already filled in. */
    open: string;
    mute: string;
    leave: string;
    /** The group's name. */
    region: string;
  };
  onOpen(): void;
  onMute(): void;
  onLeave(): void;
}

/**
 * The phone's call strip above the tab bar while this device is in a call: where it is (a state marker and the name),
 * which opens the call, then mute and leave. All three are at least 44 × 44 CSS px.
 */
export function CallBar({ phase, where, muted, labels, onOpen, onMute, onLeave }: CallBarProps) {
  return (
    <div className="d-call-bar" role="group" aria-label={labels.region} data-phase={phase}>
      <button type="button" className="d-call-bar__open" aria-label={labels.open} onClick={onOpen}>
        <span className="d-call-bar__glyph" aria-hidden="true">
          {phase === 'paused' ? <Icon name="pause" size={14} /> : <StateDot tone={phase === 'connected' ? 'ok' : 'pending'} />}
        </span>
        <span className="d-call-bar__where">{where}</span>
      </button>
      <Button className="d-call-bar__mute" pressed={muted} mark={false} aria-label={labels.mute} onClick={onMute}>
        <Icon name={muted ? 'mic-off' : 'mic'} size={20} />
      </Button>
      <Button className="d-call-bar__leave" variant="danger" aria-label={labels.leave} onClick={onLeave}>
        <Icon name="phone-off" size={20} />
      </Button>
    </div>
  );
}
