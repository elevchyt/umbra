/**
 * Application state for the workspace shell.
 *
 * This is UI state only — theme, which tool is active, which panels are docked where. The
 * DOCUMENT lives in the engine worker (spec 03 §6) and reaches the UI as summaries; nothing
 * here is part of history.
 */
import { createSignal, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { DEFAULT_BRUSH, DEFAULT_AUTO_OPTIONS, type Adjustment, type AutoOptions, type DocSummary, type EngineStats, type PatternSummary, type ProbeReply } from '@umbra/engine';
import { BLACK, WHITE, type RGB } from '@umbra/core/color';
import { TOOL_GROUPS, groupOf } from '../tools/registry';

import { DEFAULT_LAYOUT, type DockLayout } from '../workspaces/layouts';

export type ThemeName = 'darkest' | 'dark' | 'medium' | 'light';
export type ScreenMode = 'standard' | 'fullMenu' | 'full';

// ---- theme & chrome -----------------------------------------------------------------

const [theme, setTheme] = createSignal<ThemeName>('dark');
const [uiScale, setUiScale] = createSignal<'small' | 'medium' | 'large' | 'xlarge'>('medium');
const [screenMode, setScreenMode] = createSignal<ScreenMode>('standard');
const [panelsVisible, setPanelsVisible] = createSignal(true);
const [toolsVisible, setToolsVisible] = createSignal(true);
const [optionsVisible, setOptionsVisible] = createSignal(true);
const [toolsDoubleColumn, setToolsDoubleColumn] = createSignal(false);

/** View ▸ Extras and the individual Show toggles. */
const [extras, setExtras] = createStore({
  enabled: true,
  rulers: false,
  grid: false,
  guides: true,
  pixelGrid: true,
  selectionEdges: true,
  layerEdges: false,
});

// ---- tools --------------------------------------------------------------------------

const [activeTool, setActiveToolRaw] = createSignal('brush');
/** Last tool used in each group, so the group button restores it (Photoshop behaviour). */
const [groupDefaults, setGroupDefaults] = createStore<Record<string, string>>(
  Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.tools[0]!.id])),
);

function setActiveTool(id: string): void {
  const g = groupOf(id);
  if (g) setGroupDefaults(g.id, id);
  setActiveToolRaw(id);
}

const activeGroup = createMemo(() => groupOf(activeTool())?.id ?? '');

/**
 * Selection tool options, shared by every marquee/lasso/wand — Photoshop keeps one set of
 * these per tool family rather than per tool, and the modifier keys temporarily override `op`.
 */
const [selectOptions, setSelectOptions] = createStore({
  op: 'new' as 'new' | 'add' | 'subtract' | 'intersect',
  feather: 0,
  antialias: true,
  tolerance: 32,
  contiguous: true,
  sampleAllLayers: false,
});

/**
 * Brush settings, shared by every paint tool as Photoshop's options bar does. `mode` is the
 * paint blend mode, which has two entries (Behind, Clear) a layer does not.
 */
const [brush, setBrush] = createStore({
  ...DEFAULT_BRUSH,
  mode: 'normal' as string,
});

/** Latest document thumbnail for the Navigator; null until one has been rendered. */
const [thumbnail, setThumbnail] = createSignal<{
  pixels: Uint8Array;
  width: number;
  height: number;
  docWidth: number;
  docHeight: number;
} | null>(null);

/** The layer whose name is being edited in place in the Layers panel, if any. */
const [renamingLayerId, setRenamingLayerId] = createSignal<number | null>(null);

/** History panel: Photoshop's "Allow Non-Linear History" preference. */
const [nonLinearHistory, setNonLinearHistory] = createSignal(false);

/** Which channel the canvas shows; mirrors the engine's view setting. */
const [channelView, setChannelView] = createSignal<'all' | 'r' | 'g' | 'b' | number>('all');

/** Crop tool: whether committing throws the outside pixels away (Photoshop defaults to off). */
const [cropDeletes, setCropDeletes] = createSignal(false);

