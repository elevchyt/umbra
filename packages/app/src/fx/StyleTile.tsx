/**
 * A style drawn on a rounded square: the Layer Style dialog's preview tile and the Styles
 * panel's thumbnails. Rendered here, in the page, with the same effect kernels the engine uses.
 */
import { createEffect, onCleanup } from 'solid-js';
import { compositePixel, mapEffectPatterns, renderEffects, DEFAULT_GLOBAL_LIGHT, type GlobalLight, type LayerEffects } from '@umbra/engine';

const shapes = new Map<number, Float32Array>();
function shapeFor(size: number): Float32Array {
  let s = shapes.get(size);
  if (s) return s;
  s = new Float32Array(size * size);
  const c = size / 2;
  const half = size * 0.28;
  const r = size * 0.14;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(0, Math.abs(x + 0.5 - c) - (half - r));
      const dy = Math.max(0, Math.abs(y + 0.5 - c) - (half - r));
      s[y * size + x] = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(dx, dy)));
    }
  }
  shapes.set(size, s);
  return s;
}

export function StyleTile(props: { fx: LayerEffects; light?: GlobalLight; size: number; title?: string }) {
  let canvas!: HTMLCanvasElement;
  let timer = 0;
  createEffect(() => {
    // Patterns travel by id outside the engine; the tile draws the rest without them.
    const fx = mapEffectPatterns(props.fx, (p) => (p.data.length ? p : null));
    const light = props.light ?? DEFAULT_GLOBAL_LIGHT;
    const n = props.size;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const shape = shapeFor(n);
      const lo = Math.round(n * 0.22);
      const r = renderEffects(fx, { shape, width: n, height: n, originX: 0, originY: 0, docWidth: n, docHeight: n, bounds: { x0: lo, y0: lo, x1: n - lo, y1: n - lo }, light });
      const img = new ImageData(n, n);
      for (let i = 0; i < n * n; i++) {
        let c: [number, number, number] = [1, 1, 1];
        let a = 1;
        const put = (d: Uint8ClampedArray, mode: never, op: number) => {
          const o = compositePixel(mode, c, a, [d[i * 4]! / 255, d[i * 4 + 1]! / 255, d[i * 4 + 2]! / 255], (d[i * 4 + 3]! / 255) * op);
          c = o.color as [number, number, number];
          a = o.alpha;
        };
        for (const e of r.below) put(e.data, e.blendMode as never, e.opacity);
        const o = compositePixel('normal', c, a, [0.62, 0.7, 0.82], shape[i]!);
        c = o.color as [number, number, number];
        a = o.alpha;
        for (const e of r.above) put(e.data, e.blendMode as never, e.opacity);
        img.data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4);
      }
      canvas.getContext('2d')?.putImageData(img, 0, 0);
    }, 30);
  });
  onCleanup(() => clearTimeout(timer));
  return <canvas ref={canvas} class="fx-tile" width={props.size} height={props.size} style={{ width: `${props.size}px`, height: `${props.size}px` }} title={props.title} />;
}
