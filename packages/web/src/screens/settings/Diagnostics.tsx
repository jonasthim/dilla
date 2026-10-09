import type { DiagnosticsState } from '@dilla/client-core';
import { DiagnosticsPanel } from '@dilla/ui';
import { t } from '../../strings/index.ts';

export function Diagnostics({ data, writeText }: { data: DiagnosticsState; writeText: (text: string) => Promise<void> }): React.JSX.Element {
  return <section className="dw-settings-section" data-doc-state="settings-diagnostics"><DiagnosticsPanel
    data={data} labels={{ title: t('diagnostics.title'), copy: t('diagnostics.copy'), fields: {
      connection: t('diagnostics.connection'), generation: t('diagnostics.generation'), instance: t('diagnostics.instance'),
      devices: t('diagnostics.devices', { n: data.devices }),
    } }} onCopy={() => { void writeText(data.errors.slice(-20).map(error => error.code).join('\n')); }} /></section>;
}
