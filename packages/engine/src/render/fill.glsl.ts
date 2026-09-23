/**
 * Fill layers on the GPU — the mirror of `@umbra/kernels/fill`.
 *
 * A fill layer's source is computed per fragment over the canvas rectangle: a solid colour, a
 * gradient through the same 256-entry 8-bit ramp the CPU reference uses, or a repeating
 * pattern texture. Outside the canvas the source stays transparent, so an "infinite" fill
 * does not paint the pasteboard.
 */
import { gradientFillGeometry, type FillContent, type PatternDef } from '@umbra/kernels/fill';
import { gradientRamp } from '@umbra/kernels/gradient';
import { Program } from '../gpu/program.js';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform mat3 u_docToClip;
uniform vec4 u_docRect;
out vec2 v_doc;
void main() {
  vec2 doc = mix(u_docRect.xy, u_docRect.zw, a_corner);
  v_doc = doc;
  vec3 clip = u_docToClip * vec3(doc, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_doc;
uniform int u_type;          // 0 solid, 1 gradient, 2 pattern
uniform vec4 u_color;
uniform sampler2D u_ramp;    // 256×1 RGBA8
uniform int u_style;         // 0 linear, 1 radial, 2 angle, 3 reflected, 4 diamond
uniform vec4 u_geom;         // x0, y0, x1, y1
uniform float u_reverse;
uniform sampler2D u_pattern;
uniform vec2 u_patSize;
uniform float u_scale;       // pattern scale as a fraction
uniform vec2 u_phase;
out vec4 fragColor;

float gradientT(vec2 p) {
  vec2 a = u_geom.xy;
  vec2 d = u_geom.zw - a;
  float len2 = dot(d, d);
  vec2 q = p - a;
  if (u_style == 0) return len2 == 0.0 ? 0.0 : dot(q, d) / len2;
  if (u_style == 1) { float r = sqrt(len2); return r == 0.0 ? 1.0 : length(q) / r; }
  if (u_style == 2) {
    float t = (atan(q.y, q.x) - atan(d.y, d.x)) / 6.283185307179586;
    return t - floor(t);
  }
  if (u_style == 3) return len2 == 0.0 ? 0.0 : abs(dot(q, d) / len2);
  float r = sqrt(len2);
  if (r == 0.0) return 1.0;
  vec2 u = d / r;
  return (abs(q.x * u.x + q.y * u.y) + abs(-q.x * u.y + q.y * u.x)) / r;
}

void main() {
  if (u_type == 0) { fragColor = u_color; return; }
  if (u_type == 1) {
    float t = clamp(gradientT(v_doc), 0.0, 1.0);
    if (u_reverse > 0.5) t = 1.0 - t;
    fragColor = texelFetch(u_ramp, ivec2(int(floor(t * 255.0 + 0.5)), 0), 0);
    return;
  }
  vec2 px = floor((v_doc - u_phase) / u_scale);
  vec2 t = mod(px, u_patSize);
  fragColor = texelFetch(u_pattern, ivec2(t), 0);
}`;

const STYLE_INDEX = { linear: 0, radial: 1, angle: 2, reflected: 3, diamond: 4 } as const;

export class FillRenderer {
  private program: Program;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private ramps = new WeakMap<object, WebGLTexture>();
  private patterns = new WeakMap<Uint8Array, WebGLTexture>();
  /** Textures to free on dispose; WeakMaps cannot be enumerated. */
  private owned: WebGLTexture[] = [];
  private dummy: WebGLTexture;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, VERT, FRAG, 'fill-layer');
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.dummy = this.texture(1, 1, new Uint8Array(4));
  }

  private texture(w: number, h: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.owned.push(tex);
    return tex;
  }

  private patternTexture(p: PatternDef): WebGLTexture {
    let t = this.patterns.get(p.data);
    if (!t) {
      t = this.texture(p.width, p.height, p.data);
      this.patterns.set(p.data, t);
    }
    return t;
  }

  /**
   * Draw `content` into the bound target over the canvas rectangle `docRect`, through
   * `docToClip`. Straight alpha, blending off.
   */
  draw(content: FillContent, docToClip: Float32Array, docRect: { x0: number; y0: number; x1: number; y1: number }, canvas: { width: number; height: number }): void {
    const gl = this.gl;
    const p = this.program;
    p.use();
    gl.disable(gl.BLEND);
    p.uMat3('u_docToClip', docToClip);
    p.u4f('u_docRect', docRect.x0, docRect.y0, docRect.x1, docRect.y1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    p.u1i('u_ramp', 0);
    p.u1i('u_pattern', 1);

    if (content.type === 'solid') {
      p.u1i('u_type', 0);
      p.u4f('u_color', content.color[0], content.color[1], content.color[2], 1);
    } else if (content.type === 'gradient') {
      p.u1i('u_type', 1);
      let ramp = this.ramps.get(content.gradient);
      if (!ramp) {
        ramp = this.texture(256, 1, gradientRamp(content.gradient));
        this.ramps.set(content.gradient, ramp);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ramp);
      const g = gradientFillGeometry(content, canvas.width, canvas.height);
      p.u1i('u_style', STYLE_INDEX[content.style]);
      p.u4f('u_geom', g.x0, g.y0, g.x1, g.y1);
      p.u1f('u_reverse', content.reverse ? 1 : 0);
    } else {
      p.u1i('u_type', 2);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.patternTexture(content.pattern));
      p.u2f('u_patSize', content.pattern.width, content.pattern.height);
      p.u1f('u_scale', content.scale / 100);
      p.u2f('u_phase', content.phase.x, content.phase.y);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    for (const t of this.owned) this.gl.deleteTexture(t);
    this.program.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}
