/** Bounded by sample count on the audio thread, independent of main-thread timer throttling. */
export class SampleRecording {
  private samples: Float32Array | null = new Float32Array(480_000);
  private length = 0;
  append(input: Float32Array): boolean {
    if (!this.samples) return false;
    const count = Math.min(input.length, this.samples.length - this.length);
    this.samples.set(input.subarray(0, count), this.length); this.length += count;
    return this.length < this.samples.length;
  }
  finish(): Float32Array {
    const out = this.samples?.slice(0, this.length) ?? new Float32Array(0);
    this.discard(); return out;
  }
  discard(): void { this.samples?.fill(0); this.samples = null; this.length = 0; }
}
export function recordingWav(pcm: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2), view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => [...value].forEach((x, i) => { bytes[at + i] = x.charCodeAt(0); });
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true));
  return bytes;
}
