// Capture for a call (flow 06 § States): the microphone, with listen-only outcomes instead of errors, the camera and
// the screen (Chromium tab audio only, decision 10). Nothing here publishes; the session does.
import { MIC_CAPTURE, SCREEN_AUDIO_CAPTURE } from '@dilla/media';

export interface CaptureMedia {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}
export interface DisplayMedia {
  getDisplayMedia(options: DisplayMediaStreamOptions): Promise<MediaStream>;
}

export type MicResult = { track: MediaStreamTrack } | { mic: 'denied' | 'missing' };

const stopAll = (s: MediaStream): void => { for (const t of s.getTracks()) t.stop(); };

function micConstraints(input: string): MediaStreamConstraints {
  const capture = { echoCancellation: MIC_CAPTURE.echoCancellation, noiseSuppression: MIC_CAPTURE.noiseSuppression,
    autoGainControl: MIC_CAPTURE.autoGainControl } as MediaTrackConstraints;
  return { audio: input === '' ? capture : { deviceId: { exact: input }, ...capture } };
}

/**
 * The microphone: 'denied' when the person or the browser refused it, 'missing' when there is none (none listed, not
 * found, or unreadable). A chosen input that is gone falls back to the system default once.
 */
export async function acquireMic(media: CaptureMedia, input: string): Promise<MicResult> {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await media.enumerateDevices();
  } catch {
    devices = [];
  }
  if (!devices.some((d) => d.kind === 'audioinput')) return { mic: 'missing' };
  const attempt = async (id: string): Promise<MicResult | 'retry'> => {
    try {
      const stream = await media.getUserMedia(micConstraints(id));
      const track = stream.getAudioTracks()[0];
      if (track === undefined) {
        stopAll(stream);
        return { mic: 'missing' };
      }
      for (const t of stream.getTracks()) if (t !== track) t.stop();
      return { track };
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return { mic: 'denied' };
      if (name === 'OverconstrainedError' && id !== '') return 'retry';
      return { mic: 'missing' };
    }
  };
  const first = await attempt(input);
  if (first !== 'retry') return first;
  const second = await attempt('');
  return second === 'retry' ? { mic: 'missing' } : second;
}

export async function acquireCamera(media: CaptureMedia): Promise<MediaStreamTrack> {
  const stream = await media.getUserMedia({ audio: false, video: true });
  const track = stream.getVideoTracks()[0];
  if (track === undefined) {
    stopAll(stream);
    throw Object.assign(new Error('E_UNAVAILABLE: no camera track'), { name: 'NotFoundError' });
  }
  return track;
}

/** The screen, with the shared tab’s audio where the browser offers it (Chromium only, decision 10). */
export async function acquireScreen(media: DisplayMedia): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }> {
  const stream = await media.getDisplayMedia({ video: true, audio: { ...SCREEN_AUDIO_CAPTURE } });
  const video = stream.getVideoTracks()[0];
  if (video === undefined) {
    stopAll(stream);
    throw Object.assign(new Error('E_UNAVAILABLE: no screen track'), { name: 'NotFoundError' });
  }
  return { video, audio: stream.getAudioTracks()[0] ?? null };
}
