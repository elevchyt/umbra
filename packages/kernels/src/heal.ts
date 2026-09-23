/**
 * Healing — spec 04 §4.2 [doc]: Pérez et al. 2003 (Poisson image editing) and Georgiev 2004
 * (Photoshop's Healing Brush). The source is pasted so its GRADIENTS are kept while its
 * boundary meets the destination: equivalently, the pasted pixels are corrected by a smooth
 * membrane — the harmonic interpolation of the boundary differences (destination − source).
 *
 * The membrane solves Laplace's equation inside the region with those differences fixed on
 * its boundary, coarse to fine: each level is solved at half resolution first, upsampled as
 * the starting guess, then relaxed (Gauss–Seidel with over-relaxation) — a few dozen sweeps
 * per level instead of thousands at full size.
 */

/** Laplace's equation on `mask` (1 = unknown) with `values` fixed where mask is 0. In place. */
export function solveMembrane(values: Float32Array, mask: Uint8Array, w: number, h: number, channels: number, sweeps = 40): void {
  // Coarse level first, when the region is big enough to benefit.
  if (w > 16 && h > 16) {
    const cw = Math.ceil(w / 2);
    const ch = Math.ceil(h / 2);
    const cv = new Float32Array(cw * ch * channels);
    const cm = new Uint8Array(cw * ch);
    const cnt = new Float32Array(cw * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const j = (y >> 1) * cw + (x >> 1);
        // A coarse pixel is known when any of its fine pixels is: the boundary survives.
        if (!mask[i]) {
          for (let c = 0; c < channels; c++) cv[j * channels + c] = cv[j * channels + c]! + values[i * channels + c]!;
          cnt[j] = cnt[j]! + 1;
        }
      }
    }
    for (let j = 0; j < cw * ch; j++) {
      if (cnt[j]! > 0) for (let c = 0; c < channels; c++) cv[j * channels + c] = cv[j * channels + c]! / cnt[j]!;
      else cm[j] = 1;
    }
    solveMembrane(cv, cm, cw, ch, channels, sweeps);
    // Start the fine unknowns from the coarse solution.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const j = (y >> 1) * cw + (x >> 1);
        for (let c = 0; c < channels; c++) values[i * channels + c] = cv[j * channels + c]!;
      }
  }
  const omega = 1.9;
  for (let s = 0; s < sweeps; s++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let n = 0;
        for (let c = 0; c < channels; c++) {
          let sum = 0;
          n = 0;
          if (x > 0) (sum += values[(i - 1) * channels + c]!), n++;
          if (x < w - 1) (sum += values[(i + 1) * channels + c]!), n++;
          if (y > 0) (sum += values[(i - w) * channels + c]!), n++;
          if (y < h - 1) (sum += values[(i + w) * channels + c]!), n++;
          const k = i * channels + c;
          values[k] = values[k]! + omega * (sum / n - values[k]!);
        }
      }
    }
  }
}

/**
 * Heal `source` into `dest` over `region` (both straight RGB 0…1, `w × h`): returns the
 * healed pixels. `region` is 1 inside what is pasted. The membrane's boundary is the
 * region's own edge ring — the pixels where both the pasted source and the destination are
 * known (callers only have the source inside the region) — and the interior is solved.
 * Diffusion (1…7) smooths the correction further [fit]: Photoshop's lower values keep more of
 * the source's own tone near the edge.
 */
export function heal(source: Float32Array, dest: Float32Array, region: Uint8Array, w: number, h: number, diffusion = 5): Float32Array {
  // The unknowns: region pixels whose four neighbours are all in the region.
  const inner = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (region[i] && x > 0 && x < w - 1 && y > 0 && y < h - 1 && region[i - 1] && region[i + 1] && region[i - w] && region[i + w]) inner[i] = 1;
    }
  const d = new Float32Array(w * h * 3);
  // On the edge ring (and outside, where it is never read) the difference is known.
  for (let i = 0; i < w * h; i++) {
    if (inner[i] || !region[i]) continue;
    for (let c = 0; c < 3; c++) d[i * 3 + c] = dest[i * 3 + c]! - source[i * 3 + c]!;
  }
  solveMembrane(d, inner, w, h, 3, 30 + diffusion * 10);
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const k = i * 3 + c;
      out[k] = region[i] ? Math.max(0, Math.min(1, source[k]! + d[k]!)) : dest[k]!;
    }
  }
  return out;
}