/** Gradient tool options; the ramp itself is derived from the foreground/background. */
const [gradientOptions, setGradientOptions] = createStore({
  style: 'linear' as 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond',
  preset: 'fgToBg' as 'fgToBg' | 'fgToTransparent' | 'blackToWhite',
  mode: 'normal' as string,
  opacity: 1,
  reverse: false,
  dither: true,
});

/** Eyedropper sample square, in document pixels. 1 is Photoshop's "Point Sample". */
const [sampleSize, setSampleSize] = createSignal(1);

// ---- colours ------------------------------------------------------------------------

const [foreground, setForeground] = createSignal<RGB>(BLACK);
const [background, setBackground] = createSignal<RGB>(WHITE);

function swapColors(): void {
  const f = foreground();
  setForeground(background());
  setBackground(f);
}
function resetColors(): void {
  setForeground(BLACK);
  setBackground(WHITE);
}

// ---- documents (mirrored from the engine) --------------------------------------------

const [doc, setDoc] = createSignal<DocSummary | null>(null);
const [stats, setStats] = createSignal<EngineStats | null>(null);
const [engineReady, setEngineReady] = createSignal(false);
const [contextLost, setContextLost] = createSignal(false);
const [statusMessage, setStatusMessage] = createSignal<string | null>(null);

/**
 * The last histogram of each kind the engine sent: `layer` for the adjustment dialogs,
 * `below` for an adjustment layer in Properties, `composite` for the Histogram panel. Kept
 * apart so an open dialog and the panel do not overwrite each other's.
 */
export type HistogramSource = 'layer' | 'below' | 'composite';
export interface Histogram {
  source: HistogramSource;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  lum: Uint32Array;
}
/** The pattern library as the engine last reported it (thumbnails only; pixels stay there). */
const [patterns, setPatterns] = createSignal<PatternSummary[]>([]);
/**
 * An armed dialog eyedropper: the next canvas click samples and calls `onPick` instead of
 * reaching the tool. `id` lets the dialog show which of its droppers is armed.
 */
const [pickRequest, setPickRequest] = createSignal<{ id: string; onPick: (rgb: [number, number, number]) => void } | null>(null);

/** The last settings OK'd in each adjustment dialog this session — the presets' "Last Used". */
// A plain signal, not a store: these values are posted to the worker, and a store proxy cannot
// be structured-cloned.
const [lastAdjustments, setLastAdjustments] = createSignal<Partial<Record<string, Adjustment>>>({});
/** Auto Color Correction Options, shared by Levels, Curves and Image ▸ Auto *. */
const [autoOptions, setAutoOptions] = createSignal<AutoOptions>(DEFAULT_AUTO_OPTIONS);

/** Colour samplers placed with the Color Sampler tool, in document pixels (Photoshop allows 10). */
const [samplers, setSamplers] = createSignal<{ x: number; y: number }[]>([]);
/** The latest Info panel readouts. */
const [probe, setProbe] = createSignal<ProbeReply | null>(null);

/** 3-D LUTs registered in the worker, for Color Lookup. */
const [luts, setLuts] = createSignal<{ id: string; name: string; size: number }[]>([]);

const [histograms, setHistograms] = createStore<Partial<Record<HistogramSource, Histogram>>>({});
const histogram = (source: HistogramSource): Histogram | null => histograms[source] ?? null;
const setHistogram = (h: Histogram) => setHistograms(h.source, h);

/**
 * Panels dispatch engine commands through here. The UI never imports the engine directly
 * (spec 03 §3): the Workspace installs this once the worker is up.
 */
const [engine, setEngine] = createSignal<((msg: unknown) => void) | undefined>(undefined);

/** Open document tabs. M1 tracks the tab strip; multi-document engines arrive with M2. */
const [tabs, setTabs] = createStore<{ id: number; name: string; dirty: boolean }[]>([]);
const [activeTab, setActiveTab] = createSignal<number | null>(null);

// ---- panels & docking ----------------------------------------------------------------

const [layout, setLayout] = createStore<DockLayout>(structuredClone(DEFAULT_LAYOUT));

function isPanelOpen(id: string): boolean {
  return layout.columns.some((c) => c.groups.some((g) => g.panels.includes(id)));
}

