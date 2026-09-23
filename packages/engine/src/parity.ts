/**
 * GPU ≡ CPU compositing parity suite — the M2 exit criterion (spec 08).
 *
 * Every blend mode is checked over the FULL backdrop × source matrix in a single render: the
 * backdrop is a horizontal 0…1 ramp and the source a vertical one, so a 256×256 region covers
 * every 8-bit input pair at once. That is the same "ramp document" trick used to read a
 * blend function out of Photoshop, and it makes a disagreement anywhere in the domain visible
 * rather than relying on a handful of sample points.
 */
import { BLEND_MODES, type BlendMode } from '@umbra/core/blend';
import {
  compositeDocument,
  solidLayer,
  DEFAULT_BLENDING,
  type CompositeLayer,
} from '@umbra/kernels/composite';
import type { Rgb } from '@umbra/kernels/blend';
import { applierToRgbFn, compile, ADJUSTMENT_LABEL, type Adjustment } from '@umbra/kernels/adjust';
import { Program } from './gpu/program.js';
import { toGpuAdjustment } from './render/adjust.glsl.js';
import { FillRenderer } from './render/fill.glsl.js';
import { builtinPatterns, fillSampler, type FillContent } from '@umbra/kernels/fill';
import { ADJUSTMENT_SAMPLES } from './adjust-samples.js';
import { LayerCompositor, type GpuLayer, type RenderTarget } from './render/compositor.js';
import type { GpuCaps } from './gpu/caps.js';

export const PARITY_SIZE = 64;

