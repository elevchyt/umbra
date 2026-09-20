/**
 * Renders a document tree to the canvas: checkerboard, then the composited layers.
 *
 * Each layer's content is drawn into a scratch target by the tile drawer, and the compositor
 * blends that against the running accumulator (spec 03 §5.2). Every blend mode, group,
 * clipping run and mask therefore goes through exactly the same code the parity suite checks
 * against the CPU reference.
 */
import type { Rect } from '@umbra/core/geom';
import { Program } from '../gpu/program.js';
import type { TileAtlas } from '../gpu/atlas.js';
import type { GpuCaps } from '../gpu/caps.js';
import { LayerCompositor, type GpuLayer, type RenderTarget } from './compositor.js';
import { TileDrawer } from './tile-drawer.js';
import { AntsRenderer } from './ants.js';
import { QuickMaskRenderer, type QuickMaskStyle } from './quick-mask.js';
import { HandlesRenderer } from './handles.js';
import { IDENTITY, type Mat } from '@umbra/kernels/matrix';
import { docToClip, type ViewState } from './view.js';
import type { BlendMode } from '@umbra/core/blend';
import { MipPlane } from '../tiles/mip.js';
import type { Doc, Layer } from '../document.js';

const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
out vec2 v_uv;
void main() { v_uv = a_corner; gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

/** Present pass: the composite, straight→premultiplied, over whatever is already there. */
const PRESENT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_composite;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_composite, v_uv);
  fragColor = vec4(c.rgb * c.a, c.a);
}`;

/**
 * One colour channel as greyscale, over the canvas rect only.
 *
 * It uses the canvas-rect quad rather than a full-screen one so the pasteboard stays the
 * pasteboard — a channel view that painted the whole window black would hide where the
 * document ends. The composite is sampled by fragment position, since it is rendered at
 * exactly the viewport's size.
 */
const CHANNEL_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_composite;
uniform vec2 u_size;
uniform int u_channel;   // 0 = red, 1 = green, 2 = blue
out vec4 fragColor;
void main() {
  vec4 c = texture(u_composite, gl_FragCoord.xy / u_size);
  float v = u_channel == 0 ? c.r : (u_channel == 1 ? c.g : c.b);
  fragColor = vec4(v, v, v, 1.0);
}`;

