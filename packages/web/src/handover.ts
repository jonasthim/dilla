/** The page's content-free request to move worker ownership to this tab. */
export async function requestHandover(
  instanceHex: string,
  channelFactory: (name: string) => Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'>,
  startFollower: () => Promise<void>,
  nonceBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(instanceHex)) throw new Error('Invalid instance');
  const bytes = nonceBytes();
  if (bytes.length !== 16) throw new Error('Invalid nonce');
  const nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const channel = channelFactory(`dilla-core:${instanceHex}`);
  try {
    await new Promise<void>(resolve => {
      const onMessage: EventListener = event => {
        const value: unknown = (event as MessageEvent).data;
        if (typeof value !== 'object' || value === null) return;
        const row = value as Record<string, unknown>;
        const keys = Object.keys(row);
        if (keys.length !== 3 || !keys.includes('t') || !keys.includes('instance') || !keys.includes('nonce')) return;
        if (row.t !== 'released' || row.instance !== instanceHex || row.nonce !== nonce) return;
        channel.removeEventListener('message', onMessage);
        resolve();
      };
      channel.addEventListener('message', onMessage);
      channel.postMessage({ t: 'takeover', instance: instanceHex, nonce });
    });
    await startFollower();
  } finally {
    channel.close();
  }
}
