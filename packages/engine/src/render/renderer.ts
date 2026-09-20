/**
 * Viewport renderer.
 *
 * Draws the transparency checkerboard, then one instanced draw call per layer covering that
 * layer's visible tiles at the mip level matching the current zoom. One draw per layer (not
 * per tile) is what holds 60 fps with 100 layers on screen (spec 03 §5.2, M0 spike 3).
 *
 * M0 limitation: tiles are uploaded without a 1 px apron, so at zoom < 100% LINEAR
 * minification clamps at slice edges and can leave a faint tile grid. The fix (an apron, or
 * a per-level atlas with neighbour-aware upload) belongs with the real compositor in M2.
 */
import { TILE_SIZE } from '@umbra/core/pixels';
import { rectIntersect, type Rect } from '@umbra/core/geom';
import { Program } from '../gpu/program.js';
import { TileAtlas } from '../gpu/atlas.js';
import type { GpuCaps } from '../gpu/caps.js';
import { MipPlane, levelForScale, tileSpan } from '../tiles/mip.js';
import { tilesInRect } from '../tiles/plane.js';
import { docToClip, visibleDocRect, type ViewState } from './view.js';

const TILE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;   // unit quad
layout(location = 1) in vec3 a_tile;     // xy = tile origin in doc px, z = atlas slot
uniform mat3 u_docToClip;
uniform float u_tileSpan;                // doc px covered by one tile at this level
const float PAGE_TILES = 8.0;
out vec2 v_uv;
flat out float v_page;
flat out vec2 v_cell;
void main() {
  vec2 doc = a_tile.xy + a_corner * u_tileSpan;
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  // Unpack the slot into a page and a cell within that page's 8x8 grid.
  float perPage = PAGE_TILES * PAGE_TILES;
  float page = floor(a_tile.z / perPage);
  float cell = a_tile.z - page * perPage;
  vec2 cellXY = vec2(mod(cell, PAGE_TILES), floor(cell / PAGE_TILES));
  v_uv = (cellXY + a_corner) / PAGE_TILES;
  v_cell = cellXY;
  v_page = page;
}`;

const TILE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_uv;
flat in float v_page;
flat in vec2 v_cell;
uniform sampler2DArray u_atlas;
const float PAGE_TILES = 8.0;
const float PAGE_SIZE = 2048.0;
uniform float u_opacity;
// 1.0 when the slice already holds premultiplied data (a live stroke painted into it).
uniform float u_premultiplied;
out vec4 fragColor;
void main() {
  // Clamp inside the cell so linear minification cannot bleed in a neighbouring tile.
  vec2 lo = v_cell / PAGE_TILES + 0.5 / PAGE_SIZE;
  vec2 hi = (v_cell + 1.0) / PAGE_TILES - 0.5 / PAGE_SIZE;
  vec4 c = texture(u_atlas, vec3(clamp(v_uv, lo, hi), v_page));
  // Storage is straight alpha; the framebuffer accumulates premultiplied.
  vec3 rgb = mix(c.rgb * c.a, c.rgb, u_premultiplied);
  fragColor = vec4(rgb, c.a) * u_opacity;
}`;

