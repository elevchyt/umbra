/**
 * Filter Gallery ▸ Sketch (14) — spec 05 §B.10. Most redraw the image in the foreground
 * (ink) and background (paper) colours, as Photoshop's do; Chrome is grey and Water Paper
 * keeps its colour. [fit] throughout: see artistic.ts.
 */
import { clamp01, hash2 } from '../core.js';
import { lineBlur } from '../blur.js';
import { fbm } from '../render.js';
import { bool, num, str, type GalleryEffect } from '../types.js';
import { DIRECTION_OPTIONS, directionAngle } from './brush.js';
import { blurPad, blurPlane, duotone, eachPixel, grey, hatch, keepAlpha, lightAngle, lightParam, luma, noiseAt, shade, smoothstep, sobel, textureParams, texturize } from './kit.js';

export const basRelief: GalleryEffect = {
  id: 'gallery.basRelief',
  label: 'Bas Relief',
  category: 'Sketch',
  params: [
    { key: 'detail', label: 'Detail', type: 'number', min: 1, max: 15, default: 13 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 3 },
    lightParam('bottom'),
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.4 + (15 - num(p, 'detail')) * 0.15) + 1,
  model: '[fit] the smoothed luminance lit as a carved relief, dark faces in the foreground colour and lit ones in the background colour.',
  run: (src, p, ctx) => {
    const w = src.width;
    const h = src.height;
    const l = luma(src);
    const hf = blurPlane(l, w, h, num(p, 'smoothness') * 0.4 + (15 - num(p, 'detail')) * 0.15);
    const s = shade(hf, w, h, lightAngle(str(p, 'light')), 12);
    const v = s.map((x, i) => x + (l[i]! - 0.5) * 0.3);
    return duotone(src, v, ctx);
  },
};

export const chalkCharcoal: GalleryEffect = {
  id: 'gallery.chalkCharcoal',
  label: 'Chalk & Charcoal',
  category: 'Sketch',
  params: [
    { key: 'charcoal', label: 'Charcoal Area', type: 'number', min: 0, max: 20, default: 6 },
    { key: 'chalk', label: 'Chalk Area', type: 'number', min: 0, max: 20, default: 6 },
    { key: 'pressure', label: 'Stroke Pressure', type: 'number', min: 0, max: 5, default: 1 },
  ],
  pad: () => 0,
  model: 'Documented look, [fit] mechanics: a mid-grey ground; shadows redrawn in diagonal charcoal strokes (foreground), lights in coarse chalk (background).',
  run: (src, p, ctx) => {
    const C = num(p, 'charcoal') / 20;
    const K = num(p, 'chalk') / 20;
    const P = 0.8 + num(p, 'pressure') * 0.1;
    const l = luma(src);
    const v = new Float32Array(l.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = y * src.width + x;
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        const pc = clamp01((0.55 - l[i]!) * 2.2 * (0.5 + C) * P);
        const pk = clamp01((l[i]! - 0.4) * 2.2 * (0.5 + K) * P);
        let t = 0.5;
        if (hatch(gx, gy, 45, 8, 137) < pc) t = 0;
        else if (hatch(gx, gy, -45, 5, 139) < pk) t = 1;
        v[i] = t;
      }
    }
    return duotone(src, v, ctx);
  },
};

export const charcoal: GalleryEffect = {
  id: 'gallery.charcoal',
  label: 'Charcoal',
  category: 'Sketch',
  params: [
    { key: 'thickness', label: 'Charcoal Thickness', type: 'number', min: 1, max: 7, default: 1 },
    { key: 'detail', label: 'Detail', type: 'number', min: 0, max: 5, default: 5 },
    { key: 'balance', label: 'Light/Dark Balance', type: 'number', min: 0, max: 100, default: 50 },
  ],
  pad: () => 1,
  model: '[fit] smudged diagonal charcoal strokes (foreground) on paper (background): density from darkness shifted by Balance, main edges drawn by Detail.',
  run: (src, p, ctx) => {
    const T = num(p, 'thickness');
    const D = num(p, 'detail') / 5;
    const bal = (num(p, 'balance') - 50) / 100;
    const l = luma(src);
    const { mag } = sobel(l, src.width, src.height);
    const v = new Float32Array(l.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = y * src.width + x;
        const d = clamp01(1 - l[i]! + bal) * 0.9 + clamp01(mag[i]! * 4 * D);
        const hv = hatch((x + ctx.originX) / T, (y + ctx.originY) / T, 45, 6, 149);
        v[i] = smoothstep(d - 0.12, d + 0.12, hv);
      }
    }
    return duotone(src, v, ctx);
  },
};

