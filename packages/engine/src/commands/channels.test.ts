import { describe, expect, it } from 'vitest';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { emptyDoc, type Doc } from '../document.js';
import { makeSelection } from '../selection.js';
import {
  deleteChannel,
  duplicateChannel,
  loadSelection,
  maskToPlane,
  planeToMask,
  saveSelection,
  updateChannel,
} from './channels.js';

const W = 64;
const H = 64;
const size = { width: W, height: H };

function rect(x0: number, y0: number, x1: number, y1: number) {
  const mask = createMask(W, H);
  rasterizeRect(mask, size, { x0, y0, x1, y1 }, false);
  return makeSelection(W, H, mask);
}

const doc = (): Doc => emptyDoc(W, H, 'test');

describe('mask ↔ plane', () => {
  it('round-trips coverage exactly, partial values included', () => {
    const mask = createMask(W, H);
    rasterizeRect(mask, size, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
    mask[15 * W + 10] = 77;
    const back = planeToMask(maskToPlane(mask, W, H), W, H);
    expect(back[15 * W + 10]).toBe(77);
    expect(back[15 * W + 15]).toBe(255);
    expect(back[0]).toBe(0);
  });

  it('allocates nothing for an empty mask', () => {
    expect(maskToPlane(createMask(W, H), W, H).tileCount).toBe(0);
  });
});

describe('save and load selection', () => {
  it('saves to a new channel with a generated name', () => {
    const out = saveSelection(doc(), rect(10, 10, 20, 20));
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0]!.name).toBe('Alpha 1');
  });

  it('loads back the selection it saved', () => {
    const saved = saveSelection(doc(), rect(10, 10, 20, 20));
    const sel = loadSelection(saved, saved.channels[0]!.id)!;
    expect(sel.mask[15 * W + 15]).toBe(255);
    expect(sel.mask[5 * W + 5]).toBe(0);
  });

  it('keeps a feathered edge across the round trip', () => {
    const mask = createMask(W, H);
    rasterizeRect(mask, size, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
    mask[15 * W + 10] = 120;
    const saved = saveSelection(doc(), makeSelection(W, H, mask));
    const sel = loadSelection(saved, saved.channels[0]!.id)!;
    expect(sel.mask[15 * W + 10]).toBe(120);
  });

  it('combines into an existing channel', () => {
    let d = saveSelection(doc(), rect(10, 10, 20, 20));
    const id = d.channels[0]!.id;
    d = saveSelection(d, rect(30, 30, 40, 40), { targetId: id, op: 'add' });
    expect(d.channels).toHaveLength(1);
    const sel = loadSelection(d, id)!;
    expect(sel.mask[15 * W + 15]).toBe(255);
    expect(sel.mask[35 * W + 35]).toBe(255);
  });

  it('loads with an op against the current selection', () => {
    const saved = saveSelection(doc(), rect(10, 10, 30, 30));
    const withSel: Doc = { ...saved, selection: rect(20, 20, 40, 40) };
    const sel = loadSelection(withSel, saved.channels[0]!.id, { op: 'intersect' })!;
    expect(sel.mask[25 * W + 25]).toBe(255);
    expect(sel.mask[15 * W + 15]).toBe(0);
    expect(sel.mask[35 * W + 35]).toBe(0);
  });

  it('inverts on load when asked', () => {
    const saved = saveSelection(doc(), rect(10, 10, 20, 20));
    const sel = loadSelection(saved, saved.channels[0]!.id, { invert: true })!;
    expect(sel.mask[15 * W + 15]).toBe(0);
    expect(sel.mask[5 * W + 5]).toBe(255);
  });

  it('returns null for a channel that is not there', () => {
    expect(loadSelection(doc(), 999)).toBeNull();
  });
});

describe('channel management', () => {
  it('duplicates next to the original', () => {
    const saved = saveSelection(doc(), rect(1, 1, 5, 5));
    const d = duplicateChannel(saved, saved.channels[0]!.id);
    expect(d.channels.map((c) => c.name)).toEqual(['Alpha 1', 'Alpha 1 copy']);
  });

  it('renames and deletes', () => {
    let d = saveSelection(doc(), rect(1, 1, 5, 5));
    const id = d.channels[0]!.id;
    d = updateChannel(d, id, { name: 'Sky' });
    expect(d.channels[0]!.name).toBe('Sky');
    expect(deleteChannel(d, id).channels).toHaveLength(0);
  });
});
