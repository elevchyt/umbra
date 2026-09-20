/**
 * Draws a plane's tiles into the currently bound framebuffer, under the view transform.
 *
 * This is the "source pass" the compositor calls per layer (spec 03 §5.2). Tiles never
 * overlap, so it writes straight alpha directly with blending OFF — the accumulator, not the
 * hardware blender, is where compositing happens.
 */
import { TILE_SIZE } from '@umbra/core/pixels';
import { rectIntersect, type Rect } from '@umbra/core/geom';
import { Program } from '../gpu/program.js';
import { TileAtlas } from '../gpu/atlas.js';
import { MipPlane, levelForScale, tileSpan } from '../tiles/mip.js';
import { tilesInRect } from '../tiles/plane.js';
import { docToClip, visibleDocRect, type ViewState } from './view.js';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_tile;
uniform mat3 u_docToClip;
uniform float u_tileSpan;
const float PAGE_TILES = 8.0;
out vec2 v_uv;
flat out float v_page;
flat out vec2 v_cell;
void main() {
  vec2 doc = a_tile.xy + a_corner * u_tileSpan;
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  float perPage = PAGE_TILES * PAGE_TILES;
  float page = floor(a_tile.z / perPage);
  float cell = a_tile.z - page * perPage;
  vec2 cellXY = vec2(mod(cell, PAGE_TILES), floor(cell / PAGE_TILES));
  v_uv = (cellXY + a_corner) / PAGE_TILES;
  v_cell = cellXY;
  v_page = page;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_uv;
flat in float v_page;
flat in vec2 v_cell;
uniform sampler2DArray u_atlas;
/** 1.0 for single-channel planes (masks), which store coverage in red. */
uniform float u_isMask;
uniform float u_opacity;
/** 1.0 to emit premultiplied alpha, for accumulation with fixed-function blending. */
uniform float u_premultiply;
const float PAGE_TILES = 8.0;
const float PAGE_SIZE = 2048.0;
out vec4 fragColor;
void main() {
  vec2 lo = v_cell / PAGE_TILES + 0.5 / PAGE_SIZE;
  vec2 hi = (v_cell + 1.0) / PAGE_TILES - 0.5 / PAGE_SIZE;
  vec4 c = texture(u_atlas, vec3(clamp(v_uv, lo, hi), v_page));
  if (u_isMask > 0.5) { fragColor = vec4(c.rrr, 1.0); return; }
  c.a *= u_opacity;
  fragColor = u_premultiply > 0.5 ? vec4(c.rgb * c.a, c.a) : c;
}`;

export class TileDrawer {
  private program: Program;
  private quad: WebGLBuffer;
  private instances: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private data = new Float32Array(3 * 512);

  constructor(
    private gl: WebGL2RenderingContext,
    private atlas: TileAtlas,
  ) {
    this.program = new Program(gl, VERT, FRAG, 'tile-drawer');
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  setAtlas(atlas: TileAtlas): void {
    this.atlas = atlas;
  }

  /** Returns the number of tile instances drawn. */
  draw(
    plane: MipPlane,
    view: ViewState,
    clip: Rect,
    isMask = false,
    opacity = 1,
    premultiply = false,
  ): number {
    const gl = this.gl;
    const visible = rectIntersect(visibleDocRect(view), clip);
    if (visible.x1 <= visible.x0 || visible.y1 <= visible.y0) return 0;

    const level = levelForScale(view.zoom, 8);
    const span = tileSpan(level);
    const layer = plane.level(level);

    const cells = [
      ...tilesInRect({
        x0: visible.x0 / (1 << level),
        y0: visible.y0 / (1 << level),
        x1: visible.x1 / (1 << level),
        y1: visible.y1 / (1 << level),
      }),
    ];
    if (this.data.length < cells.length * 3) {
      this.data = new Float32Array(cells.length * 3 * 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    }

    this.atlas.beginBatch();
    let n = 0;
    for (const { tx, ty } of cells) {
      if (!layer.hasTile(tx, ty)) continue;
      const tile = layer.tileAt(tx, ty);
      if (!isMask && tile.isTransparent()) continue;
      const slot = this.atlas.acquire(tile);
      const o = n * 3;
      this.data[o] = tx * span;
      this.data[o + 1] = ty * span;
      this.data[o + 2] = slot;
      n++;
    }
    if (n === 0) return 0;

    this.program.use();
    gl.bindVertexArray(this.vao);
    this.atlas.bind(0);
    this.program.u1i('u_atlas', 0);
    this.program.uMat3('u_docToClip', docToClip(view));
    this.program.u1f('u_tileSpan', span);
    this.program.u1f('u_isMask', isMask ? 1 : 0);
    this.program.u1f('u_opacity', opacity);
    this.program.u1f('u_premultiply', premultiply ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, n * 3);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    return n;
  }

  dispose(): void {
    this.program.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteBuffer(this.instances);
    this.gl.deleteVertexArray(this.vao);
  }
}

export { TILE_SIZE };
