/**
 * Child-process harness for the PSD memory spike.
 *
 * Lazy and eager reads must run in separate processes: RSS is a high-water mark that never
 * falls, so measuring both in one process would attribute the first run's peak to the second.
 *
 * Usage: node measure-read.mjs <file.psd> <lazy|eager>
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPsd, getLayerImageData, initializeCanvas } = require('ag-psd');

const [, , file, mode] = process.argv;

initializeCanvas(
  () => {
    throw new Error('canvas should not be needed');
  },
  (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
);

let peakRss = process.memoryUsage().rss;
const baseline = peakRss;
const sample = () => {
  const m = process.memoryUsage();
  if (m.rss > peakRss) peakRss = m.rss;
};
const timer = setInterval(sample, 2);

const t0 = performance.now();
// Pass the Buffer straight through: ag-psd accepts {buffer,byteOffset,byteLength}, so
// slicing out an ArrayBuffer here would double the file's memory for no reason.
const ab = readFileSync(file);
sample();

let layers = 0;
let retainedBytes = 0;

if (mode === 'lazy') {
  // Defer bitmap decoding, then decode ONE layer at a time and release it straight away.
  const psd = readPsd(ab, {
    useRawData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  for (const layer of psd.children ?? []) {
    const px = getLayerImageData(layer);
    if (px) retainedBytes += px.data.length;
    layer.rawData = undefined;
    layer.imageData = undefined;
    layers++;
    sample();
  }
} else {
  // Decode every layer up front — what ag-psd does by default.
  const psd = readPsd(ab, {
    useImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  for (const layer of psd.children ?? []) {
    if (layer.imageData) retainedBytes += layer.imageData.data.length;
    layers++;
  }
  sample();
}

clearInterval(timer);
sample();
process.stdout.write(
  JSON.stringify({
    mode,
    layers,
    ms: Math.round(performance.now() - t0),
    baselineMb: +(baseline / 1e6).toFixed(1),
    peakRssMb: +(peakRss / 1e6).toFixed(1),
    growthMb: +((peakRss - baseline) / 1e6).toFixed(1),
    decodedMb: +(retainedBytes / 1e6).toFixed(1),
  }),
);
