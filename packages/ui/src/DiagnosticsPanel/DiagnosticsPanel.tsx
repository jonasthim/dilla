import './DiagnosticsPanel.css';
export type DiagnosticsPanelProps = { data: { connection: string; generation: string | null; instance: string; devices: number; errors: readonly { code: string; at: number }[] }; labels: { title: string; copy: string }; onCopy(): void };
export function DiagnosticsPanel({ data, labels, onCopy }: DiagnosticsPanelProps) {
  return <section className="d-diagnostics-panel"><h2>{labels.title}</h2><dl><dt>connection</dt><dd>{data.connection}</dd><dt>generation</dt><dd>{data.generation}</dd><dt>instance</dt><dd>{data.instance}</dd><dt>devices</dt><dd>{data.devices}</dd></dl><ul>{data.errors.slice(-20).map((error, index) => <li data-error-code={error.code} key={`${error.at}-${index}`}><code>{error.code}</code><time>{error.at}</time></li>)}</ul><button type="button" onClick={onCopy}>{labels.copy}</button></section>;
}
