/**
 * The GPU dab pass — spec 04 §4.1's dab rasteriser: the computed round tip or a sampled tip,
 * masked by the dual brush, textured, with noise, confined to the selection. The CPU reference
 * is `dabAlpha` in `@umbra/kernels/brush`; the two follow the same steps.
 *
 * Dabs render directly into the atlas slice of the target tile, so painting never reads a
 * tile back to the CPU mid-stroke. The tile store stays authoritative: `readbackTile` copies
 * the result back at stroke end, which is also what makes the stroke survive a context loss.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { Program } from '../gpu/program.js';
import { TileAtlas } from '../gpu/atlas.js';
import type { Tile } from '../tiles/plane.js';

const DAB_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform vec4 u_rect;   // dab bounds in tile-local px: x0,y0,x1,y1
out vec2 v_local;      // position in tile-local px
void main() {
  vec2 p = mix(u_rect.xy, u_rect.zw, a_corner);
  v_local = p;
  vec2 ndc = (p / float(${TILE_SIZE})) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const DAB_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_local;
uniform vec2 u_centre;     // tile-local px
uniform float u_radius;
uniform float u_hardness;
uniform float u_angle;     // tip rotation, radians
uniform float u_roundness; // 1 is a circle
uniform vec2 u_flip;       // ±1 per axis
uniform vec4 u_color;      // straight alpha
uniform sampler2D u_selection;
uniform float u_useSelection;
uniform vec2 u_selectionSize;
uniform vec2 u_tileOrigin;  // document coords of this tile's top-left
// Sampled tips: a layer of the tip array, and the tip's aspect factors (longest side / side).
uniform sampler2DArray u_tips;
uniform float u_tipLayer;   // < 0: the computed round tip
uniform vec2 u_tipAspect;
// Dual brush: up to eight stamps (x, y, radius, angle in tile-local px), their roundness and
// flips, the secondary tip, hardness and how it combines.
uniform int u_dualCount;
uniform vec4 u_dual[8];
uniform vec4 u_dualExtra[8];  // roundness, flipX, flipY, -
uniform float u_dualTipLayer;
uniform vec2 u_dualAspect;
uniform float u_dualHardness;
uniform int u_dualMode;
// Texture: a luminance pattern repeating in document space.
uniform float u_texOn;
uniform sampler2D u_pattern;
uniform vec2 u_patternSize;
uniform vec4 u_texParams;   // scale (fraction), brightness, contrast, invert
uniform int u_texMode;
uniform float u_texDepth;
uniform float u_noise;
uniform float u_noiseSeed;
out vec4 fragColor;

float tipShape(vec2 rel, float radius, float angle, float roundness, vec2 flip, float hardness, float layer, vec2 aspect) {
  float c = cos(-angle);
  float s = sin(-angle);
  vec2 tip = vec2(rel.x * c - rel.y * s, (rel.x * s + rel.y * c) / max(0.01, roundness)) * flip;
  if (layer >= 0.0) {
    vec2 uv = 0.5 + tip / (2.0 * radius) * aspect;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
    return texture(u_tips, vec3(uv, layer)).r;
  }
  float d = length(tip);
  // Hard core out to hardness*radius, then a smooth falloff to the rim.
  float inner = radius * hardness;
  return 1.0 - smoothstep(inner, max(radius, inner + 0.5), d);
}

float dualBlend(int m, float p, float s) {
  if (m == 0) return p * s;
  if (m == 1) return min(p, s);
  if (m == 2) return p < 0.5 ? 2.0 * p * s : 1.0 - 2.0 * (1.0 - p) * (1.0 - s);
  if (m == 3) return s >= 1.0 ? (p > 0.0 ? 1.0 : 0.0) : min(1.0, p / (1.0 - s)) * s;
  if (m == 4) return s <= 0.0 ? 0.0 : max(0.0, 1.0 - (1.0 - p) / s);
  if (m == 5) return max(0.0, p + s - 1.0);
  if (m == 6) return p + s >= 1.0 ? p : 0.0;
  return clamp(p * (0.5 + s), 0.0, 1.0);
}

float textureBlend(int m, float a, float t, float depth) {
  float v;
  if (m == 0) v = a * t;
  else if (m == 1) v = a - (1.0 - t);
  else if (m == 2) v = min(a, t);
  else if (m == 3) v = a < 0.5 ? 2.0 * a * t : 1.0 - 2.0 * (1.0 - a) * (1.0 - t);
  else if (m == 4) v = t >= 1.0 ? 1.0 : min(1.0, a / (1.0 - t));
  else if (m == 5) v = t <= 0.0 ? 0.0 : max(0.0, 1.0 - (1.0 - a) / t);
  else if (m == 6) v = a + t - 1.0;
  else if (m == 7) v = a + t >= 1.0 ? 1.0 : 0.0;
  else if (m == 8) v = a * (0.5 + t);
  else v = a * t * 2.0;
  v = clamp(v, 0.0, 1.0);
  return a + (v - a) * clamp(depth, 0.0, 1.0);
}

uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}

void main() {
  vec2 rel = v_local - u_centre;
  float a = tipShape(rel, u_radius, u_angle, u_roundness, u_flip, u_hardness, u_tipLayer, u_tipAspect);
  if (u_dualCount > 0) {
    float s = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= u_dualCount) break;
      vec4 st = u_dual[i];
      vec4 ex = u_dualExtra[i];
      vec2 fl = vec2(ex.y > 0.5 ? -1.0 : 1.0, ex.z > 0.5 ? -1.0 : 1.0);
      s = max(s, tipShape(v_local - st.xy, st.z, st.w, ex.x, fl, u_dualHardness, u_dualTipLayer, u_dualAspect));
    }
    a = dualBlend(u_dualMode, a, s);
  }
  vec2 docPos = u_tileOrigin + v_local;
  if (u_texOn > 0.5) {
    vec2 q = floor(floor(docPos) / max(0.01, u_texParams.x));
    ivec2 pi = ivec2(mod(q, u_patternSize));
    float t = texelFetch(u_pattern, pi, 0).r;
    t = t + u_texParams.y / 150.0;
    t = 0.5 + (t - 0.5) * (1.0 + u_texParams.z / 50.0);
    t = clamp(t, 0.0, 1.0);
    if (u_texParams.w > 0.5) t = 1.0 - t;
    a = textureBlend(u_texMode, a, t, u_texDepth);
  }
  if (u_noise > 0.5 && a > 0.0 && a < 1.0) {
    ivec2 ip = ivec2(floor(docPos));
    uint h = hashU(uint(ip.x) * 0x27d4eb2du ^ uint(ip.y) * 0x165667b1u ^ uint(u_noiseSeed));
    float n = float(h) / 4294967296.0 - 0.5;
    a = clamp(a + n * 4.0 * a * (1.0 - a), 0.0, 1.0);
  }
  a *= u_color.a;
  // A stroke is confined to the selection, with partial coverage where the selection is
  // feathered or anti-aliased. This is the whole reason selections are masks, not shapes.
  if (u_useSelection > 0.5) {
    a *= texture(u_selection, docPos / u_selectionSize).r;
  }
  if (a <= 0.0) discard;
  fragColor = vec4(u_color.rgb * a, a);   // premultiplied
}`;

export interface SelectionTexture {
  tex: WebGLTexture;
  width: number;
  height: number;
}

export interface DabParams {
  /** Document-space centre. */
  x: number;
  y: number;
  /** Semi-major axis in document pixels. */
  radius: number;
  hardness: number;
  /** Tip rotation in radians. */
  angle: number;
  /** 0…1; 1 is a circle. */
  roundness: number;
  /** Straight RGB plus the alpha this dab deposits (the brush's flow). */
  color: [number, number, number, number];
  flipX?: boolean;
  flipY?: boolean;
  /** Sampled tip id (see `BrushTextures`). */
  tip?: string;
  /** Dual-brush stamps, document space. */
  dual?: { x: number; y: number; radius: number; angle: number; roundness: number; flipX: boolean; flipY: boolean }[];
  textureDepth?: number;
}

