import { TabHandover } from '@dilla/ui';
import { t } from '../strings/index.ts';

export function OtherTab({ onUse, onRetry = onUse, phase = 'other-tab' }: {
  onUse: () => void; onRetry?: () => void; phase?: 'other-tab' | 'waiting' | 'failed' | 'paused';
}): React.JSX.Element {
  return <div data-doc-state="tabs-handover" tabIndex={-1} className="dw-other-tab"><TabHandover phase={phase}
    labels={{ use: t('tabs.use'), wait: t('tabs.wait'), failed: t('tabs.failed'), paused: t('tabs.paused') }}
    onUse={onUse} onRetry={onRetry} />{phase === 'other-tab' && <span className="d-sr-only">{t('boot.otherTab.status')}</span>}</div>;
}
