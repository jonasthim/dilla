// The unknown-KID hold (protocol/05 Rotation, DEV-19): one strict FIFO per receiving track, audio and video
// alike. Once the head is pending, later frames queue behind it, because a WebRTC encoded-transform sink drops
// any frame whose counter is not above the last one written (W3C ED §2.1.1): frames may be delayed, never reordered.
// Values from SP-02 (task 15, measured): holds of 500–2000 ms released in order caused 0 receiver PLIs and 0 key
// frames, with the longest decode gap 3–12 ms above the hold; 2000 ms was the largest hold tested.

export const HOLD_MAX_AGE_MS = 2_000;
export const HOLD_MAX_FRAMES = 256;

export class PendingQueue<T> {
  private readonly items: Array<{ at: number; item: T }> = [];

  constructor(
    readonly maxAgeMs: number = HOLD_MAX_AGE_MS,
    readonly maxFrames: number = HOLD_MAX_FRAMES,
  ) {}

  get length(): number {
    return this.items.length;
  }

  /** Appends `item`; when the queue was full, removes and returns the head so the caller can count the drop. */
  push(now: number, item: T): T | undefined {
    this.items.push({ at: now, item });
    return this.items.length > this.maxFrames ? this.items.shift()?.item : undefined;
  }

  peek(): T | undefined {
    return this.items[0]?.item;
  }

  shift(): T | undefined {
    return this.items.shift()?.item;
  }

  headExpired(now: number): boolean {
    const head = this.items[0];
    return head !== undefined && now - head.at > this.maxAgeMs;
  }

  clear(): T[] {
    return this.items.splice(0).map((e) => e.item);
  }
}