const CHECKER_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform mat3 u_docToClip;
uniform vec4 u_docRect;   // x0, y0, x1, y1
void main() {
  vec2 doc = mix(u_docRect.xy, u_docRect.zw, a_corner);
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const CHECKER_FRAG = `#version 300 es
precision highp float;
uniform float u_size;     // checker square size in device px
uniform vec3 u_light;
uniform vec3 u_dark;
out vec4 fragColor;
void main() {
  vec2 c = floor(gl_FragCoord.xy / u_size);
  float odd = mod(c.x + c.y, 2.0);
  fragColor = vec4(mix(u_dark, u_light, odd), 1.0);
}`;

export interface LayerDraw {
  plane: MipPlane;
  opacity: number;
  visible: boolean;
  /** Slices hold premultiplied data (true only while a live stroke owns the layer). */
  premultiplied?: boolean;
}

export interface FrameStats {
  drawCalls: number;
  instances: number;
  level: number;
  cpuMs: number;
}

export class Renderer {
  private tileProgram!: Program;
  private checkerProgram!: Program;
  private quadBuffer!: WebGLBuffer;
  private instanceBuffer!: WebGLBuffer;
  private tileVao!: WebGLVertexArrayObject;
  private checkerVao!: WebGLVertexArrayObject;
  private instanceData = new Float32Array(3 * 1024);
  atlas!: TileAtlas;

  constructor(
    private gl: WebGL2RenderingContext,
    private caps: GpuCaps,
    private atlasBudgetBytes = 1024 * 1024 * 1024,
  ) {
    this.build();
  }

  private build(): void {
    const gl = this.gl;
    this.tileProgram = new Program(gl, TILE_VERT, TILE_FRAG, 'tiles');
    this.checkerProgram = new Program(gl, CHECKER_VERT, CHECKER_FRAG, 'checker');
    this.atlas = new TileAtlas(gl, this.caps, this.atlasBudgetBytes);

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    this.tileVao = gl.createVertexArray();
    gl.bindVertexArray(this.tileVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(1, 1);

    this.checkerVao = gl.createVertexArray();
    gl.bindVertexArray(this.checkerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Rebuild every GPU object after a context loss, from the CPU tile store. */
  restore(gl: WebGL2RenderingContext, caps: GpuCaps): void {
    this.gl = gl;
    this.caps = caps;
    this.build();
  }

  render(
    view: ViewState,
    docRect: Rect,
    layers: readonly LayerDraw[],
    pasteboard: [number, number, number] = [0.157, 0.157, 0.157],
  ): FrameStats {
    const t0 = performance.now();
    const gl = this.gl;
    const dpr = view.devicePixelRatio;
    const vw = Math.max(1, Math.round(view.width * dpr));
    const vh = Math.max(1, Math.round(view.height * dpr));

    gl.viewport(0, 0, vw, vh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(pasteboard[0], pasteboard[1], pasteboard[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const clip = docToClip(view);
    const visible = rectIntersect(visibleDocRect(view), docRect);

    // Transparency checkerboard, clipped to the canvas.
    this.checkerProgram.use();
    gl.bindVertexArray(this.checkerVao);
    gl.disable(gl.BLEND);
    this.checkerProgram.uMat3('u_docToClip', clip);
    this.checkerProgram.u4f('u_docRect', docRect.x0, docRect.y0, docRect.x1, docRect.y1);
    this.checkerProgram.u1f('u_size', 8 * dpr);
    gl.uniform3f(this.checkerProgram.loc('u_light'), 0.8, 0.8, 0.8);
    gl.uniform3f(this.checkerProgram.loc('u_dark'), 0.6, 0.6, 0.6);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const stats: FrameStats = { drawCalls: 1, instances: 0, level: 0, cpuMs: 0 };
    if (visible.x1 <= visible.x0 || visible.y1 <= visible.y0) {
      stats.cpuMs = performance.now() - t0;
      return stats;
    }

    // One instanced draw per layer preserves stacking order while keeping draw calls at O(layers).
    const level = levelForScale(view.zoom, 8);
    const span = tileSpan(level);
    stats.level = level;

    this.atlas.beginFrame();
    this.tileProgram.use();
    gl.bindVertexArray(this.tileVao);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.atlas.bind(0);
    this.tileProgram.u1i('u_atlas', 0);
    this.tileProgram.uMat3('u_docToClip', clip);
    this.tileProgram.u1f('u_tileSpan', span);

    // Tile-grid cells of the chosen level that intersect the visible document area.
    const cells = [
      ...tilesInRect({
        x0: visible.x0 / (1 << level),
        y0: visible.y0 / (1 << level),
        x1: visible.x1 / (1 << level),
        y1: visible.y1 / (1 << level),
      }),
    ];

    for (const layer of layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const plane = layer.plane.level(level);
      // Slices acquired for previous layers are already drawn and may now be recycled.
      this.atlas.beginBatch();
      let n = 0;
      this.ensureInstanceCapacity(cells.length);
      for (const { tx, ty } of cells) {
        if (!plane.hasTile(tx, ty)) continue;
        const tile = plane.tileAt(tx, ty);
        if (tile.isTransparent()) continue;
        const slice = this.atlas.acquire(tile);
        const o = n * 3;
        this.instanceData[o] = tx * span;
        this.instanceData[o + 1] = ty * span;
        this.instanceData[o + 2] = slice;
        n++;
      }
      if (n === 0) continue;

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, n * 3);
      this.tileProgram.u1f('u_opacity', layer.opacity);
      this.tileProgram.u1f('u_premultiplied', layer.premultiplied ? 1 : 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      stats.drawCalls++;
      stats.instances += n;
    }

    gl.bindVertexArray(null);
    stats.cpuMs = performance.now() - t0;
    return stats;
  }

  private ensureInstanceCapacity(tiles: number): void {
    if (this.instanceData.length >= tiles * 3) return;
    this.instanceData = new Float32Array(tiles * 3 * 2);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
  }

  dispose(): void {
    this.atlas.dispose();
    this.tileProgram.dispose();
    this.checkerProgram.dispose();
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.tileVao);
    gl.deleteVertexArray(this.checkerVao);
  }
}

export { TILE_SIZE };
