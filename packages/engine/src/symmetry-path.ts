/**
 * The symmetry path as a document path (Edit Points): the figure a symmetry mirrors across —
 * its lines cut to the canvas, its curves fitted with Béziers — ready for the Direct Selection
 * tool. Radial and Mandala have none: they repeat by turning, which a path cannot hold.
 */
import { symmetryFigure, type Symmetry } from '@umbra/kernels/brush';
import { corner, type Path } from '@umbra/kernels/vector/path';
import { cubicsToSubpath, fitCurve } from '@umbra/kernels/vector/fit';

export function symmetryPath(sym: Symmetry, width: number, height: number): Path | null {
  if (sym.mode === 'off' || sym.mode === 'path' || sym.mode === 'radial' || sym.mode === 'mandala') return null;
  const fig = symmetryFigure(sym, width, height);
  return {
    subpaths: fig.polys.map((poly, i) =>
      fig.straight[i] ? { knots: poly.map((p) => corner(p.x, p.y)), closed: false, op: 'add' as const } : cubicsToSubpath(fitCurve(poly, 0.25, fig.closed[i]!), fig.closed[i]!),
    ),
  };
}
