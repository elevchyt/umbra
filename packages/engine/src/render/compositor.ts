/**
 * GPU layer compositor — docs/spec/06-compositing-math.md, executed on the GPU.
 *
 * WebGL2 cannot read the framebuffer it is writing, so a general blend mode needs the backdrop
 * as a TEXTURE. The compositor therefore keeps a pool of RGBA16F targets and ping-pongs: read
 * accumulator A plus the layer's source, write accumulator B (spec 03 §5.2).
 *
 * Accumulators hold STRAIGHT alpha, matching both the tile store and the CPU reference, so GPU
 * and CPU results can be diffed directly with no premultiply round trip in between.
 */
import { BLEND_MODE_INDEX, BLEND_GLSL, SPECIAL_FILL_GLSL } from './blend.glsl.js';
import { ADJUST_GLSL, type GpuAdjustment } from './adjust.glsl.js';
import { Program } from '../gpu/program.js';
import type { GpuCaps } from '../gpu/caps.js';
import type { BlendMode } from '@umbra/core/blend';

const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
out vec2 v_uv;
void main() {
  v_uv = a_corner;
  gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLEND_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform sampler2D u_mask;

uniform int   u_mode;
uniform float u_opacity;
uniform float u_fill;
uniform float u_hasMask;
uniform float u_maskDensity;
uniform float u_seed;
uniform vec2  u_origin;        // document-space origin of this region, for Dissolve
uniform vec3  u_channels;      // 1 = this channel may be written
uniform float u_blendIfCount;
uniform vec4  u_blendIfThis;
uniform vec4  u_blendIfUnder;
uniform float u_blendIfChannel; // 0 = gray, 1 = r, 2 = g, 3 = b
/** 1.0 when u_source holds premultiplied alpha (the batched fast path). */
uniform float u_srcPremul;

${BLEND_GLSL}
${SPECIAL_FILL_GLSL}

out vec4 fragColor;

float channelValue(vec3 c, float which) {
  if (which < 0.5) return uLum(c);
  if (which < 1.5) return c.r;
  if (which < 2.5) return c.g;
  return c.b;
}

void main() {
  vec4 backdrop = texture(u_backdrop, v_uv);
  vec4 src = texture(u_source, v_uv);
  if (u_srcPremul > 0.5 && src.a > 0.0) src.rgb /= src.a;

  float shape = src.a;
  if (u_hasMask > 0.5) {
    float coverage = texture(u_mask, v_uv).r;
    shape *= 1.0 - u_maskDensity * (1.0 - coverage);
  }

  float neutral = specialFillNeutral(u_mode);
  bool special = neutral >= 0.0;

  float alpha = shape * (special ? 1.0 : u_fill) * u_opacity;
  vec3 color = special ? mix(vec3(neutral), src.rgb, u_fill) : src.rgb;

  if (u_blendIfCount > 0.5) {
    alpha *= rampWeight(channelValue(src.rgb, u_blendIfChannel), u_blendIfThis);
    alpha *= rampWeight(channelValue(backdrop.rgb, u_blendIfChannel), u_blendIfUnder);
  }

  if (u_mode == M_DISSOLVE) {
    vec2 docPos = u_origin + gl_FragCoord.xy;
    alpha = alpha > dissolveNoise(docPos, u_seed) ? 1.0 : 0.0;
  }

  vec4 result;
  if (u_mode == M_HARD_MIX && u_fill < 1.0) {
    // Hard Mix needs the backdrop inside the blend, so it cannot use the generic path.
    vec3 hm = vec3(
      hardMixWithFill(backdrop.r, src.r, u_fill),
      hardMixWithFill(backdrop.g, src.g, u_fill),
      hardMixWithFill(backdrop.b, src.b, u_fill)
    );
    result = compositeOver(M_NORMAL, backdrop, vec4(hm, alpha));
  } else {
    result = compositeOver(u_mode, backdrop, vec4(color, alpha));
  }

  result.rgb = mix(backdrop.rgb, result.rgb, u_channels);
  fragColor = result;
}`;

/**
 * Adjustment layer pass — spec 06 §8: `Cr = mix(Cb, B(Cb, f(Cb)), α)` with α = mask ×
 * opacity × fill (× Blend If), and the backdrop's alpha passed through untouched.
 */
const ADJUST_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_backdrop;
uniform sampler2D u_mask;
uniform int   u_mode;
uniform float u_opacity;
uniform float u_fill;
uniform float u_hasMask;
uniform float u_maskDensity;
uniform vec3  u_channels;
uniform float u_blendIfCount;
uniform vec4  u_blendIfThis;
uniform vec4  u_blendIfUnder;
uniform float u_blendIfChannel;

${BLEND_GLSL}
${ADJUST_GLSL}

out vec4 fragColor;

float channelValue(vec3 c, float which) {
  if (which < 0.5) return uLum(c);
  if (which < 1.5) return c.r;
  if (which < 2.5) return c.g;
  return c.b;
}

void main() {
  vec4 backdrop = texture(u_backdrop, v_uv);
  if (backdrop.a <= 0.0) { fragColor = backdrop; return; }
  vec3 adjusted = clamp(adjustColor(quantise8(backdrop.rgb)), 0.0, 1.0);

  float alpha = u_opacity * u_fill;
  if (u_hasMask > 0.5) {
    float coverage = texture(u_mask, v_uv).r;
    alpha *= 1.0 - u_maskDensity * (1.0 - coverage);
  }
  if (u_blendIfCount > 0.5) {
    alpha *= rampWeight(channelValue(adjusted, u_blendIfChannel), u_blendIfThis);
    alpha *= rampWeight(channelValue(backdrop.rgb, u_blendIfChannel), u_blendIfUnder);
  }
  if (alpha <= 0.0) { fragColor = backdrop; return; }

  vec4 over = compositeOver(u_mode, vec4(backdrop.rgb, 1.0), vec4(adjusted, alpha));
  fragColor = vec4(mix(backdrop.rgb, over.rgb, u_channels), backdrop.a);
}`;

const COPY_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  fragColor = vec4(c.rgb, c.a * u_opacity);
}`;

/** Premultiplied cross-fade, for pass-through group opacity (spec 06 §4). */
const LERP_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_t;
out vec4 fragColor;
void main() {
  vec4 a = texture(u_a, v_uv);
  vec4 b = texture(u_b, v_uv);
  float alpha = mix(a.a, b.a, u_t);
  if (alpha <= 0.0) { fragColor = vec4(0.0); return; }
  vec3 pa = a.rgb * a.a;
  vec3 pb = b.rgb * b.a;
  fragColor = vec4(mix(pa, pb, u_t) / alpha, alpha);
}`;

