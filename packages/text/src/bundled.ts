/**
 * The bundled OFL fonts (Noto Sans and its Arabic, Hebrew and Devanagari companions; see
 * fonts/OFL.txt). They are the default face and the fallback chain when a document's fonts
 * are missing. Fetched on first type use, like HarfBuzz.
 */
import type { FontRegistry } from './fonts.js';

export const BUNDLED_FONTS = [
  'NotoSans-Regular.ttf',
  'NotoSans-Bold.ttf',
  'NotoSans-Italic.ttf',
  'NotoSans-BoldItalic.ttf',
  'NotoSansArabic-Regular.ttf',
  'NotoSansHebrew-Regular.ttf',
  'NotoSansDevanagari-Regular.ttf',
] as const;

export function bundledFontUrl(file: (typeof BUNDLED_FONTS)[number]): URL {
  return new URL(`../fonts/${file}`, import.meta.url);
}

/** Fetch and register the bundled set; the Regular faces become the fallbacks. */
export async function loadBundledFonts(reg: FontRegistry, load: (url: URL) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => r.arrayBuffer())): Promise<void> {
  const files = await Promise.all(BUNDLED_FONTS.map(async (f) => ({ f, bytes: new Uint8Array(await load(bundledFontUrl(f))) })));
  for (const { bytes } of files) reg.add(bytes, 'bundled');
  reg.fallbacks = reg.faces.filter((f) => f.source === 'bundled' && f.style === 'Regular');
}
