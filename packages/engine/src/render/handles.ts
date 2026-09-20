/**
 * Free Transform's bounding box and handles — spec 04 §5.
 *
 * Drawn in screen space from the four transformed corners, so the handles stay the same size
 * at any zoom and the box follows rotation and skew exactly. The outline is a thin light line
 * rather than marching ants: a transform box is not a selection, and Photoshop distinguishes
 * them the same way.
 */
import { Program } from '../gpu/program.js';
import { apply, type Mat } from '@umbra/kernels/matrix';
import { docToClip, screenPointAtDoc, type ViewState } from './view.js';
import type { Rect } from '@umbra/core/geom';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // clip space, already transformed on the CPU
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;

/** The eight handles plus the centre reference point, in the order Photoshop numbers them. */
export type HandleId =
  | 'nw' | 'n' | 'ne'
  | 'w' | 'e'
  | 'sw' | 's' | 'se'
  | 'pivot';

const HANDLE_PX = 7;

export const HANDLE_ORDER: HandleId[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

/** Unit coordinates of each handle inside the transform box. */
export const HANDLE_UV: Record<HandleId, { u: number; v: number }> = {
  nw: { u: 0, v: 0 },
  n: { u: 0.5, v: 0 },
  ne: { u: 1, v: 0 },
  w: { u: 0, v: 0.5 },
  e: { u: 1, v: 0.5 },
  sw: { u: 0, v: 1 },
  s: { u: 0.5, v: 1 },
  se: { u: 1, v: 1 },
  pivot: { u: 0.5, v: 0.5 },
};

/** Document-space position of a handle for a box under a transform. */
export function handlePoint(box: Rect, matrix: Mat, id: HandleId): { x: number; y: number } {
  const { u, v } = HANDLE_UV[id];
  return apply(matrix, { x: box.x0 + (box.x1 - box.x0) * u, y: box.y0 + (box.y1 - box.y0) * v });
}

/** Screen-space position, for hit-testing against the pointer. */
export function handleScreen(box: Rect, matrix: Mat, id: HandleId, view: ViewState): {
  x: number;
  y: number;
} {
  const p = handlePoint(box, matrix, id);
  return screenPointAtDoc(view, p.x, p.y);
}

/**
 * The handle under a screen point, or null. Corners win over edges when they overlap, which is
 * what a user aiming at a corner expects on a small box.
 */
export function hitHandle(
  box: Rect,
  matrix: Mat,
  view: ViewState,
  sx: number,
  sy: number,
  radius = HANDLE_PX + 3,
): HandleId | null {
  const corners: HandleId[] = ['nw', 'ne', 'sw', 'se'];
  const edges: HandleId[] = ['n', 's', 'w', 'e'];
  for (const group of [corners, edges]) {
    for (const id of group) {
      const p = handleScreen(box, matrix, id, view);
      if (Math.hypot(p.x - sx, p.y - sy) <= radius) return id;
    }
  }
  return null;
}



export class HandlesRenderer {
  private program: Program;
  private buffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, VERT, FRAG, 'handles');
    this.buffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private upload(data: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  draw(view: ViewState, box: Rect, matrix: Mat): void {
    const gl = this.gl;
    const m = docToClip(view);
    const toClip = (p: { x: number; y: number }): [number, number] => {
      const q = apply(matrix, p);
      return [m[0]! * q.x + m[3]! * q.y + m[6]!, m[1]! * q.x + m[4]! * q.y + m[7]!];
    };

    const corners = [
      toClip({ x: box.x0, y: box.y0 }),
      toClip({ x: box.x1, y: box.y0 }),
      toClip({ x: box.x1, y: box.y1 }),
      toClip({ x: box.x0, y: box.y1 }),
    ];

    this.program.use();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // Outline: four segments through the transformed corners.
    const outline = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      outline[i * 4] = a[0];
      outline[i * 4 + 1] = a[1];
      outline[i * 4 + 2] = b[0];
      outline[i * 4 + 3] = b[1];
    }
    this.upload(outline);
    gl.uniform4f(this.program.loc('u_color'), 0.85, 0.85, 0.85, 1);
    gl.drawArrays(gl.LINES, 0, 8);

    // Handles: small screen-space squares, so they stay grabbable at any zoom.
    const dpr = view.devicePixelRatio;
    const hw = ((HANDLE_PX * dpr) / Math.max(1, view.width * dpr)) * 2;
    const hh = ((HANDLE_PX * dpr) / Math.max(1, view.height * dpr)) * 2;
    const quads: number[] = [];
    for (const id of HANDLE_ORDER) {
      const { u, v } = HANDLE_UV[id];
      const [cx, cy] = toClip({
        x: box.x0 + (box.x1 - box.x0) * u,
        y: box.y0 + (box.y1 - box.y0) * v,
      });
      const x0 = cx - hw / 2;
      const x1 = cx + hw / 2;
      const y0 = cy - hh / 2;
      const y1 = cy + hh / 2;
      quads.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);
    }
    this.upload(new Float32Array(quads));
    gl.uniform4f(this.program.loc('u_color'), 0.95, 0.95, 0.95, 1);
    gl.drawArrays(gl.TRIANGLES, 0, quads.length / 2);

    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.program.dispose();
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }
}
