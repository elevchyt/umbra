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
import type { ViewState } from './view.js';
import type { Doc, Layer } from '../document.js';

const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
out vec2 v_uv;
void main() { v_uv = a_corner; gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

/** Final present pass: checkerboard under the composite, then straight→premultiplied. */
const PRESENT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_composite;
uniform vec2 u_size;
uniform float u_checkerSize;
uniform vec3 u_light;
uniform vec3 u_dark;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_composite, v_uv);
  vec2 cell = floor(gl_FragCoord.xy / u_checkerSize);
  float odd = mod(cell.x + cell.y, 2.0);
  vec3 checker = mix(u_dark, u_light, odd);
  fragColor = vec4(mix(checker, c.rgb, c.a), 1.0);
}`;

/** Fills the canvas rect so the checkerboard only shows inside the document. */
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
  private present: Program;
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
    this.present = new Program(gl, QUAD_VERT, PRESENT_FRAG, 'present');
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

    if (layer.mask && layer.mask.enabled) {
      const maskPlane = layer.mask.plane;
      out.drawMask = (_t: RenderTarget) => {
        this.tiles.draw(maskPlane, view, clip, true);
      };
    }

    if (layer.kind === 'group') {
      out.children = layer.children.map((c) => this.toGpuLayer(c, view, clip));
    } else {
      const plane = layer.plane;
      out.drawSource = (_t: RenderTarget) => {
        this.stats.layerPasses++;
        this.stats.tileInstances += this.tiles.draw(plane, view, clip);
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
        this.stats.tileInstances += this.tiles.draw(plane, view, clip, false, opacity, true);
      };
    }
    return out;
  }

  render(
    doc: Doc,
    view: ViewState,
    docRect: Rect,
    pasteboard: [number, number, number] = [0.157, 0.157, 0.157],
  ): DocumentFrameStats {
    const gl = this.gl;
    const dpr = view.devicePixelRatio;
    const vw = Math.max(1, Math.round(view.width * dpr));
    const vh = Math.max(1, Math.round(view.height * dpr));

    this.stats = { layerPasses: 0, batchedLayers: 0, tileInstances: 0, level: 0 };
    this.compositor.resize(vw, vh);
    this.compositor.setOrigin(0, 0);

    const layers = doc.layers.map((l) => this.toGpuLayer(l, view, docRect));

    // Composite onto transparency; the present pass puts the checkerboard underneath.
    const composite = this.compositor.compositeOnTransparent(layers);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vw, vh);
    gl.disable(gl.BLEND);
    gl.clearColor(pasteboard[0], pasteboard[1], pasteboard[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.present.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, composite.tex);
    this.present.u1i('u_composite', 0);
    this.present.u2f('u_size', vw, vh);
    this.present.u1f('u_checkerSize', 8 * dpr);
    gl.uniform3f(this.present.loc('u_light'), 0.8, 0.8, 0.8);
    gl.uniform3f(this.present.loc('u_dark'), 0.6, 0.6, 0.6);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    this.compositor.releaseAll();
    return this.stats;
  }

  dispose(): void {
    this.compositor.dispose();
    this.tiles.dispose();
    this.present.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}

export { CANVAS_MASK_VERT };
