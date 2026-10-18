// The call sounds of the shell (flow 06 § Sounds, L-WEB-52): join and leave ticks for other people's devices in the call
// this device is in, and the ring while an incoming ring may sound. sounds.ts only plays; every rule of when is here.
import { useContext, useEffect, useRef } from 'react';
import type { Ring, VoiceCall } from '@dilla/client-core';
import { isMuted, SETTINGS } from '@dilla/client-core';
import type { Sounds } from '../../call/sounds.ts';
import { VoiceDepsContext } from './useCall.tsx';

export interface UseSoundsOptions {
  presenceChoice?: string;
  rings: readonly Ring[] | undefined;
  /** The voice slice's entry of the call this device is in, and that call's channel (null outside a call). */
  room: VoiceCall | undefined;
  inCall: string | null;
  deafened: boolean;
  settings: Readonly<Record<string, string>>;
  selfId: string | null;
  /** The server a ring's channel belongs to, for that server's mute (WA5); unset for DMs. */
  ringCommunity?: (channelId: string) => string | undefined;
}

/** True while a ring exists that may sound: not busy, not quiet, and its channel and server are not muted. */
export function ringAudible(rings: readonly Ring[] | undefined, settings: Readonly<Record<string, string>>,
  communityOf?: (channelId: string) => string | undefined): boolean {
  return (rings ?? []).some(r => !r.busy && !r.quiet && !isMuted(settings, r.channelId, communityOf?.(r.channelId)));
}

/** The browser's autoplay rule: no sound before the person interacted with the page (L-WEB-52). */
function activated(): boolean {
  const n = navigator as { userActivation?: { hasBeenActive: boolean } };
  return n.userActivation?.hasBeenActive === true;
}

/**
 * Join and leave: only for another user's device entering or leaving the call this device is in (never the own user's
 * devices, R2), never while deafened, never with `sound.voice` off, never before user activation. The people already in
 * the call when this device joined make no sound. The ring: while a ring that is neither busy nor quiet exists, outside a
 * call, with `sound.ring` on and after user activation; it stops when the last such ring ends.
 */
export function useSounds(o: UseSoundsOptions): void {
  const deps = useContext(VoiceDepsContext);
  const sounds = useRef<Sounds | null>(null);
  const get = (): Sounds => {
    sounds.current ??= deps.createSounds();
    return sounds.current;
  };
  useEffect(() => () => { sounds.current?.dispose(); sounds.current = null; }, []);

  // The ring.
  const ringing = useRef(false);
  // The DM mute is re-read here: muting a DM while it rings stops the sound at once (review m3).
  const wantRing = o.presenceChoice !== 'dnd' && o.inCall === null && ringAudible(o.rings, o.settings, o.ringCommunity)
    && o.settings[SETTINGS.soundRing] !== 'off' && activated();
  useEffect(() => {
    if (wantRing === ringing.current) return;
    ringing.current = wantRing;
    if (wantRing) get().startRing(); else get().stopRing();
  });

  // Join and leave, by diffing the devices of the call this device is in.
  // The baseline is the first snapshot of the room this device is in (review m1): a room that arrives after the join
  // (an answered ring, before the DM's loadVoice) holds the people already there, not people joining.
  const known = useRef<{ call: string | null; devices: Map<string, string> | null }>({ call: null, devices: null });
  const { room, inCall, deafened, selfId } = o;
  const voiceOn = o.settings[SETTINGS.soundVoice] !== 'off';
  useEffect(() => {
    const devices = room === undefined ? null : new Map(room.participants.map(p => [p.deviceId, p.userId]));
    const before = known.current;
    const same = before.call === inCall;
    known.current = { call: inCall, devices: devices ?? (same ? before.devices : null) };
    if (inCall === null || !same || before.devices === null || devices === null) return;
    const others = (from: Map<string, string>, to: Map<string, string>) =>
      [...to].some(([device, user]) => !from.has(device) && user !== selfId);
    const joined = others(before.devices, devices);
    const left = others(devices, before.devices);
    if ((!joined && !left) || deafened || !voiceOn || !activated()) return;
    if (joined) get().play('join');
    if (left) get().play('leave');
  }, [room, inCall, deafened, selfId, voiceOn]); // eslint-disable-line react-hooks/exhaustive-deps
}
