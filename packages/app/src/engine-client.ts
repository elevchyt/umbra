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
import type { DocSummary, EngineStats, FromEngine, ToEngine, GpuCaps } from '@umbra/engine';

export interface EngineClientEvents {
  onReady?: (caps: GpuCaps) => void;
  onStats?: (stats: EngineStats) => void;
  onDoc?: (doc: DocSummary) => void;
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
  private panning = false;
  private lastPan = { x: 0, y: 0 };

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

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (this.paintMode && e.button === 0) {
        this.send({ t: 'strokeBegin', size: this.brushSize, hardness: this.brushHardness, color: this.brushColor });
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
      if (this.paintMode && e.buttons & 1) {
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
      if (this.paintMode && this.ready) write(e, FLAG_UP);
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

  brushSize = 60;
  brushHardness = 0.6;
  brushColor: [number, number, number, number] = [0.1, 0.45, 0.95, 1];

  resize(width: number, height: number): void {
    this.send({ t: 'resize', width, height, dpr: devicePixelRatio });
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.worker.terminate();
  }
}
