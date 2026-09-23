/**
 * Document parity — real documents through the real render path.
 *
 * The pattern cases in parity.ts check the compositor's MATHS: every layer is painted from a
 * procedural pattern straight into a scratch target. They never touch the tile store, the
 * atlas, or how a plane's tiles and default reach the GPU — and that is where the worst bug
 * of M4 lived: single-channel mask tiles were uploaded as RGBA, rejected by WebGL, and drew as
 * whatever the atlas slot held before. These cases build `Doc`s, render them with the
 * DocumentRenderer the app uses, and compare against the CPU reference pixel for pixel.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { compositeDocument } from '@umbra/kernels/composite';
import { createMask, rasterizeEllipse, rasterizeRect } from '@umbra/kernels/selection';
import { builtinPatterns } from '@umbra/kernels/fill';
import { TileAtlas } from './gpu/atlas.js';
import type { GpuCaps } from './gpu/caps.js';
import { DocumentRenderer } from './render/document-renderer.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { emptyDoc, makePixelLayer, type Doc, type RasterMask } from './document.js';
import { Plane } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import { makeSelection } from './selection.js';
import { addAdjustmentLayer, addFillLayer } from './commands/adjust.js';
import type { ParityResult } from './parity.js';

const W = 600;
const H = 300;
const MASK8 = { layout: 'A', sample: 'u8' } as const;

function colourful(): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
      d[o] = (x * 3) & 255;
      d[o + 1] = (y * 5) & 255;
      d[o + 2] = (x + y) & 255;
      d[o + 3] = 255;
    }
  }
  return w.commit();
}

/** A mask with `def` everywhere unstored, and `value` inside `rect` — stored tiles only there. */
function maskWith(def: 0 | 255, value: number, rect: { x0: number; y0: number; x1: number; y1: number }): RasterMask {
  const w = Plane.empty(MASK8, [def]).writer();
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT)[(y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))] = value;
    }
  }
  return { plane: new MipPlane(w.commit()), enabled: true, linked: true, density: 1, feather: 0, defaultColor: def === 255 ? 1 : 0 };
}

function withSelection(doc: Doc, shape: 'rect' | 'ellipse'): Doc {
  const m = createMask(W, H);
  const r = { x0: 150, y0: 60, x1: 460, y1: 240 };
  if (shape === 'rect') rasterizeRect(m, { width: W, height: H }, r, false);
  else rasterizeEllipse(m, { width: W, height: H }, r, true);
  return { ...doc, selection: makeSelection(W, H, m) };
}

function documents(): { name: string; doc: Doc }[] {
  const base = () => makePixelLayer('Background', colourful());
  const one = (layers: Doc['layers']): Doc => ({ ...emptyDoc(W, H, 'parity'), layers, activeLayerIds: [layers[layers.length - 1]!.id] });
  const pattern = builtinPatterns()[4]!;
  return [
    {
      // What Photoshop writes: a mask cropped to its painted area with a white default.
      name: 'doc: white-default mask with stored tiles (a cropped PSD mask)',
      doc: one([base(), makePixelLayer('Top', colourful(), { blendMode: 'multiply', mask: maskWith(255, 0, { x0: 280, y0: 40, x1: 520, y1: 200 }) })]),
    },
    {
      name: 'doc: black-default mask revealing a stored region, over a background',
      doc: one([base(), makePixelLayer('Top', colourful(), { opacity: 0.6, blendMode: 'difference', mask: maskWith(0, 200, { x0: 100, y0: 100, x1: 590, y1: 290 }) })]),
    },
    {
      name: 'doc: adjustment layer masked by an elliptical selection',
      doc: addAdjustmentLayer(withSelection(one([base()]), 'ellipse'), { kind: 'invert' }),
    },
    {
      name: 'doc: gradient fill layer masked by a selection',
      doc: addFillLayer(withSelection(one([base()]), 'rect'), {
        type: 'gradient',
        gradient: { colorStops: [{ at: 0, color: [1, 0, 0] }, { at: 1, color: [0, 0, 1] }], opacityStops: [{ at: 0, opacity: 1 }, { at: 1, opacity: 0.5 }] },
        style: 'radial',
        angle: 20,
        scale: 80,
        reverse: false,
        offset: { x: 0, y: 0 },
      }),
    },
    {
      name: 'doc: pattern fill layer, full canvas',
      doc: addFillLayer(one([base()]), { type: 'pattern', pattern, scale: 100, phase: { x: 3, y: 5 } }),
    },
  ];
}

export function runDocumentParity(gl: WebGL2RenderingContext, caps: GpuCaps): ParityResult[] {
  const atlas = new TileAtlas(gl, caps, 64 * 1024 * 1024);
  const renderer = new DocumentRenderer(gl, caps, atlas);
  const results: ParityResult[] = [];
  try {
    for (const { name, doc } of documents()) {
      atlas.beginFrame();
      const gpu = renderer.renderToBuffer(doc, caps.maxTextureSize);
      const layers = toCompositeLayers(doc);
      let maxDelta = 0;
      let sum = 0;
      let worstAt: { x: number; y: number } | null = null;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const c = compositeDocument(layers, x, y);
          const cpu = [...c.color.map((v) => Math.round(v * 255)), Math.round(c.alpha * 255)];
          const o = (y * W + x) * 4;
          for (let k = 0; k < 4; k++) {
            // Colour is meaningless where nothing is covered.
            if (k < 3 && cpu[3] === 0 && gpu.pixels[o + 3] === 0) continue;
            const d = Math.abs(cpu[k]! - gpu.pixels[o + k]!);
            sum += d;
            if (d > maxDelta) {
              maxDelta = d;
              worstAt = { x, y };
            }
          }
        }
      }
      results.push({ name, pass: maxDelta <= 1, maxDelta, meanDelta: sum / (W * H * 4), worstAt });
    }
  } finally {
    renderer.dispose();
    atlas.dispose();
  }
  return results;
}
