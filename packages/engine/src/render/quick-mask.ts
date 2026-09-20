/**
 * Quick Mask overlay — spec 04 §3.
 *
 * Quick Mask shows the selection as a rubylith sheet: the PROTECTED area (coverage 0) is
 * tinted, the selected area is clear, and partial coverage tints proportionally. That is the
 * whole point of the mode — a feathered or painted edge is visible as a gradient, which
 * marching ants, being a hard contour at 50%, cannot show.
 *
 * The overlay is drawn in document space over the presented frame, so it lands exactly on the
 * pixels it describes at any zoom and rotation.
 */
import { Program } from '../gpu/program.js';
import { docToClip, type ViewState } from './view.js';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform mat3 u_docToClip;
uniform vec2 u_docSize;
out vec2 v_uv;
void main() {
  vec2 doc = a_corner * u_docSize;
  v_uv = a_corner;
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_selection;
uniform vec3 u_color;
uniform float u_opacity;
/** 0 tints the masked area (Photoshop's default), 1 tints the selected area. */
uniform float u_indicateSelected;
out vec4 fragColor;
void main() {
  float selected = texture(u_selection, v_uv).r;
  float tint = mix(1.0 - selected, selected, u_indicateSelected);
  float a = tint * u_opacity;
  fragColor = vec4(u_color * a, a);
}`;

export interface QuickMaskStyle {
  /** Overlay colour; Photoshop's default is pure red. */
  color: [number, number, number];
  /** 0…1; Photoshop's default is 0.5. */
  opacity: number;
  /** false tints the masked area (the default), true tints the selected area instead. */
  indicateSelected: boolean;
}

export const DEFAULT_QUICK_MASK: QuickMaskStyle = {
  color: [1, 0, 0],
  opacity: 0.5,
  indicateSelected: false,
};

export class QuickMaskRenderer {
  private program: Program;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, VERT, FRAG, 'quick-mask');
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

  draw(
    view: ViewState,
    selection: WebGLTexture,
    docWidth: number,
    docHeight: number,
    style: QuickMaskStyle,
  ): void {
    const gl = this.gl;
    this.program.use();
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    // The overlay is emitted premultiplied, so this is a plain "over".
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, selection);
    this.program.u1i('u_selection', 0);
    this.program.uMat3('u_docToClip', docToClip(view));
    this.program.u2f('u_docSize', docWidth, docHeight);
    gl.uniform3f(this.program.loc('u_color'), style.color[0], style.color[1], style.color[2]);
    this.program.u1f('u_opacity', style.opacity);
    this.program.u1f('u_indicateSelected', style.indicateSelected ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.program.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}
