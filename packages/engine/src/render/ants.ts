/**
 * Marching ants — spec 04 §3.
 *
 * The selection outline is traced on the CPU as unit edges along the 50% iso-contour, then
 * drawn as screen-space dashed lines. Drawing the contour rather than shading the mask is what
 * keeps the outline exactly one device pixel wide at any zoom, which is how a selection stays
 * legible at 3200% as well as at 6%.
 *
 * The dash phase advances with time, and the pattern is measured in SCREEN pixels, so the ants
 * keep their size and speed as the user zooms.
 */
import { Program } from '../gpu/program.js';
import { docToClip, type ViewState } from './view.js';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_point;  // x, y in document space; z = distance along the outline
uniform mat3 u_docToClip;
uniform float u_zoom;
out float v_dist;
void main() {
  vec3 clip = u_docToClip * vec3(a_point.xy, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  // Measure the dash in screen pixels so it does not stretch with zoom.
  v_dist = a_point.z * u_zoom;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in float v_dist;
uniform float u_phase;
uniform float u_dash;
out vec4 fragColor;
void main() {
  float t = mod(v_dist + u_phase, u_dash * 2.0);
  // Alternating black and white gives an outline visible over any artwork.
  fragColor = t < u_dash ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0, 1.0, 1.0, 1.0);
}`;

export class AntsRenderer {
  private program: Program;
  private buffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private vertexCount = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, VERT, FRAG, 'ants');
    this.buffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  /** `outline` is x,y,dist triples, two per segment. */
  setOutline(outline: Float32Array): void {
    const gl = this.gl;
    this.vertexCount = outline.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, outline, gl.DYNAMIC_DRAW);
  }

  get isEmpty(): boolean {
    return this.vertexCount === 0;
  }

  draw(view: ViewState, timeMs: number): void {
    if (this.vertexCount === 0) return;
    const gl = this.gl;
    this.program.use();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.program.uMat3('u_docToClip', docToClip(view));
    this.program.u1f('u_zoom', view.zoom * view.devicePixelRatio);
    this.program.u1f('u_dash', 4 * view.devicePixelRatio);
    // Ants crawl along the outline; the sign makes them move "into" the selection.
    this.program.u1f('u_phase', -(timeMs / 1000) * 12 * view.devicePixelRatio);
    gl.drawArrays(gl.LINES, 0, this.vertexCount);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.program.dispose();
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }
}
