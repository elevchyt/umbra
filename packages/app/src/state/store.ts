/**
 * Application state for the workspace shell.
 *
 * This is UI state only — theme, which tool is active, which panels are docked where. The
 * DOCUMENT lives in the engine worker (spec 03 §6) and reaches the UI as summaries; nothing
 * here is part of history.
 */
import { createSignal, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { DocSummary, EngineStats } from '@umbra/engine';
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
  | 'canvasSize';

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