export interface RenderTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

export interface BlendIfSpec {
  channel: 'gray' | 'r' | 'g' | 'b';
  thisLayer: [number, number, number, number];
  underlying: [number, number, number, number];
}

export interface GpuLayer {
  kind: 'pixel' | 'group' | 'adjustment';
  /** Adjustment layers: the function, as uniforms. */
  adjustment?: GpuAdjustment;
  name?: string;
  visible: boolean;
  opacity: number;
  fill: number;
  blendMode: BlendMode;
  clipped: boolean;
  seed?: number;
  channels?: { r: boolean; g: boolean; b: boolean };
  blendIf?: BlendIfSpec[];
  /** Paints this layer's straight-alpha content into the bound target. */
  drawSource?: (target: RenderTarget) => void;
  /** Paints the mask's coverage into the red channel of the bound target. */
  drawMask?: (target: RenderTarget) => void;
  /** Start the mask target at full coverage — see `renderMask`. */
  maskStartsOpaque?: boolean;
  maskDensity?: number;
  children?: GpuLayer[];
  /**
   * True when this layer can be batched with its neighbours: a plain pixel layer in Normal
   * mode with no mask, no Blend If, no channel restriction and Fill 100%. A run of these is
   * accumulated into ONE scratch target with fixed-function blending and composited with a
   * single blend pass, instead of one full-viewport pass each (spec 03 §5.2).
   */
  plain?: boolean;
  /** Set by the batcher: `drawSource` emits premultiplied alpha. */
  sourcePremultiplied?: boolean;
  /** Draws the layer's tiles with a given opacity, premultiplied, for batching. */
  drawBatched?: (opacity: number) => void;
}

const CHANNEL_INDEX = { gray: 0, r: 1, g: 2, b: 3 } as const;

export class LayerCompositor {
  private blendProgram: Program;
  private copyProgram: Program;
  private lerpProgram: Program;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private pool: RenderTarget[] = [];
  private inUse = new Set<RenderTarget>();
  private width = 0;
  private height = 0;
  /** Document-space origin of the region being composited, for Dissolve. */
  private origin: [number, number] = [0, 0];