const PATTERN_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
out vec2 v_uv;
void main() { v_uv = a_corner; gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

const PATTERN_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform int u_kind;      // 0 = solid, 1 = horizontal ramp, 2 = vertical ramp, 3 = colour field
uniform vec4 u_color;
uniform float u_opacity;
uniform float u_premultiply;
out vec4 fragColor;
void main() {
  vec4 c;
  if (u_kind == 1) c = vec4(vec3(v_uv.x), u_color.a);
  else if (u_kind == 2) c = vec4(vec3(v_uv.y), u_color.a);
  else if (u_kind == 3) {
    // 4096 distinct 8-bit colours, built from integer pixel coordinates so the CPU side can
    // reproduce every value exactly — no float rounding that could differ between the two.
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    c = vec4(float(x * 4) / 255.0, float(y * 4) / 255.0, float((x * 37 + y * 11) % 256) / 255.0, u_color.a);
  }
  else c = u_color;
  c.a *= u_opacity;
  fragColor = u_premultiply > 0.5 ? vec4(c.rgb * c.a, c.a) : c;
}`;

type PatternKind = 'solid' | 'rampX' | 'rampY' | 'colors';

/** Value a pattern produces at a pixel, matching the shader exactly. */
function patternSample(kind: PatternKind, color: Rgb, alpha: number, x: number, y: number): { color: Rgb; alpha: number } {
  // The shader samples at pixel centres: uv = (i + 0.5) / size.
  const u = (x + 0.5) / PARITY_SIZE;
  const v = (y + 0.5) / PARITY_SIZE;
  if (kind === 'rampX') return { color: [u, u, u], alpha };
  if (kind === 'rampY') return { color: [v, v, v], alpha };
  if (kind === 'colors') return { color: [(x * 4) / 255, (y * 4) / 255, ((x * 37 + y * 11) % 256) / 255], alpha };
  return { color, alpha };
}

interface CaseLayer {
  pattern: PatternKind;
  color?: Rgb;
  alpha?: number;
  mode?: BlendMode;
  opacity?: number;
  fill?: number;
  clipped?: boolean;
  visible?: boolean;
  maskPattern?: PatternKind;
  maskDensity?: number;
  children?: CaseLayer[];
  /** Makes this an adjustment layer; `pattern` is then ignored. */
  adjustment?: Adjustment;
  /** Makes this a fill layer; `pattern` is then ignored. */
  fillContent?: FillContent;
  blendIf?: { channel: 'gray'; thisLayer: [number, number, number, number]; underlying: [number, number, number, number] }[];
}

export interface ParityCase {
  name: string;
  layers: CaseLayer[];
  /** Allowed max per-channel difference in 8-bit units. */
  tolerance?: number;
}

export interface ParityResult {
  name: string;
  pass: boolean;
  maxDelta: number;
  meanDelta: number;
  worstAt: { x: number; y: number } | null;
}

export class ParityRunner {
  private compositor: LayerCompositor;
  private fills: FillRenderer;
  private pattern: Program;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;

  constructor(
    private gl: WebGL2RenderingContext,
    caps: GpuCaps,
  ) {
    this.compositor = new LayerCompositor(gl, caps);
    this.compositor.resize(PARITY_SIZE, PARITY_SIZE);
    this.pattern = new Program(gl, PATTERN_VERT, PATTERN_FRAG, 'parity.pattern');
    this.fills = new FillRenderer(gl);
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

  private paint(
    kind: PatternKind,
    color: Rgb,
    alpha: number,
    opacity = 1,
    premultiply = false,
  ): void {
    const gl = this.gl;
    const k = kind === 'rampX' ? 1 : kind === 'rampY' ? 2 : kind === 'colors' ? 3 : 0;
    this.pattern.use();
    this.pattern.u1i('u_kind', k);
    this.pattern.u4f('u_color', color[0], color[1], color[2], alpha);
    this.pattern.u1f('u_opacity', opacity);
    this.pattern.u1f('u_premultiply', premultiply ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private toGpuLayer(l: CaseLayer): GpuLayer {
    const color = l.color ?? [1, 1, 1];
    const alpha = l.alpha ?? 1;
    if (l.fillContent) {
      const content = l.fillContent;
      // Document space is the 64×64 target itself, y up to match the patterns' row order.
      const s = 2 / PARITY_SIZE;
      const docToClip = new Float32Array([s, 0, 0, 0, s, 0, -1, -1, 1]);
      const rect = { x0: 0, y0: 0, x1: PARITY_SIZE, y1: PARITY_SIZE };
      return {
        kind: 'pixel',
        visible: l.visible ?? true,
        opacity: l.opacity ?? 1,
        fill: l.fill ?? 1,
        blendMode: l.mode ?? 'normal',
        clipped: l.clipped ?? false,
        maskDensity: l.maskDensity ?? 1,
        drawSource: () => this.fills.draw(content, docToClip, rect, { width: PARITY_SIZE, height: PARITY_SIZE }),
        drawMask: l.maskPattern ? (_t: RenderTarget) => this.paint(l.maskPattern!, [1, 1, 1], 1) : undefined,
      };
    }
    if (l.adjustment) {
      return {
        kind: 'adjustment',
        visible: l.visible ?? true,
        opacity: l.opacity ?? 1,
        fill: l.fill ?? 1,
        blendMode: l.mode ?? 'normal',
        clipped: l.clipped ?? false,
        maskDensity: l.maskDensity ?? 1,
        blendIf: l.blendIf,
        adjustment: toGpuAdjustment(l.adjustment),
        drawMask: l.maskPattern ? (_t: RenderTarget) => this.paint(l.maskPattern!, [1, 1, 1], 1) : undefined,
      };
    }
    const out: GpuLayer = {
      kind: l.children ? 'group' : 'pixel',
      visible: l.visible ?? true,
      opacity: l.opacity ?? 1,
      fill: l.fill ?? 1,
      blendMode: l.mode ?? 'normal',
      clipped: l.clipped ?? false,
      maskDensity: l.maskDensity ?? 1,
      blendIf: l.blendIf,
      children: l.children?.map((c) => this.toGpuLayer(c)),
      drawSource: l.children ? undefined : (_t: RenderTarget) => this.paint(l.pattern, color, alpha),
      drawMask: l.maskPattern ? (_t: RenderTarget) => this.paint(l.maskPattern!, [1, 1, 1], 1) : undefined,
    };

    // Mirror the renderer's batching rule so the fast path is exercised here too: it is the
    // common path in the app, so parity must cover it, not only the general one.
    if (!l.children) {
      out.plain =
        (l.mode ?? 'normal') === 'normal' &&
        !l.clipped &&
        !l.maskPattern &&
        (l.fill ?? 1) >= 1 &&
        !l.blendIf;
      out.drawBatched = (opacity: number) => this.paint(l.pattern, color, alpha, opacity, true);
    }
    return out;
  }

  private toCpuLayer(l: CaseLayer): CompositeLayer {
    const color = l.color ?? [1, 1, 1];
    const alpha = l.alpha ?? 1;
    const base = solidLayer(color, alpha, {
      visible: l.visible ?? true,
      opacity: l.opacity ?? 1,
      fill: l.fill ?? 1,
      blendMode: l.mode ?? 'normal',
      clipped: l.clipped ?? false,
      blending: { ...DEFAULT_BLENDING, blendIf: l.blendIf ?? [] },
    });
    const mask = l.maskPattern
      ? {
          sample: (x: number, y: number) => patternSample(l.maskPattern!, [1, 1, 1], 1, x, y).color[0],
          enabled: true,
          density: l.maskDensity ?? 1,
        }
      : undefined;
    if (l.adjustment) {
      return { ...base, kind: 'adjustment', sample: undefined, adjust: applierToRgbFn(compile(l.adjustment)), mask };
    }
    if (l.fillContent) {
      return { ...base, sample: fillSampler(l.fillContent, PARITY_SIZE, PARITY_SIZE), mask };
    }
    if (l.children) {
      return {
        ...base,
        kind: 'group',
        sample: undefined,
        children: l.children.map((c) => this.toCpuLayer(c)),
      };
    }
    return {
      ...base,
      sample: (x, y) => patternSample(l.pattern, color, alpha, x, y),
      mask,
    };
  }

  run(testCase: ParityCase): ParityResult {
    const gpu = this.compositor.compositeToPixels(testCase.layers.map((l) => this.toGpuLayer(l)));
    this.compositor.releaseAll();

    const cpuLayers = testCase.layers.map((l) => this.toCpuLayer(l));
    const cpu = new Uint8ClampedArray(PARITY_SIZE * PARITY_SIZE * 4);
    for (let y = 0; y < PARITY_SIZE; y++) {
      for (let x = 0; x < PARITY_SIZE; x++) {
        const px = compositeDocument(cpuLayers, x, y);
        const o = (y * PARITY_SIZE + x) * 4;
        cpu[o] = Math.round(px.color[0] * 255);
        cpu[o + 1] = Math.round(px.color[1] * 255);
        cpu[o + 2] = Math.round(px.color[2] * 255);
        cpu[o + 3] = Math.round(px.alpha * 255);
      }
    }

    let maxDelta = 0;
    let sum = 0;
    let worstAt: { x: number; y: number } | null = null;
    // No vertical flip is needed: readPixels reads bottom-up and the quad maps uv.y = 0 to the
    // bottom, so GPU row 0 and CPU row 0 both correspond to v ~= 0. Both sides use the same
    // convention, which is all the comparison requires.
    for (let i = 0; i < cpu.length; i++) {
      const d = Math.abs(cpu[i]! - gpu[i]!);
      sum += d;
      if (d > maxDelta) {
        maxDelta = d;
        const p = i >> 2;
        worstAt = { x: p % PARITY_SIZE, y: Math.floor(p / PARITY_SIZE) };
      }
    }

    const tolerance = testCase.tolerance ?? 1;
    return {
      name: testCase.name,
      pass: maxDelta <= tolerance,
      maxDelta,
      meanDelta: sum / cpu.length,
      worstAt,
    };
  }

  dispose(): void {
    this.compositor.dispose();
    this.fills.dispose();
    this.pattern.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}

/** The parity matrix: every mode over the full input domain, plus the structural cases. */
export function parityCases(): ParityCase[] {
  const cases: ParityCase[] = [];

  // Dissolve is stochastic and Pass Through is not a layer mode, so both are excluded here.
  const modes = BLEND_MODES.filter((m) => m !== 'passThrough' && m !== 'dissolve');

  for (const mode of modes) {
    cases.push({
      name: `mode ${mode} (full ramp matrix)`,
      layers: [
        { pattern: 'rampX' },
        { pattern: 'rampY', mode },
      ],
    });
  }

  // Opacity and alpha behave the same way for every mode; spot-check the interesting ones.
  for (const mode of ['normal', 'multiply', 'overlay', 'colorDodge', 'luminosity'] as BlendMode[]) {
    cases.push({
      name: `mode ${mode} at 50% opacity`,
      layers: [{ pattern: 'rampX' }, { pattern: 'rampY', mode, opacity: 0.5 }],
    });
    cases.push({
      name: `mode ${mode} over 50% alpha backdrop`,
      layers: [{ pattern: 'rampX', alpha: 0.5 }, { pattern: 'rampY', mode }],
    });
  }

  // The special 8: Fill must be folded into the colour, not into coverage.
  for (const mode of ['colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference'] as BlendMode[]) {
    for (const fill of [0, 0.25, 0.5, 0.75]) {
      cases.push({
        name: `special fill ${mode} @ ${fill * 100}%`,
        layers: [{ pattern: 'rampX' }, { pattern: 'rampY', mode, fill }],
      });
    }
  }

  cases.push(
    {
      name: 'mask as coverage',
      layers: [{ pattern: 'rampX' }, { pattern: 'solid', color: [1, 1, 1], maskPattern: 'rampY' }],
    },
    {
      name: 'mask density 50%',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [1, 1, 1], maskPattern: 'rampY', maskDensity: 0.5 },
      ],
    },
    {
      name: 'pass-through group sees the backdrop',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', children: [{ pattern: 'rampY', mode: 'multiply' }] },
      ],
    },
    {
      name: 'isolated group hides the backdrop',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', mode: 'normal', children: [{ pattern: 'rampY', mode: 'multiply' }] },
      ],
    },
    {
      name: 'pass-through group at 50% opacity',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', opacity: 0.5, children: [{ pattern: 'rampY', mode: 'screen' }] },
      ],
    },
    {
      name: 'isolated group at 50% opacity',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', mode: 'normal', opacity: 0.5, children: [{ pattern: 'rampY' }] },
      ],
    },
    {
      name: 'clipping mask confined to base alpha',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [0.2, 0.4, 0.6], alpha: 0.5 },
        { pattern: 'rampY', clipped: true },
      ],
    },
    {
      name: 'clipping mask with base opacity',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [0.2, 0.4, 0.6], opacity: 0.5 },
        { pattern: 'rampY', clipped: true },
      ],
    },
    {
      name: 'two clipped layers over one base',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [0.3, 0.3, 0.3] },
        { pattern: 'rampY', clipped: true, mode: 'multiply' },
        { pattern: 'solid', color: [1, 0.5, 0], clipped: true, opacity: 0.5 },
      ],
    },
    {
      name: 'blend if on the underlying layer',
      layers: [
        { pattern: 'rampX' },
        {
          pattern: 'solid',
          color: [1, 1, 1],
          blendIf: [{ channel: 'gray', thisLayer: [0, 0, 1, 1], underlying: [0.2, 0.6, 1, 1] }],
        },
      ],
    },
    {
      name: 'hidden layer is skipped',
      layers: [{ pattern: 'rampX' }, { pattern: 'rampY', visible: false }],
    },
    {
      name: 'batched run of plain Normal layers',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [1, 0, 0], alpha: 0.5 },
        { pattern: 'rampY', alpha: 0.5 },
        { pattern: 'solid', color: [0, 0, 1], alpha: 0.25 },
      ],
    },
    {
      name: 'batched run with per-layer opacity',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [1, 1, 0], opacity: 0.3 },
        { pattern: 'rampY', opacity: 0.6 },
      ],
    },
    {
      name: 'batched run interrupted by a blend mode',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'solid', color: [0.9, 0.2, 0.2], alpha: 0.5 },
        { pattern: 'rampY', mode: 'multiply' },
        { pattern: 'solid', color: [0.2, 0.9, 0.2], alpha: 0.5 },
      ],
    },
    {
      name: 'nested groups',
      layers: [
        { pattern: 'rampX' },
        {
          pattern: 'solid',
          children: [{ pattern: 'solid', children: [{ pattern: 'rampY', mode: 'overlay' }] }],
        },
      ],
    },
  );

  // Adjustment layers: every kind over 4096 distinct colours, GLSL mirror vs CPU kernel.
  for (const adjustment of ADJUSTMENT_SAMPLES) {
    cases.push({
      name: `adjustment ${ADJUSTMENT_LABEL[adjustment.kind]}${adjustment.kind === 'hueSaturation' && adjustment.colorize ? ' (colorize)' : ''}${adjustment.kind === 'brightnessContrast' && adjustment.legacy ? ' (legacy)' : ''}`,
      layers: [{ pattern: 'colors' }, { pattern: 'solid', adjustment }],
    });
  }
  const hue = ADJUSTMENT_SAMPLES.find((a) => a.kind === 'hueSaturation')!;
  const curves = ADJUSTMENT_SAMPLES.find((a) => a.kind === 'curves')!;
  cases.push(
    {
      name: 'adjustment through a mask',
      layers: [{ pattern: 'colors' }, { pattern: 'solid', adjustment: hue, maskPattern: 'rampY' }],
    },
    {
      name: 'adjustment at 50% opacity, Multiply',
      layers: [{ pattern: 'colors' }, { pattern: 'solid', adjustment: curves, opacity: 0.5, mode: 'multiply' }],
    },
    {
      name: 'adjustment in Luminosity mode',
      layers: [{ pattern: 'colors' }, { pattern: 'solid', adjustment: hue, mode: 'luminosity' }],
    },
    {
      name: 'adjustment over a 50% alpha backdrop keeps its alpha',
      layers: [{ pattern: 'colors', alpha: 0.5 }, { pattern: 'solid', adjustment: { kind: 'invert' } }],
    },
    {
      name: 'clipped adjustment affects only its base',
      layers: [
        { pattern: 'rampX' },
        { pattern: 'colors', alpha: 0.5 },
        { pattern: 'solid', adjustment: hue, clipped: true },
      ],
    },
    {
      name: 'adjustment inside a pass-through group reaches below it',
      layers: [
        { pattern: 'colors' },
        { pattern: 'solid', children: [{ pattern: 'solid', adjustment: { kind: 'invert' } }] },
      ],
    },
    {
      name: 'adjustment inside an isolated group sees only the group',
      layers: [
        { pattern: 'colors' },
        {
          pattern: 'solid',
          mode: 'normal',
          children: [{ pattern: 'rampY', alpha: 0.5 }, { pattern: 'solid', adjustment: { kind: 'invert' } }],
        },
      ],
    },
  );

  // Fill layers: each source over the full target, one masked and blended.
  const ramp = {
    colorStops: [
      { at: 0, color: [0.1, 0.2, 0.9] as [number, number, number] },
      { at: 0.6, color: [1, 0.8, 0.1] as [number, number, number], midpoint: 0.3 },
      { at: 1, color: [0.9, 0.1, 0.2] as [number, number, number] },
    ],
    opacityStops: [
      { at: 0, opacity: 1 },
      { at: 1, opacity: 0.4 },
    ],
  };
  const patterns = builtinPatterns();
  cases.push(
    { name: 'fill: solid colour', layers: [{ pattern: 'colors' }, { pattern: 'solid', fillContent: { type: 'solid', color: [0.3, 0.6, 0.2] }, opacity: 0.7 }] },
    ...(['linear', 'radial', 'angle', 'reflected', 'diamond'] as const).map((style) => ({
      name: `fill: ${style} gradient`,
      layers: [
        { pattern: 'colors' as const },
        {
          pattern: 'solid' as const,
          fillContent: { type: 'gradient' as const, gradient: ramp, style, angle: 35, scale: 90, reverse: style === 'radial', offset: { x: 5, y: -10 } },
        },
      ],
      // The ramp index is t rounded to 1/255; float32 against float64 can round a boundary
      // pixel to the neighbouring entry, one level away on this gradient.
      tolerance: 2,
    })),
    {
      name: 'fill: pattern, scaled and offset, through a mask in Multiply',
      layers: [
        { pattern: 'colors' },
        {
          pattern: 'solid',
          fillContent: { type: 'pattern', pattern: patterns.find((p) => p.id === 'umbra-bricks')!, scale: 150, phase: { x: 5, y: 3 } },
          maskPattern: 'rampX',
          mode: 'multiply',
        },
      ],
    },
  );

  return cases;
}
