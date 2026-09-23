/**
 * The ABR corpus: Photoshop's own brush files, read where they are installed (they are
 * Adobe's, so they are not copied into the repository). Point UMBRA_ABR_CORPUS at a folder of
 * .abr files, or leave it unset to look for a Photoshop 2020 install on a mounted Windows
 * partition. Skipped when none is found.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAbrFile, writeAbrFile } from './abr.js';

function corpus(): string[] {
  const roots = process.env.UMBRA_ABR_CORPUS
    ? [process.env.UMBRA_ABR_CORPUS]
    : existsSync('/mnt')
      ? readdirSync('/mnt').map((d) => join('/mnt', d, 'Program Files/Adobe/Adobe Photoshop 2020'))
      : [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
        else if (/\.abr$/i.test(e)) out.push(p);
      } catch {
        // Unreadable entries on a foreign file system are not the corpus.
      }
    }
  };
  for (const r of roots) walk(r, 0);
  // One copy of each file, by name and size (a dual-boot box has two installs).
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.split('/').pop()}:${statSync(p).size}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const files = corpus();

describe.skipIf(files.length === 0)('ABR corpus', () => {
  for (const file of files) {
    it(`imports ${file.split('/').pop()} with its tips and dynamics, and survives a round trip`, () => {
      const bytes = new Uint8Array(readFileSync(file));
      const abr = readAbrFile(bytes, 'corpus');
      expect(abr.presets.length).toBeGreaterThan(0);
      // Every sampled tip a preset names was read, and is a real bitmap.
      for (const p of abr.presets) {
        const tip = p.params.tip;
        if (tip?.kind !== 'sampled') continue;
        const t = abr.tips.get(tip.id);
        expect(t, `${p.name}: tip ${tip.id}`).toBeDefined();
        expect(t!.data.length).toBe(t!.width * t!.height);
        expect(t!.data.some((v) => v > 0)).toBe(true);
      }
      // Nothing was lost outright. Bristle and erodible tips are drawn round (a known gap).
      expect(abr.lost.filter((l) => !l.endsWith('tip drawn as a round tip'))).toEqual([]);
      expect(abr.presets.every((p) => !p.name.startsWith('$$$'))).toBe(true);
      // Written back out and read again: the same presets with the same settings.
      const again = readAbrFile(writeAbrFile(abr.presets, abr.tips, abr.patterns), 'again');
      expect(again.presets.map((p) => p.name)).toEqual(abr.presets.map((p) => p.name));
      const strip = (o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'id' ? undefined : v)));
      for (let i = 0; i < abr.presets.length; i++) expect(strip(again.presets[i]!.params), abr.presets[i]!.name).toEqual(strip(abr.presets[i]!.params));
    });
  }
});
