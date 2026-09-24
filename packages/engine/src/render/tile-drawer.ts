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
import { IDENTITY, invert, transformedBounds, type Mat } from '@umbra/kernels/matrix';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_tile;
uniform mat3 u_docToClip;
/** The live transform alone (plane → document), for clipping to the canvas. */
uniform mat3 u_live;
uniform float u_tileSpan;
const float PAGE_TILES = 8.0;
out vec2 v_uv;
out vec2 v_doc;
flat out float v_page;
flat out vec2 v_cell;
void main() {
  vec2 doc = a_tile.xy + a_corner * u_tileSpan;
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  v_doc = (u_live * vec3(doc, 1.0)).xy;
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
in vec2 v_doc;
flat in float v_page;
flat in vec2 v_cell;
uniform sampler2DArray u_atlas;
/** 1.0 for single-channel planes (masks), which store coverage in red. */
uniform float u_isMask;
uniform float u_opacity;
/** 1.0 to emit premultiplied alpha, for accumulation with fixed-function blending. */
uniform float u_premultiply;
/** 1.0 for a live Wet Edges stroke: coverage through the pooling curve (kernels' wetEdges). */
uniform float u_wet;
/** x0, y0, x1, y1 in document space; used when u_useBounds is 1 (a transformed overlay). */
uniform vec4 u_bounds;
uniform float u_useBounds;
const float PAGE_TILES = 8.0;
const float PAGE_SIZE = 2048.0;
out vec4 fragColor;
void main() {
  if (u_useBounds > 0.5 && (v_doc.x < u_bounds.x || v_doc.y < u_bounds.y || v_doc.x > u_bounds.z || v_doc.y > u_bounds.w)) discard;
  vec2 lo = v_cell / PAGE_TILES + 0.5 / PAGE_SIZE;
  vec2 hi = (v_cell + 1.0) / PAGE_TILES - 0.5 / PAGE_SIZE;
  vec4 c = texture(u_atlas, vec3(clamp(v_uv, lo, hi), v_page));
  if (u_isMask > 0.5) { fragColor = vec4(c.rrr, 1.0); return; }
  if (u_wet > 0.5) c.a = c.a * (0.5 + 2.0 * c.a * (1.0 - c.a));
  c.a *= u_opacity;
  fragColor = u_premultiply > 0.5 ? vec4(c.rgb * c.a, c.a) : c;
}`;

/**
 * `view · m` as the column-major 3×3 the shader wants. The tile quad is built in plane space,
 * so the layer's own transform has to be applied first and the view transform second.
 */
function mul3(view: Float32Array, m: Mat): Float32Array {
  const a = [m.a, m.b, 0, m.c, m.d, 0, m.e, m.f, 1];
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] =
        view[0 * 3 + row]! * a[col * 3 + 0]! +
        view[1 * 3 + row]! * a[col * 3 + 1]! +
        view[2 * 3 + row]! * a[col * 3 + 2]!;
    }
  }
  return out;
}

export class TileDrawer {
  /** Set by the renderer while it draws a live Wet Edges stroke. */
  wet = false;
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
    /**
     * An extra transform applied to the plane before the view transform. This is how a live
     * Move or Free Transform previews: the layer's tiles are drawn moved rather than rewritten,
     * so dragging costs nothing and the pixels are only resampled once, on commit.
     */
    matrix: Mat = IDENTITY,
    /** Discard what the transform carries outside this document rect (the Clone Source overlay). */
    bounds: Rect | null = null,
  ): number {
    const gl = this.gl;
    const visible = rectIntersect(visibleDocRect(view), clip);
    if (visible.x1 <= visible.x0 || visible.y1 <= visible.y0) return 0;

    const level = levelForScale(view.zoom, 8);
    const span = tileSpan(level);
    const layer = plane.level(level);

    // With a transform in play, the tiles that end up visible are the ones whose PRE-image
    // covers the visible rect, so the search area is mapped back through the inverse.
    const inverse = invert(matrix);
    if (!inverse) return 0;
    const source = matrix === IDENTITY ? visible : transformedBounds(inverse, visible);
    const cells = [
      ...tilesInRect({
        x0: source.x0 / (1 << level),
        y0: source.y0 / (1 << level),
        x1: source.x1 / (1 << level),
        y1: source.y1 / (1 << level),
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
    this.program.uMat3('u_docToClip', mul3(docToClip(view), matrix));
    this.program.u1f('u_tileSpan', span);
    this.program.u1f('u_isMask', isMask ? 1 : 0);
    this.program.u1f('u_opacity', opacity);
    this.program.u1f('u_premultiply', premultiply ? 1 : 0);
    this.program.u1f('u_wet', this.wet ? 1 : 0);
    this.program.uMat3('u_live', new Float32Array([matrix.a, matrix.b, 0, matrix.c, matrix.d, 0, matrix.e, matrix.f, 1]));
    this.program.u1f('u_useBounds', bounds ? 1 : 0);
    if (bounds) this.program.u4f('u_bounds', bounds.x0, bounds.y0, bounds.x1, bounds.y1);
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
