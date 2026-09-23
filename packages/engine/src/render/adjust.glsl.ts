/**
 * Adjustment layers on the GPU — spec 06 §8.
 *
 * Every adjustment in `@umbra/kernels/adjust` has a mirror here. The table-shaped ones (Levels,
 * Curves, Brightness/Contrast, Exposure, Invert, Posterize) are uploaded as their three
 * 256-entry tables and are exact by construction. The rest are transcribed line for line from
 * the kernel, because a 3-D LUT is not good enough: measured against the kernel on 200 000
 * random colours, a 52³ LUT was off by up to 7 levels on a Hue/Saturation hue shift (the
 * function creases along hue-sector boundaries that do not line up with the grid) and a 86³
 * one by 2. The parity suite checks these transcriptions against the kernel.
 *
 * Inputs are quantised to 8 bits first, exactly as `applierToRgbFn` does on the CPU side.
 */
import {
  compile,
  rgbToHsl,
  SELECTIVE_RANGES,
  HUE_BANDS,
  type Adjustment,
} from '@umbra/kernels/adjust';
import { sampleGradient } from '@umbra/kernels/gradient';

export const ADJUST_GLSL = /* glsl */ `
uniform int u_adjKind;
uniform sampler2D u_adjTable;   // 256×1 RGBA32F, values 0…1
uniform vec4 u_adj0;
uniform vec4 u_adj1;
uniform vec4 u_adj2;
uniform vec4 u_adj3;

const int ADJ_TABLE = 0;
const int ADJ_THRESHOLD = 1;
const int ADJ_DESATURATE = 2;
const int ADJ_MIXER = 3;
const int ADJ_HUESAT = 4;
const int ADJ_VIBRANCE = 5;
const int ADJ_BALANCE = 6;
const int ADJ_BLACKWHITE = 7;
const int ADJ_PHOTOFILTER = 8;
const int ADJ_GRADIENTMAP = 9;
const int ADJ_SELECTIVE = 10;

vec3 quantise8(vec3 c) { return floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }

vec3 tableLookup(vec3 c) {
  ivec3 i = ivec3(c * 255.0 + 0.5);
  return vec3(
    texelFetch(u_adjTable, ivec2(i.r, 0), 0).r,
    texelFetch(u_adjTable, ivec2(i.g, 0), 0).g,
    texelFetch(u_adjTable, ivec2(i.b, 0), 0).b
  );
}

vec3 rgbToHsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) / 2.0;
  float d = mx - mn;
  if (d == 0.0) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0)) / 6.0;
  else if (mx == c.g) h = ((c.b - c.r) / d + 2.0) / 6.0;
  else h = ((c.r - c.g) / d + 4.0) / 6.0;
  return vec3(h * 360.0, s, l);
}

float hslChannel(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hslToRgb(float h, float s, float l) {
  if (s == 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float hk = mod(mod(h, 360.0) + 360.0, 360.0) / 360.0;
  return vec3(hslChannel(p, q, hk + 1.0 / 3.0), hslChannel(p, q, hk), hslChannel(p, q, hk - 1.0 / 3.0));
}

float applyLightness(float l, float amount) {
  if (amount == 0.0) return l;
  return amount > 0.0 ? l + (1.0 - l) * (amount / 100.0) : l * (1.0 + amount / 100.0);
}

float wrap360(float v) { return mod(mod(v, 360.0) + 360.0, 360.0); }

float hueBandWeight(float h, vec4 r) {
  float db = wrap360(r.y - r.x);
  float dc = wrap360(r.z - r.x);
  float dd = wrap360(r.w - r.x);
  float dh = wrap360(h - r.x);
  if (dh <= db) return db == 0.0 ? 1.0 : dh / db;
  if (dh <= dc) return 1.0;
  if (dh <= dd) return dd == dc ? 1.0 : (dd - dh) / (dd - dc);
  return 0.0;
}

float balanceWeight(float v, int band) {
  const float a = 0.25;
  const float b = 0.333;
  if (band == 0) return clamp((v - b) / -a + 0.5, 0.0, 1.0);
  if (band == 2) return clamp((v - (1.0 - b)) / a + 0.5, 0.0, 1.0);
  return clamp((v - b) / a + 0.5, 0.0, 1.0) * clamp((v + b - 1.0) / -a + 0.5, 0.0, 1.0);
}

vec3 adjustColor(vec3 c) {
  if (u_adjKind == ADJ_TABLE) return tableLookup(c);

  if (u_adjKind == ADJ_THRESHOLD) {
    return vec3(uLum(c) * 255.0 + 1e-3 >= u_adj0.x ? 1.0 : 0.0);
  }

  if (u_adjKind == ADJ_DESATURATE) {
    return vec3((max(max(c.r, c.g), c.b) + min(min(c.r, c.g), c.b)) / 2.0);
  }

  if (u_adjKind == ADJ_MIXER) {
    return clamp(vec3(
      dot(u_adj0.xyz, c) + u_adj0.w,
      dot(u_adj1.xyz, c) + u_adj1.w,
      dot(u_adj2.xyz, c) + u_adj2.w
    ) / 100.0, 0.0, 1.0);
  }

  if (u_adjKind == ADJ_HUESAT) {
    if (u_adj0.w > 0.5) {
      float lifted = applyLightness(rgbToHsl(c).z, u_adj1.z);
      return hslToRgb(u_adj1.x, u_adj1.y, lifted);
    }
    vec3 hsl = rgbToHsl(c);
    float hue = u_adj0.x;
    float sat = u_adj0.y;
    float light = u_adj0.z;
    // Colour ranges: table texels 2i (the range angles) and 2i+1 (hue, sat, light) for the
    // u_adj1.w bands in use. An achromatic pixel has no hue for them to act on.
    if (hsl.y > 0.0) {
      int n = int(u_adj1.w);
      for (int i = 0; i < 6; i++) {
        if (i >= n) break;
        vec4 r = texelFetch(u_adjTable, ivec2(2 * i, 0), 0);
        vec4 v = texelFetch(u_adjTable, ivec2(2 * i + 1, 0), 0);
        float w = hueBandWeight(hsl.x, r);
        hue += w * v.x;
        sat += w * v.y;
        light += w * v.z;
      }
    }
    float s2 = clamp(hsl.y * (1.0 + clamp(sat, -100.0, 100.0) / 100.0), 0.0, 1.0);
    return hslToRgb(hsl.x + hue, s2, applyLightness(hsl.z, clamp(light, -100.0, 100.0)));
  }

  if (u_adjKind == ADJ_VIBRANCE) {
    vec3 hsl = rgbToHsl(c);
    float skin = max(0.0, 1.0 - abs(hsl.x - 35.0) / 35.0);
    float weight = (1.0 - hsl.y) * (1.0 - 0.5 * skin);
    float s2 = hsl.y * (1.0 + u_adj0.x * weight);
    s2 = s2 * (1.0 + u_adj0.y);
    return hslToRgb(hsl.x, clamp(s2, 0.0, 1.0), hsl.z);
  }

  if (u_adjKind == ADJ_BALANCE) {
    float before = uLum(c);
    vec3 o;
    for (int i = 0; i < 3; i++) {
      float v = c[i];
      float delta =
        balanceWeight(v, 0) * u_adj0[i] +
        balanceWeight(v, 1) * u_adj1[i] +
        balanceWeight(v, 2) * u_adj2[i];
      o[i] = clamp(v + delta * 0.7, 0.0, 1.0);
    }
    return u_adj3.x > 0.5 ? setLum(o, before) : o;
  }

  if (u_adjKind == ADJ_BLACKWHITE) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float mid = c.r + c.g + c.b - mx - mn;
    float primary;
    float secondary;
    if (mx == c.r) {
      primary = u_adj0.x;                                  // reds
      secondary = mn == c.b ? u_adj0.y : u_adj1.y;         // yellows : magentas
    } else if (mx == c.g) {
      primary = u_adj0.z;                                  // greens
      secondary = mn == c.b ? u_adj0.y : u_adj0.w;         // yellows : cyans
    } else {
      primary = u_adj1.x;                                  // blues
      secondary = mn == c.r ? u_adj0.w : u_adj1.y;         // cyans : magentas
    }
    float grey = clamp(mn + (mid - mn) * secondary + (mx - mid) * primary, 0.0, 1.0);
    return u_adj1.z > 0.5 ? hslToRgb(u_adj2.x, u_adj2.y, grey) : vec3(grey);
  }

  if (u_adjKind == ADJ_PHOTOFILTER) {
    float before = uLum(c);
    vec3 o = c + (c * u_adj0.rgb - c) * u_adj0.w;
    if (u_adj1.x > 0.5) o = setLum(o, before);
    return clamp(o, 0.0, 1.0);
  }

  if (u_adjKind == ADJ_SELECTIVE) {
    // Rows 0…8 of the table hold each range's C, M, Y, K as fractions; u_adj0.x = Relative.
    vec3 c8 = floor(c * 255.0 + 0.5);
    float mx = max(max(c8.r, c8.g), c8.b);
    float mn = min(min(c8.r, c8.g), c8.b);
    float md = c8.r + c8.g + c8.b - mx - mn;
    bool white = c8.r > 128.0 && c8.g > 128.0 && c8.b > 128.0;
    bool black = c8.r < 128.0 && c8.g < 128.0 && c8.b < 128.0;
    bool neutral = mx > 0.0 && mn < 255.0;
    vec3 v = c8 / 255.0;
    vec3 shift = vec3(0.0);
    for (int i = 0; i < 9; i++) {
      bool member;
      float scale;
      if (i == 0) { member = c8.r == mx; scale = mx - md; }
      else if (i == 1) { member = c8.b == mn; scale = md - mn; }
      else if (i == 2) { member = c8.g == mx; scale = mx - md; }
      else if (i == 3) { member = c8.r == mn; scale = md - mn; }
      else if (i == 4) { member = c8.b == mx; scale = mx - md; }
      else if (i == 5) { member = c8.g == mn; scale = md - mn; }
      else if (i == 6) { member = white; scale = 2.0 * mn - 255.0; }
      else if (i == 7) { member = neutral; scale = (510.0 - (abs(2.0 * mx - 255.0) + abs(2.0 * mn - 255.0))) / 2.0; }
      else { member = black; scale = 255.0 - 2.0 * mx; }
      if (!member || scale <= 0.0) continue;
      vec4 k = texelFetch(u_adjTable, ivec2(i, 0), 0);
      vec3 res = (-1.0 - k.xyz) * k.w - k.xyz;
      if (u_adj0.x > 0.5) res *= 1.0 - v;
      shift += clamp(res, -v, 1.0 - v) * scale;
    }
    return clamp((c8 + shift) / 255.0, 0.0, 1.0);
  }

  if (u_adjKind == ADJ_GRADIENTMAP) {
    int i = int(floor(clamp(uLum(c), 0.0, 1.0) * 255.0 + 0.5));
    return texelFetch(u_adjTable, ivec2(i, 0), 0).rgb;
  }

  return c;
}
`;

