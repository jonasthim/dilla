import { useEffect } from 'react';
import type { DiagnosticsState } from '@dilla/client-core';
import { DiagnosticsPanel } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { t } from '../../strings/index.ts';

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Device-local diagnostics: stable codes only (L-TS-43); Copy writes those codes, one per line, and nothing else. The
 * instance shows by its name (W-05); its hex id stays the BroadcastChannel's.
 */
export function Diagnostics({ data, instanceName, writeText }: {
  data: DiagnosticsState; instanceName: string | null; writeText: (text: string) => Promise<void>;
}): React.JSX.Element {
  const client = useCore();
  // The device list, once per mount, for the devices fact; a refusal leaves the count as it was.
  useEffect(() => {
    client.call({ m: 'refreshDevices' }).catch(() => undefined);
  }, [client]);
  return <section className="dw-settings-section" data-doc-state="settings-diagnostics"><DiagnosticsPanel
    data={{ ...data, instance: instanceName ?? t('shell.status.unknown') }}
    labels={{ title: t('diagnostics.title'), copy: t('diagnostics.copy'), empty: t('diagnostics.empty'), fields: {
      connection: t('diagnostics.connection'), generation: t('diagnostics.generation'), instance: t('diagnostics.instance'),
      devices: t('diagnostics.devices'),
    } }} formatTime={at => clock.format(new Date(at))}
    onCopy={() => { writeText(data.errors.slice(-20).map(error => error.code).join('\n')).catch(() => undefined); }} /></section>;
}