/** Stroke-wide settings the dab shader needs beside each dab's own. */
export interface DabStyle {
  dual?: { tip?: string; hardness: number; mode: number };
  texture?: { scale: number; brightness: number; contrast: number; invert: boolean; mode: number };
  noise?: boolean;
  noiseSeed?: number;
}

export const DUAL_MODES = ['multiply', 'darken', 'overlay', 'colorDodge', 'colorBurn', 'linearBurn', 'hardMix', 'linearHeight'] as const;
export const TEXTURE_MODES = ['multiply', 'subtract', 'darken', 'overlay', 'colorDodge', 'colorBurn', 'linearBurn', 'hardMix', 'linearHeight', 'height'] as const;

const TIP_SIZE = 256;
const TIP_LAYERS = 32;

/**
 * The textures the dab shader samples: sampled brush tips, resampled into the layers of one
 * 256² array (with their aspect kept aside), and the brush's texture pattern.
 */
export class BrushTextures {
  readonly tips: WebGLTexture;
  readonly pattern: WebGLTexture;
  private slots = new Map<string, { layer: number; aspect: [number, number]; used: number }>();
  private patternKey: string | null = null;
  patternSize: [number, number] = [1, 1];
  private clock = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.tips = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tips);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, TIP_SIZE, TIP_SIZE, TIP_LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.pattern = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pattern);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** The array layer holding a tip (uploading it, evicting the least recently used). */
  tipLayer(id: string, tip: { width: number; height: number; data: Uint8Array }): { layer: number; aspect: [number, number] } {
    const hit = this.slots.get(id);
    if (hit) {
      hit.used = ++this.clock;
      return hit;
    }
    let layer = this.slots.size;
    if (layer >= TIP_LAYERS) {
      const [oldId, old] = [...this.slots].reduce((m, e) => (e[1].used < m[1].used ? e : m));
      this.slots.delete(oldId);
      layer = old.layer;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tips);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, TIP_SIZE, TIP_SIZE, 1, gl.RED, gl.UNSIGNED_BYTE, resampleTip(tip));
    const m = Math.max(tip.width, tip.height);
    const slot = { layer, aspect: [m / tip.width, m / tip.height] as [number, number], used: ++this.clock };
    this.slots.set(id, slot);
    return slot;
  }

  /** Make `lum` (0…1 per pixel) the texture pattern, if it is not already. */
  setPattern(key: string, width: number, height: number, lum: Float32Array): void {
    if (this.patternKey === key) return;
    const gl = this.gl;
    const bytes = new Uint8Array(width * height);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, lum[i]!)) * 255);
    gl.bindTexture(gl.TEXTURE_2D, this.pattern);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    this.patternKey = key;
    this.patternSize = [width, height];
  }

  dispose(): void {
    this.gl.deleteTexture(this.tips);
    this.gl.deleteTexture(this.pattern);
  }
}

