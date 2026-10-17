import { it, expect } from 'vitest';
import { SampleRecording } from '../src/audio/sample-recording';
it('caps the local recording at exactly ten seconds even when a timer would be throttled', () => {
  const r=new SampleRecording();
  for(let i=0;i<4000;i++)r.append(new Float32Array(128).fill(0.5));
  const pcm=r.finish();expect(pcm.length).toBe(480000);expect(pcm[479999]).toBe(0.5);
  expect(r.finish()).toHaveLength(0);
});
it('discard releases all audio and ignores late capture', () => {
  const r=new SampleRecording();r.append(new Float32Array([0.5]));r.discard();r.append(new Float32Array([0.9]));expect(r.finish()).toHaveLength(0);
});
