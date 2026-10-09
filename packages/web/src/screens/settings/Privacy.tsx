import type { TrustSummary } from '@dilla/client-core';
import { TrustAlert } from '@dilla/ui';
import { t } from '../../strings/index.ts';

export function Privacy({ records, onCompare }: { records: readonly TrustSummary[]; onCompare: (record: TrustSummary) => void }): React.JSX.Element {
  return <section className="dw-settings-section" data-doc-state="trust-privacy" aria-labelledby="privacy-title">
    <h2 id="privacy-title" tabIndex={-1} data-privacy-heading>{t('privacy.section')}</h2>
    <ul className="dw-trust-list">{records.map(record => {
      const compare = () => onCompare(record);
      return <li key={record.userId} data-doc-state={record.changedUmk !== null ? 'trust-changed' : undefined}>
        {record.changedUmk !== null && record.shared ? <TrustAlert kind="changed" name={record.name}
          labels={{ changed: t('privacy.changed'), unlisted: t('privacy.unlisted'), verify: t('privacy.compare', { name: record.name }) }} onVerify={compare} />
          : record.changedUmk !== null ? <p role="alert">{record.name} {t('privacy.changed')}</p>
          : <strong>{record.name}</strong>}
        {record.changedUmk === null && !record.verified && <><p>{t('privacy.firstSeenLabel')}</p><p>{t('privacy.firstSeen', { name: record.name })}</p></>}
        {!record.shared ? <p>{t('privacy.noShared')}</p> : record.changedUmk === null ?
          <button type="button" onClick={compare}>{t('privacy.compare', { name: record.name })}</button> : null}
      </li>;
    })}</ul>
  </section>;
}