/** A tip resampled to fill TIP_SIZE² (area-averaged when shrinking, bilinear when growing). */
function resampleTip(t: { width: number; height: number; data: Uint8Array }): Uint8Array {
  const out = new Uint8Array(TIP_SIZE * TIP_SIZE);
  const sx = t.width / TIP_SIZE;
  const sy = t.height / TIP_SIZE;
  for (let y = 0; y < TIP_SIZE; y++) {
    const y0 = y * sy;
    const y1 = Math.max(y0 + 1e-6, (y + 1) * sy);
    for (let x = 0; x < TIP_SIZE; x++) {
      const x0 = x * sx;
      const x1 = Math.max(x0 + 1e-6, (x + 1) * sx);
      if (sx <= 1 && sy <= 1) {
        // Growing: bilinear at the centre.
        const fx = (x + 0.5) * sx - 0.5;
        const fy = (y + 0.5) * sy - 0.5;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const at = (i: number, j: number) => t.data[Math.min(t.height - 1, Math.max(0, j)) * t.width + Math.min(t.width - 1, Math.max(0, i))]!;
        const ax = fx - ix;
        const ay = fy - iy;
        out[y * TIP_SIZE + x] = Math.round((at(ix, iy) * (1 - ax) + at(ix + 1, iy) * ax) * (1 - ay) + (at(ix, iy + 1) * (1 - ax) + at(ix + 1, iy + 1) * ax) * ay);
        continue;
      }
      let sum = 0;
      let wsum = 0;
      for (let j = Math.floor(y0); j < Math.ceil(y1); j++) {
        const wy = Math.min(y1, j + 1) - Math.max(y0, j);
        for (let i = Math.floor(x0); i < Math.ceil(x1); i++) {
          const w = wy * (Math.min(x1, i + 1) - Math.max(x0, i));
          sum += (t.data[Math.min(t.height - 1, j) * t.width + Math.min(t.width - 1, i)] ?? 0) * w;
          wsum += w;
        }
      }
      out[y * TIP_SIZE + x] = Math.round(sum / Math.max(1e-9, wsum));
    }
  }
  return out;
}

