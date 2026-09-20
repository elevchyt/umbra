/**
 * ag-psd allocates pixel buffers through a canvas by default, which needs a DOM (or the
 * `canvas` native module under Node) and round-trips through premultiplied alpha.
 *
 * We never want either: PSD stores STRAIGHT alpha and so does our tile store, so a canvas
 * round trip would quietly destroy colour in transparent areas (spec 02 §1). Supplying a
 * plain `{data,width,height}` factory keeps the data untouched and lets the reader run
 * anywhere — worker, Node test, CI — with no canvas at all.
 */
import { initializeCanvas } from 'ag-psd';

let done = false;

export function initPsdEnvironment(): void {
  if (done) return;
  done = true;
  initializeCanvas(
    () => {
      throw new Error(
        'ag-psd asked for a canvas: read PSDs with useRawData/useImageData so no canvas is needed',
      );
    },
    (width: number, height: number) =>
      ({ data: new Uint8ClampedArray(width * height * 4), width, height }) as ImageData,
  );
}
