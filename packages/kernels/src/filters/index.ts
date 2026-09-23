/** The filter registry: every filter Umbra implements, by menu command id. */
import { BLUR_FILTERS } from './blur.js';
import { SHARPEN_FILTERS } from './sharpen.js';
import { NOISE_FILTERS } from './noise.js';
import { OTHER_FILTERS } from './other.js';
import type { FilterDef } from './types.js';

export const FILTERS: FilterDef[] = [...BLUR_FILTERS, ...SHARPEN_FILTERS, ...NOISE_FILTERS, ...OTHER_FILTERS];

export const FILTER_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));

export * from './types.js';
export * from './core.js';
