/**
 * GLSL blend library — the GPU mirror of `@umbra/kernels/blend`.
 *
 * Every function here must agree with the CPU reference to within ±1/255; the M2 parity suite
 * renders both and diffs them (spec 03 §5.3). When a formula changes, it changes in BOTH
 * places or the suite fails, which is the point.
 *
 * Mode numbers are indices into `BLEND_MODES` from @umbra/core/blend.
 */
import { BLEND_MODES } from '@umbra/core/blend';

export const BLEND_MODE_INDEX: Record<string, number> = Object.fromEntries(
  BLEND_MODES.map((m, i) => [m, i]),
);

/** Shared GLSL: blend functions + the general compositing equation. */
export const BLEND_GLSL = /* glsl */ `
const int M_NORMAL        = ${BLEND_MODE_INDEX.normal};
const int M_DISSOLVE      = ${BLEND_MODE_INDEX.dissolve};
const int M_DARKEN        = ${BLEND_MODE_INDEX.darken};
const int M_MULTIPLY      = ${BLEND_MODE_INDEX.multiply};
const int M_COLOR_BURN    = ${BLEND_MODE_INDEX.colorBurn};
const int M_LINEAR_BURN   = ${BLEND_MODE_INDEX.linearBurn};
const int M_DARKER_COLOR  = ${BLEND_MODE_INDEX.darkerColor};
const int M_LIGHTEN       = ${BLEND_MODE_INDEX.lighten};
const int M_SCREEN        = ${BLEND_MODE_INDEX.screen};
const int M_COLOR_DODGE   = ${BLEND_MODE_INDEX.colorDodge};
const int M_LINEAR_DODGE  = ${BLEND_MODE_INDEX.linearDodge};
const int M_LIGHTER_COLOR = ${BLEND_MODE_INDEX.lighterColor};
const int M_OVERLAY       = ${BLEND_MODE_INDEX.overlay};
const int M_SOFT_LIGHT    = ${BLEND_MODE_INDEX.softLight};
const int M_HARD_LIGHT    = ${BLEND_MODE_INDEX.hardLight};
const int M_VIVID_LIGHT   = ${BLEND_MODE_INDEX.vividLight};
const int M_LINEAR_LIGHT  = ${BLEND_MODE_INDEX.linearLight};
const int M_PIN_LIGHT     = ${BLEND_MODE_INDEX.pinLight};
const int M_HARD_MIX      = ${BLEND_MODE_INDEX.hardMix};
const int M_DIFFERENCE    = ${BLEND_MODE_INDEX.difference};
const int M_EXCLUSION     = ${BLEND_MODE_INDEX.exclusion};
const int M_SUBTRACT      = ${BLEND_MODE_INDEX.subtract};
const int M_DIVIDE        = ${BLEND_MODE_INDEX.divide};
const int M_HUE           = ${BLEND_MODE_INDEX.hue};
const int M_SATURATION    = ${BLEND_MODE_INDEX.saturation};
const int M_COLOR         = ${BLEND_MODE_INDEX.color};
const int M_LUMINOSITY    = ${BLEND_MODE_INDEX.luminosity};

float bColorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}

float bColorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}

float bHardLight(float b, float s) {
  return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
}

float bSoftLight(float b, float s) {
  return s <= 0.5
    ? 2.0 * b * s + b * b * (1.0 - 2.0 * s)
    : 2.0 * b * (1.0 - s) + sqrt(b) * (2.0 * s - 1.0);
}

float bDivide(float b, float s) {
  return s <= 0.0 ? 1.0 : min(1.0, b / s);
}

/** Per-channel blend. Non-separable modes are handled by blendRgb below. */
float blendChannel(int mode, float b, float s) {
  if (mode == M_MULTIPLY)      return b * s;
  if (mode == M_SCREEN)        return b + s - b * s;
  if (mode == M_DARKEN)        return min(b, s);
  if (mode == M_LIGHTEN)       return max(b, s);
  if (mode == M_COLOR_BURN)    return bColorBurn(b, s);
  if (mode == M_LINEAR_BURN)   return max(0.0, b + s - 1.0);
  if (mode == M_COLOR_DODGE)   return bColorDodge(b, s);
  if (mode == M_LINEAR_DODGE)  return min(1.0, b + s);
  if (mode == M_OVERLAY)       return bHardLight(s, b);
  if (mode == M_SOFT_LIGHT)    return bSoftLight(b, s);
  if (mode == M_HARD_LIGHT)    return bHardLight(b, s);
  if (mode == M_VIVID_LIGHT)   return s <= 0.5 ? bColorBurn(b, 2.0 * s) : bColorDodge(b, 2.0 * s - 1.0);
  if (mode == M_LINEAR_LIGHT)  return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (mode == M_PIN_LIGHT)     return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
  if (mode == M_HARD_MIX)      return (b + s >= 1.0) ? 1.0 : 0.0;
  if (mode == M_DIFFERENCE)    return abs(b - s);
  if (mode == M_EXCLUSION)     return b + s - 2.0 * b * s;
  if (mode == M_SUBTRACT)      return max(0.0, b - s);
  if (mode == M_DIVIDE)        return bDivide(b, s);
  return s; // Normal, Dissolve
}

float uLum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

vec3 clipColor(vec3 c) {
  float l = uLum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) {
    float d = l - n;
    c = (d == 0.0) ? vec3(l) : l + (c - l) * l / d;
  }
  if (x > 1.0) {
    float d = x - l;
    c = (d == 0.0) ? vec3(l) : l + (c - l) * (1.0 - l) / d;
  }
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - uLum(c))); }

float uSat(vec3 c) {
  return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

vec3 setSat(vec3 c, float s) {
  float cmax = max(max(c.r, c.g), c.b);
  float cmin = min(min(c.r, c.g), c.b);
  float cmid = c.r + c.g + c.b - cmax - cmin;
  float mid = (cmax > cmin) ? ((cmid - cmin) * s / (cmax - cmin)) : 0.0;
  float hi = (cmax > cmin) ? s : 0.0;
  // Rebuild in the original channel order.
  vec3 o;
  o.r = (c.r == cmax) ? hi : ((c.r == cmin) ? 0.0 : mid);
  o.g = (c.g == cmax) ? hi : ((c.g == cmin) ? 0.0 : mid);
  o.b = (c.b == cmax) ? hi : ((c.b == cmin) ? 0.0 : mid);
  // Guard against ties, where two channels can both look like the max.
  if (c.r == c.g && c.g == c.b) o = vec3(0.0);
  return o;
}

vec3 blendRgb(int mode, vec3 b, vec3 s) {
  if (mode == M_HUE)           return setLum(setSat(s, uSat(b)), uLum(b));
  if (mode == M_SATURATION)    return setLum(setSat(b, uSat(s)), uLum(b));
  if (mode == M_COLOR)         return setLum(s, uLum(b));
  if (mode == M_LUMINOSITY)    return setLum(b, uLum(s));
  if (mode == M_DARKER_COLOR)  return uLum(s) < uLum(b) ? s : b;
  if (mode == M_LIGHTER_COLOR) return uLum(s) > uLum(b) ? s : b;
  return vec3(
    blendChannel(mode, b.r, s.r),
    blendChannel(mode, b.g, s.g),
    blendChannel(mode, b.b, s.b)
  );
}

/**
 * The general compositing equation (spec 06 §1) on STRAIGHT-alpha values.
 * Accumulators hold straight alpha so the GPU result can be compared to the CPU reference
 * without a premultiply round trip losing precision.
 */
vec4 compositeOver(int mode, vec4 backdrop, vec4 source) {
  float ab = backdrop.a;
  float as = source.a;
  float ar = as + ab * (1.0 - as);
  if (ar <= 0.0) return vec4(0.0);
  vec3 blended = blendRgb(mode, backdrop.rgb, source.rgb);
  vec3 mixed = (1.0 - ab) * source.rgb + ab * blended;
  vec3 col = ((1.0 - as) * ab * backdrop.rgb + as * mixed) / ar;
  return vec4(col, ar);
}

/** Position-stable hash, matching kernels/blend.ts dissolveNoise. */
float dissolveNoise(vec2 p, float seed) {
  int x = int(p.x);
  int y = int(p.y);
  int h = x * 374761393 + y * 668265263 + int(seed) * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return float(uint(h)) / 4294967296.0;
}

/** Trapezoidal Blend If weight (spec 06 §5). */
float rampWeight(float v, vec4 stops) {
  if (v < stops.x) return 0.0;
  if (v < stops.y) return stops.y == stops.x ? 1.0 : (v - stops.x) / (stops.y - stops.x);
  if (v <= stops.z) return 1.0;
  if (v <= stops.w) return stops.w == stops.z ? 0.0 : 1.0 - (v - stops.z) / (stops.w - stops.z);
  return 0.0;
}
`;

/** Neutral source colour per special-fill mode; -1 means "not a special mode". */
export const SPECIAL_FILL_GLSL = /* glsl */ `
float specialFillNeutral(int mode) {
  if (mode == M_COLOR_BURN || mode == M_LINEAR_BURN) return 1.0;
  if (mode == M_COLOR_DODGE || mode == M_LINEAR_DODGE || mode == M_DIFFERENCE) return 0.0;
  if (mode == M_VIVID_LIGHT || mode == M_LINEAR_LIGHT || mode == M_HARD_MIX) return 0.5;
  return -1.0;
}

float hardMixWithFill(float b, float s, float fill) {
  if (fill >= 1.0) return (b + s >= 1.0) ? 1.0 : 0.0;
  return clamp((b + fill * s - fill) / (1.0 - fill), 0.0, 1.0);
}
`;
