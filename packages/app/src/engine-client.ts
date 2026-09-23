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
  onTransform?: (active: boolean) => void;
  onProbe?: (msg: { tag?: string } & import('@umbra/engine').ProbeReply) => void;
  onFilterBox?: (msg: unknown) => void;
  onLuts?: (msg: { list: { id: string; name: string; size: number }[]; loaded?: string; error?: string }) => void;
  onReplaceColorPreview?: (p: { pixels: Uint8Array; width: number; height: number }) => void;
  onPatterns?: (list: import('@umbra/engine').PatternSummary[]) => void;
  onHistogram?: (h: { source: 'layer' | 'below' | 'composite'; r: Uint32Array; g: Uint32Array; b: Uint32Array; lum: Uint32Array }) => void;
  onThumbnail?: (t: { pixels: Uint8Array; width: number; height: number; docWidth: number; docHeight: number }) => void;
  onRecovery?: (info: { name: string; savedAt: number; width: number; height: number }) => void;
  onNoRecovery?: () => void;
  onSpikes?: (pass: boolean, text: string) => void;
  onPsdSaved?: (name: string, buffer: ArrayBuffer) => void;
  onStyles?: (list: import('@umbra/engine').StylePreset[]) => void;
  onBrushes?: (msg: { groups: import('@umbra/engine').BrushGroup[]; tips: Record<string, import('@umbra/engine').TipBitmap>; defined?: import('@umbra/engine').BrushPreset; note?: string }) => void;
  onFonts?: (list: { family: string; styles: { style: string; postscript: string }[] }[], added?: number) => void;
  onTypeSelection?: (text: string) => void;
  onCustomShapes?: (list: { id: string; name: string; path: import('@umbra/engine').Path }[], error?: string) => void;
  onParity?: (pass: boolean, text: string) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onError?: (message: string) => void;
}