export const chrome: GalleryEffect = {
  id: 'gallery.chrome',
  label: 'Chrome',
  category: 'Sketch',
  params: [
    { key: 'detail', label: 'Detail', type: 'number', min: 0, max: 10, default: 4 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 0, max: 10, default: 7 },
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.5 + (10 - num(p, 'detail')) * 0.2 + 0.5) + 1,
  model: '[fit] the smoothed luminance as a polished surface: its value and lighting folded through a cosine, so it reflects in bands of grey.',
  run: (src, p) => {
    const w = src.width;
    const h = src.height;
    const hf = blurPlane(luma(src), w, h, num(p, 'smoothness') * 0.5 + (10 - num(p, 'detail')) * 0.2 + 0.5);
    const s = shade(hf, w, h, 135, 10);
    const v = hf.map((x, i) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (x * 1.5 + s[i]! - 0.5)));
    return grey(src, v);
  },
};

export const conteCrayon: GalleryEffect = {
  id: 'gallery.conteCrayon',
  label: 'Conté Crayon',
  category: 'Sketch',
  params: [
    { key: 'fgLevel', label: 'Foreground Level', type: 'number', min: 1, max: 15, default: 11 },
    { key: 'bgLevel', label: 'Background Level', type: 'number', min: 1, max: 15, default: 7 },
    ...textureParams(4),
  ],
  pad: () => 0,
  model: '[fit] darks in the foreground colour (Foreground Level), lights in the background colour (Background Level), a mid-tone paper between, texturized.',
  run: (src, p, ctx) => {
    const F = num(p, 'fgLevel') / 15;
    const B = num(p, 'bgLevel') / 15;
    const v = luma(src).map((l) => 0.5 - 0.5 * clamp01((0.5 - l) * 2.5) * F + 0.5 * clamp01((l - 0.5) * 2.5) * B);
    return texturize(duotone(src, v, ctx), ctx, str(p, 'texture'), num(p, 'scaling'), num(p, 'relief'), lightAngle(str(p, 'light')), bool(p, 'invert'));
  },
};

export const graphicPen: GalleryEffect = {
  id: 'gallery.graphicPen',
  label: 'Graphic Pen',
  category: 'Sketch',
  params: [
    { key: 'length', label: 'Stroke Length', type: 'number', min: 1, max: 15, default: 15 },
    { key: 'balance', label: 'Light/Dark Balance', type: 'number', min: 0, max: 100, default: 50 },
    { key: 'direction', label: 'Stroke Direction', type: 'select', default: 'rightDiagonal', options: DIRECTION_OPTIONS },
  ],
  pad: () => 0,
  model: '[fit] fine ink strokes (foreground) on paper (background): a stroke is inked where its random level is under the darkness, shifted by Balance.',
  run: (src, p, ctx) => {
    const len = num(p, 'length');
    const bal = num(p, 'balance') / 100 - 0.5;
    const ang = directionAngle(str(p, 'direction'));
    const l = luma(src);
    const v = new Float32Array(l.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = y * src.width + x;
        v[i] = hatch(x + ctx.originX, y + ctx.originY, ang, len, 151) < clamp01(1 - l[i]! + bal) ? 0 : 1;
      }
    }
    return duotone(src, v, ctx);
  },
};

export const halftonePattern: GalleryEffect = {
  id: 'gallery.halftonePattern',
  label: 'Halftone Pattern',
  category: 'Sketch',
  params: [
    { key: 'size', label: 'Size', type: 'number', min: 1, max: 12, default: 1 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 50, default: 5 },
    {
      key: 'pattern',
      label: 'Pattern Type',
      type: 'select',
      default: 'dot',
      options: [
        { value: 'circle', label: 'Circle' },
        { value: 'dot', label: 'Dot' },
        { value: 'line', label: 'Line' },
      ],
    },
  ],
  pad: () => 0,
  model: '[fit] an amplitude-modulated screen in the foreground and background colours: round dots, horizontal lines, or rings about the canvas centre; cell 3 + 2 × Size px.',
  run: (src, p, ctx) => {
    const cell = 3 + 2 * num(p, 'size');
    const C = 1 + num(p, 'contrast') / 10;
    const kind = str(p, 'pattern');
    const cx = ctx.docWidth / 2;
    const cy = ctx.docHeight / 2;
    const l = luma(src);
    const v = new Float32Array(l.length);
    const aa = 1 / cell;
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = y * src.width + x;
        const gx = x + ctx.originX + 0.5;
        const gy = y + ctx.originY + 0.5;
        const ink = clamp01(0.5 - (l[i]! - 0.5) * C);
        let d: number;
        let r: number;
        if (kind === 'line') {
          d = Math.abs(gy / cell - Math.floor(gy / cell) - 0.5) * 2;
          r = ink;
        } else if (kind === 'circle') {
          const q = Math.hypot(gx - cx, gy - cy) / cell;
          d = Math.abs(q - Math.floor(q) - 0.5) * 2;
          r = ink;
        } else {
          const fx = gx / cell - Math.floor(gx / cell) - 0.5;
          const fy = gy / cell - Math.floor(gy / cell) - 0.5;
          d = Math.hypot(fx, fy) * Math.SQRT2;
          r = Math.sqrt(ink);
        }
        v[i] = smoothstep(r - aa, r + aa, d);
      }
    }
    return duotone(src, v, ctx);
  },
};

