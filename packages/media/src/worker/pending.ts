// The unknown-KID hold (protocol/05 Rotation, DEV-19): one strict FIFO per receiving track, audio and video
// alike. Once the head is pending, later frames queue behind it, because a WebRTC encoded-transform sink drops
// any frame whose counter is not above the last one written (W3C ED §2.1.1): frames may be delayed, never reordered.
// Values from SP-02 (task 15, measured): holds of 500–2000 ms released in order caused 0 receiver PLIs and 0 key
// frames, with the longest decode gap 3–12 ms above the hold; 2000 ms was the largest hold tested.
// HOLD_MAX_BYTES (task 17 review M7): a peer or the SFU flooding large unknown-KID frames could otherwise hold up to
// 256 frames of any size per track; 8 MiB is about 2 s of a 30 Mbit/s screen share, far above any dilla preset.

export const HOLD_MAX_AGE_MS = 2_000;
export const HOLD_MAX_FRAMES = 256;
export const HOLD_MAX_BYTES = 8 * 1024 * 1024;

export class PendingQueue<T> {
  private readonly items: Array<{ at: number; item: T; bytes: number }> = [];
  private held = 0;

  constructor(
    readonly maxAgeMs: number = HOLD_MAX_AGE_MS,
    readonly maxFrames: number = HOLD_MAX_FRAMES,
    readonly maxBytes: number = HOLD_MAX_BYTES,
  ) {}

  get length(): number {
    return this.items.length;
  }

  /** The bytes held now. */
  get bytes(): number {
    return this.held;
  }

  /**
   * Appends `item` of `bytes` bytes; while the queue is over its frame or byte bound, removes heads (oldest first,
   * possibly `item` itself) and returns them so the caller can count each drop.
   */
  push(now: number, item: T, bytes = 0): T[] {
    this.items.push({ at: now, item, bytes });
    this.held += bytes;
    const evicted: T[] = [];
    while (this.items.length > 0 && (this.items.length > this.maxFrames || this.held > this.maxBytes)) {
      const head = this.shift();
      if (head !== undefined) evicted.push(head);
    }
    return evicted;
  }

  peek(): T | undefined {
    return this.items[0]?.item;
  }

  shift(): T | undefined {
    const head = this.items.shift();
    if (head === undefined) return undefined;
    this.held -= head.bytes;
    return head.item;
  }

  headExpired(now: number): boolean {
    const head = this.items[0];
    return head !== undefined && now - head.at > this.maxAgeMs;
  }

  clear(): T[] {
    this.held = 0;
    return this.items.splice(0).map((e) => e.item);
  }
}
