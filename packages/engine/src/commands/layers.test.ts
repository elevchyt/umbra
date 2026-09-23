import { describe, expect, it } from 'vitest';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makeGroup, makePixelLayer, type Doc } from '../document.js';
import { setClipped } from './layers.js';

const layer = (name: string) => makePixelLayer(name, Plane.empty(RGBA8));

describe('clipping masks', () => {
  it('clips a layer to the one below, and releases it again', () => {
    const a = layer('a');
    const b = layer('b');
    const d: Doc = { ...emptyDoc(10, 10), layers: [a, b], activeLayerIds: [b.id] };
    const clipped = setClipped(d, b.id, true);
    expect(clipped.layers[1]!.clipped).toBe(true);
    expect(setClipped(clipped, b.id, false).layers[1]!.clipped).toBe(false);
  });

  it('will not clip the bottom layer of a list, which has nothing to clip to', () => {
    const a = layer('a');
    const inner = layer('inner');
    const g = makeGroup('g', [inner]);
    const d: Doc = { ...emptyDoc(10, 10), layers: [a, g], activeLayerIds: [a.id] };
    expect(setClipped(d, a.id, true)).toBe(d);
    // Inside a group the same rule applies to the group's own bottom layer.
    expect(setClipped(d, inner.id, true)).toBe(d);
  });
});
