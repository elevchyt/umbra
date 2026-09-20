/**
 * Lock-free pointer-sample ring buffer in a SharedArrayBuffer.
 *
 * The UI thread writes every coalesced pointer sample the moment it arrives; the engine
 * worker drains the ring once per frame. Nothing in the path can block on the UI thread's
 * event loop, which is what keeps brush latency inside one frame (spec 03 §2, M0 spike 1).
 *
 * Samples are Float64 so the timestamp can hold an absolute Unix epoch value
 * (`timeOrigin + now()`) exactly. That matters because a worker has its own `timeOrigin`:
 * a relative timestamp written by the UI thread would be misread by the worker, so latency
 * has to be measured on a clock both sides agree on.
 */

/** x, y, pressure, tiltX, tiltY, twist, timeAbs, flags */
export const SAMPLE_FLOATS = 8;
const HEADER_I32 = 16;
const HEADER_BYTES = HEADER_I32 * 4;

const IDX_WRITE = 0;
const IDX_READ = 1;
const IDX_DROPPED = 2;

export const FLAG_DOWN = 1;
export const FLAG_UP = 2;
export const FLAG_COALESCED = 4;

export interface PointerSample {
  /** CSS pixels relative to the canvas element. */
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  /** Unix epoch ms, comparable across threads. */
  timeAbs: number;
  flags: number;
}

export function nowAbs(): number {
  return performance.timeOrigin + performance.now();
}

export function createRingBuffer(capacity = 4096): SharedArrayBuffer {
  if ((capacity & (capacity - 1)) !== 0) throw new Error('ring capacity must be a power of two');
  return new SharedArrayBuffer(HEADER_BYTES + capacity * SAMPLE_FLOATS * 8);
}

export class PointerRing {
  private readonly header: Int32Array;
  private readonly data: Float64Array;
  readonly capacity: number;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_I32);
    this.data = new Float64Array(sab, HEADER_BYTES);
    this.capacity = this.data.length / SAMPLE_FLOATS;
  }

  /** Writer side (UI thread). Drops the oldest sample when full rather than stalling. */
  push(s: PointerSample): void {
    const w = Atomics.load(this.header, IDX_WRITE);
    const r = Atomics.load(this.header, IDX_READ);
    if (w - r >= this.capacity) {
      Atomics.store(this.header, IDX_READ, r + 1);
      Atomics.add(this.header, IDX_DROPPED, 1);
    }
    const o = (w & (this.capacity - 1)) * SAMPLE_FLOATS;
    const d = this.data;
    d[o] = s.x;
    d[o + 1] = s.y;
    d[o + 2] = s.pressure;
    d[o + 3] = s.tiltX;
    d[o + 4] = s.tiltY;
    d[o + 5] = s.twist;
    d[o + 6] = s.timeAbs;
    d[o + 7] = s.flags;
    // Publish the slot only after its payload is fully written.
    Atomics.store(this.header, IDX_WRITE, w + 1);
    Atomics.notify(this.header, IDX_WRITE);
  }

  /** Reader side (engine worker). Returns samples in order and advances the read cursor. */
  drain(out: PointerSample[] = []): PointerSample[] {
    out.length = 0;
    const w = Atomics.load(this.header, IDX_WRITE);
    let r = Atomics.load(this.header, IDX_READ);
    const d = this.data;
    while (r < w) {
      const o = (r & (this.capacity - 1)) * SAMPLE_FLOATS;
      out.push({
        x: d[o]!,
        y: d[o + 1]!,
        pressure: d[o + 2]!,
        tiltX: d[o + 3]!,
        tiltY: d[o + 4]!,
        twist: d[o + 5]!,
        timeAbs: d[o + 6]!,
        flags: d[o + 7]!,
      });
      r++;
    }
    Atomics.store(this.header, IDX_READ, r);
    return out;
  }

  get pending(): number {
    return Atomics.load(this.header, IDX_WRITE) - Atomics.load(this.header, IDX_READ);
  }

  get dropped(): number {
    return Atomics.load(this.header, IDX_DROPPED);
  }
}
