export interface NoiseAsset { url: string; sha256: string }
export interface NoiseAssets { glue: NoiseAsset; wasm: NoiseAsset; model: NoiseAsset; detector: NoiseAsset }
export async function verifiedAsset(asset: NoiseAsset): Promise<ArrayBuffer> {
  const url = new URL(asset.url, self.location.origin);
  if (url.origin !== self.location.origin || !/^https?:$/.test(url.protocol)) throw Error('Cross-origin suppression asset refused');
  const response = await fetch(url, {credentials:'same-origin',redirect:'error'});
  if (!response.ok) throw Error(`Suppression asset failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if (hash !== asset.sha256) throw Error('Suppression asset integrity mismatch');
  return bytes;
}
