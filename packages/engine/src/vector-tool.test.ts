import { describe, expect, it } from 'vitest';
import type { Path } from '@umbra/kernels/vector/path';
import { VectorTool, type VectorPointer } from './vector-tool.js';

const ev = (phase: VectorPointer['phase'], x: number, y: number, over: Partial<VectorPointer> = {}): VectorPointer => ({ phase, x, y, shift: false, alt: false, ctrl: false, clicks: 1, ...over });

/** Drive a tool through a click or drag; returns the final path and the commit names seen. */
function gesture(t: VectorTool, path: Path | null, pts: [number, number][], over: Partial<VectorPointer> = {}): { path: Path | null; commits: string[] } {
  let p = path;
  const commits: string[] = [];
  const apply = (r: { path: Path | null; commit: string | null }) => {
    if (r.path) p = r.path;
    if (r.commit) commits.push(r.commit);
  };
  apply(t.pointer(p, ev('down', pts[0]![0], pts[0]![1], over)));
  for (const q of pts.slice(1)) apply(t.pointer(p, ev('move', q[0], q[1], over)));
  const last = pts[pts.length - 1]!;
  apply(t.pointer(p, ev('up', last[0], last[1], over)));
  return { path: p, commits };
}

describe('the Pen', () => {
  it('clicks make corners; clicking the first anchor closes', () => {
    const t = new VectorTool(() => 4);
    let r = gesture(t, null, [[10, 10]]);
    expect(r.commits).toEqual(['New Work Path']);
    r = gesture(t, r.path, [[50, 10]]);
    r = gesture(t, r.path, [[30, 40]]);
    r = gesture(t, r.path, [[11, 11]]);
    expect(r.commits).toEqual(['Close Path']);
    const sp = r.path!.subpaths[0]!;
    expect(sp.closed).toBe(true);
    expect(sp.knots.map((k) => [k.anchor.x, k.anchor.y])).toEqual([
      [10, 10],
      [50, 10],
      [30, 40],
    ]);
    expect(t.drawing).toBeNull();
  });

  it('a drag makes a smooth point; Alt-drag a cusp', () => {
    const t = new VectorTool(() => 4);
    let r = gesture(t, null, [[10, 10]]);
    r = gesture(t, r.path, [[50, 10], [60, 20]]);
    const k = r.path!.subpaths[0]!.knots[1]!;
    expect([k.out.x, k.out.y, k.in.x, k.in.y, k.smooth]).toEqual([60, 20, 40, 0, true]);
    r = gesture(t, r.path, [[90, 10], [95, 30]], { alt: true });
    const c = r.path!.subpaths[0]!.knots[2]!;
    expect([c.out.x, c.out.y, c.in.x, c.in.y, c.smooth]).toEqual([95, 30, 90, 10, false]);
  });

  it('Shift keeps the next anchor on 45° lines; Escape ends the sub-path', () => {
    const t = new VectorTool(() => 4);
    let r = gesture(t, null, [[10, 10]]);
    r = gesture(t, r.path, [[40, 13]], { shift: true });
    expect(r.path!.subpaths[0]!.knots[1]!.anchor.y).toBeCloseTo(10, 6);
    t.key(r.path, 'Escape');
    expect(t.drawing).toBeNull();
    // The next click starts a second sub-path.
    r = gesture(t, r.path, [[10, 60]]);
    expect(r.path!.subpaths.length).toBe(2);
  });

  it('Auto Add/Delete: a click on a segment adds an anchor, on an anchor deletes it', () => {
    const t = new VectorTool(() => 4);
    let r = gesture(t, null, [[10, 10]]);
    r = gesture(t, r.path, [[50, 10]]);
    r = gesture(t, r.path, [[50, 50]]);
    t.key(r.path, 'Enter');
    r = gesture(t, r.path, [[30, 10]]);
    expect(r.commits).toEqual(['Add Anchor Point']);
    expect(r.path!.subpaths[0]!.knots.length).toBe(4);
    r = gesture(t, r.path, [[30, 10]]);
    expect(r.commits).toEqual(['Delete Anchor Point']);
    expect(r.path!.subpaths[0]!.knots.length).toBe(3);
  });
});

