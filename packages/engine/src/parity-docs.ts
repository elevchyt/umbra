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
import { DEFAULTS, EMPTY_EFFECTS } from '@umbra/kernels/effects/types';
import { TileAtlas } from './gpu/atlas.js';
import type { GpuCaps } from './gpu/caps.js';
import { DocumentRenderer } from './render/document-renderer.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { DEFAULT_BLENDING_STATE, emptyDoc, makeGroup, makePixelLayer, type Doc, type RasterMask } from './document.js';
import { Plane } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import { makeSelection } from './selection.js';
import { addAdjustmentLayer, addFillLayer } from './commands/adjust.js';
import type { ParityResult } from './parity.js';
import { makeShapeLayer } from './shape-layers.js';
import { liveShapePath } from '@umbra/kernels/vector/shapes';
import { DEFAULT_STROKE } from '@umbra/kernels/vector/stroke';

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

/** An opaque disc and bar of colour over transparency: a shape for layer effects to act on. */
function shape(): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = Math.hypot(x - 200, y - 150) < 80 || (x > 260 && x < 480 && y > 110 && y < 190);
      if (!inside) continue;
      const d = w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
      d.set([40 + (x & 63), 120, 200 - (y & 63), 255], o);
    }
  }
  return w.commit();
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
      name: 'doc: layer effects — drop shadow, bevel, stroke',
      doc: one([
        base(),
        makePixelLayer('Shape', shape(), {
          effects: {
            ...EMPTY_EFFECTS,
            dropShadow: [{ ...DEFAULTS.dropShadow(), opacity: 0.8, distance: 12, size: 10 }],
            bevel: { ...DEFAULTS.bevel(), size: 8 },
            stroke: [{ ...DEFAULTS.stroke(), size: 4, position: 'center', blendMode: 'overlay' }],
          },
        }),
      ]),
    },
    {
      name: 'doc: layer effects on a 60% layer — glow, overlay, inner shadow',
      doc: one([
        base(),
        makePixelLayer('Shape', shape(), {
          opacity: 0.6,
          effects: {
            ...EMPTY_EFFECTS,
            outerGlow: { ...DEFAULTS.outerGlow(), opacity: 0.9, size: 14 },
            colorOverlay: [{ ...DEFAULTS.colorOverlay(), blendMode: 'screen', opacity: 0.7 }],
            innerShadow: [{ ...DEFAULTS.innerShadow(), opacity: 0.9, size: 12, distance: 8 }],
          },
        }),
      ]),
    },
    {
      name: 'doc: shallow knockout at fill 0 inside a group punches to the group entry',
      doc: one([
        base(),
        makeGroup('Group', [makePixelLayer('Middle', colourful(), { blendMode: 'difference' }), makePixelLayer('Punch', shape(), { fill: 0, blending: { ...DEFAULT_BLENDING_STATE, knockout: 'shallow' } })], { blendMode: 'normal' }),
      ]),
    },
    {
      name: 'doc: deep knockout at 70% opacity reaches the document bottom',
      doc: one([base(), makePixelLayer('Middle', colourful(), { blendMode: 'multiply' }), makePixelLayer('Punch', shape(), { opacity: 0.7, fill: 0.4, blending: { ...DEFAULT_BLENDING_STATE, knockout: 'deep' } })]),
    },
    {
      name: 'doc: Blend If with gray and green ranges together',
      doc: one([
        base(),
        makePixelLayer('Top', colourful(), {
          blendMode: 'screen',
          blending: {
            ...DEFAULT_BLENDING_STATE,
            blendIf: [
              { channel: 'gray', thisLayer: [0.1, 0.3, 0.8, 0.95], underlying: [0, 0, 1, 1] },
              { channel: 'g', thisLayer: [0, 0, 1, 1], underlying: [0.2, 0.5, 1, 1] },
            ],
          },
        }),
      ]),
    },
    {
      name: 'doc: pattern fill layer, full canvas',
      doc: addFillLayer(one([base()]), { type: 'pattern', pattern, scale: 100, phase: { x: 3, y: 5 } }),
    },
    {
      name: 'doc: shape layers (rounded rect with dashed stroke, star) over pixels',
      doc: one([
        base(),
        makeShapeLayer('Rect', liveShapePath({ kind: 'rect', x: 40.5, y: 30, w: 300, h: 160, radii: [30, 0, 60, 10], angle: 12 }), { type: 'solid', color: [0.2, 0.5, 1] }, { enabled: true, style: { ...DEFAULT_STROKE, width: 7, dashes: [3, 1] }, content: { type: 'solid', color: [0, 0, 0] }, opacity: 0.8, blendMode: 'multiply' }, { width: W, height: H }, { opacity: 0.7, blendMode: 'overlay' }),
        makeShapeLayer('Star', liveShapePath({ kind: 'polygon', cx: 450, cy: 150, r: 120, sides: 5, star: 50, smoothCorners: false, smoothIndents: false, radius: 0, angle: 0 }), { type: 'solid', color: [1, 0.8, 0] }, null, { width: W, height: H }),
      ]),
    },
    {
      name: 'doc: vector mask with a subtracted component, over a raster mask',
      doc: one([
        base(),
        makePixelLayer('Masked', colourful(), {
          mask: maskWith(255, 0, { x0: 0, y0: 0, x1: 200, y1: H }),
          vectorMask: {
            enabled: true,
            path: {
              subpaths: [
                ...liveShapePath({ kind: 'ellipse', cx: 300, cy: 150, rx: 250, ry: 120, angle: 0 }).subpaths,
                { ...liveShapePath({ kind: 'rect', x: 250, y: 100, w: 100, h: 100, radii: [0, 0, 0, 0], angle: 0 }).subpaths[0]!, op: 'subtract' },
              ],
            },
          },
        }),
      ]),
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
