/** The filter registry: every filter Umbra implements, by menu command id. */
import { BLUR_FILTERS } from './blur.js';
import { lensBlur } from './lensblur.js';
import { DISTORT_FILTERS } from './distort.js';
import { NOISE_FILTERS } from './noise.js';
import { PIXELATE_FILTERS } from './pixelate.js';
import { RENDER_FILTERS } from './render.js';
import { SHARPEN_FILTERS } from './sharpen.js';
import { STYLIZE_FILTERS } from './stylize.js';
import { VIDEO_FILTERS } from './video.js';
import { OTHER_FILTERS } from './other.js';
import type { FilterDef } from './types.js';

export const FILTERS: FilterDef[] = [
  ...BLUR_FILTERS,
  lensBlur,
  ...DISTORT_FILTERS,
  ...NOISE_FILTERS,
  ...PIXELATE_FILTERS,
  ...RENDER_FILTERS,
  ...SHARPEN_FILTERS,
  ...STYLIZE_FILTERS,
  ...VIDEO_FILTERS,
  ...OTHER_FILTERS,
];

export const FILTER_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));

export * from './types.js';
export * from './core.js';