describe('selecting and editing', () => {
  const square = (): Path => ({
    subpaths: [
      {
        closed: true,
        op: 'add',
        knots: [
          [10, 10],
          [40, 10],
          [40, 40],
          [10, 40],
        ].map(([x, y]) => ({ anchor: { x: x!, y: y! }, in: { x: x!, y: y! }, out: { x: x!, y: y! }, smooth: false })),
      },
    ],
  });

  it('Direct Selection drags an anchor; a marquee selects several', () => {
    const t = new VectorTool(() => 4);
    t.tool = 'directSelect';
    let r = gesture(t, square(), [[40, 40], [45, 50]]);
    expect(r.commits).toEqual(['Drag Anchor']);
    expect(r.path!.subpaths[0]!.knots[2]!.anchor).toEqual({ x: 45, y: 50 });
    r = gesture(t, square(), [[0, 0], [45, 20]]);
    expect(t.selected.map((s) => s.k).sort()).toEqual([0, 1]);
  });

  it('Path Selection moves a whole sub-path; Alt-drag duplicates it', () => {
    const t = new VectorTool(() => 4);
    t.tool = 'pathSelect';
    let r = gesture(t, square(), [[25, 25], [35, 25]]);
    expect(r.commits).toEqual(['Drag Paths']);
    expect(r.path!.subpaths[0]!.knots[0]!.anchor).toEqual({ x: 20, y: 10 });
    r = gesture(t, square(), [[25, 25], [25, 75]], { alt: true });
    expect(r.path!.subpaths.length).toBe(2);
    expect(r.path!.subpaths[1]!.knots[0]!.anchor).toEqual({ x: 10, y: 60 });
  });

  it('Convert Point pulls handles out of a corner and retracts them again', () => {
    const t = new VectorTool(() => 4);
    t.tool = 'convertPoint';
    let r = gesture(t, square(), [[40, 10], [50, 10]]);
    const k = r.path!.subpaths[0]!.knots[1]!;
    expect([k.out.x, k.in.x, k.smooth]).toEqual([50, 30, true]);
    r = gesture(t, r.path, [[40, 10]]);
    const c = r.path!.subpaths[0]!.knots[1]!;
    expect([c.out, c.in]).toEqual([c.anchor, c.anchor]);
  });

  it('Backspace deletes the selected anchors', () => {
    const t = new VectorTool(() => 4);
    t.tool = 'directSelect';
    gesture(t, square(), [[0, 0], [45, 20]]);
    const r = t.key(square(), 'Backspace');
    expect(r.path!.subpaths[0]!.knots.length).toBe(2);
  });
});

describe('Freeform and Curvature Pens', () => {
  it('the Freeform Pen fits curves to the trail, closing near the start', () => {
    const t = new VectorTool(() => 4);
    t.tool = 'freeformPen';
    const pts: [number, number][] = Array.from({ length: 60 }, (_, i) => [32 + 20 * Math.cos((i / 60) * Math.PI * 2), 32 + 20 * Math.sin((i / 60) * Math.PI * 2)]);
    const r = gesture(t, null, [...pts, [52, 32]]);
    expect(r.commits).toEqual(['New Work Path']);
    const sp = r.path!.subpaths[0]!;
    expect(sp.closed).toBe(true);
    expect(sp.knots.length).toBeLessThan(12);
  });

  it('the Curvature Pen smooths through its points, and a double-click makes a corner', () => {
    const t = new VectorTool(() => 4);
    t.tool = 'curvaturePen';
    let r = gesture(t, null, [[10, 30]]);
    r = gesture(t, r.path, [[30, 10]]);
    r = gesture(t, r.path, [[50, 30]]);
    const mid = r.path!.subpaths[0]!.knots[1]!;
    expect(mid.smooth).toBe(true);
    expect(mid.out.x).toBeGreaterThan(mid.anchor.x);
    r = gesture(t, r.path, [[50, 30]], { clicks: 2 });
    r = gesture(t, r.path, [[70, 10]]);
    const cornerKnot = r.path!.subpaths[0]!.knots[2]!;
    expect(cornerKnot.smooth).toBe(false);
  });
});