export const notePaper: GalleryEffect = {
  id: 'gallery.notePaper',
  label: 'Note Paper',
  category: 'Sketch',
  params: [
    { key: 'balance', label: 'Image Balance', type: 'number', min: 0, max: 50, default: 25 },
    { key: 'graininess', label: 'Graininess', type: 'number', min: 0, max: 20, default: 10 },
    { key: 'relief', label: 'Relief', type: 'number', min: 0, max: 25, default: 11 },
  ],
  pad: () => blurPad(1.5) + 1,
  model: '[fit] the image thresholded at Image Balance and embossed into grainy handmade paper: dark areas in the foreground colour, raised; paper in the background colour.',
  run: (src, p, ctx) => {
    const w = src.width;
    const h = src.height;
    const t = num(p, 'balance') / 50;
    const G = num(p, 'graininess') / 20;
    const R = num(p, 'relief') / 25;
    const m = luma(src).map((l) => smoothstep(t - 0.04, t + 0.04, l));
    const s = shade(blurPlane(m, w, h, 1.5), w, h, 135, 8 * R + 0.01);
    const v = new Float32Array(m.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const grain = (hash2(x + ctx.originX, y + ctx.originY, 157) - 0.5) * G * 0.25;
        v[i] = 0.3 + m[i]! * 0.55 + (s[i]! - 0.5) * R * 1.2 + grain;
      }
    }
    return duotone(src, v, ctx);
  },
};

export const photocopy: GalleryEffect = {
  id: 'gallery.photocopy',
  label: 'Photocopy',
  category: 'Sketch',
  params: [
    { key: 'detail', label: 'Detail', type: 'number', min: 1, max: 24, default: 7 },
    { key: 'darkness', label: 'Darkness', type: 'number', min: 1, max: 50, default: 8 },
  ],
  pad: (p) => blurPad(1 + num(p, 'detail') * 0.4),
  model: '[fit] toner where a pixel is darker than its neighbourhood (a high-pass of radius from Detail), darker with Darkness; flat areas copy as paper.',
  run: (src, p, ctx) => {
    const l = luma(src);
    const m = blurPlane(l, src.width, src.height, 1 + num(p, 'detail') * 0.4);
    const D = num(p, 'darkness');
    return duotone(src, l.map((x, i) => 1 - clamp01((m[i]! - x) * D * 0.8 + (0.25 - x) * D * 0.05)), ctx);
  },
};

export const plaster: GalleryEffect = {
  id: 'gallery.plaster',
  label: 'Plaster',
  category: 'Sketch',
  params: [
    { key: 'balance', label: 'Image Balance', type: 'number', min: 0, max: 50, default: 20 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 2 },
    lightParam('top'),
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.6 + 0.5) + 1,
  model: '[fit] the image thresholded at Image Balance and moulded: dark areas raised and lit, light areas sunk; foreground and background colours.',
  run: (src, p, ctx) => {
    const w = src.width;
    const h = src.height;
    const t = num(p, 'balance') / 50;
    const hf = blurPlane(
      luma(src).map((l) => 1 - smoothstep(t - 0.05, t + 0.05, l)),
      w,
      h,
      num(p, 'smoothness') * 0.6 + 0.5,
    );
    const s = shade(hf, w, h, lightAngle(str(p, 'light')), 14);
    return duotone(src, hf.map((x, i) => 0.55 + (s[i]! - 0.5) * 1.6 - x * 0.35), ctx);
  },
};

