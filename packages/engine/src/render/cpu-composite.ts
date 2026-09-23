/**
 * Bridges the document tree to the CPU reference compositor.
 *
 * Used for export, for headless rendering, and by the tests that check a PSD renders the way
 * the spec says it should (spec 03 §5.3).
 */
import { TILE_SHIFT, TILE_SIZE, channelCount, maxValue } from '@umbra/core/pixels';
import type { CompositeLayer, Sample } from '@umbra/kernels/composite';
import { DEFAULT_BLENDING } from '@umbra/kernels/composite';
import type { Rgb } from '@umbra/kernels/blend';
import { applierToRgbFn, compile } from '@umbra/kernels/adjust';
import { fillSampler } from '@umbra/kernels/fill';
import type { Doc, Layer } from '../document.js';
import type { Plane } from '../tiles/plane.js';

/** Read one straight-alpha RGBA sample from a plane. */
function samplePlane(plane: Plane, x: number, y: number): Sample {
  const tile = plane.tileAt(x >> TILE_SHIFT, y >> TILE_SHIFT);
  const n = channelCount(plane.format.layout);
  const max = maxValue(plane.format.sample);
  const d = tile.data;
  let o = 0;
  if (!tile.uniform) {
    const lx = x - ((x >> TILE_SHIFT) << TILE_SHIFT);
    const ly = y - ((y >> TILE_SHIFT) << TILE_SHIFT);
    o = (ly * TILE_SIZE + lx) * n;
  }
  const color: Rgb = [d[o]! / max, d[o + 1]! / max, d[o + 2]! / max];
  return { color, alpha: d[o + 3]! / max };
}

/** Read one coverage value from a single-channel mask plane. */
function sampleMask(plane: Plane, x: number, y: number): number {
  const tile = plane.tileAt(x >> TILE_SHIFT, y >> TILE_SHIFT);
  const max = maxValue(plane.format.sample);
  if (tile.uniform) return tile.data[0]! / max;
  const lx = x - ((x >> TILE_SHIFT) << TILE_SHIFT);
  const ly = y - ((y >> TILE_SHIFT) << TILE_SHIFT);
  return tile.data[ly * TILE_SIZE + lx]! / max;
}

/**
 * `size` is the canvas, which a gradient fill layer needs: its geometry is defined relative
 * to the canvas, not to any stored pixels.
 */
export function toCompositeLayer(layer: Layer, size: { width: number; height: number } = { width: 0, height: 0 }): CompositeLayer {
  const base: CompositeLayer = {
    kind: layer.kind === 'fill' ? 'pixel' : layer.kind,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    fill: layer.fill,
    blendMode: layer.blendMode,
    clipped: layer.clipped,
    blending: layer.blending ?? DEFAULT_BLENDING,
    seed: layer.seed,
  };

  if (layer.mask) {
    const plane = layer.mask.plane.base;
    base.mask = {
      sample: (x, y) => sampleMask(plane, x, y),
      enabled: layer.mask.enabled,
      density: layer.mask.density,
    };
  }

  if (layer.kind === 'group') {
    base.children = layer.children.map((c) => toCompositeLayer(c, size));
  } else if (layer.kind === 'adjustment') {
    base.adjust = applierToRgbFn(compile(layer.adjustment));
  } else if (layer.kind === 'fill') {
    base.kind = 'pixel';
    base.sample = fillSampler(layer.content, size.width, size.height);
  } else {
    const plane = layer.plane.base;
    base.sample = (x, y) => samplePlane(plane, x, y);
  }
  return base;
}

export function toCompositeLayers(doc: Doc): CompositeLayer[] {
  return doc.layers.map((l) => toCompositeLayer(l, doc));
}
