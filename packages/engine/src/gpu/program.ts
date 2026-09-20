/** Minimal shader-program wrapper: compile, cache uniform locations, set uniforms. */

export class Program {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSrc: string,
    fragmentSrc: string,
    readonly label = 'program',
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSrc, `${label}.vert`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSrc, `${label}.frag`);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    // Shaders can be detached immediately; the linked program keeps what it needs.
    gl.detachShader(p, vs);
    gl.detachShader(p, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`link failed (${label}): ${log}`);
    }
    this.handle = p;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.uniforms.set(name, l);
    }
    return l;
  }

  attrib(name: string): number {
    return this.gl.getAttribLocation(this.handle, name);
  }

  u1i(name: string, v: number): void {
    this.gl.uniform1i(this.loc(name), v);
  }
  u1f(name: string, v: number): void {
    this.gl.uniform1f(this.loc(name), v);
  }
  u2f(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y);
  }
  u4f(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
  }
  uMat3(name: string, m: Float32Array): void {
    this.gl.uniformMatrix3fv(this.loc(name), false, m);
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  label: string,
): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error(`createShader failed (${label})`);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
      .join('\n');
    throw new Error(`compile failed (${label}): ${log}\n${numbered}`);
  }
  return s;
}
