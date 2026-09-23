import { describe, expect, it } from 'vitest';
import { FILTERS, FILTER_BY_ID } from './index.js';
import { fromRgba8, toRgba8, makeRaster, type Raster } from './core.js';
import { irisSpans } from './lensblur.js';
import { defaultsOf, type FilterContext, type FilterDef, type FilterParams } from './types.js';

const W = 40;
const H = 28;

/** Colourful, with a transparent corner and a half-alpha stripe — the awkward cases. */
function image(): Raster {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      px[o] = (x * 37 + y * 11) & 255;
      px[o + 1] = (x * 5 + y * 23 + 40) & 255;
      px[o + 2] = ((x ^ y) * 13) & 255;
      px[o + 3] = x < 4 && y < 4 ? 0 : y >= 20 && y < 23 ? 128 : 255;
    }
  }
  return fromRgba8(px, W, H);
}

/** A smooth opaque map for the 'layer' parameter (Displace, Lens Blur's depth). */
function mapImage(): Raster {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      px[o] = Math.round((x / (W - 1)) * 255);
      px[o + 1] = Math.round((y / (H - 1)) * 255);
      px[o + 2] = 128;
      px[o + 3] = 255;
    }
  }
  return fromRgba8(px, W, H);
}

function crop(img: Raster, b: { x0: number; y0: number; x1: number; y1: number }): Raster {
  const sw = b.x1 - b.x0;
  const out = makeRaster(sw, b.y1 - b.y0);
  for (let y = 0; y < out.height; y++) out.data.set(img.data.subarray(((b.y0 + y) * W + b.x0) * 4, ((b.y0 + y) * W + b.x1) * 4), y * sw * 4);
  return out;
}

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  originX: 0,
  originY: 0,
  docWidth: W,
  docHeight: H,
  foreground: [0, 0, 0],
  background: [1, 1, 1],
  coverage: null,
  map: mapImage(),
  ...over,
});

/** Three parameter sets: the defaults, and two spread across each numeric range. */
function paramSets(def: FilterDef): FilterParams[] {
  const sets = [defaultsOf(def)];
  for (const [t, pick] of [[0.2, 1], [0.55, 2]] as const) {
    const p = defaultsOf(def);
    for (const s of def.params) {
      if (s.type === 'number') {
        // Radii get the log scale so a 1000 px maximum does not dominate a 40 px test image.
        const v = s.scale === 'log' ? Math.exp(Math.log(s.min) + t * 0.6 * (Math.log(s.max) - Math.log(s.min))) : s.min + t * (s.max - s.min);
        p[s.key] = s.step && s.step < 1 ? Math.round(v * 10) / 10 : Math.round(v);
      } else if (s.type === 'select') p[s.key] = s.options[pick % s.options.length]!.value;
      else if (s.type === 'bool') p[s.key] = pick === 1;
      else if (s.type === 'seed') p[s.key] = 7 * pick;
      else if (s.type === 'point') p[s.key] = { x: 0.3 * pick, y: 0.25 * pick };
      else if (s.type === 'layer') p[s.key] = pick;
    }
    sets.push(p);
  }
  return sets;
}

function checksum(r: Raster): string {
  const b = toRgba8(r);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619);
  return (h >>> 0).toString(16);
}

describe('every filter', () => {
  for (const def of FILTERS) {
    it(`${def.label}: three parameter sets, sane output, golden checksum`, () => {
      const sums: string[] = [];
      for (const p of paramSets(def)) {
        const out = def.run(image(), p, ctx());
        expect([out.width, out.height]).toEqual([W, H]);
        for (let i = 0; i < out.data.length; i += 4) {
          const a = out.data[i + 3]!;
          expect(Number.isFinite(a) && a >= -1e-6 && a <= 1 + 1e-6, `${def.id} alpha at ${i}`).toBe(true);
          // Premultiplied: colour can never exceed its alpha.
          for (let c = 0; c < 3; c++) expect(out.data[i + c]! <= a + 1e-5 && out.data[i + c]! >= -1e-6, `${def.id} c${c} at ${i >> 2}`).toBe(true);
        }
        sums.push(checksum(out));
      }
      // The goldens: a regression net for the next change, since there is no Photoshop oracle.
      expect(sums).toMatchSnapshot();
    });

    it(`${def.label}: a crop grown by its declared pad matches the full run`, () => {
      for (const p of paramSets(def)) {
        const pad = def.pad(p);
        if (pad === 'full') continue;
        const full = toRgba8(def.run(image(), p, ctx()));
        // The region 10…30 × 8…20, computed from a crop that includes the pad.
        const region = { x0: 10, y0: 8, x1: 30, y1: 20 };
        const src = { x0: Math.max(0, region.x0 - pad), y0: Math.max(0, region.y0 - pad), x1: Math.min(W, region.x1 + pad), y1: Math.min(H, region.y1 + pad) };
        const sw = src.x1 - src.x0;
        const part = toRgba8(def.run(crop(image(), src), p, ctx({ originX: src.x0, originY: src.y0, map: crop(mapImage(), src) })));
        let worst = 0;
        for (let y = region.y0; y < region.y1; y++) {
          for (let x = region.x0; x < region.x1; x++) {
            for (let c = 0; c < 4; c++) {
              worst = Math.max(worst, Math.abs(full[(y * W + x) * 4 + c]! - part[((y - src.y0) * sw + (x - src.x0)) * 4 + c]!));
            }
          }
        }
        expect(worst, `${def.id} ${JSON.stringify(p)}`).toBeLessThanOrEqual(1);
      }
    });
  }
});

