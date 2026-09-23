/**
 * The vector tools' overlay — spec 04 §6: the target path's outline, its anchors (hollow, or
 * filled when selected), the handles of the knots being edited, the Pen's rubber band to the
 * pointer, and a selection marquee. Drawn in screen space like the transform handles, so it
 * reads the same at any zoom.
 */
import { Program } from '../gpu/program.js';
import { docToClip, type ViewState } from './view.js';

type Pt = { x: number; y: number };

export interface PathOverlay {
  outlines: Pt[][];
  anchors: { p: Pt; selected: boolean }[];
  handles: { anchor: Pt; handle: Pt }[];
  rubber: [Pt, Pt] | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  trail: Pt[] | null;
  /** Type editing: selected text (quads, filled translucent), the caret, the paragraph box. */
  highlight?: Pt[][];
  caret?: [Pt, Pt] | null;
  box?: Pt[] | null;
}

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;

const ANCHOR_PX = 6;
const HANDLE_DOT_PX = 5;

export class PathOverlayRenderer {
  private program: Program;
  private buffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = new Program(gl, VERT, FRAG, 'path-overlay');
    this.buffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private draw(mode: number, data: number[], rgba: [number, number, number, number]): void {
    if (data.length === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.uniform4f(this.program.loc('u_color'), ...rgba);
    gl.drawArrays(mode, 0, data.length / 2);
  }

  render(view: ViewState, o: PathOverlay): void {
    const gl = this.gl;
    const m = docToClip(view);
    const clip = (p: Pt): [number, number] => [m[0]! * p.x + m[3]! * p.y + m[6]!, m[1]! * p.x + m[4]! * p.y + m[7]!];
    const dpr = view.devicePixelRatio;
    const px = (n: number): [number, number] => [((n * dpr) / Math.max(1, view.width * dpr)) * 2, ((n * dpr) / Math.max(1, view.height * dpr)) * 2];

    this.program.use();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    if (o.highlight?.length) {
      const tri: number[] = [];
      for (const q of o.highlight) {
        const c = q.map(clip);
        tri.push(...c[0]!, ...c[1]!, ...c[2]!, ...c[0]!, ...c[2]!, ...c[3]!);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.draw(gl.TRIANGLES, tri, [0.15, 0.45, 1, 0.35]);
      gl.disable(gl.BLEND);
    }
    if (o.box) {
      const b: number[] = [];
      for (let i = 0; i < o.box.length; i++) b.push(...clip(o.box[i]!), ...clip(o.box[(i + 1) % o.box.length]!));
      this.draw(gl.LINES, b, [0.55, 0.55, 0.55, 1]);
    }
    if (o.caret) {
      // Black with a white edge beside it, so it reads over any colour.
      const [a, b] = o.caret;
      const [dx] = px(1);
      const ca = clip(a);
      const cb = clip(b);
      this.draw(gl.LINES, [ca[0] + dx, ca[1], cb[0] + dx, cb[1]], [1, 1, 1, 1]);
      this.draw(gl.LINES, [...ca, ...cb], [0, 0, 0, 1]);
    }

    const lines: number[] = [];
    const seg = (a: Pt, b: Pt) => lines.push(...clip(a), ...clip(b));
    for (const poly of o.outlines) for (let i = 0; i + 1 < poly.length; i++) seg(poly[i]!, poly[i + 1]!);
    if (o.trail) for (let i = 0; i + 1 < o.trail.length; i++) seg(o.trail[i]!, o.trail[i + 1]!);
    if (o.rubber) seg(o.rubber[0], o.rubber[1]);
    // Photoshop's path colour: a mid blue that reads on light and dark images.
    this.draw(gl.LINES, lines, [0.15, 0.55, 1, 1]);

    const handleLines: number[] = [];
    for (const h of o.handles) handleLines.push(...clip(h.anchor), ...clip(h.handle));
    this.draw(gl.LINES, handleLines, [0.15, 0.55, 1, 1]);

    if (o.marquee) {
      const { x0, y0, x1, y1 } = o.marquee;
      const box: number[] = [];
      const c = [clip({ x: x0, y: y0 }), clip({ x: x1, y: y0 }), clip({ x: x1, y: y1 }), clip({ x: x0, y: y1 })];
      for (let i = 0; i < 4; i++) box.push(...c[i]!, ...c[(i + 1) % 4]!);
      this.draw(gl.LINES, box, [0.9, 0.9, 0.9, 1]);
    }

    const square = (p: Pt, size: number, out: number[]) => {
      const [cx, cy] = clip(p);
      const [w, h] = px(size);
      const x0 = cx - w / 2;
      const x1 = cx + w / 2;
      const y0 = cy - h / 2;
      const y1 = cy + h / 2;
      out.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);
    };
    const outline = (p: Pt, size: number, out: number[]) => {
      const [cx, cy] = clip(p);
      const [w, h] = px(size);
      const x0 = cx - w / 2;
      const x1 = cx + w / 2;
      const y0 = cy - h / 2;
      const y1 = cy + h / 2;
      out.push(x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0);
    };
    const dots: number[] = [];
    for (const h of o.handles) square(h.handle, HANDLE_DOT_PX, dots);
    this.draw(gl.TRIANGLES, dots, [0.15, 0.55, 1, 1]);

    // Anchors: white hollow squares, filled blue when selected.
    const fill: number[] = [];
    const white: number[] = [];
    const rims: number[] = [];
    for (const a of o.anchors) {
      if (a.selected) square(a.p, ANCHOR_PX, fill);
      else square(a.p, ANCHOR_PX, white);
      outline(a.p, ANCHOR_PX, rims);
    }
    this.draw(gl.TRIANGLES, white, [1, 1, 1, 1]);
    this.draw(gl.TRIANGLES, fill, [0.15, 0.55, 1, 1]);
    this.draw(gl.LINES, rims, [0.15, 0.55, 1, 1]);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.program.dispose();
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
  }
}