export const ADJ_KIND = {
  table: 0,
  threshold: 1,
  desaturate: 2,
  mixer: 3,
  hueSat: 4,
  vibrance: 5,
  balance: 6,
  blackWhite: 7,
  photoFilter: 8,
  gradientMap: 9,
  selective: 10,
} as const;

/** Uniform payload for one adjustment. `table` is 256 RGBA texels, or null. */
export interface GpuAdjustment {
  kind: number;
  table: Float32Array | null;
  /** Four vec4s: u_adj0…u_adj3. */
  params: Float32Array;
}

export function toGpuAdjustment(adj: Adjustment): GpuAdjustment {
  const params = new Float32Array(16);
  const set = (i: number, ...v: number[]) => params.set(v, i * 4);

  switch (adj.kind) {
    case 'threshold':
      set(0, adj.level);
      return { kind: ADJ_KIND.threshold, table: null, params };
    case 'desaturate':
      return { kind: ADJ_KIND.desaturate, table: null, params };
    case 'channelMixer': {
      const rows = adj.monochrome ? [adj.r, adj.r, adj.r] : [adj.r, adj.g, adj.b];
      rows.forEach((row, i) => set(i, row.r, row.g, row.b, row.constant));
      return { kind: ADJ_KIND.mixer, table: null, params };
    }
    case 'hueSaturation': {
      const bands = adj.bands
        ? HUE_BANDS.map((n) => adj.bands![n]).filter((b) => b.hue !== 0 || b.saturation !== 0 || b.lightness !== 0)
        : [];
      set(0, adj.master.hue, adj.master.saturation, adj.master.lightness, adj.colorize ? 1 : 0);
      set(1, adj.colorizeHue, Math.min(1, Math.max(0, adj.colorizeSaturation / 100)), adj.colorizeLightness, bands.length);
      let table: Float32Array | null = null;
      if (bands.length) {
        table = new Float32Array(256 * 4);
        bands.forEach((b, i) => {
          table!.set(b.range, 8 * i);
          table!.set([b.hue, b.saturation, b.lightness, 0], 8 * i + 4);
        });
      }
      return { kind: ADJ_KIND.hueSat, table, params };
    }
    case 'vibrance':
      set(0, adj.vibrance / 100, adj.saturation / 100);
      return { kind: ADJ_KIND.vibrance, table: null, params };
    case 'colorBalance': {
      const band = (b: typeof adj.shadows) => [b.cyanRed / 100, b.magentaGreen / 100, b.yellowBlue / 100];
      set(0, ...band(adj.shadows));
      set(1, ...band(adj.midtones));
      set(2, ...band(adj.highlights));
      set(3, adj.preserveLuminosity ? 1 : 0);
      return { kind: ADJ_KIND.balance, table: null, params };
    }
    case 'blackWhite': {
      set(0, adj.reds / 100, adj.yellows / 100, adj.greens / 100, adj.cyans / 100);
      set(1, adj.blues / 100, adj.magentas / 100, adj.tint ? 1 : 0);
      if (adj.tint) {
        const [h, s] = rgbToHsl(adj.tint[0], adj.tint[1], adj.tint[2]);
        set(2, h, s);
      }
      return { kind: ADJ_KIND.blackWhite, table: null, params };
    }
    case 'photoFilter':
      set(0, adj.color[0], adj.color[1], adj.color[2], Math.min(1, Math.max(0, adj.density / 100)));
      set(1, adj.preserveLuminosity ? 1 : 0);
      return { kind: ADJ_KIND.photoFilter, table: null, params };
    case 'selectiveColor': {
      const table = new Float32Array(256 * 4);
      SELECTIVE_RANGES.forEach((r, i) => {
        const s = adj.ranges[r];
        table.set([s.c / 100, s.m / 100, s.y / 100, s.k / 100], i * 4);
      });
      set(0, adj.relative ? 1 : 0);
      return { kind: ADJ_KIND.selective, table, params };
    }
    case 'gradientMap': {
      const table = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = sampleGradient(adj.gradient, adj.reverse ? 1 - i / 255 : i / 255);
        table.set([r, g, b, 1], i * 4);
      }
      return { kind: ADJ_KIND.gradientMap, table, params };
    }
    default: {
      const applier = compile(adj);
      if (applier.shape !== 'lut') throw new Error(`no GPU form for ${adj.kind}`);
      const table = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        table[i * 4] = applier.r[i]! / 255;
        table[i * 4 + 1] = applier.g[i]! / 255;
        table[i * 4 + 2] = applier.b[i]! / 255;
        table[i * 4 + 3] = 1;
      }
      return { kind: ADJ_KIND.table, table, params };
    }
  }
}
