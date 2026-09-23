import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every .ts/.tsx source under packages/(name)/src. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'dist') continue;
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('sources', () => {
  // A raw U+2028/U+2029 is a line terminator to the parser: inside a regular expression it
  // breaks the module (it happened twice while writing the type engine). Write the escapes.
  it('contain no raw line or paragraph separators', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const bad = readdirSync(root)
      .map((pkg) => join(root, pkg, 'src'))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
      .flatMap((d) => sources(d))
      .filter((f) => /[\u2028\u2029]/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