export class DabPainter {
  private program: Program;
  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private quad: WebGLBuffer;
  /** Tiles whose atlas slice is newer than their CPU pixels. */
  readonly gpuDirty = new Set<Tile>();
  /** Sampled tips and the texture pattern. */
  readonly textures: BrushTextures;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, DAB_VERT, DAB_FRAG, 'dab');
    this.textures = new BrushTextures(gl);
    this.fbo = gl.createFramebuffer();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Paint one dab into every tile it touches. Returns the tiles it modified. */
  paint(
    atlas: TileAtlas,
    tileFor: (tx: number, ty: number) => Tile,
    p: DabParams,
    selection?: SelectionTexture | null,
    style: DabStyle = {},
    tipOf: (id: string) => { width: number; height: number; data: Uint8Array } | undefined = () => undefined,
  ): Tile[] {
    const gl = this.gl;
    const touched: Tile[] = [];
    // A squashed or sampled tip still fits its radius; the dual stamps may reach past it.
    const r = p.radius / Math.max(0.01, Math.min(1, p.roundness)) * (p.tip ? Math.SQRT2 : 1) + 1;
    const tx0 = (p.x - r) >> TILE_SHIFT;
    const tx1 = (p.x + r) >> TILE_SHIFT;
    const ty0 = (p.y - r) >> TILE_SHIFT;
    const ty1 = (p.y + r) >> TILE_SHIFT;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.bindVertexArray(this.vao);
    this.program.use();
    gl.enable(gl.BLEND);
    // Source is already premultiplied; classic "over".
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.program.u1f('u_useSelection', selection ? 1 : 0);
    if (selection) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, selection.tex);
      this.program.u1i('u_selection', 1);
      this.program.u2f('u_selectionSize', selection.width, selection.height);
    }
    // Tips, dual brush, texture, noise.
    const layerOf = (id: string | undefined) => {
      const bmp = id ? tipOf(id) : undefined;
      return bmp ? this.textures.tipLayer(id!, bmp) : null;
    };
    const main = layerOf(p.tip);
    this.program.u1f('u_tipLayer', main ? main.layer : -1);
    this.program.u2f('u_tipAspect', main?.aspect[0] ?? 1, main?.aspect[1] ?? 1);
    this.program.u2f('u_flip', p.flipX ? -1 : 1, p.flipY ? -1 : 1);
    const dual = style.dual && p.dual?.length ? p.dual.slice(0, 8) : [];
    this.program.u1i('u_dualCount', dual.length);
    if (dual.length) {
      const dt = layerOf(style.dual!.tip);
      this.program.u1f('u_dualTipLayer', dt ? dt.layer : -1);
      this.program.u2f('u_dualAspect', dt?.aspect[0] ?? 1, dt?.aspect[1] ?? 1);
      this.program.u1f('u_dualHardness', style.dual!.hardness);
      this.program.u1i('u_dualMode', style.dual!.mode);
      const extra = new Float32Array(32);
      dual.forEach((d, i) => extra.set([d.roundness, d.flipX ? 1 : 0, d.flipY ? 1 : 0, 0], i * 4));
      gl.uniform4fv(this.program.loc('u_dualExtra'), extra);
    }
    // Every sampler gets its own unit, bound or not: two sampler types sharing unit 0 is an
    // error at draw time even when the shader never reads them.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures.tips);
    this.program.u1i('u_tips', 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.pattern);
    this.program.u1i('u_pattern', 3);
    this.program.u2f('u_patternSize', this.textures.patternSize[0], this.textures.patternSize[1]);
    if (!selection) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.pattern);
      this.program.u1i('u_selection', 1);
    }
    gl.activeTexture(gl.TEXTURE0);
    const tex = style.texture && p.textureDepth !== undefined ? style.texture : null;
    this.program.u1f('u_texOn', tex ? 1 : 0);
    if (tex) {
      this.program.u4f('u_texParams', tex.scale, tex.brightness, tex.contrast, tex.invert ? 1 : 0);
      this.program.u1i('u_texMode', tex.mode);
      this.program.u1f('u_texDepth', p.textureDepth ?? 1);
    }
    this.program.u1f('u_noise', style.noise ? 1 : 0);
    this.program.u1f('u_noiseSeed', style.noiseSeed ?? 0);

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = tileFor(tx, ty);
        const slot = atlas.acquire(tile);
        const { page, x: cx, y: cy } = TileAtlas.locate(slot);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, atlas.textureHandle, 0, page);
        // Restrict rendering to this tile's cell within the page.
        gl.viewport(cx, cy, TILE_SIZE, TILE_SIZE);
        const lx = p.x - (tx << TILE_SHIFT);
        const ly = p.y - (ty << TILE_SHIFT);
        this.program.u4f(
          'u_rect',
          Math.max(0, lx - r),
          Math.max(0, ly - r),
          Math.min(TILE_SIZE, lx + r),
          Math.min(TILE_SIZE, ly + r),
        );
        this.program.u2f('u_centre', lx, ly);
        this.program.u2f('u_tileOrigin', tx << TILE_SHIFT, ty << TILE_SHIFT);
        this.program.u1f('u_radius', p.radius);
        this.program.u1f('u_hardness', p.hardness);
        this.program.u1f('u_angle', p.angle);
        this.program.u1f('u_roundness', Math.max(0.01, p.roundness));
        this.program.u4f('u_color', p.color[0], p.color[1], p.color[2], p.color[3]);
        if (dual.length) {
          const st = new Float32Array(32);
          dual.forEach((d, i) => st.set([d.x - (tx << TILE_SHIFT), d.y - (ty << TILE_SHIFT), d.radius, d.angle], i * 4));
          gl.uniform4fv(this.program.loc('u_dual'), st);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.gpuDirty.add(tile);
        touched.push(tile);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return touched;
  }

  /** Copy an atlas slice back to CPU pixels so the tile store regains authority. */
  readbackTile(atlas: TileAtlas, tile: Tile, out: Uint8Array): void {
    const gl = this.gl;
    const slot = atlas.acquire(tile);
    const { page, x, y } = TileAtlas.locate(slot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, atlas.textureHandle, 0, page);
    gl.readPixels(x, y, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    this.program.dispose();
    this.textures.dispose();
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}
