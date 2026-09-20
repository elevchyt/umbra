/**
 * Minimal GPU dab pass — enough of a brush to measure the input→pixels latency budget
 * (M0 spike 1) and to prove the render-into-atlas path the real brush engine needs in M8.
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
in vec2 v_local;
uniform vec2 u_centre;     // tile-local px
uniform float u_radius;
uniform float u_hardness;
uniform vec4 u_color;      // straight alpha
out vec4 fragColor;
void main() {
  float d = distance(v_local, u_centre);
  // Hard core out to hardness*radius, then a smooth falloff to the rim.
  float inner = u_radius * u_hardness;
  float a = 1.0 - smoothstep(inner, max(u_radius, inner + 0.5), d);
  a *= u_color.a;
  if (a <= 0.0) discard;
  fragColor = vec4(u_color.rgb * a, a);   // premultiplied
}`;

export interface DabParams {
  /** Document-space centre. */
  x: number;
  y: number;
  radius: number;
  hardness: number;
  color: [number, number, number, number];
}

export class DabPainter {
  private program: Program;
  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private quad: WebGLBuffer;
  /** Tiles whose atlas slice is newer than their CPU pixels. */
  readonly gpuDirty = new Set<Tile>();

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, DAB_VERT, DAB_FRAG, 'dab');
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
  paint(atlas: TileAtlas, tileFor: (tx: number, ty: number) => Tile, p: DabParams): Tile[] {
    const gl = this.gl;
    const touched: Tile[] = [];
    const r = p.radius + 1;
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
        this.program.u1f('u_radius', p.radius);
        this.program.u1f('u_hardness', p.hardness);
        this.program.u4f('u_color', p.color[0], p.color[1], p.color[2], p.color[3]);
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
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}
