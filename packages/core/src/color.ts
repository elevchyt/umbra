/**
 * Colour conversions for the UI (picker, Color panel, Info readouts).
 *
 * Values are 0…1 unless a function says otherwise. These are sRGB/D50-Lab conversions good
 * enough for the interface; document colour management goes through ICC transforms in M10 and
 * does NOT use this module.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}
export interface HSB {
  h: number; // 0…360
  s: number; // 0…100
  b: number; // 0…100
}
export interface LAB {
  l: number; // 0…100
  a: number; // −128…127
  b: number;
}
export interface CMYK {
  c: number;
  m: number;
  y: number;
  k: number; // each 0…100
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function hexToRgb(hex: string): RGB | null {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
}

export function rgbToCss(c: RGB): string {
  return `#${rgbToHex(c)}`;
}

export function rgbToHsb({ r, g, b }: RGB): HSB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : (d / max) * 100, b: max * 100 };
}

export function hsbToRgb({ h, s, b }: HSB): RGB {
  const S = s / 100;
  const V = b / 100;
  const c = V * S;
  const hh = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = V - c;
  const seg = Math.floor(hh / 60) % 6;
  const t: [number, number, number] =
    seg === 0 ? [c, x, 0]
    : seg === 1 ? [x, c, 0]
    : seg === 2 ? [0, c, x]
    : seg === 3 ? [0, x, c]
    : seg === 4 ? [x, 0, c]
    : [c, 0, x];
  return { r: t[0] + m, g: t[1] + m, b: t[2] + m };
}

/** sRGB transfer function (encoded → linear). */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Relative luminance, used for contrast decisions in the UI. */
export function luminance(c: RGB): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

// D65 white point, matching sRGB.
const Xn = 0.95047;
const Yn = 1;
const Zn = 1.08883;

export function rgbToLab(c: RGB): LAB {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / Xn;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / Yn;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / Zn;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb({ l, a, b }: LAB): RGB {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * Xn;
  const y = inv(fy) * Yn;
  const z = inv(fz) * Zn;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return { r: clamp01(linearToSrgb(rl)), g: clamp01(linearToSrgb(gl)), b: clamp01(linearToSrgb(bl)) };
}

/**
 * Naive CMYK, for the picker's readout only. Real CMYK goes through an ICC profile (M10);
 * this is the same "no profile" arithmetic every editor shows before one is assigned.
 */
export function rgbToCmyk({ r, g, b }: RGB): CMYK {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  const d = 1 - k;
  return { c: ((1 - r - k) / d) * 100, m: ((1 - g - k) / d) * 100, y: ((1 - b - k) / d) * 100, k: k * 100 };
}

export function cmykToRgb({ c, m, y, k }: CMYK): RGB {
  const K = k / 100;
  return {
    r: clamp01((1 - c / 100) * (1 - K)),
    g: clamp01((1 - m / 100) * (1 - K)),
    b: clamp01((1 - y / 100) * (1 - K)),
  };
}

/** True when the colour cannot be reproduced in a naive CMYK gamut — drives the ⚠ marker. */
export function outOfCmykGamut(c: RGB): boolean {
  const back = cmykToRgb(rgbToCmyk(c));
  return Math.abs(back.r - c.r) + Math.abs(back.g - c.g) + Math.abs(back.b - c.b) > 0.02;
}

export function isWebSafe(c: RGB): boolean {
  const ok = (v: number) => Math.abs(Math.round((v * 255) / 51) * 51 - v * 255) < 1;
  return ok(c.r) && ok(c.g) && ok(c.b);
}

export function nearestWebSafe(c: RGB): RGB {
  const q = (v: number) => (Math.round((v * 255) / 51) * 51) / 255;
  return { r: q(c.r), g: q(c.g), b: q(c.b) };
}

export const BLACK: RGB = { r: 0, g: 0, b: 0 };
export const WHITE: RGB = { r: 1, g: 1, b: 1 };