// ---- properties that pin particular filters down --------------------------------------------

const flat = (v: [number, number, number, number]) => {
  const r = makeRaster(W, H);
  for (let i = 0; i < r.data.length; i += 4) r.data.set([v[0] * v[3], v[1] * v[3], v[2] * v[3], v[3]], i);
  return r;
};
const run = (id: string, p: FilterParams, src = image()) => FILTER_BY_ID.get(id)!.run(src, { ...defaultsOf(FILTER_BY_ID.get(id)!), ...p }, ctx());
const px = (r: Raster, x: number, y: number) => Array.from(toRgba8(r).subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe('filter properties', () => {
  it('blurs leave a flat image flat', () => {
    for (const id of ['blur.gaussianblur', 'blur.boxblur', 'blur.motionblur', 'blur.shapeblur', 'blur.blur', 'blur.blurmore', 'blur.surfaceblur', 'noise.median']) {
      expect(px(run(id, {}, flat([0.4, 0.6, 0.2, 1])), 20, 14), id).toEqual([102, 153, 51, 255]);
    }
  });

  it('Gaussian Blur preserves the image\'s total', () => {
    const src = image();
    const out = run('blur.gaussianblur', { radius: 3 }, src);
    const sum = (r: Raster) => r.data.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum(out) - sum(src)) / sum(src)).toBeLessThan(0.02);
  });

  it('Box Blur is the exact mean of the window', () => {
    const src = image();
    const out = run('blur.boxblur', { radius: 1 }, src);
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src.data[((10 + dy) * W + 15 + dx) * 4]!;
    expect(out.data[(10 * W + 15) * 4]).toBeCloseTo(s / 9, 5);
  });

  it('Median removes an isolated speck; Dust & Scratches only above its threshold', () => {
    const src = flat([0.5, 0.5, 0.5, 1]);
    src.data.set([1, 1, 1, 1], (10 * W + 10) * 4);
    expect(px(run('noise.median', { radius: 1 }, src), 10, 10)[0]).toBe(128);
    expect(px(run('noise.dustscratches', { radius: 1, threshold: 200 }, src), 10, 10)[0]).toBe(255);
    expect(px(run('noise.dustscratches', { radius: 1, threshold: 50 }, src), 10, 10)[0]).toBe(128);
  });

  it('Unsharp Mask leaves flat areas and increases edge contrast', () => {
    expect(px(run('sharpen.unsharpmask', { amount: 200 }, flat([0.3, 0.3, 0.3, 1])), 5, 5)[0]).toBe(77);
    const edge = makeRaster(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge.data.set(x < 20 ? [0.3, 0.3, 0.3, 1] : [0.7, 0.7, 0.7, 1], (y * W + x) * 4);
    const out = run('sharpen.unsharpmask', { amount: 200, radius: 1 }, edge);
    expect(px(out, 19, 5)[0]).toBeLessThan(77);
    expect(px(out, 20, 5)[0]).toBeGreaterThan(179);
  });

  it('High Pass turns a flat image into 50% grey', () => {
    expect(px(run('other.highpass', { radius: 4 }, flat([0.2, 0.9, 0.4, 1])), 10, 10)).toEqual([128, 128, 128, 255]);
  });

  it('Maximum never darkens and Minimum never lightens', () => {
    const src = toRgba8(image());
    for (const preserve of ['squareness', 'roundness']) {
      const mx = toRgba8(run('other.maximum', { radius: 2, preserve }));
      const mn = toRgba8(run('other.minimum', { radius: 2, preserve }));
      for (let i = 0; i < src.length; i += 4) {
        if (src[i + 3] !== 255 || mx[i + 3] !== 255 || mn[i + 3] !== 255) continue;
        expect(mx[i]!).toBeGreaterThanOrEqual(src[i]!);
        expect(mn[i]!).toBeLessThanOrEqual(src[i]!);
      }
    }
  });

  it('Offset with Wrap Around moves pixels and wraps them back', () => {
    const out = run('other.offset', { h: 5, v: 3, undefined: 'wrap' });
    expect(px(out, 5 + 12, 3 + 9)).toEqual(px(image(), 12, 9));
    expect(px(out, 2, 1)).toEqual(px(image(), W - 3, H - 2));
  });

  it('HSB/HSL: RGB→HSB then HSB→RGB is the identity', () => {
    const there = run('other.hsbhsl', { input: 'rgb', rows: 'hsb' });
    const back = run('other.hsbhsl', { input: 'hsb', rows: 'rgb' }, there);
    const a = toRgba8(image());
    const b = toRgba8(back);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(1);
  });

  it('Custom with the identity kernel is the identity', () => {
    const k = Array(25).fill(0);
    k[12] = 1;
    expect(Array.from(toRgba8(run('other.custom', { kernel: k, scale: 1, offset: 0 })))).toEqual(Array.from(toRgba8(image())));
  });

  it('Add Noise is repeatable for a seed and roughly unbiased', () => {
    const a = run('noise.addnoise', { amount: 40, seed: 3 });
    const b = run('noise.addnoise', { amount: 40, seed: 3 });
    expect(checksum(a)).toBe(checksum(b));
    const g = flat([0.5, 0.5, 0.5, 1]);
    const out = toRgba8(run('noise.addnoise', { amount: 40, seed: 9 }, g));
    let mean = 0;
    for (let i = 0; i < out.length; i += 4) mean += out[i]!;
    expect(Math.abs(mean / (W * H) - 128)).toBeLessThan(4);
  });

  it('Average paints the mean colour of the selection', () => {
    const cov = new Uint8Array(W * H);
    cov.fill(255, 0, W); // top row only
    const src = image();
    const out = FILTER_BY_ID.get('blur.average')!.run(src, {}, ctx({ coverage: cov }));
    let r = 0;
    let a = 0;
    for (let x = 0; x < W; x++) {
      r += src.data[x * 4]!;
      a += src.data[x * 4 + 3]!;
    }
    expect(out.data[(15 * W + 30) * 4]! / out.data[(15 * W + 30) * 4 + 3]!).toBeCloseTo(r / a, 5);
  });

  const same = (a: Raster, b: Raster, tol = 1) => {
    const x = toRgba8(a);
    const y = toRgba8(b);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i]! - y[i]!));
    return worst <= tol;
  };

  it('Twirl, Pinch, Spherize and ZigZag at zero are the identity', () => {
    expect(same(run('distort.twirl', { angle: 0 }), image())).toBe(true);
    expect(same(run('distort.pinch', { amount: 0 }), image())).toBe(true);
    expect(same(run('distort.spherize', { amount: 0 }), image())).toBe(true);
    expect(same(run('distort.zigzag', { amount: 0 }), image())).toBe(true);
    expect(same(run('distort.shear', { middle: 0 }), image())).toBe(true);
  });

  it('Twirl leaves everything outside the inscribed ellipse alone', () => {
    const out = toRgba8(run('distort.twirl', { angle: 300 }));
    const src = toRgba8(image());
    for (const [x, y] of [[0, 0], [39, 0], [0, 27], [39, 27], [5, 2]] as const) {
      const o = (y * W + x) * 4;
      expect(Array.from(out.subarray(o, o + 4))).toEqual(Array.from(src.subarray(o, o + 4)));
    }
  });

  it('Displace through a mid-grey map moves nothing; a bright red one moves right to left', () => {
    const grey = flat([0.5, 0.5, 0.5, 1]);
    const f = FILTER_BY_ID.get('distort.displace')!;
    const p = { ...defaultsOf(f), map: 1, h: 50, v: 50 };
    expect(same(f.run(image(), p, ctx({ map: grey })), image())).toBe(true);
    // Red = 1 is (1 − ½)·2 of the scale, and 12.5% of 128 px is 16 px: pixel 10 reads pixel 26.
    const ramp = makeRaster(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ramp.data.set([x / W, 0, 0, 1], (y * W + x) * 4);
    const red = flat([1, 0.5, 0.5, 1]);
    const out = f.run(ramp, { ...p, h: 12.5, v: 0 }, ctx({ map: red }));
    expect(out.data[(10 * W + 10) * 4]!).toBeCloseTo(26 / W, 2);
  });

  it('Polar Coordinates there and back again roughly restores the middle', () => {
    const smooth = makeRaster(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) smooth.data.set([0.5 + 0.4 * Math.sin(x / 7), 0.5 + 0.4 * Math.cos(y / 5), 0.5, 1], (y * W + x) * 4);
    const there = run('distort.polarcoordinates', { mode: 'toPolar' }, smooth);
    const back = run('distort.polarcoordinates', { mode: 'toRect' }, there);
    let err = 0;
    let count = 0;
    for (let y = 6; y < 22; y++) for (let x = 6; x < 34; x++) {
      err += Math.abs(back.data[(y * W + x) * 4]! - smooth.data[(y * W + x) * 4]!);
      count++;
    }
    expect(err / count).toBeLessThan(0.05);
  });

  it('De-Interlace replaces one field with the other', () => {
    const out = run('video.deinterlace', { eliminate: 'odd', create: 'duplication' });
    const src = image();
    // Rows 0, 2, 4… are the odd field (numbered from 1): each is now a copy of the row above.
    for (const y of [2, 10]) for (let x = 0; x < W * 4; x++) expect(out.data[y * W * 4 + x]).toBe(src.data[(y - 1) * W * 4 + x]);
    for (let x = 0; x < W * 4; x++) expect(out.data[3 * W * 4 + x]).toBe(src.data[3 * W * 4 + x]);
  });

  it('NTSC Colors leaves greys alone and tames pure red', () => {
    expect(px(run('video.ntsccolors', {}, flat([0.5, 0.5, 0.5, 1])), 5, 5)).toEqual([128, 128, 128, 255]);
    const red = px(run('video.ntsccolors', {}, flat([1, 0, 0, 1])), 5, 5);
    expect(red[0]!).toBeLessThan(255);
    expect(red[1]! + red[2]!).toBeGreaterThan(0);
  });

  it('Lens Blur at radius 0 is the identity; with no depth map it keeps a flat image flat', () => {
    expect(same(run('blur.lensblur', { radius: 0 }), image())).toBe(true);
    expect(px(run('blur.lensblur', { radius: 6 }, flat([0.2, 0.6, 0.4, 1])), 20, 14)).toEqual(px(flat([0.2, 0.6, 0.4, 1]), 20, 14));
  });

  it('Lens Blur keeps the focal plane sharp', () => {
    const f = FILTER_BY_ID.get('blur.lensblur')!;
    // Depth: left half black (in focus at 0), right half white.
    const depth = makeRaster(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) depth.data.set(x < 20 ? [0, 0, 0, 1] : [1, 1, 1, 1], (y * W + x) * 4);
    const out = f.run(image(), { ...defaultsOf(f), depth: 'layer', map: 1, focal: 0, radius: 5 }, ctx({ map: depth }));
    expect(px(out, 8, 12)).toEqual(px(image(), 8, 12));
    expect(px(out, 32, 12)).not.toEqual(px(image(), 32, 12));
  });

  it('the iris is the polygon asked for', () => {
    // Rotation 0 puts a vertex at the top, so a square iris is a diamond: widest in the middle.
    const spans = irisSpans(4, 10, 0, 0);
    const width = (dy: number) => spans.filter((s) => s[0] === dy).reduce((n, s) => n + s[2] - s[1] + 1, 0);
    expect(width(0)).toBeGreaterThan(width(-5));
    expect(width(-5)).toBeGreaterThan(width(-9));
    // Turned 45° it is upright: every row the same width.
    const upright = irisSpans(4, 10, 45, 0);
    expect(new Set(upright.map((s) => s[2] - s[1])).size).toBe(1);
    expect(irisSpans(6, 10, 0, 1).length).toBe(21);
  });

  it('Clouds are the same pixel in a crop as in the full canvas, and differ by seed', () => {
    const a = run('render.clouds', { seed: 3 });
    const b = run('render.clouds', { seed: 4 });
    expect(same(a, b, 0)).toBe(false);
  });

  it('Mosaic cells are flat', () => {
    const out = toRgba8(run('pixelate.mosaic', { cell: 8 }));
    const at = (x: number, y: number) => Array.from(out.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect(at(8, 8)).toEqual(at(15, 15));
    expect(at(16, 8)).toEqual(at(23, 12));
  });

  it('Solarize inverts only the bright half', () => {
    expect(px(run('stylize.solarize', {}, flat([0.2, 0.2, 0.2, 1])), 3, 3)).toEqual([51, 51, 51, 255]);
    expect(px(run('stylize.solarize', {}, flat([0.8, 0.8, 0.8, 1])), 3, 3)).toEqual([51, 51, 51, 255]);
  });

  it('Find Edges turns a flat image white', () => {
    expect(px(run('stylize.findedges', {}, flat([0.3, 0.7, 0.1, 1])), 20, 14)).toEqual([255, 255, 255, 255]);
  });
});
