/** Filter ▸ Video — spec 05 §B.8. */
import { clamp01, cloneRaster, mapStraight } from './core.js';
import { str, type FilterDef } from './types.js';

export const deinterlace: FilterDef = {
  id: 'video.deinterlace',
  label: 'De-Interlace',
  category: 'Video',
  params: [
    { key: 'eliminate', label: 'Eliminate', type: 'select', default: 'odd', options: [{ value: 'odd', label: 'Odd Fields' }, { value: 'even', label: 'Even Fields' }] },
    { key: 'create', label: 'Create New Fields by', type: 'select', default: 'interpolation', options: [{ value: 'duplication', label: 'Duplication' }, { value: 'interpolation', label: 'Interpolation' }] },
  ],
  pad: () => 1,
  model: 'Documented: the chosen field\'s rows are replaced by a copy of the row above, or the average of the rows either side. Rows count from the top of the document.',
  run: (src, p, ctx) => {
    const odd = str(p, 'eliminate') === 'odd';
    const interp = str(p, 'create') === 'interpolation';
    const out = cloneRaster(src);
    const w = src.width;
    for (let y = 0; y < src.height; y++) {
      // Photoshop numbers fields from 1, so the first row is odd.
      const gy = y + ctx.originY;
      if ((gy % 2 === 0) !== odd) continue;
      const above = Math.max(0, y - 1);
      const below = Math.min(src.height - 1, y + 1);
      for (let i = 0; i < w * 4; i++) {
        const a = src.data[above * w * 4 + i]!;
        out.data[y * w * 4 + i] = interp ? (a + src.data[below * w * 4 + i]!) / 2 : a;
      }
    }
    return out;
  },
};

export const ntsc: FilterDef = {
  id: 'video.ntsccolors',
  label: 'NTSC Colors',
  category: 'Video',
  params: [],
  pad: () => 0,
  model: '[fit] in YIQ, chroma is scaled down wherever luma ± chroma would leave the broadcast range (−20…+120 IRE of a 0…100 scale), so saturated colours no longer bleed on NTSC.',
  run: (src) =>
    mapStraight(src, (px) => {
      const r = px[0]!;
      const g = px[1]!;
      const b = px[2]!;
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      let I = 0.596 * r - 0.274 * g - 0.322 * b;
      let Q = 0.211 * r - 0.523 * g + 0.312 * b;
      const C = Math.hypot(I, Q);
      const limit = Math.min(1.2 - Y, Y + 0.2);
      if (C > limit && C > 0) {
        const k = Math.max(0, limit) / C;
        I *= k;
        Q *= k;
      }
      px[0] = clamp01(Y + 0.956 * I + 0.621 * Q);
      px[1] = clamp01(Y - 0.272 * I - 0.647 * Q);
      px[2] = clamp01(Y - 1.106 * I + 1.703 * Q);
    }),
};

export const VIDEO_FILTERS: FilterDef[] = [deinterlace, ntsc];
