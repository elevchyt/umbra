/** Runs the parity matrix and formats a report, mirroring the M0 spike runner's output. */
import { ParityRunner, parityCases, type ParityResult } from './parity.js';
import { runDocumentParity } from './parity-docs.js';
import type { GpuCaps } from './gpu/caps.js';

export function runParity(gl: WebGL2RenderingContext, caps: GpuCaps): {
  pass: boolean;
  text: string;
  results: ParityResult[];
} {
  const runner = new ParityRunner(gl, caps);
  const results: ParityResult[] = [];
  try {
    for (const c of parityCases()) results.push(runner.run(c));
  } finally {
    runner.dispose();
  }
  results.push(...runDocumentParity(gl, caps));
  // A rejected GL call only warns in the console, and the mask-upload bug of M4 hid behind
  // exactly that for two milestones. Any error left pending fails the run.
  const glError = gl.getError();
  results.push({
    name: glError === gl.NO_ERROR ? 'no WebGL errors raised' : `WebGL error 0x${glError.toString(16)} raised during the run`,
    pass: glError === gl.NO_ERROR,
    maxDelta: 0,
    meanDelta: 0,
    worstAt: null,
  });

  const failed = results.filter((r) => !r.pass);
  const worst = results.reduce((a, b) => (b.maxDelta > a.maxDelta ? b : a), results[0]!);
  const lines = [
    '',
    '══ M2 GPU ≡ CPU compositing parity ═════════════════════════',
    ...failed.map(
      (r) =>
        `FAIL  ${r.name}\n      maxΔ=${r.maxDelta} meanΔ=${r.meanDelta.toFixed(3)} at ${r.worstAt ? `(${r.worstAt.x},${r.worstAt.y})` : '—'}`,
    ),
    failed.length === 0 ? 'all cases within tolerance' : '',
    '───────────────────────────────────────────────────────────',
    `${results.length - failed.length}/${results.length} cases passed  (worst: ${worst.name}, maxΔ=${worst.maxDelta})`,
    '',
  ].filter(Boolean);
  return { pass: failed.length === 0, text: lines.join('\n'), results };
}
