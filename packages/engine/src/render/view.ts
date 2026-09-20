/**
 * Per-window view state: zoom, scroll centre and canvas rotation (the Rotate View tool).
 * Not part of the document and never recorded in history (spec 02 §1).
 */
import {
  IDENTITY,
  matMul,
  matRotate,
  matScale,
  matTranslate,
  matInvert,
  matMapRect,
  matToMat3,
  rectOuter,
  clamp,
  type Mat2d,
  type Point,
  type Rect,
} from '@umbra/core/geom';

/** Photoshop's zoom range. */
export const MIN_ZOOM = 0.001;
export const MAX_ZOOM = 128;

/** The zoom stops Ctrl+= / Ctrl+- step through. */
export const ZOOM_STOPS = [
  0.0033, 0.005, 0.0067, 0.01, 0.0167, 0.025, 0.0333, 0.05, 0.0667, 0.125, 0.1667, 0.25, 0.3333,
  0.5, 0.6667, 1, 2, 3, 4, 5, 6, 8, 12, 16, 32, 64, 128,
];

export interface ViewState {
  /** Screen pixels per document pixel. */
  zoom: number;
  /** Document point pinned to the centre of the viewport. */
  centre: Point;
  /** Canvas rotation in radians. */
  rotation: number;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
  devicePixelRatio: number;
}

export function initialView(width = 800, height = 600, dpr = 1): ViewState {
  return { zoom: 1, centre: { x: 0, y: 0 }, rotation: 0, width, height, devicePixelRatio: dpr };
}

/** Document space → CSS-pixel screen space. */
export function docToScreen(v: ViewState): Mat2d {
  let m: Mat2d = matTranslate(-v.centre.x, -v.centre.y);
  m = matMul(matScale(v.zoom), m);
  if (v.rotation !== 0) m = matMul(matRotate(v.rotation), m);
  return matMul(matTranslate(v.width / 2, v.height / 2), m);
}

export function screenToDoc(v: ViewState): Mat2d {
  return matInvert(docToScreen(v));
}

/** Document space → WebGL clip space, honouring devicePixelRatio implicitly via the viewport. */
export function docToClip(v: ViewState): Float32Array {
  const screenToClip: Mat2d = {
    a: 2 / v.width,
    b: 0,
    c: 0,
    d: -2 / v.height,
    e: -1,
    f: 1,
  };
  return matToMat3(matMul(screenToClip, docToScreen(v)));
}

/** Document-space bounds of what the viewport currently shows. */
export function visibleDocRect(v: ViewState): Rect {
  return rectOuter(
    matMapRect(screenToDoc(v), { x0: 0, y0: 0, x1: v.width, y1: v.height }),
  );
}

export function docPointAtScreen(v: ViewState, sx: number, sy: number): Point {
  const m = screenToDoc(v);
  return { x: m.a * sx + m.c * sy + m.e, y: m.b * sx + m.d * sy + m.f };
}

/** Zoom about a fixed screen point, the way the Zoom tool and Alt+wheel behave. */
export function zoomAt(v: ViewState, factor: number, sx: number, sy: number): ViewState {
  const before = docPointAtScreen(v, sx, sy);
  const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const next: ViewState = { ...v, zoom };
  const after = docPointAtScreen(next, sx, sy);
  return {
    ...next,
    centre: { x: next.centre.x + (before.x - after.x), y: next.centre.y + (before.y - after.y) },
  };
}

export function nextZoomStop(zoom: number, dir: 1 | -1): number {
  if (dir > 0) {
    for (const s of ZOOM_STOPS) if (s > zoom * 1.0001) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STOPS[i]!;
    if (s < zoom * 0.9999) return s;
  }
  return MIN_ZOOM;
}

/** View ▸ Fit on Screen. `pad` leaves a margin in CSS px, as Photoshop does. */
export function fitToScreen(v: ViewState, docW: number, docH: number, pad = 32): ViewState {
  const aw = Math.max(1, v.width - pad);
  const ah = Math.max(1, v.height - pad);
  const zoom = clamp(Math.min(aw / docW, ah / docH), MIN_ZOOM, MAX_ZOOM);
  return { ...v, zoom, rotation: 0, centre: { x: docW / 2, y: docH / 2 } };
}

export function panBy(v: ViewState, dxScreen: number, dyScreen: number): ViewState {
  // Undo rotation so a drag moves the image with the pointer.
  const cos = Math.cos(-v.rotation);
  const sin = Math.sin(-v.rotation);
  const dx = (dxScreen * cos - dyScreen * sin) / v.zoom;
  const dy = (dxScreen * sin + dyScreen * cos) / v.zoom;
  return { ...v, centre: { x: v.centre.x - dx, y: v.centre.y - dy } };
}

export const IDENTITY_MAT = IDENTITY;
