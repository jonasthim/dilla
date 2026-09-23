import './KeyHint.css';
export type KeyHintProps = { keys: string[]; label?: string };
export function KeyHint({ keys, label }: KeyHintProps) {
  return (
    <span className="d-keyhint">
      {keys.map((k, i) => <kbd key={i} className="d-keyhint__kbd">{k}</kbd>)}
      {label ? <span className="d-keyhint__label">{label}</span> : null}
    </span>
  );
}
