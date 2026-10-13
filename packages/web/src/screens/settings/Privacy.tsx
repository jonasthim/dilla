import type { TrustSummary } from '@dilla/client-core';
import { TrustAlert } from '@dilla/ui';
import { t } from '../../strings/index.ts';

/**
 * The contacts this device pinned, in Flow 05's states: changed (an alert that cannot be dismissed), unlisted (no
 * comparison), verified (the compared public key) or first seen here. Names and the shared flag come from the worker's
 * trust slice only; the worker and core own every trust decision.
 */
export function Privacy({ records, onCompare }: { records: readonly TrustSummary[]; onCompare: (record: TrustSummary) => void }): React.JSX.Element {
  return <section className="dw-settings-section" data-doc-state="trust-privacy" aria-labelledby="privacy-title">
    <h2 id="privacy-title" tabIndex={-1} data-privacy-heading>{t('privacy.section')}</h2>
    <ul className="dw-trust-list">{records.map(record => {
      const compare = () => onCompare(record);
      const changed = record.changedUmk !== null;
      const unlisted = record.unlisted === true;
      return <li key={record.userId} data-doc-state={changed ? 'trust-changed' : undefined}>
        {changed && record.shared ? <TrustAlert kind="changed" name={record.name}
          labels={{ changed: t('privacy.changed'), unlisted: t('privacy.unlisted'), verify: t('privacy.compare', { name: record.name }) }} onVerify={compare} />
          : changed ? <p role="alert">{record.name} {t('privacy.changed')}</p>
          : <strong>{record.name}</strong>}
        {unlisted ? <p role="status">{t('privacy.unlisted')}</p>
          : changed ? null
          : record.verified ? <><p>{t('privacy.verifiedLabel')}</p><code className="dw-trust-key">{record.umk}</code></>
          : <><p>{t('privacy.firstSeenLabel')}</p><p>{t('privacy.firstSeen', { name: record.name })}</p></>}
        {!record.shared ? <p>{t('privacy.noShared')}</p> : !changed && !unlisted ?
          <button type="button" onClick={compare}>{t('privacy.compare', { name: record.name })}</button> : null}
      </li>;
    })}</ul>
  </section>;
}