  constructor(
    private gl: WebGL2RenderingContext,
    caps: GpuCaps,
  ) {
    if (!caps.colorBufferHalfFloat && !caps.colorBufferFloat) {
      throw new Error('LayerCompositor needs a float colour buffer (EXT_color_buffer_float)');
    }
    this.blendProgram = new Program(gl, QUAD_VERT, BLEND_FRAG, 'composite.blend');
    this.copyProgram = new Program(gl, QUAD_VERT, COPY_FRAG, 'composite.copy');
    this.lerpProgram = new Program(gl, QUAD_VERT, LERP_FRAG, 'composite.lerp');

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

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.disposeTargets();
    this.width = width;
    this.height = height;
  }

  setOrigin(x: number, y: number): void {
    this.origin = [x, y];
  }

  // ---- target pool ---------------------------------------------------------------------

  private createTarget(): RenderTarget {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, this.width, this.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`compositor target incomplete: 0x${status.toString(16)}`);
    }
    return { tex, fbo, width: this.width, height: this.height };
  }

  private acquire(): RenderTarget {
    const free = this.pool.find((t) => !this.inUse.has(t));
    const t = free ?? this.createTarget();
    if (!free) this.pool.push(t);
    this.inUse.add(t);
    return t;
  }

  private release(t: RenderTarget): void {
    this.inUse.delete(t);
  }

  private fill(t: RenderTarget, r: number, g: number, b: number, a: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.width, t.height);
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private clear(t: RenderTarget): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.width, t.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ---- passes ---------------------------------------------------------------------------

  private drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private blendPass(
    dst: RenderTarget,
    backdrop: RenderTarget,
    source: RenderTarget,
    mask: RenderTarget | null,
    layer: GpuLayer,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);

    const p = this.blendProgram;
    p.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, (mask ?? source).tex);
    p.u1i('u_backdrop', 0);
    p.u1i('u_source', 1);
    p.u1i('u_mask', 2);

    p.u1i('u_mode', BLEND_MODE_INDEX[layer.blendMode] ?? 0);
    p.u1f('u_opacity', layer.opacity);
    p.u1f('u_fill', layer.fill);
    p.u1f('u_hasMask', mask ? 1 : 0);
    p.u1f('u_srcPremul', layer.sourcePremultiplied ? 1 : 0);
    p.u1f('u_maskDensity', layer.maskDensity ?? 1);
    p.u1f('u_seed', layer.seed ?? 0);
    p.u2f('u_origin', this.origin[0], this.origin[1]);
    const ch = layer.channels ?? { r: true, g: true, b: true };
    gl.uniform3f(p.loc('u_channels'), ch.r ? 1 : 0, ch.g ? 1 : 0, ch.b ? 1 : 0);

    const bi = layer.blendIf?.[0];
    p.u1f('u_blendIfCount', bi ? 1 : 0);
    if (bi) {
      p.u4f('u_blendIfThis', ...bi.thisLayer);
      p.u4f('u_blendIfUnder', ...bi.underlying);
      p.u1f('u_blendIfChannel', CHANNEL_INDEX[bi.channel]);
    }

    this.drawQuad();
  }

  private _adjust?: Program;
  /**
   * Adjustment tables by identity. The renderer caches one `GpuAdjustment` per adjustment
   * value, so a table is uploaded once per edit rather than once per frame; the cap keeps a
   * long slider drag from leaking a texture per step.
   */
  private tables = new Map<Float32Array, WebGLTexture>();
  private emptyTable?: WebGLTexture;
  /** Color Lookup grids by identity, like `tables`; a 1³ stand-in keeps the sampler valid. */
  private cubes = new Map<Float32Array, WebGLTexture>();
  private emptyCube?: WebGLTexture;

  private cubeTexture(cube: { size: number; data: Float32Array } | undefined): WebGLTexture {
    const gl = this.gl;
    const upload = (size: number, data: Float32Array): WebGLTexture => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return tex;
    };
    if (!cube) return (this.emptyCube ??= upload(1, new Float32Array(3)));
    let tex = this.cubes.get(cube.data);
    if (tex) return tex;
    tex = upload(cube.size, cube.data);
    this.cubes.set(cube.data, tex);
    if (this.cubes.size > 8) {
      const [oldest, oldTex] = this.cubes.entries().next().value!;
      gl.deleteTexture(oldTex);
      this.cubes.delete(oldest);
    }
    return tex;
  }

  private tableTexture(table: Float32Array | null): WebGLTexture {
    const gl = this.gl;
    const upload = (data: Float32Array): WebGLTexture => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 256, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return tex;
    };
    if (!table) return (this.emptyTable ??= upload(new Float32Array(256 * 4)));
    let tex = this.tables.get(table);
    if (tex) {
      // Refresh recency.
      this.tables.delete(table);
      this.tables.set(table, tex);
      return tex;
    }
    tex = upload(table);
    this.tables.set(table, tex);
    if (this.tables.size > 64) {
      const [oldest, oldTex] = this.tables.entries().next().value!;
      gl.deleteTexture(oldTex);
      this.tables.delete(oldest);
    }
    return tex;
  }

  private adjustPass(dst: RenderTarget, backdrop: RenderTarget, mask: RenderTarget | null, layer: GpuLayer): void {
    const gl = this.gl;
    const adj = layer.adjustment;
    this._adjust ??= new Program(gl, QUAD_VERT, ADJUST_FRAG, 'composite.adjust');
    const table = this.tableTexture(adj?.table ?? null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    const p = this._adjust;
    p.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, (mask ?? backdrop).tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, table);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.cubeTexture(adj?.cube));
    p.u1i('u_backdrop', 0);
    p.u1i('u_mask', 1);
    p.u1i('u_adjTable', 2);
    p.u1i('u_adjCube', 3);

    p.u1i('u_mode', BLEND_MODE_INDEX[layer.blendMode] ?? 0);
    p.u1f('u_opacity', layer.opacity);
    p.u1f('u_fill', layer.fill);
    p.u1f('u_hasMask', mask ? 1 : 0);
    p.u1f('u_maskDensity', layer.maskDensity ?? 1);
    const ch = layer.channels ?? { r: true, g: true, b: true };
    gl.uniform3f(p.loc('u_channels'), ch.r ? 1 : 0, ch.g ? 1 : 0, ch.b ? 1 : 0);
    const bi = layer.blendIf?.[0];
    p.u1f('u_blendIfCount', bi ? 1 : 0);
    if (bi) {
      p.u4f('u_blendIfThis', ...bi.thisLayer);
      p.u4f('u_blendIfUnder', ...bi.underlying);
      p.u1f('u_blendIfChannel', CHANNEL_INDEX[bi.channel]);
    }

    p.u1i('u_adjKind', adj?.kind ?? -1);
    const v = adj?.params ?? new Float32Array(16);
    for (let i = 0; i < 4; i++) p.u4f(`u_adj${i}`, v[i * 4]!, v[i * 4 + 1]!, v[i * 4 + 2]!, v[i * 4 + 3]!);

    this.drawQuad();
  }

  private copyPass(dst: RenderTarget, src: RenderTarget, opacity = 1): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    this.copyProgram.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    this.copyProgram.u1i('u_tex', 0);
    this.copyProgram.u1f('u_opacity', opacity);
    this.drawQuad();
  }

  private lerpPass(dst: RenderTarget, a: RenderTarget, b: RenderTarget, t: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    this.lerpProgram.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    this.lerpProgram.u1i('u_a', 0);
    this.lerpProgram.u1i('u_b', 1);
    this.lerpProgram.u1f('u_t', t);
    this.drawQuad();
  }

  // ---- tree walk --------------------------------------------------------------------------

  /**
   * Composite a layer list onto `backdrop`, returning a NEW target the caller owns.
   * `backdrop` is left untouched.
   */
  compositeLayers(layers: readonly GpuLayer[], backdrop: RenderTarget): RenderTarget {
    let acc = this.acquire();
    this.copyPass(acc, backdrop);

    let i = 0;
    while (i < layers.length) {
      const layer = layers[i]!;
      if (!layer.visible) {
        i++;
        continue;
      }
      // A layer with a clipped layer above it is a clipping BASE: it must go through the
      // clipping path, never into a batch, or its clipped layers lose what they clip to.
      const isClipBase = (k: number) => layers[k + 1]?.clipped === true;

      // Fast path: batch a run of plain Normal layers into a single blend pass.
      if (layer.plain && layer.drawBatched && !isClipBase(i)) {
        let end = i;
        while (
          end + 1 < layers.length &&
          layers[end + 1]!.plain &&
          layers[end + 1]!.drawBatched &&
          layers[end + 1]!.visible &&
          !isClipBase(end + 1)
        ) {
          end++;
        }
        if (end > i) {
          const next = this.compositeBatch(layers.slice(i, end + 1), acc);
          this.release(acc);
          acc = next;
          i = end + 1;
          continue;
        }
      }

      let n = 0;
      while (i + 1 + n < layers.length && layers[i + 1 + n]!.clipped) n++;

      const next =
        n > 0
          ? this.compositeClipGroup(layer, layers.slice(i + 1, i + 1 + n), acc)
          : this.compositeOne(layer, acc);
      this.release(acc);
      acc = next;
      i += 1 + n;
    }
    return acc;
  }

  /**
   * Accumulate several plain layers into one scratch target using the hardware blender, then
   * composite the lot with a single pass. This is what keeps a 100-layer document interactive:
   * the per-layer cost becomes a few tile quads rather than a full-viewport shader pass.
   */
  private compositeBatch(run: readonly GpuLayer[], backdrop: RenderTarget): RenderTarget {
    const gl = this.gl;
    const src = this.acquire();
    this.clear(src);
    gl.bindFramebuffer(gl.FRAMEBUFFER, src.fbo);
    gl.viewport(0, 0, src.width, src.height);
    gl.enable(gl.BLEND);
    // Sources are emitted premultiplied, so this is the classic "over" operator.
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const l of run) l.drawBatched!(l.opacity);
    gl.disable(gl.BLEND);

    const dst = this.acquire();
    this.blendPass(dst, backdrop, src, null, {
      ...run[0]!,
      blendMode: 'normal',
      opacity: 1,
      fill: 1,
      sourcePremultiplied: true,
    });
    this.release(src);
    return dst;
  }

  private renderSource(layer: GpuLayer): RenderTarget {
    const src = this.acquire();
    this.clear(src);
    if (layer.drawSource) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, src.fbo);
      gl.viewport(0, 0, src.width, src.height);
      layer.drawSource(src);
    }
    return src;
  }

  private renderMask(layer: GpuLayer): RenderTarget | null {
    if (!layer.drawMask) return null;
    const m = this.acquire();
    // A mask target normally starts empty (nothing shows); an ERASE preview starts full,
    // because it multiplies coverage down from 1 rather than painting it up from 0.
    if (layer.maskStartsOpaque) this.fill(m, 1, 1, 1, 1);
    else this.clear(m);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.fbo);
    gl.viewport(0, 0, m.width, m.height);
    layer.drawMask(m);
    return m;
  }

  private compositeOne(layer: GpuLayer, backdrop: RenderTarget): RenderTarget {
    if (layer.kind === 'group') return this.compositeGroup(layer, backdrop);
    if (layer.kind === 'adjustment') {
      const mask = this.renderMask(layer);
      const dst = this.acquire();
      this.adjustPass(dst, backdrop, mask, layer);
      if (mask) this.release(mask);
      return dst;
    }

    const src = this.renderSource(layer);
    const mask = this.renderMask(layer);
    const dst = this.acquire();
    this.blendPass(dst, backdrop, src, mask, layer);
    this.release(src);
    if (mask) this.release(mask);
    return dst;
  }

  private compositeGroup(group: GpuLayer, backdrop: RenderTarget): RenderTarget {
    const children = group.children ?? [];
    const mask = this.renderMask(group);
    // A group's own mask multiplies its opacity; a full mask implementation for groups needs
    // the mask sampled per pixel, which the lerp/blend passes below already do via u_mask.
    const maskless = !mask;

    if (group.blendMode === 'passThrough') {
      const inner = this.compositeLayers(children, backdrop);
      if (group.opacity >= 1 && maskless) {
        return inner;
      }
      const dst = this.acquire();
      this.lerpPass(dst, backdrop, inner, group.opacity);
      this.release(inner);
      if (mask) this.release(mask);
      return dst;
    }

    // Isolated: children composite onto transparency, then blend as a single source.
    const empty = this.acquire();
    this.clear(empty);
    const inner = this.compositeLayers(children, empty);
    this.release(empty);

    const dst = this.acquire();
    this.blendPass(dst, backdrop, inner, mask, group);
    this.release(inner);
    if (mask) this.release(mask);
    return dst;
  }

  private compositeClipGroup(
    base: GpuLayer,
    clipped: readonly GpuLayer[],
    backdrop: RenderTarget,
  ): RenderTarget {
    if (base.kind === 'group' || !base.drawSource) {
      let acc = this.compositeOne(base, backdrop);
      for (const c of clipped) {
        const next = this.compositeOne(c, acc);
        this.release(acc);
        acc = next;
      }
      return acc;
    }

    // Build the clipped stack over the base colour treated as opaque, then blend the result
    // using the base's own alpha, mode and opacity (spec 06 §6).
    const baseSrc = this.renderSource(base);
    const baseMask = this.renderMask(base);

    const opaqueBase = this.acquire();
    this.opaqueCopy(opaqueBase, baseSrc);

    let stack = opaqueBase;
    for (const c of clipped) {
      if (!c.visible) continue;
      const next = this.compositeOne(c, stack);
      this.release(stack);
      stack = next;
    }

    // Re-apply the base's alpha to the stacked colour before the final blend.
    const shaped = this.acquire();
    this.applyAlphaFrom(shaped, stack, baseSrc);
    this.release(stack);

    const dst = this.acquire();
    this.blendPass(dst, backdrop, shaped, baseMask, base);
    this.release(shaped);
    this.release(baseSrc);
    if (baseMask) this.release(baseMask);
    return dst;
  }

  /** Copy colour with alpha forced to 1, so clipped layers blend against a solid base. */
  private opaqueCopy(dst: RenderTarget, src: RenderTarget): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    this.opaqueProgram().use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    this.opaqueProgram().u1i('u_tex', 0);
    this.drawQuad();
  }

  private _opaque?: Program;
  private opaqueProgram(): Program {
    this._opaque ??= new Program(
      this.gl,
      QUAD_VERT,
      `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() { fragColor = vec4(texture(u_tex, v_uv).rgb, 1.0); }`,
      'composite.opaque',
    );
    return this._opaque;
  }

  /** Take colour from `colorSrc` and alpha from `alphaSrc`. */
  private applyAlphaFrom(dst: RenderTarget, colorSrc: RenderTarget, alphaSrc: RenderTarget): void {
    const gl = this.gl;
    this._applyAlpha ??= new Program(
      gl,
      QUAD_VERT,
      `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_color;
uniform sampler2D u_alpha;
out vec4 fragColor;
void main() { fragColor = vec4(texture(u_color, v_uv).rgb, texture(u_alpha, v_uv).a); }`,
      'composite.applyAlpha',
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    this._applyAlpha.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, colorSrc.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, alphaSrc.tex);
    this._applyAlpha.u1i('u_color', 0);
    this._applyAlpha.u1i('u_alpha', 1);
    this.drawQuad();
  }
  private _applyAlpha?: Program;

  /**
   * Composite a layer list onto transparency. The returned target belongs to the pool and is
   * valid until `releaseAll()`.
   */
  compositeOnTransparent(layers: readonly GpuLayer[]): RenderTarget {
    const empty = this.acquire();
    this.clear(empty);
    const result = this.compositeLayers(layers, empty);
    this.release(empty);
    return result;
  }

  /** Composite a document and read the result back as straight-alpha RGBA8. */
  compositeToPixels(layers: readonly GpuLayer[]): Uint8ClampedArray {
    const result = this.compositeOnTransparent(layers);
    const gl = this.gl;
    const floats = new Float32Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, result.fbo);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, floats);
    this.release(result);

    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(floats[i]! * 255);
    return out;
  }

  releaseAll(): void {
    this.inUse.clear();
  }

  private disposeTargets(): void {
    const gl = this.gl;
    for (const t of this.pool) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.pool = [];
    this.inUse.clear();
  }

  dispose(): void {
    this.disposeTargets();
    this.blendProgram.dispose();
    this.copyProgram.dispose();
    this.lerpProgram.dispose();
    this._opaque?.dispose();
    this._applyAlpha?.dispose();
    this._adjust?.dispose();
    for (const tex of this.tables.values()) this.gl.deleteTexture(tex);
    for (const tex of this.cubes.values()) this.gl.deleteTexture(tex);
    if (this.emptyCube) this.gl.deleteTexture(this.emptyCube);
    if (this.emptyTable) this.gl.deleteTexture(this.emptyTable);
    this.tables.clear();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}
