/**
 * UI-thread half of the engine protocol: owns the worker, the pointer ring writer and the
 * rAF tick loop.
 *
 * Workers have no requestAnimationFrame, so the UI thread drives frames. Pointer samples do
 * NOT travel as messages — they go straight into the shared ring, so a burst of tablet
 * samples never queues up behind anything (spec 03 §2).
 */
import {
  createRingBuffer,
  PointerRing,
  FLAG_DOWN,
  FLAG_UP,
  FLAG_COALESCED,
  nowAbs,
} from '@umbra/engine/input/ring';
import { DEFAULT_BRUSH, type BrushParams, type DocSummary, type EngineStats, type FromEngine, type ToEngine, type GpuCaps } from '@umbra/engine';

export interface EngineClientEvents {
  onReady?: (caps: GpuCaps) => void;
  onStats?: (stats: EngineStats) => void;
  onDoc?: (doc: DocSummary) => void;
  onSampled?: (color: [number, number, number], toBackground: boolean) => void;
  onSpikes?: (pass: boolean, text: string) => void;
  onPsdSaved?: (name: string, buffer: ArrayBuffer) => void;
  onParity?: (pass: boolean, text: string) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onError?: (message: string) => void;
}

export class EngineClient {
  private readonly worker: Worker;
  private readonly ring: PointerRing;
  private readonly sab: SharedArrayBuffer;
  private rafHandle = 0;
  ready = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly events: EngineClientEvents,
  ) {
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error(
        'SharedArrayBuffer unavailable — the page is not cross-origin isolated. ' +
          'Check the COOP/COEP headers served by the app:// protocol.',
      );
    }
    this.sab = createRingBuffer(4096);
    this.ring = new PointerRing(this.sab);

    this.worker = new Worker(new URL('../../engine/src/worker.ts', import.meta.url), {
      type: 'module',
      name: 'umbra-engine',
    });
    this.worker.onmessage = (ev: MessageEvent<FromEngine>) => this.handle(ev.data);
    this.worker.onerror = (e) => this.events.onError?.(`worker error: ${e.message}`);

    const offscreen = canvas.transferControlToOffscreen();
    const rect = canvas.getBoundingClientRect();
    this.send(
      {
        t: 'init',
        canvas: offscreen,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        dpr: devicePixelRatio,
        ring: this.sab,
      },
      [offscreen],
    );

    this.attachPointer(canvas);
    this.loop();
  }

  private handle(msg: FromEngine): void {
    switch (msg.t) {
      case 'ready':
        this.ready = true;
        this.events.onReady?.(msg.caps);
        break;
      case 'stats':
        this.events.onStats?.(msg.stats);
        break;
      case 'doc':
        this.events.onDoc?.(msg.doc);
        break;
      case 'sampled':
        this.events.onSampled?.(msg.color, msg.toBackground);
        break;
      case 'spikes':
        this.events.onSpikes?.(msg.pass, msg.text);
        break;
      case 'parity':
        this.events.onParity?.(msg.pass, msg.text);
        break;
      case 'psdSaved':
        this.events.onPsdSaved?.(msg.name, msg.buffer);
        break;
      case 'contextLost':
        this.events.onContextLost?.();
        break;
      case 'contextRestored':
        this.events.onContextRestored?.();
        break;
      case 'error':
        this.events.onError?.(msg.message);
        break;
    }
  }

  send(msg: ToEngine, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  private loop = (): void => {
    this.send({ t: 'tick' });
    this.rafHandle = requestAnimationFrame(this.loop);
  };

  // ---- pointer ----------------------------------------------------------------------

  /** Set by the UI when a paint tool is active; otherwise drags pan the view. */
  paintMode = false;
  /** Active selection tool id, or null when the pointer is not making a selection. */
  selectTool: string | null = null;
  /** Set while the Eyedropper is active; the number is the sample square's edge in doc px. */
  sampleSize: number | null = null;
  /** Combine mode chosen in the options bar; modifier keys override it for one gesture. */
  selectOp = 'new';
  private selecting = false;
  /**
   * A polygonal lasso is click-to-click, not press-drag: the gesture outlives the button, so
   * it is tracked separately and only ends on a double-click, Enter, or a click on the start.
   */
  private polygon = false;
  /** True while the Eyedropper button is held, so dragging keeps sampling. */
  private sampling = false;

  /** True while a marquee/lasso gesture is in flight, so Escape can cancel it. */
  get isSelecting(): boolean {
    return this.selecting || this.polygon;
  }
  private panning = false;
  private lastPan = { x: 0, y: 0 };

  /** Commit the in-flight gesture (double-click or Enter on a polygonal lasso). */
  finishSelect(x?: number, y?: number): void {
    if (!this.selecting && !this.polygon) return;
    this.send({ t: 'endSelect', x, y });
    this.selecting = false;
    this.polygon = false;
  }

  /** Discard the in-flight gesture, restoring the selection that preceded it. */
  cancelSelect(): void {
    if (!this.selecting && !this.polygon) return;
    this.send({ t: 'cancelSelect' });
    this.selecting = false;
    this.polygon = false;
  }

  private attachPointer(canvas: HTMLCanvasElement): void {
    const toLocal = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const write = (e: PointerEvent, flags: number, coalesced = false) => {
      const p = toLocal(e);
      this.ring.push({
        x: p.x,
        y: p.y,
        // Mice report 0.5 while down; tablets report a real value.
        pressure: e.pressure > 0 ? e.pressure : 0.5,
        tiltX: e.tiltX ?? 0,
        tiltY: e.tiltY ?? 0,
        twist: e.twist ?? 0,
        timeAbs: nowAbs(),
        flags: flags | (coalesced ? FLAG_COALESCED : 0),
      });
    };

    /**
     * Shift adds, Alt subtracts, both intersect — the same everywhere in Photoshop. With no
     * modifier held the options bar's mode applies.
     */
    const opFor = (e: PointerEvent): string =>
      e.shiftKey && e.altKey
        ? 'intersect'
        : e.shiftKey
          ? 'add'
          : e.altKey
            ? 'subtract'
            : this.selectOp;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (this.sampleSize !== null && e.button === 0) {
        const p = toLocal(e);
        // Alt-click sets the background colour, as everywhere in Photoshop.
        this.send({ t: 'sample', x: p.x, y: p.y, size: this.sampleSize, toBackground: e.altKey });
        this.sampling = true;
        return;
      }
      if (this.selectTool && e.button === 0) {
        const p = toLocal(e);
        if (this.selectTool === 'magicWand') {
          this.send({ t: 'magicWand', x: p.x, y: p.y, op: opFor(e) });
        } else if (this.selectTool === 'lassoPolygon') {
          if (!this.polygon) {
            this.polygon = true;
            this.send({ t: 'beginSelect', tool: this.selectTool, x: p.x, y: p.y, op: opFor(e) });
          } else {
            this.send({ t: 'addSelectPoint', x: p.x, y: p.y });
          }
          // A double-click closes the polygon, as it does in Photoshop.
          if (e.detail >= 2) this.finishSelect(p.x, p.y);
        } else {
          this.selecting = true;
          this.send({ t: 'beginSelect', tool: this.selectTool, x: p.x, y: p.y, op: opFor(e) });
        }
        return;
      }
      if (this.paintMode && e.button === 0) {
        this.send({ t: 'strokeBegin', brush: this.brush, color: this.brushColor, mode: this.paintBlendMode });
        write(e, FLAG_DOWN);
      } else {
        this.panning = true;
        const p = toLocal(e);
        this.lastPan = p;
      }
    });

    // pointerrawupdate delivers samples at full tablet rate, ahead of pointermove.
    const moveEvent = 'onpointerrawupdate' in canvas ? 'pointerrawupdate' : 'pointermove';
    canvas.addEventListener(moveEvent, ((e: PointerEvent) => {
      if (this.sampling && this.sampleSize !== null) {
        const p = toLocal(e);
        this.send({ t: 'sample', x: p.x, y: p.y, size: this.sampleSize, toBackground: e.altKey });
        return;
      }
      if (this.selecting || this.polygon) {
        // For a polygon this only previews the segment that follows the cursor.
        const p = toLocal(e);
        this.send({ t: 'updateSelect', x: p.x, y: p.y });
      } else if (this.paintMode && e.buttons & 1) {
        // Every coalesced sample matters for stroke fidelity, not just the latest one.
        const batch = e.getCoalescedEvents?.() ?? [];
        if (batch.length > 1) for (const c of batch) write(c, 0, true);
        else write(e, 0);
      } else if (this.panning) {
        const p = toLocal(e);
        this.send({ t: 'pan', dx: p.x - this.lastPan.x, dy: p.y - this.lastPan.y });
        this.lastPan = p;
      }
    }) as EventListener);

    const up = (e: PointerEvent) => {
      // The FLAG_UP sample terminates the stroke. Sending a separate `strokeEnd` MESSAGE would
      // race the ring: messages are delivered immediately, but ring samples are only drained on
      // the next tick, so the stroke would end before its own samples had been consumed and the
      // tail of the stroke would be silently dropped.
      if (this.selecting) {
        const p = toLocal(e);
        this.send({ t: 'endSelect', x: p.x, y: p.y });
        this.selecting = false;
      }
      // A polygon gesture deliberately survives the button release.
      if (this.paintMode && this.ready) write(e, FLAG_UP);
      this.sampling = false;
      this.panning = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        if (e.ctrlKey || e.altKey) {
          this.send({ t: 'zoomAt', factor: Math.exp(-e.deltaY * 0.002), x, y });
        } else if (e.shiftKey) {
          this.send({ t: 'pan', dx: -e.deltaY, dy: 0 });
        } else {
          this.send({ t: 'pan', dx: -e.deltaX, dy: -e.deltaY });
        }
      },
      { passive: false },
    );
  }

  brushColor: [number, number, number] = [0, 0, 0];
  brush: BrushParams = { ...DEFAULT_BRUSH };
  /** Paint blend mode, which unlike a layer's may also be 'behind' or 'clear'. */
  paintBlendMode = 'normal';

  resize(width: number, height: number): void {
    this.send({ t: 'resize', width, height, dpr: devicePixelRatio });
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.worker.terminate();
  }
}