function togglePanel(id: string): void {
  if (isPanelOpen(id)) closePanel(id);
  else openPanel(id);
}

function openPanel(id: string): void {
  if (isPanelOpen(id)) {
    // Already docked — just bring its tab to the front.
    setLayout(
      produce((l) => {
        for (const col of l.columns) {
          for (const g of col.groups) {
            if (g.panels.includes(id)) g.active = id;
          }
        }
      }),
    );
    return;
  }
  setLayout(
    produce((l) => {
      const col = l.columns[l.columns.length - 1];
      if (!col) return;
      const group = col.groups[0];
      if (group) {
        group.panels.push(id);
        group.active = id;
      }
    }),
  );
}

function closePanel(id: string): void {
  setLayout(
    produce((l) => {
      for (const col of l.columns) {
        for (const g of col.groups) {
          const i = g.panels.indexOf(id);
          if (i < 0) continue;
          g.panels.splice(i, 1);
          if (g.active === id) g.active = g.panels[0] ?? '';
        }
        // Drop emptied tab groups so the column collapses naturally.
        col.groups = col.groups.filter((g) => g.panels.length > 0);
      }
      l.columns = l.columns.filter((c) => c.groups.length > 0);
    }),
  );
}

function resetLayout(next: DockLayout = DEFAULT_LAYOUT): void {
  setLayout(structuredClone(next));
}

// ---- dialogs -------------------------------------------------------------------------

export type DialogId =
  | 'newDocument'
  | 'colorPicker'
  | 'preferences'
  | 'about'
  | 'systemInfo'
  | 'shortcuts'
  | 'newWorkspace'
  | 'imageSize'
  | 'canvasSize'
  | 'fill'
  | 'stroke'
  | 'adjustment'
  | 'fillLayer'
  | 'spatial'
  | 'applyImage'
  | 'filter'
  | 'gallery'
  | 'smartBlend'
  | 'closeContents'
  | 'layerStyle'
  | 'globalLight'
  | 'fade'
  | 'calculations'
  | 'definePattern';

const [dialog, setDialog] = createSignal<{ id: DialogId; payload?: unknown } | null>(null);
function openDialog(id: DialogId, payload?: unknown) {
  setDialog({ id, payload });
}
function closeDialog() {
  setDialog(null);
}

export const store = {
  theme,
  setTheme,
  uiScale,
  setUiScale,
  screenMode,
  setScreenMode,
  panelsVisible,
  setPanelsVisible,
  toolsVisible,
  setToolsVisible,
  optionsVisible,
  setOptionsVisible,
  toolsDoubleColumn,
  setToolsDoubleColumn,
  extras,
  setExtras,

  activeTool,
  setActiveTool,
  activeGroup,
  groupDefaults,
  selectOptions,
  setSelectOptions,
  sampleSize,
  setSampleSize,
  brush,
  setBrush,
  gradientOptions,
  setGradientOptions,
  cropDeletes,
  setCropDeletes,
  channelView,
  setChannelView,
  nonLinearHistory,
  setNonLinearHistory,
  renamingLayerId,
  setRenamingLayerId,
  thumbnail,
  setThumbnail,

  foreground,
  setForeground,
  background,
  setBackground,
  swapColors,
  resetColors,

  doc,
  setDoc,
  stats,
  setStats,
  engineReady,
  setEngineReady,
  contextLost,
  setContextLost,
  statusMessage,
  setStatusMessage,
  histogram,
  setHistogram,
  patterns,
  setPatterns,
  luts,
  setLuts,
  pickRequest,
  setPickRequest,
  samplers,
  setSamplers,
  probe,
  setProbe,
  lastAdjustments,
  setLastAdjustment: (a: Adjustment) => setLastAdjustments((prev) => ({ ...prev, [a.kind]: a })),
  autoOptions,
  setAutoOptions,
  get engine() {
    return engine();
  },
  setEngine,
  tabs,
  setTabs,
  activeTab,
  setActiveTab,

  layout,
  setLayout,
  isPanelOpen,
  togglePanel,
  openPanel,
  closePanel,
  resetLayout,

  dialog,
  openDialog,
  closeDialog,
};

export type Store = typeof store;
