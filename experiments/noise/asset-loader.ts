import lock from './asset-lock.json';
export async function load(path: string): Promise<ArrayBuffer> {
  const url = new URL(`/assets/${path}`, self.location.origin);
  if (url.origin !== self.location.origin) throw Error('Cross-origin model refused');
  const response = await fetch(url, {credentials:'same-origin',redirect:'error'});
  if (!response.ok) throw Error(`Local asset failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if (hash !== (lock.sha256 as Record<string,string>)[path]) throw Error(`Asset integrity mismatch: ${path}, got ${hash}, size ${bytes.byteLength}, type ${response.headers.get('content-type')}`);
  return bytes;
}
