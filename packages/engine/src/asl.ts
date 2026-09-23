/**
 * Photoshop style libraries (.asl) — spec 07: read and write, so styles move between Umbra
 * and Photoshop. The layout (after Krita's and GIMP's readers, and psd-tools' notes):
 *
 *   uint16 2 · '8BSL' · uint16 3 · uint32 patternsSize · patterns (the PSD 'Patt' records)
 *   uint32 styleCount · per style: uint32 size · descriptor v16 'null' {Nm, Idnt}
 *                                  · descriptor v16 'Styl' {documentMode, Lefx} · pad to 4
 *
 * Written files carry `Lefx` only (no `documentMode`): see writeAsl.
 *
 * `Lefx` is the same effects descriptor a PSD layer carries, so ag-psd's own parser and
 * serialiser do the effects, and psd-effects.ts maps them to ours.
 */
import { createReader, readUint16, readUint32, checkSignature, readPattern } from 'ag-psd/dist/psdReader';
import { createWriter, getWriterBuffer, writeUint16, writeUint32, writeSignature, writePattern, writeBytes } from 'ag-psd/dist/psdWriter';
import { readVersionAndDescriptor, writeVersionAndDescriptor, parseEffects, serializeEffects } from 'ag-psd/dist/descriptor';
import type { PatternDef } from '@umbra/kernels/fill';
import { mapEffectPatterns } from '@umbra/kernels/effects/types';
import type { StylePreset } from '@umbra/kernels/effects/presets';
import { effectsFromPsd, effectsToPsd } from './psd-effects.js';

export interface AslContents {
  styles: StylePreset[];
  patterns: PatternDef[];
  /** Per style, what could not be read (as on PSD open). */
  lost: { style: string; features: string[] }[];
}

type AgPattern = { name: string; id: string; bounds: { x: number; y: number; w: number; h: number }; data: Uint8Array };

export function readAsl(bytes: Uint8Array): AslContents {
  const r = createReader(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const version = readUint16(r);
  if (version !== 2) throw new Error(`Not a style library (version ${version})`);
  checkSignature(r, '8BSL');
  readUint16(r); // patterns version, 3
  const patternsSize = readUint32(r);
  const patternsEnd = r.offset + patternsSize;
  const patterns: PatternDef[] = [];
  while (r.offset < patternsEnd - 4) {
    const p = readPattern(r) as unknown as AgPattern;
    patterns.push({ id: p.id, name: p.name, width: p.bounds.w, height: p.bounds.h, data: p.data });
  }
  r.offset = patternsEnd;
  const count = readUint32(r);
  const styles: StylePreset[] = [];
  const lost: AslContents['lost'] = [];
  for (let k = 0; k < count; k++) {
    const size = readUint32(r);
    const end = r.offset + size;
    const meta = readVersionAndDescriptor(r) as { 'Nm  '?: string; Idnt?: string };
    const styl = readVersionAndDescriptor(r) as { Lefx?: unknown };
    const name = meta['Nm  '] ?? `Style ${k + 1}`;
    if (styl.Lefx) {
      const agEffects = parseEffects(styl.Lefx as never, false);
      const { effects, lost: missing } = effectsFromPsd(agEffects, patterns);
      styles.push({ id: meta.Idnt ?? `asl-${k}-${name}`, name, effects });
      if (missing.length) lost.push({ style: name, features: missing });
    }
    r.offset = end;
    while (r.offset % 4) r.offset++;
  }
  return { styles, patterns, lost };
}

export function writeAsl(styles: readonly StylePreset[]): Uint8Array {
  // Every pattern a style uses goes in the library's pattern section.
  const patterns = new Map<string, PatternDef>();
  for (const s of styles) mapEffectPatterns(s.effects, (p) => (p.data.length && patterns.set(p.id, p), p));
  const w = createWriter();
  writeUint16(w, 2);
  writeSignature(w, '8BSL');
  writeUint16(w, 3);
  const pw = createWriter();
  for (const p of patterns.values()) writePattern(pw, { name: p.name, id: p.id, x: 0, y: 0, bounds: { x: 0, y: 0, w: p.width, h: p.height }, data: p.data } as never);
  const pbytes = new Uint8Array(getWriterBuffer(pw));
  writeUint32(w, pbytes.length);
  writeBytes(w, pbytes);
  writeUint32(w, styles.length);
  for (const s of styles) {
    const sw = createWriter();
    writeVersionAndDescriptor(sw, '', 'null', { 'Nm  ': s.name, Idnt: s.id });
    // Photoshop also writes a `documentMode` descriptor (the blending options); ag-psd's writer
    // cannot express it and the effects need only `Lefx`, so it is left out.
    writeVersionAndDescriptor(sw, '', 'Styl', { Lefx: serializeEffects(effectsToPsd(s.effects), false, false) } as never);
    let sbytes = new Uint8Array(getWriterBuffer(sw));
    const padded = (sbytes.length + 3) & ~3;
    if (padded !== sbytes.length) {
      const p = new Uint8Array(padded);
      p.set(sbytes);
      sbytes = p;
    }
    writeUint32(w, sbytes.length);
    writeBytes(w, sbytes);
  }
  return new Uint8Array(getWriterBuffer(w));
}
