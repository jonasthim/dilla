import { Button } from '../Button/Button.tsx';
import './DiagnosticsPanel.css';

export type DiagnosticsPanelProps = {
  data: { connection: string; generation: string | null; instance: string; devices: number | string; errors: readonly { code: string; at: number }[] };
  labels: { title: string; copy: string; fields: { connection: string; generation: string; instance: string; devices: string }; empty?: string };
  /** The visible form of an error's time (ms since the epoch); the `<time>` element carries the ISO form. Default HH:MM:SS UTC. */
  formatTime?(at: number): string;
  onCopy(): void;
};

const isoTime = (at: number) => new Date(at).toISOString();
const defaultFormat = (at: number) => isoTime(at).slice(11, 19);

/** Device-local diagnostics: four labelled facts and the last 20 stable codes with their times (W-05). */
export function DiagnosticsPanel({ data, labels, formatTime = defaultFormat, onCopy }: DiagnosticsPanelProps) {
  const errors = data.errors.slice(-20);
  return <section className="d-diagnostics-panel">
    <h2 tabIndex={-1}>{labels.title}</h2>
    <dl>
      <dt>{labels.fields.connection}</dt><dd>{data.connection}</dd>
      <dt>{labels.fields.generation}</dt><dd>{data.generation}</dd>
      <dt>{labels.fields.instance}</dt><dd>{data.instance}</dd>
      <dt>{labels.fields.devices}</dt><dd>{data.devices}</dd>
    </dl>
    {errors.length > 0
      ? <ul>{errors.map((error, index) => <li data-error-code={error.code} key={`${error.at}-${index}`}><code>{error.code}</code><time dateTime={isoTime(error.at)}>{formatTime(error.at)}</time></li>)}</ul>
      : labels.empty ? <p className="d-diagnostics-panel__empty">{labels.empty}</p> : null}
    <Button onClick={onCopy}>{labels.copy}</Button>
  </section>;
}