/** Snap a drag to the nearest 45°, for Shift-constrained gradients. */
function snap45(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return to;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
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
        if (msg.pick) this.pickHandler?.(msg.color);
        else this.events.onSampled?.(msg.color, msg.toBackground);
        break;
      case 'transform':
        this.transformActive = msg.active;
        this.events.onTransform?.(msg.active);
        break;
      case 'recovery':
        this.events.onRecovery?.(msg);
        break;
      case 'noRecovery':
        this.events.onNoRecovery?.();
        break;
      case 'thumbnail':
        this.events.onThumbnail?.(msg);
        break;
      case 'probe':
        this.events.onProbe?.(msg);
        break;
      case 'filterBox':
        this.events.onFilterBox?.(msg);
        break;
      case 'luts':
        this.events.onLuts?.(msg);
        break;
      case 'replaceColorPreview':
        this.events.onReplaceColorPreview?.(msg);
        break;
      case 'patterns':
        this.events.onPatterns?.(msg.list);
        break;
      case 'styles':
        this.events.onStyles?.(msg.list);
        break;
      case 'brushes':
        this.events.onBrushes?.(msg);
        break;
      case 'fonts':
        this.events.onFonts?.(msg.list, msg.added);
        break;
      case 'glyphs':
        window.dispatchEvent(new CustomEvent('umbra:glyphs', { detail: msg }));
        break;
      case 'typeSelection':
        this.events.onTypeSelection?.(msg.text);
        break;
      case 'customShapes':
        this.events.onCustomShapes?.(msg.list, msg.error);
        break;
      case 'histogram':
        this.events.onHistogram?.(msg);
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

  /** Readouts are not frame work: they run on their own timer, which a hidden page does not stall. */
  private probeTimer = setInterval(() => {
    const now = performance.now();
    if (this.probing && (this.probeDirty ? now - this.probeAt > 30 : now - this.probeAt > 250)) {
      this.probeDirty = false;
      this.probeAt = now;
      this.send({ t: 'probe', cursor: this.probeCursor, samplers: this.samplers });
    }
  }, 40);

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
  /**
   * Set while a dialog's eyedropper is armed (Levels/Curves black, grey and white points,
   * Replace Color, Curves' on-image tool): a canvas click samples the composite and hands the
   * colour here instead of reaching the active tool.
   */
  pickHandler: ((rgb: [number, number, number]) => void) | null = null;
  /** A dialog is open: the canvas only answers an armed eyedropper, never the active tool. */
  modal = false;
  /**
   * The Info panel is showing, or there are colour samplers: keep the readouts fresh. The
   * pointer's position is sent as it moves, and everything is re-sent a few times a second
   * so edits and dialog previews show up without the pointer moving.
   */
  probing = false;
  samplers: { x: number; y: number }[] = [];
  /** The Color Sampler tool: a click places a sampler, Alt-click removes the nearest. */
  samplerTool = false;
  private probeCursor: { x: number; y: number } | null = null;
  private probeDirty = false;
  private probeAt = 0;
  /** True while the Crop tool is selected. */
  cropTool = false;
  private cropFrom: { x: number; y: number } | null = null;
  /** 'bucket' or 'gradient' when one of the fill tools is active. */
  fillTool: 'bucket' | 'gradient' | null = null;
  /** Filled in by the UI so the worker gets the colours and options the options bar shows. */
  fillRequest: (() => Record<string, unknown>) | null = null;
  private gradientFrom: { x: number; y: number } | null = null;
  /** True while a Free Transform box is open, so the pointer drives handles, not tools. */
  transformActive = false;
  /** True when the Move tool is selected, so a drag transforms rather than pans. */
  moveTool = false;
  /** Set while a vector tool (Pen, anchors, Path/Direct Selection) is active. */
  vectorTool: string | null = null;
  private vectorDown = false;
  /** Set while a type tool is active: presses place or edit type. */
  typeTool = false;
  private typeDown = false;
  private transformDragging = false;
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
      if (this.samplerTool && !this.pickHandler && !this.modal && e.button === 0) {
        this.send({ t: 'probe', cursor: toLocal(e), samplers: this.samplers, tag: e.altKey ? 'removeSampler' : 'placeSampler' });
        return;
      }
      if (this.modal && !this.pickHandler) return;
      if (this.pickHandler && e.button === 0) {
        const p = toLocal(e);
        // Photoshop's adjustment eyedroppers default to a 3×3 average.
        this.send({ t: 'sample', x: p.x, y: p.y, size: 3, toBackground: false, pick: true });
        return;
      }
      // Dragging on the canvas with the Crop tool redraws the rectangle from scratch; the
      // handles on the existing one are the transform box's, handled below.
      if (this.cropTool && e.button === 0) {
        const p = toLocal(e);
        if (!this.transformActive) {
          this.cropFrom = p;
          this.send({ t: 'beginCrop' });
          this.transformActive = true;
          return;
        }
      }
      // A live transform owns the pointer: handles first, then dragging the box body.
      if ((this.transformActive || this.moveTool) && e.button === 0) {
        const p = toLocal(e);
        if (!this.transformActive) {
          // The Move tool opens a transient box on press and commits it on release.
          this.send({ t: 'beginTransform', transient: true });
          this.transformActive = true;
        }
        this.send({ t: 'transformDragBegin', x: p.x, y: p.y, rotate: e.altKey && e.shiftKey });
        this.transformDragging = true;
        return;
      }
      if (this.typeTool && e.button === 0 && !this.transformActive) {
        const p = toLocal(e);
        this.typeDown = true;
        this.send({ t: 'typePointer', phase: 'down', x: p.x, y: p.y, shift: e.shiftKey, clicks: e.detail });
        return;
      }
      if (this.vectorTool && e.button === 0 && !this.transformActive) {
        const p = toLocal(e);
        this.vectorDown = true;
        this.send({ t: 'vectorPointer', phase: 'down', x: p.x, y: p.y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, clicks: e.detail });
        return;
      }
      if (this.fillTool && e.button === 0) {
        const p = toLocal(e);
        if (this.fillTool === 'bucket') {
          this.send({ t: 'bucket', x: p.x, y: p.y, ...(this.fillRequest?.() ?? {}) } as never);
        } else {
          // A gradient is defined by a drag, so nothing is drawn until the button comes up.
          this.gradientFrom = p;
        }
        return;
      }
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
      if (this.dragAction && e.button === 0) {
        const p = toLocal(e);
        this.dragDown = true;
        this.send(this.dragAction('down', p.x, p.y) as never);
        return;
      }
      if (this.clickAction && e.button === 0) {
        const p = toLocal(e);
        this.send(this.clickAction(p.x, p.y) as never);
        return;
      }
      if (this.paintMode && e.button === 0 && this.altSamples && e.altKey) {
        const p = toLocal(e);
        this.send({ t: 'setCloneSource', x: p.x, y: p.y });
        return;
      }
      if (this.paintMode && e.button === 0) {
        this.send({ t: 'strokeBegin', brush: this.brush, color: this.brushColor, bg: this.brushBg, mode: this.paintBlendMode, ...(this.retouch ? { retouch: this.retouch as never } : {}) });
        write(e, FLAG_DOWN);
      } else {
        this.panning = true;
        const p = toLocal(e);
        this.lastPan = p;
      }
    });

    // pointerrawupdate delivers samples at full tablet rate, ahead of pointermove.
    const moveEvent = 'onpointerrawupdate' in canvas ? 'pointerrawupdate' : 'pointermove';
    canvas.addEventListener('pointermove', (e) => {
      this.probeCursor = toLocal(e);
      this.probeDirty = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.probeCursor = null;
      this.probeDirty = true;
    });
    canvas.addEventListener(moveEvent, ((e: PointerEvent) => {
      if (this.cropFrom) {
        const p = toLocal(e);
        this.send({ t: 'setCropRect', x0: this.cropFrom.x, y0: this.cropFrom.y, x1: p.x, y1: p.y });
        return;
      }
      if (this.transformDragging) {
        const p = toLocal(e);
        this.send({
          t: 'transformDragMove',
          x: p.x,
          y: p.y,
          constrain: e.shiftKey,
          fromCentre: e.altKey,
        });
        return;
      }
      if (this.dragDown && this.dragAction) {
        const p = toLocal(e);
        this.send(this.dragAction('move', p.x, p.y) as never);
        return;
      }
      if (this.typeDown) {
        const p = toLocal(e);
        this.send({ t: 'typePointer', phase: 'move', x: p.x, y: p.y, shift: e.shiftKey, clicks: 0 });
        return;
      }
      if (this.vectorTool && !this.transformActive) {
        // Moves go even with the button up: the Pen's rubber band follows the pointer.
        const p = toLocal(e);
        this.send({ t: 'vectorPointer', phase: 'move', x: p.x, y: p.y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, clicks: 0 });
        if (this.vectorDown || !this.panning) return;
      }
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
      if (this.dragDown) {
        this.dragDown = false;
        const p = toLocal(e);
        if (this.dragAction) this.send(this.dragAction('up', p.x, p.y) as never);
      }
      if (this.typeDown) {
        this.typeDown = false;
        const p = toLocal(e);
        this.send({ t: 'typePointer', phase: 'up', x: p.x, y: p.y, shift: e.shiftKey, clicks: e.detail });
      }
      if (this.vectorDown) {
        this.vectorDown = false;
        const p = toLocal(e);
        this.send({ t: 'vectorPointer', phase: 'up', x: p.x, y: p.y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, clicks: e.detail });
      }
      if (this.selecting) {
        const p = toLocal(e);
        this.send({ t: 'endSelect', x: p.x, y: p.y });
        this.selecting = false;
      }
      // A polygon gesture deliberately survives the button release.
      if (this.transformDragging) {
        this.transformDragging = false;
        this.send({ t: 'transformDragEnd' });
      }
      this.cropFrom = null;
      if (this.gradientFrom) {
        const from = this.gradientFrom;
        this.gradientFrom = null;
        let to = toLocal(e);
        // Shift constrains the drag to 45° steps, as it does in Photoshop.
        if (e.shiftKey) to = snap45(from, to);
        this.send({ t: 'gradient', from, to, ...(this.fillRequest?.() ?? {}) } as never);
      }
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
  brushBg: [number, number, number] = [1, 1, 1];
  /** A retouching tool's stroke settings (sent with each stroke), or null for plain painting. */
  retouch: { tool: string; options: unknown } | null = null;
  /** Clone Stamp / Healing: Alt-click sets the source instead of painting. */
  altSamples = false;
  /** A tool that acts on a click (Magic Eraser): its message, given the click point. */
  clickAction: ((x: number, y: number) => unknown) | null = null;
  /** A tool whose whole drag goes to the engine as one message per phase (Patch, CA Move). */
  dragAction: ((phase: 'down' | 'move' | 'up', x: number, y: number) => unknown) | null = null;
  private dragDown = false;
  brush: BrushParams = { ...DEFAULT_BRUSH };
  /** Paint blend mode, which unlike a layer's may also be 'behind' or 'clear'. */
  paintBlendMode = 'normal';

  resize(width: number, height: number): void {
    this.send({ t: 'resize', width, height, dpr: devicePixelRatio });
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    clearInterval(this.probeTimer);
    this.worker.terminate();
  }
}
