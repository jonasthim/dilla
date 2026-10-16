import { Banner } from '../Banner/Banner.tsx';

export type TrustAlertProps = { kind: 'changed' | 'unlisted'; name: string; labels: { changed: string; unlisted: string; verify: string }; onVerify?(): void };

/**
 * A contact's trust alert: a danger Banner (x icon, danger bar, role alert), never dismissable, so it reads like the
 * other danger banners beside it (W-09). The Compare action stands only when there is a key to compare (`onVerify`).
 */
export function TrustAlert({ kind, name, labels, onVerify }: TrustAlertProps) {
  return <Banner tone="danger" action={onVerify ? { label: labels.verify, onAction: onVerify } : undefined}>
    <strong>{name}</strong> {labels[kind]}
  </Banner>;
}
