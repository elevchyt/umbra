/**
 * Alpha channels and Select ▸ Save/Load Selection — spec 02 §5.
 *
 * A saved selection is the selection's coverage mask stored as a plane, so it goes through the
 * same tile store as everything else and costs nothing when it is mostly empty. The round trip
 * is lossless: coverage is 0…255 on both sides, which is why a feathered selection survives
 * being saved and loaded.
 */
import { TILE_SIZE, TILE_SHIFT, type PlaneFormat } from '@umbra/core/pixels';
import { combine, createMask, type CombineOp, type Mask } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import type { AlphaChannel, Doc } from '../document.js';
import { makeSelection, type Selection } from '../selection.js';

const MASK8: PlaneFormat = { layout: 'A', sample: 'u8' };

let nextChannelId = 1;

/** Coverage mask → plane. Empty tiles are never allocated, so an unused area is free. */
export function maskToPlane(mask: Mask, width: number, height: number): Plane {
  const writer = Plane.empty(MASK8, [0]).writer();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = mask[y * width + x]!;
      if (v === 0) continue;
      const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      data[((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1))] = v;
    }
  }
  return writer.commit();
}

/** Plane → coverage mask, the inverse of `maskToPlane`. */
export function planeToMask(plane: Plane, width: number, height: number): Mask {
  const mask = createMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = plane.tileAt(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = tile.uniform ? 0 : ((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1));
      mask[y * width + x] = tile.data[o]!;
    }
  }
  return mask;
}

function uniqueName(doc: Doc, wanted?: string): string {
  if (wanted) return wanted;
  let n = 1;
  const taken = new Set(doc.channels.map((c) => c.name));
  while (taken.has(`Alpha ${n}`)) n++;
  return `Alpha ${n}`;
}

/**
 * Select ▸ Save Selection. With no `targetId` it makes a new channel; with one it combines
 * into that channel, which is how Photoshop's Add to/Subtract from/Intersect with Channel
 * options work.
 */
export function saveSelection(
  doc: Doc,
  sel: Selection,
  opts: { targetId?: number; op?: CombineOp; name?: string } = {},
): Doc {
  const op = opts.op ?? 'new';
  const existing = opts.targetId !== undefined ? doc.channels.find((c) => c.id === opts.targetId) : undefined;

  if (!existing) {
    const channel: AlphaChannel = {
      id: nextChannelId++,
      name: uniqueName(doc, opts.name),
      plane: new MipPlane(maskToPlane(sel.mask, doc.width, doc.height)),
      color: [1, 0, 0],
      opacity: 0.5,
      visible: false,
      indicates: 'masked',
    };
    return { ...doc, channels: [...doc.channels, channel] };
  }

  const base = planeToMask(existing.plane.base, doc.width, doc.height);
  combine(base, sel.mask, op);
  return {
    ...doc,
    channels: doc.channels.map((c) =>
      c.id === existing.id ? { ...c, plane: new MipPlane(maskToPlane(base, doc.width, doc.height)) } : c,
    ),
  };
}

/**
 * Select ▸ Load Selection. `invert` is the dialog's Invert box; a channel that stores the
 * MASKED area rather than the selected one is inverted automatically, which is what the
 * channel's own setting is for.
 */
export function loadSelection(
  doc: Doc,
  channelId: number,
  opts: { op?: CombineOp; invert?: boolean } = {},
): Selection | null {
  const channel = doc.channels.find((c) => c.id === channelId);
  if (!channel) return null;
  const mask = planeToMask(channel.plane.base, doc.width, doc.height);
  if (opts.invert) for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]!;

  const op = opts.op ?? 'new';
  if (op === 'new' || !doc.selection) return makeSelection(doc.width, doc.height, mask);
  const base = Uint8Array.from(doc.selection.mask);
  combine(base, mask, op);
  return makeSelection(doc.width, doc.height, base);
}

export function deleteChannel(doc: Doc, id: number): Doc {
  return { ...doc, channels: doc.channels.filter((c) => c.id !== id) };
}

export function updateChannel(doc: Doc, id: number, patch: Partial<AlphaChannel>): Doc {
  return { ...doc, channels: doc.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** Duplicate a channel, which is how Photoshop's panel menu copies a saved selection. */
export function duplicateChannel(doc: Doc, id: number): Doc {
  const source = doc.channels.find((c) => c.id === id);
  if (!source) return doc;
  const copy: AlphaChannel = {
    ...source,
    id: nextChannelId++,
    name: `${source.name} copy`,
    visible: false,
  };
  const at = doc.channels.findIndex((c) => c.id === id);
  const channels = [...doc.channels];
  channels.splice(at + 1, 0, copy);
  return { ...doc, channels };
}
