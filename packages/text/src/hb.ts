/**
 * HarfBuzz, lazily — spec 03 §7: the WASM shaper is a chunk of its own, loaded the first
 * time type is used, never at startup.
 */
export type HB = typeof import('harfbuzzjs');

let loading: Promise<HB> | null = null;

export function loadHarfBuzz(): Promise<HB> {
  loading ??= import('harfbuzzjs');
  return loading;
}
