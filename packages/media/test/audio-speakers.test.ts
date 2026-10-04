import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { SpeakerPolicy } from '../src/audio/speakers';

class FakePub {
  subscribed = true;
  setSubscribed(v: boolean) {
    this.subscribed = v;
  }
}
class FakeParticipant {
  readonly mic = new FakePub();
  constructor(readonly identity: string) {}
  getTrackPublication(source: Track.Source) {
    return source === Track.Source.Microphone ? this.mic : undefined;
  }
}

function room(n: number): { room: Room & EventEmitter; people: FakeParticipant[] } {
  const people = Array.from({ length: n }, (_, i) => new FakeParticipant(`p${i}`));
  const r = new EventEmitter() as EventEmitter & { remoteParticipants: Map<string, FakeParticipant> };
  r.remoteParticipants = new Map(people.map((p) => [p.identity, p]));
  return { room: r as unknown as Room & EventEmitter, people };
}

const subscribed = (people: FakeParticipant[]) => people.filter((p) => p.mic.subscribed).map((p) => p.identity);

describe('the top-6 speaker policy (ruling DEV-04 a)', () => {
  it('with six or fewer remote participants everyone stays subscribed', () => {
    const { room: r, people } = room(6);
    const policy = new SpeakerPolicy(r, { now: () => 0 });
    r.emit(RoomEvent.ActiveSpeakersChanged, [people[5]]);
    expect(subscribed(people)).toHaveLength(6);
    policy.dispose();
  });

  it('starts with the first six by join order and unsubscribes the rest', () => {
    const { room: r, people } = room(9);
    const policy = new SpeakerPolicy(r, { now: () => 0 });
    expect(subscribed(people)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    policy.dispose();
  });

  it('a seventh speaker displaces the quietest only after holdMs', () => {
    let now = 0;
    const { room: r, people } = room(9);
    const policy = new SpeakerPolicy(r, { holdMs: 2_000, now: () => now });
    const top = (...ids: number[]) => r.emit(RoomEvent.ActiveSpeakersChanged, ids.map((i) => people[i]));

    top(0, 1, 2, 3, 4, 7); // p7 is loud, p5 silent
    expect(people[7].mic.subscribed).toBe(false);
    now = 1_000;
    top(0, 1, 2, 3, 4, 7);
    expect(people[7].mic.subscribed).toBe(false); // inside the hold
    now = 2_100;
    top(0, 1, 2, 3, 4, 7);
    expect(people[7].mic.subscribed).toBe(true);
    expect(people[5].mic.subscribed).toBe(false); // the one that was out of the top longest
    expect(subscribed(people)).toHaveLength(6);
    policy.dispose();
  });

  it('a speaker who drops out of the top before the hold ends displaces nobody', () => {
    let now = 0;
    const { room: r, people } = room(9);
    const policy = new SpeakerPolicy(r, { holdMs: 2_000, now: () => now });
    r.emit(RoomEvent.ActiveSpeakersChanged, [people[8]]);
    now = 1_500;
    r.emit(RoomEvent.ActiveSpeakersChanged, [people[0]]);
    now = 4_000;
    r.emit(RoomEvent.ActiveSpeakersChanged, [people[0]]);
    expect(people[8].mic.subscribed).toBe(false);
    expect(subscribed(people)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    policy.dispose();
  });

  it('dispose stops reacting', () => {
    let now = 0;
    const { room: r, people } = room(8);
    const policy = new SpeakerPolicy(r, { holdMs: 0, now: () => now });
    policy.dispose();
    now = 10_000;
    r.emit(RoomEvent.ActiveSpeakersChanged, [people[7]]);
    expect(people[7].mic.subscribed).toBe(false);
  });
});