export const reticulation: GalleryEffect = {
  id: 'gallery.reticulation',
  label: 'Reticulation',
  category: 'Sketch',
  params: [
    { key: 'density', label: 'Density', type: 'number', min: 0, max: 50, default: 12 },
    { key: 'fgLevel', label: 'Foreground Level', type: 'number', min: 0, max: 50, default: 40 },
    { key: 'bgLevel', label: 'Background Level', type: 'number', min: 0, max: 50, default: 5 },
  ],
  pad: () => 0,
  model: '[fit] clumped grain (film emulsion shrinking): clumps in the shadows, grain in the highlights, thresholded against the luminance.',
  run: (src, p, ctx) => {
    const D = num(p, 'density') / 50;
    const F = num(p, 'fgLevel') / 50;
    const B = num(p, 'bgLevel') / 50;
    const l = luma(src);
    const v = new Float32Array(l.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = y * src.width + x;
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        const n = fbm(gx, gy, 3, 163) * 0.6 + hash2(gx, gy, 167) * 0.4;
        const th = 0.5 + (n - 0.5) * (0.4 + D * 1.2);
        const on = smoothstep(th - 0.03, th + 0.03, l[i]!);
        v[i] = on * (1 - B * 0.5) + (1 - on) * (0.5 - F * 0.5);
      }
    }
    return duotone(src, v, ctx);
  },
};

export const stamp: GalleryEffect = {
  id: 'gallery.stamp',
  label: 'Stamp',
  category: 'Sketch',
  params: [
    { key: 'balance', label: 'Light/Dark Balance', type: 'number', min: 0, max: 50, default: 25 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 50, default: 5 },
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.25),
  model: '[fit] the smoothed luminance thresholded at Balance, like a rubber stamp: foreground ink on background paper.',
  run: (src, p, ctx) => {
    const t = num(p, 'balance') / 50;
    const b = blurPlane(luma(src), src.width, src.height, num(p, 'smoothness') * 0.25);
    return duotone(src, b.map((x) => smoothstep(t - 0.02, t + 0.02, x)), ctx);
  },
};

export const tornEdges: GalleryEffect = {
  id: 'gallery.tornEdges',
  label: 'Torn Edges',
  category: 'Sketch',
  params: [
    { key: 'balance', label: 'Image Balance', type: 'number', min: 0, max: 50, default: 25 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 11 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 1, max: 25, default: 17 },
  ],
  pad: () => blurPad(1),
  model: '[fit] a threshold at Image Balance whose edge is torn by noise (rougher at low Smoothness), softness from Contrast.',
  run: (src, p, ctx) => {
    const t = num(p, 'balance') / 50;
    const rough = (16 - num(p, 'smoothness')) / 50;
    const wdt = 0.3 / num(p, 'contrast');
    const b = blurPlane(luma(src), src.width, src.height, 1);
    const v = new Float32Array(b.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = y * src.width + x;
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        const th = t + (fbm(gx, gy, 4, 173) - 0.5) * rough * 2 + noiseAt(gx, gy, 179) * rough * 0.5;
        v[i] = smoothstep(th - wdt, th + wdt, b[i]!);
      }
    }
    return duotone(src, v, ctx);
  },
};

export const waterPaper: GalleryEffect = {
  id: 'gallery.waterPaper',
  label: 'Water Paper',
  category: 'Sketch',
  params: [
    { key: 'length', label: 'Fiber Length', type: 'number', min: 3, max: 50, default: 15 },
    { key: 'brightness', label: 'Brightness', type: 'number', min: 0, max: 100, default: 60 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 100, default: 80 },
  ],
  pad: (p) => Math.ceil(num(p, 'length') / 2) + 2,
  model: '[fit] colour bled along paper fibres — horizontal and vertical smears of Fiber Length mixed by a blotchy fibre pattern — with Brightness and Contrast.',
  run: (src, p, ctx) => {
    const len = num(p, 'length');
    const a = keepAlpha(src, lineBlur(src, 0, len));
    const b = keepAlpha(src, lineBlur(src, 90, len));
    const Br = (num(p, 'brightness') - 60) / 100;
    const C = num(p, 'contrast') / 80;
    return eachPixel(src, (px, i, x, y) => {
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      const k = smoothstep(0.3, 0.7, fbm(gx, gy, 6, 181) * 0.7 + hash2(Math.floor(gx / 3), gy, 183) * 0.3);
      const aa = a.data[i * 4 + 3]!;
      for (let c = 0; c < 3; c++) {
        const m = aa > 0 ? (a.data[i * 4 + c]! * k + b.data[i * 4 + c]! * (1 - k)) / aa : px[c]!;
        px[c] = 0.5 + (m - 0.5) * C + Br;
      }
    });
  },
};

export const SKETCH: GalleryEffect[] = [
  basRelief,
  chalkCharcoal,
  charcoal,
  chrome,
  conteCrayon,
  graphicPen,
  halftonePattern,
  notePaper,
  photocopy,
  plaster,
  reticulation,
  stamp,
  tornEdges,
  waterPaper,
];
