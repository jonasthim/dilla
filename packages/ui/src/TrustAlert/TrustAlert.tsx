import './TrustAlert.css';
export type TrustAlertProps = { kind: 'changed' | 'unlisted'; name: string; labels: { changed: string; unlisted: string; verify: string }; onVerify(): void };
export function TrustAlert({ kind, name, labels, onVerify }: TrustAlertProps) {
  return <div className="d-trust-alert" role="alert"><strong>{name}</strong><span>{labels[kind]}</span><button type="button" onClick={onVerify}>{labels.verify}</button></div>;
}