/** A quad covering the canvas rect in document space, so it follows zoom and rotation. */
const CANVAS_MASK_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform mat3 u_docToClip;
uniform vec4 u_docRect;
void main() {
  vec2 doc = mix(u_docRect.xy, u_docRect.zw, a_corner);
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

/**
 * The transparency checkerboard, drawn ONLY over the canvas rect so the pasteboard stays
 * visible around it — a document's edge has to be obvious, and a checkerboard that runs to
 * the window edge hides exactly that.
 *
 * The cells are measured in device pixels rather than document pixels, so they stay the same
 * size on screen at any zoom. Photoshop does the same.
 */
const CHECKER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform float u_checkerSize;
uniform vec3 u_light;
uniform vec3 u_dark;
out vec4 fragColor;
void main() {
  vec2 cell = floor(gl_FragCoord.xy / u_checkerSize);
  float odd = mod(cell.x + cell.y, 2.0);
  fragColor = vec4(mix(u_dark, u_light, odd), 1.0);
}`;

export interface DocumentFrameStats {
  /** Full-viewport blend passes (the expensive ones). */
  layerPasses: number;
  /** Layers folded into a batched fast-path run. */
  batchedLayers: number;
  tileInstances: number;
  level: number;
}

export class DocumentRenderer {
  readonly compositor: LayerCompositor;
  readonly tiles: TileDrawer;
  readonly ants: AntsRenderer;
  readonly quickMask: QuickMaskRenderer;
  readonly handles: HandlesRenderer;
  private present: Program;
  private checker: Program;
  private channel: Program;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private stats: DocumentFrameStats = { layerPasses: 0, batchedLayers: 0, tileInstances: 0, level: 0 };

  constructor(
    private gl: WebGL2RenderingContext,
    caps: GpuCaps,
    atlas: TileAtlas,
  ) {
    this.compositor = new LayerCompositor(gl, caps);
    this.tiles = new TileDrawer(gl, atlas);
    this.ants = new AntsRenderer(gl);
    this.quickMask = new QuickMaskRenderer(gl);
    this.handles = new HandlesRenderer(gl);
    this.present = new Program(gl, QUAD_VERT, PRESENT_FRAG, 'present');
    this.checker = new Program(gl, CANVAS_MASK_VERT, CHECKER_FRAG, 'checker');
    this.channel = new Program(gl, CANVAS_MASK_VERT, CHANNEL_FRAG, 'channel-view');
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

  setAtlas(atlas: TileAtlas): void {
    this.tiles.setAtlas(atlas);
  }

  /**
   * A live stroke, drawn as a synthetic layer immediately above the one being painted.
   *
   * It has to be a separate layer rather than pixels in the target: the stroke buffer holds
   * accumulated FLOW and is only applied at the brush's opacity and blend mode when the stroke
   * ends, so the preview has to apply them the same way without touching the layer.
   */
  private strokeOverlay: {
    plane: MipPlane;
    layerId: number;
    opacity: number;
    mode: BlendMode;
  } | null = null;

  /**
   * A live Move or Free Transform. The listed layers draw through `matrix` instead of being
   * rewritten, so dragging is free and the pixels are resampled exactly once, on commit.
   */
  private liveTransform: { ids: ReadonlySet<number>; matrix: Mat } | null = null;

  setLiveTransform(t: { ids: ReadonlySet<number>; matrix: Mat } | null): void {
    this.liveTransform = t;
  }

  setStrokeOverlay(
    overlay: { plane: MipPlane; layerId: number; opacity: number; mode: BlendMode } | null,
  ): void {
    this.strokeOverlay = overlay;
  }

  /** Map a layer list to GPU layers, splicing the live stroke in above its target. */
  private toGpuLayers(layers: readonly Layer[], view: ViewState, clip: Rect): GpuLayer[] {
    const out: GpuLayer[] = [];
    for (const l of layers) {
      out.push(this.toGpuLayer(l, view, clip));
      const o = this.strokeOverlay;
      if (o && o.layerId === l.id) {
        out.push({
          kind: 'pixel',
          name: '<stroke>',
          visible: true,
          opacity: o.opacity,
          fill: 1,
          blendMode: o.mode,
          clipped: false,
          seed: 0,
          maskDensity: 1,
          drawSource: () => {
            this.stats.layerPasses++;
            this.stats.tileInstances += this.tiles.draw(o.plane, view, clip);
          },
        });
      }
    }
    return out;
  }

  private toGpuLayer(layer: Layer, view: ViewState, clip: Rect): GpuLayer {
    const out: GpuLayer = {
      kind: layer.kind,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      fill: layer.fill,
      blendMode: layer.blendMode,
      clipped: layer.clipped,
      seed: layer.seed,
      channels: layer.blending?.channels,
      blendIf: layer.blending?.blendIf as GpuLayer['blendIf'],
      maskDensity: layer.mask?.density ?? 1,
    };

    const live =
      this.liveTransform && this.liveTransform.ids.has(layer.id) ? this.liveTransform.matrix : IDENTITY;

    if (layer.mask && layer.mask.enabled) {
      const maskPlane = layer.mask.plane;
      out.drawMask = (_t: RenderTarget) => {
        this.tiles.draw(maskPlane, view, clip, true, 1, false, live);
      };
    }

    if (layer.kind === 'group') {
      out.children = this.toGpuLayers(layer.children, view, clip);
    } else {
      const plane = layer.plane;
      out.drawSource = (_t: RenderTarget) => {
        this.stats.layerPasses++;
        this.stats.tileInstances += this.tiles.draw(plane, view, clip, false, 1, false, live);
      };
      const ch = layer.blending?.channels;
      out.plain =
        layer.blendMode === 'normal' &&
        !layer.clipped &&
        !out.drawMask &&
        layer.fill >= 1 &&
        (layer.blending?.blendIf?.length ?? 0) === 0 &&
        (!ch || (ch.r && ch.g && ch.b));
      out.drawBatched = (opacity: number) => {
        this.stats.batchedLayers++;
        this.stats.tileInstances += this.tiles.draw(plane, view, clip, false, opacity, true, live);
      };
    }
    return out;
  }

  render(
    doc: Doc,
    view: ViewState,
    docRect: Rect,
    pasteboard: [number, number, number] = [0.157, 0.157, 0.157],
    showAnts = true,
    quickMask: { tex: WebGLTexture; style: QuickMaskStyle } | null = null,
    transformBox: { box: Rect; matrix: Mat } | null = null,
    channelView: 'all' | 'r' | 'g' | 'b' = 'all',
  ): DocumentFrameStats {
    const gl = this.gl;
    const dpr = view.devicePixelRatio;
    const vw = Math.max(1, Math.round(view.width * dpr));
    const vh = Math.max(1, Math.round(view.height * dpr));

    this.stats = { layerPasses: 0, batchedLayers: 0, tileInstances: 0, level: 0 };
    this.compositor.resize(vw, vh);
    this.compositor.setOrigin(0, 0);

    const layers = this.toGpuLayers(doc.layers, view, docRect);

    // Composite onto transparency; the present pass puts the checkerboard underneath.
    const composite = this.compositor.compositeOnTransparent(layers);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vw, vh);
    gl.disable(gl.BLEND);
    gl.clearColor(pasteboard[0], pasteboard[1], pasteboard[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindVertexArray(this.vao);

    // Checkerboard first, clipped to the canvas rect.
    this.checker.use();
    this.checker.uMat3('u_docToClip', docToClip(view));
    gl.uniform4f(
      this.checker.loc('u_docRect'),
      docRect.x0,
      docRect.y0,
      docRect.x1,
      docRect.y1,
    );
    this.checker.u1f('u_checkerSize', 8 * dpr);
    gl.uniform3f(this.checker.loc('u_light'), 0.8, 0.8, 0.8);
    gl.uniform3f(this.checker.loc('u_dark'), 0.6, 0.6, 0.6);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, composite.tex);

    if (channelView === 'all') {
      // The artwork over the checker. The composite is straight alpha and zero outside the
      // canvas, so a plain "over" leaves the pasteboard untouched.
      this.present.use();
      this.present.u1i('u_composite', 0);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
    } else {
      this.channel.use();
      this.channel.u1i('u_composite', 0);
      this.channel.u2f('u_size', vw, vh);
      this.channel.u1i('u_channel', channelView === 'r' ? 0 : channelView === 'g' ? 1 : 2);
      this.channel.uMat3('u_docToClip', docToClip(view));
      gl.uniform4f(this.channel.loc('u_docRect'), docRect.x0, docRect.y0, docRect.x1, docRect.y1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);

    // The rubylith goes over the artwork but under the outline. Photoshop hides the ants in
    // Quick Mask mode, because the overlay already shows the edge — and shows it better,
    // since it renders partial coverage the ants' 50% contour throws away.
    if (quickMask) {
      this.quickMask.draw(view, quickMask.tex, doc.width, doc.height, quickMask.style);
    } else if (showAnts) {
      // Selection outline sits on top of everything, in screen space.
      this.ants.draw(view, performance.now());
    }
    // The transform box goes above even the ants: it is what the pointer is acting on.
    if (transformBox) this.handles.draw(view, transformBox.box, transformBox.matrix);

    this.compositor.releaseAll();
    return this.stats;
  }

  /**
   * Composite the whole document at 1:1 and read it back as straight-alpha RGBA8.
   *
   * The Magic Wand needs the composited pixels, and reading them from the GPU is far cheaper
   * than walking the layer tree per pixel on the CPU (a 4K document would be tens of millions
   * of closure calls). Capped at the device's texture limit; larger documents need tiling,
   * which is not implemented yet.
   */
  renderToBuffer(doc: Doc, maxSize: number): { pixels: Uint8Array; width: number; height: number } {
    const gl = this.gl;
    const width = Math.min(doc.width, maxSize);
    const height = Math.min(doc.height, maxSize);
    const view: ViewState = {
      zoom: 1,
      rotation: 0,
      centre: { x: width / 2, y: height / 2 },
      width,
      height,
      devicePixelRatio: 1,
    };

    this.compositor.resize(width, height);
    const layers = doc.layers.map((l) => this.toGpuLayer(l, view, { x0: 0, y0: 0, x1: doc.width, y1: doc.height }));
    const composite = this.compositor.compositeOnTransparent(layers);

    const floats = new Float32Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, composite.fbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, floats);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.compositor.releaseAll();

    // readPixels is bottom-up; flip into document order.
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4;
      const dst = y * width * 4;
      for (let i = 0; i < width * 4; i++) {
        pixels[dst + i] = Math.round(Math.min(1, Math.max(0, floats[src + i]!)) * 255);
      }
    }
    return { pixels, width, height };
  }

  dispose(): void {
    this.compositor.dispose();
    this.tiles.dispose();
    this.ants.dispose();
    this.present.dispose();
    this.checker.dispose();
    this.channel.dispose();
    this.quickMask.dispose();
    this.handles.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}
