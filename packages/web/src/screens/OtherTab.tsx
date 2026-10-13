import { TabHandover } from '@dilla/ui';
import { t } from '../strings/index.ts';

/**
 * The tab hand-over view (L-WEB-46): the waiting tab's "Use this tab", or the old leader's paused state. `overlay`
 * covers a shell that is still leaving, so focus moves here before the composer is removed.
 */
export function OtherTab({ onUse, onRetry = onUse, phase = 'other-tab', overlay = false }: {
  onUse: () => void; onRetry?: () => void; phase?: 'other-tab' | 'waiting' | 'failed' | 'paused'; overlay?: boolean;
}): React.JSX.Element {
  return <div data-doc-state="tabs-handover" tabIndex={-1} className={overlay ? 'dw-other-tab dw-other-tab--overlay' : 'dw-other-tab'}><TabHandover phase={phase}
    labels={{ otherTab: t('boot.otherTab.status'), use: t('tabs.use'), wait: t('tabs.wait'), failed: t('tabs.failed'), paused: t('tabs.paused') }}
    onUse={onUse} onRetry={onRetry} /></div>;
}
