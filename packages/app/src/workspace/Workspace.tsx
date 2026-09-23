import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { produce } from 'solid-js/store';
import { MenuBar } from '@umbra/ui/menu/MenuBar';
import { ToolsPanel } from '@umbra/ui/workspace/ToolsPanel';
import { Dock } from '@umbra/ui/dock/Dock';
import { rgbToCss } from '@umbra/core/color';
import { FOREGROUND_TO_BACKGROUND, FOREGROUND_TO_TRANSPARENT, ADJUSTMENT_LABEL, defaultAdjustment, type Adjustment, type FillSummary, SPATIAL_LABEL, defaultSpatial, type SpatialAdjustment, screenPointAtDoc, type ViewState, FILTER_BY_ID, defaultsOf } from '@umbra/engine';
import { AdjustmentDialog } from '../adjust/AdjustmentDialog';
import { initialAdjustment } from '../adjust/initial';
import { FillLayerDialog } from '../adjust/fill';
import { SpatialDialog } from '../adjust/spatial';
import { ApplyImageDialog, CalculationsDialog } from '../adjust/applyimage';
import { FilterDialog, colours as filterColours } from '../filters/FilterDialog';
import { FadeDialog } from '../filters/FadeDialog';
import { GalleryDialog } from '../filters/GalleryDialog';
import { EngineClient } from '../engine-client';
import { store, type ThemeName } from '../state/store';
import { MENUS, COMMAND_BY_ID } from '../menus/menus';
import { TOOL_GROUPS, TOOL_BY_ID, ALL_TOOLS, PAINT_TOOLS, SELECT_TOOLS, cycleForKey, groupOf } from '../tools/registry';
import { PANEL_META, PANEL_BY_COMMAND, renderPanel } from '../panels/panels';
import { WORKSPACE_BY_ID, DEFAULT_LAYOUT } from '../workspaces/layouts';
import { Keymap, EXTRA_BINDINGS, isTextEntry, chordFromEvent, chordLabel } from '../keymap/keymap';
import { OptionsBar } from './OptionsBar';
import { DocumentTabs, StatusBar } from './Chrome';
import { NewDocumentDialog, ColorPickerDialog, AboutDialog, SystemInfoDialog, ShortcutsDialog, ImageSizeDialog, CanvasSizeDialog, AmountDialog, FillDialog, StrokeDialog, Dialog, NameDialog, type FillRequest, type StrokeRequest } from '../dialogs/Dialogs';

const THEME_ORDER: ThemeName[] = ['darkest', 'dark', 'medium', 'light'];

/**
 * Write a produced file wherever the platform can: a native Save dialog under Electron,
 * a browser download otherwise. The engine only ever hands us bytes; where they land is a
 * shell concern (spec 03 §2.1).
 */
async function deliverFile(name: string, buffer: ArrayBuffer): Promise<void> {
  const shell = (globalThis as Record<string, any>).umbraShell;
  if (shell?.saveFile) {
    const path = await shell.saveFile(name, buffer);
    store.setStatusMessage(path ? `Saved ${path}` : 'Save cancelled');
  } else {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'image/vnd.adobe.photoshop' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    store.setStatusMessage(`Downloaded ${name}`);
  }
  setTimeout(() => store.setStatusMessage(null), 4000);
}

/** Hand a headless harness its result; the Electron main process is waiting on this. */
function reportToShell(pass: boolean, text: string): void {
  const shell = (globalThis as Record<string, any>).umbraShell;
  // In a plain browser there is no shell to hand the report to; the console is the report.
  if (shell?.reportSpikes) shell.reportSpikes({ pass, text });
  else console.log(text);
}

/** Arrow keys move by one document pixel, or ten with Shift. */
const ARROW_NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function Workspace() {
  let canvasRef!: HTMLCanvasElement;
  let docAreaRef!: HTMLDivElement;
  let client: EngineClient | undefined;

  const [pickerTarget, setPickerTarget] = createSignal<'foreground' | 'background'>('foreground');
  const [quickMask, setQuickMask] = createSignal(false);
  const [transforming, setTransforming] = createSignal(false);
  const [recovery, setRecovery] = createSignal<{ name: string; savedAt: number } | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // ---- keymap -------------------------------------------------------------------------
  const keymap = new Keymap();
  for (const c of COMMAND_BY_ID.values()) if (c.shortcut) keymap.add(c.shortcut, c.cmd);
  for (const b of EXTRA_BINDINGS) keymap.add(b.shortcut, b.cmd);

  // ---- engine -------------------------------------------------------------------------
  onMount(() => {
    try {
      client = new EngineClient(canvasRef, {
        onReady: () => {
          store.setEngineReady(true);
          // Headless harnesses: the shell opens the page with a hash and waits for a report.
          if (location.hash === '#spikes') client!.send({ t: 'runSpikes' });
          else if (location.hash === '#parity') client!.send({ t: 'runParity' });
          // Ask about a crashed session BEFORE making any document. Recovering replaces the
          // open document — there is only one — so the prompt must only ever appear when there
          // is nothing yet to lose. It used to arrive after the default document, seconds into
          // a session, claiming the current work would be untouched; it would not have been.
          else client!.send({ t: 'checkRecovery' });
        },
        onStats: (s) => {
          // Dev aid: the live engine stats are awkward to inspect from the UI thread
          // otherwise, and view/atlas bugs are much easier to diagnose with them to hand.
          if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__umbraStats = s;
          store.setStats(s);
        },
        onDoc: (d) => {
          // Dev aid, like __umbraStats: the summary is what the panels render from, and it
          // arrives by message, so it is trustworthy even when a hidden pane stalls frames.
          if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__umbraDoc = d;
          store.setDoc(d);
          if (store.tabs.length === 0) {
            store.setTabs([{ id: 1, name: d.name, dirty: false }]);
            store.setActiveTab(1);
          } else {
            store.setTabs(0, 'name', d.name);
          }
        },
        onSpikes: (pass, text) => reportToShell(pass, text),
        onParity: (pass, text) => reportToShell(pass, text),
        onPsdSaved: (name, buffer) => void deliverFile(name, buffer),
        onTransform: setTransforming,
        onThumbnail: (t) => {
          // Dev aid: the rendered thumbnail itself, independent of the Navigator's drawing.
          if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__umbraThumb = t;
          store.setThumbnail(t);
        },
        onHistogram: store.setHistogram,
        onPatterns: store.setPatterns,
        onFilterBox: (m) => window.dispatchEvent(new CustomEvent('umbra:filter-box', { detail: m })),
        onProbe: (m) => {
          if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__umbraProbe = m;
          store.setProbe({ cursor: m.cursor, samplers: m.tag ? store.probe()?.samplers ?? [] : m.samplers });
          const at = m.cursor;
          if (!at || !m.tag) return;
          const list = store.samplers();
          if (m.tag === 'placeSampler') {
            if (list.length >= 10) flash('Photoshop allows 10 colour samplers; this one was not placed.');
            else if (at.before) store.setSamplers([...list, { x: at.x, y: at.y }]);
          } else if (list.length) {
            // Alt-click removes the nearest sampler.
            let best = 0;
            list.forEach((s, i) => {
              if (Math.hypot(s.x - at.x, s.y - at.y) < Math.hypot(list[best]!.x - at.x, list[best]!.y - at.y)) best = i;
            });
            store.setSamplers(list.filter((_, i) => i !== best));
          }
        },
        onReplaceColorPreview: (p) => window.dispatchEvent(new CustomEvent('umbra:replace-color-preview', { detail: p })),
        onLuts: (m) => {
          store.setLuts(m.list);
          if (m.error) flash(`Could not load the LUT: ${m.error}`);
          if (m.loaded) lutLoaded(m.loaded);
        },
        onRecovery: (info) => setRecovery({ name: info.name, savedAt: info.savedAt }),
        onNoRecovery: () => startDefaultDocument(),
        onSampled: (color, toBackground) => {
          // @umbra/core/color works in 0…1, which is also what the engine samples in.
          const rgb = { r: color[0], g: color[1], b: color[2] };
          if (toBackground) store.setBackground(rgb);
          else store.setForeground(rgb);
        },
        onContextLost: () => store.setContextLost(true),
        onContextRestored: () => store.setContextLost(false),
        onError: (m) => {
          setError(m);
          if (location.hash) reportToShell(false, `ERROR: ${m}`);
        },
      });
      client.paintMode = PAINT_TOOLS.has(store.activeTool());
      store.setEngine(() => (m: unknown) => client!.send(m as never));
      // Dev aid: drive the engine from the console or an automation script.
      if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__umbraSend = (m: unknown) => client!.send(m as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    /**
     * An image on the system clipboard becomes a new layer. The application clipboard keeps
     * planes and coordinates, which the system one cannot carry, so the two are separate:
     * Edit ▸ Paste uses ours, and a system image arrives here as a placed bitmap.
     */
    const onPaste = async (e: ClipboardEvent) => {
      if (isTextEntry(e.target)) return;
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      const bitmap = await createImageBitmap(file);
      send({ t: 'placeBitmap', bitmap, name: file.name || 'Pasted Image' });
    };
    window.addEventListener('paste', onPaste);
    onCleanup(() => window.removeEventListener('paste', onPaste));

    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      client?.resize(Math.max(1, r.width), Math.max(1, r.height));
    });
    ro.observe(docAreaRef);
    onCleanup(() => {
      ro.disconnect();
      client?.dispose();
    });
  });

  // Paint mode and brush settings follow the active tool and options bar.
  createEffect(() => {
    const tool = store.activeTool();
    const size = store.sampleSize();
    if (!client) return;
    client.paintMode = PAINT_TOOLS.has(tool);
    client.selectTool = SELECT_TOOLS.has(tool) ? tool : null;
    client.sampleSize = tool === 'eyedropper' ? size : null;
    client.moveTool = tool === 'move';
    client.fillTool = tool === 'paintBucket' ? 'bucket' : tool === 'gradient' ? 'gradient' : null;
    client.cropTool = tool === 'crop';
  });

  // An armed dialog eyedropper takes canvas clicks away from the tool. Read the signals
  // before the guard, or the effect never subscribes (see the note below).
  createEffect(() => {
    const req = store.pickRequest();
    const ready = store.engineReady();
    const modal = !!store.dialog();
    const samplers = store.samplers();
    const probing = store.isPanelOpen('info') || samplers.length > 0;
    const samplerTool = store.activeTool() === 'colorSampler';
    if (!client || !ready) return;
    client.pickHandler = req ? (rgb) => req.onPick(rgb) : null;
    client.modal = modal;
    client.samplers = samplers;
    client.probing = probing;
    client.samplerTool = samplerTool;
  });

  // Selection options live in the UI store; the engine needs them before the next gesture.
  createEffect(() => {
    // Read every value BEFORE the guard. An effect that returns early registers no
    // dependencies and never runs again — and on the first run `client` is not up yet.
    const o = store.selectOptions;
    const next = {
      op: o.op,
      feather: o.feather,
      antialias: o.antialias,
      tolerance: o.tolerance,
      contiguous: o.contiguous,
    };
    if (!client) return;
    client.selectOp = next.op;
    send({
      t: 'setSelectOptions',
      feather: next.feather,
      antialias: next.antialias,
      tolerance: next.tolerance,
      contiguous: next.contiguous,
    });
  });
  createEffect(() => {
    const b = store.brush;
    const tool = store.activeTool();
    const c = store.foreground();
    // Every field is read by name, and all of them BEFORE the `client` guard. Spreading a
    // Solid store goes through ownKeys and does not subscribe the effect to the individual
    // properties; returning early registers no dependencies at all. Either mistake leaves the
    // engine painting with whatever the brush was when the effect first ran.
    const params = {
      size: b.size,
      hardness: b.hardness,
      spacing: b.spacing,
      angle: b.angle,
      roundness: b.roundness,
      opacity: b.opacity,
      flow: b.flow,
      smoothing: b.smoothing,
      airbrush: b.airbrush,
      airbrushRate: b.airbrushRate,
      pressureSize: b.pressureSize,
      pressureOpacity: b.pressureOpacity,
    };
    const mode = b.mode;
    const g = store.gradientOptions;
    const gradientArgs = {
      style: g.style,
      preset: g.preset,
      mode: g.mode,
      opacity: g.opacity,
      reverse: g.reverse,
      dither: g.dither,
    };
    if (!client) return;
    // The fill tools send their options with the click, so the worker never has to be told
    // about them up front and the options bar is always authoritative.
    client.fillRequest = () => {
      const fg: [number, number, number] = [c.r, c.g, c.b];
      const bgc = store.background();
      const bg: [number, number, number] = [bgc.r, bgc.g, bgc.b];
      if (store.activeTool() === 'paintBucket') {
        return { color: fg, mode: mode === 'behind' || mode === 'clear' ? 'normal' : mode, opacity: b.opacity };
      }
      return {
        gradient:
          gradientArgs.preset === 'fgToTransparent'
            ? FOREGROUND_TO_TRANSPARENT(fg)
            : gradientArgs.preset === 'blackToWhite'
              ? FOREGROUND_TO_BACKGROUND([0, 0, 0], [1, 1, 1])
              : FOREGROUND_TO_BACKGROUND(fg, bg),
        style: gradientArgs.style,
        reverse: gradientArgs.reverse,
        dither: gradientArgs.dither,
        mode: gradientArgs.mode,
        opacity: gradientArgs.opacity,
      };
    };
    // The Pencil is the brush with a hard tip; that is all that distinguishes them.
    client.brush = tool === 'pencil' ? { ...params, hardness: 1 } : params;
    client.brushColor = [c.r, c.g, c.b];
    // The Eraser is the Clear paint mode with the brush's own settings.
    client.paintBlendMode = tool === 'eraser' ? 'clear' : mode;
  });

  // Theme + UI scale live on <html> so CSS variables cascade everywhere.
  createEffect(() => {
    document.documentElement.dataset.theme = store.theme();
    document.documentElement.dataset.uiScale = store.uiScale();
  });

  // ---- commands ------------------------------------------------------------------------
  const send = (m: Parameters<EngineClient['send']>[0]) => client?.send(m);

  function runCommand(cmd: string): void {
    // Panel toggles are generated, so handle them before the explicit switch.
    const panelId = PANEL_BY_COMMAND[cmd];
    if (panelId) {
      store.togglePanel(panelId);
      return;
    }
    if (cmd.startsWith('workspace.') && WORKSPACE_BY_ID.has(cmd.slice('workspace.'.length))) {
      store.resetLayout(WORKSPACE_BY_ID.get(cmd.slice('workspace.'.length))!.layout);
      return;
    }
    // Filters come from the registry, like panel toggles: one handler for all of them.
    const filter = FILTER_BY_ID.get(cmd);
    if (filter) {
      const doc = store.doc();
      const active = doc?.layers.find((l) => l.id === doc.activeLayerIds[0]);
      if (!active || (active.kind !== 'pixel' && doc?.maskTarget !== active.id)) {
        flash(`Could not complete ${filter.label} because the target layer is not a pixel layer.`);
        return;
      }
      // Filters with no settings run at once, as Blur and Find Edges do in Photoshop; so do
      // Clouds and Difference Clouds, whose only settings are a seed (fresh every time) and
      // a flag.
      if (cmd === 'filter.gallery') store.openDialog('gallery');
      else if (filter.params.every((s) => s.type === 'seed' || s.type === 'bool')) {
        const params = defaultsOf(filter);
        for (const s of filter.params) if (s.type === 'seed') params[s.key] = Math.floor(Math.random() * 1e9);
        send({ t: 'applyFilter', id: cmd, params, ...filterColours() });
      } else store.openDialog('filter', cmd);
      return;
    }

    switch (cmd) {
      case 'file.new':
        store.openDialog('newDocument');
        break;
      case 'file.open':
        void openFile();
        break;
      case 'file.close':
      case 'file.closeAll':
        store.setTabs([]);
        store.setActiveTab(null);
        send({ t: 'newDoc', width: 1920, height: 1080 });
        break;
      case 'file.exit':
        window.close();
        break;
      case 'file.save':
      case 'file.saveAs':
      case 'file.saveCopy':
        send({ t: 'savePsd', name: psdName() });
        break;

      case 'edit.undo':
        send({ t: 'undo' });
        break;
      case 'edit.redo':
        send({ t: 'redo' });
        break;

      case 'view.fit':
        send({ t: 'fit' });
        break;
      case 'view.actual':
        send({ t: 'actualPixels' });
        break;
      case 'view.zoomIn':
        send({ t: 'zoomAt', factor: 1.5, x: 0, y: 0 });
        break;
      case 'view.zoomOut':
        send({ t: 'zoomAt', factor: 1 / 1.5, x: 0, y: 0 });
        break;
      case 'view.rulers':
        store.setExtras('rulers', !store.extras.rulers);
        break;
      case 'show.grid':
        store.setExtras('grid', !store.extras.grid);
        break;
      case 'show.guides':
        store.setExtras('guides', !store.extras.guides);
        break;
      case 'show.pixelGrid':
        store.setExtras('pixelGrid', !store.extras.pixelGrid);
        break;
      case 'view.extras':
        store.setExtras('enabled', !store.extras.enabled);
        break;
      case 'view.togglePanels':
        // Tab hides every panel AND the bars; Shift+Tab keeps the toolbar and options bar.
        {
          const hiding = store.panelsVisible();
          store.setPanelsVisible(!hiding);
          store.setToolsVisible(!hiding);
          store.setOptionsVisible(!hiding);
        }
        break;
      case 'view.toggleSidePanels':
        store.setPanelsVisible(!store.panelsVisible());
        break;
      case 'view.cycleScreenMode':
      case 'screen.standard':
      case 'screen.fullMenu':
      case 'screen.full':
        cycleScreenMode(cmd);
        break;
      case 'view.themeDarker':
        stepTheme(-1);
        break;
      case 'view.themeLighter':
        stepTheme(1);
        break;

      case 'color.swap':
        store.swapColors();
        break;
      case 'color.defaults':
        store.resetColors();
        break;
      case 'select.quickMask': {
        const on = !quickMask();
        setQuickMask(on);
        send({ t: 'setQuickMask', on });
        break;
      }

      case 'brush.sizeUp':
        store.setBrush('size', Math.min(5000, store.brush.size + stepFor(store.brush.size)));
        break;
      case 'brush.sizeDown':
        store.setBrush('size', Math.max(1, store.brush.size - stepFor(store.brush.size)));
        break;
      case 'brush.hardnessUp':
        store.setBrush('hardness', Math.min(1, store.brush.hardness + 0.25));
        break;
      case 'brush.hardnessDown':
        store.setBrush('hardness', Math.max(0, store.brush.hardness - 0.25));
        break;

      case 'workspace.reset':
        store.resetLayout(DEFAULT_LAYOUT);
        break;
      case 'prefs.interface':
      case 'prefs.general':
        stepTheme(1);
        store.setStatusMessage('Preferences dialog arrives in M11; Shift+F1/F2 cycle the theme.');
        break;

      case 'help.about':
        store.openDialog('about');
        break;
      case 'help.systemInfo':
      case 'help.gpuInfo':
        store.openDialog('systemInfo');
        break;
      case 'help.shortcuts':
        store.openDialog('shortcuts');
        break;

      case 'transform.commit':
        send(store.activeTool() === 'crop' ? { t: 'commitCrop' } : { t: 'commitTransform' });
        break;
      case 'transform.cancel':
        send(store.activeTool() === 'crop' ? { t: 'cancelCrop' } : { t: 'cancelTransform' });
        break;
      case 'crop.syncDeletes':
        send({ t: 'setCropDeletes', on: store.cropDeletes() });
        break;
      case 'image.crop':
        send({ t: 'cropToSelection' });
        break;
      case 'edit.freeTransform':
        send({ t: 'beginTransform', transient: false });
        break;
      case 'select.transformSelection':
        send({ t: 'beginTransform', transient: false, selectionOnly: true });
        break;
      case 'transform.again':
        send({ t: 'transformAgain' });
        break;
      case 'transform.scale':
      case 'transform.rotate':
      case 'transform.skew':
        send({ t: 'beginTransform', transient: false });
        break;
      // Edit ▸ Transform acts on the LAYER; Image ▸ Image Rotation is the one that turns the
      // canvas. These were once crossed, so a layer rotate spun the whole document.
      case 'transform.rotate180':
        send({ t: 'transformLayerFixed', op: 'rotate180' });
        break;
      case 'transform.rotate90cw':
        send({ t: 'transformLayerFixed', op: 'rotate90cw' });
        break;
      case 'transform.rotate90ccw':
        send({ t: 'transformLayerFixed', op: 'rotate90ccw' });
        break;
      case 'transform.flipH':
        send({ t: 'transformLayerFixed', op: 'flipH' });
        break;
      case 'transform.flipV':
        send({ t: 'transformLayerFixed', op: 'flipV' });
        break;
      case 'layer.viaCopy':
        send({ t: 'layerVia', cut: false });
        break;
      case 'layer.viaCut':
        send({ t: 'layerVia', cut: true });
        break;
      case 'select.reselect':
        send({ t: 'reselect' });
        break;
      case 'mask.revealAll':
      case 'mask.hideAll':
      case 'mask.revealSelection':
      case 'mask.hideSelection':
      case 'mask.fromTransparency':
      case 'mask.delete':
      case 'mask.apply':
        send({ t: 'maskCommand', command: cmd.slice(5) });
        break;
      case 'mask.enable':
        send({ t: 'maskCommand', command: 'toggle' });
        break;
      case 'edit.cut':
        send({ t: 'clipboard', op: 'cut' });
        break;
      case 'edit.copy':
        send({ t: 'clipboard', op: 'copy' });
        break;
      case 'edit.copyMerged':
        send({ t: 'clipboard', op: 'copyMerged' });
        break;
      case 'edit.paste':
        send({ t: 'clipboard', op: 'paste' });
        break;
      case 'edit.pasteInPlace':
        send({ t: 'clipboard', op: 'pasteInPlace' });
        break;
      case 'edit.pasteInto':
        send({ t: 'clipboard', op: 'pasteInto' });
        break;
      case 'edit.pasteOutside':
        send({ t: 'clipboard', op: 'pasteOutside' });
        break;
      case 'edit.fill':
        store.openDialog('fill');
        break;
      case 'edit.stroke':
        store.openDialog('stroke');
        break;
      case 'edit.clear':
        send({
          t: 'fill',
          color: [0, 0, 0],
          mode: 'normal',
          opacity: 1,
          preserveTransparency: false,
          clear: true,
        });
        break;

      // Select menu
      case 'select.all':
        send({ t: 'selectCommand', command: 'all' });
        break;
      case 'select.deselect':
        send({ t: 'selectCommand', command: 'deselect' });
        break;
      case 'select.inverse':
        send({ t: 'selectCommand', command: 'inverse' });
        break;
      case 'modify.feather':
        promptAmount('Feather Selection', 'Feather Radius', 1, (v) =>
          send({ t: 'selectCommand', command: 'feather', amount: v }),
        );
        break;
      case 'modify.expand':
        promptAmount('Expand Selection', 'Expand By', 1, (v) =>
          send({ t: 'selectCommand', command: 'expand', amount: v }),
        );
        break;
      case 'modify.contract':
        promptAmount('Contract Selection', 'Contract By', 1, (v) =>
          send({ t: 'selectCommand', command: 'contract', amount: v }),
        );
        break;
      case 'modify.border':
        promptAmount('Border Selection', 'Width', 4, (v) =>
          send({ t: 'selectCommand', command: 'border', amount: v }),
        );
        break;
      case 'layer.rename': {
        const id = store.doc()?.activeLayerIds[0];
        if (id !== undefined) {
          // Rename happens in place in the Layers panel, so make sure that panel is showing.
          store.openPanel('layers');
          store.setRenamingLayerId(id);
        }
        break;
      }
      case 'panel.options':
        store.setOptionsVisible(!store.optionsVisible());
        break;
      case 'panel.tools':
        store.setToolsVisible(!store.toolsVisible());
        break;
      case 'edit.toggleLastState':
        send({ t: 'toggleLastState' });
        break;
      case 'select.saveSelection':
        send({ t: 'saveSelection' });
        break;
      case 'select.loadSelection': {
        const first = store.doc()?.channels?.[0];
        if (first) send({ t: 'loadSelection', channelId: first.id });
        else store.setStatusMessage('No saved channels to load.');
        break;
      }
      case 'view.channelAll':
      case 'view.channelRed':
      case 'view.channelGreen':
      case 'view.channelBlue': {
        const view =
          cmd === 'view.channelRed' ? 'r' : cmd === 'view.channelGreen' ? 'g' : cmd === 'view.channelBlue' ? 'b' : 'all';
        store.setChannelView(view);
        send({ t: 'setChannelView', view });
        break;
      }
      case 'select.grow':
        send({ t: 'selectCommand', command: 'grow' });
        break;
      case 'select.similar':
        send({ t: 'selectCommand', command: 'similar' });
        break;
      case 'modify.smooth':
        promptAmount('Smooth Selection', 'Sample Radius', 2, (v) =>
          send({ t: 'selectCommand', command: 'smooth', amount: v }),
        );
        break;

      // Layer menu
      case 'layer.new':
        send({ t: 'layerCommand', command: 'add' });
        break;
      case 'layer.delete':
        send({ t: 'layerCommand', command: 'delete' });
        break;
      case 'image.autoTone':
      case 'image.autoContrast':
      case 'image.autoColor':
      case 'adjust.equalize': {
        const doc = store.doc();
        const active = doc?.layers.find((l) => l.id === doc.activeLayerIds[0]);
        if (!active || active.kind !== 'pixel') {
          flash('Could not complete the command because the target layer is not a pixel layer.');
          break;
        }
        const mode = cmd === 'adjust.equalize' ? 'equalize' : cmd === 'image.autoTone' ? 'tone' : cmd === 'image.autoContrast' ? 'contrast' : 'color';
        send({ t: 'autoAdjust', mode });
        break;
      }
      case 'adjust.shadowsHighlights':
      case 'adjust.hdrToning':
      case 'adjust.matchColor':
      case 'adjust.replaceColor': {
        const doc = store.doc();
        const active = doc?.layers.find((l) => l.id === doc.activeLayerIds[0]);
        const kind = cmd.slice('adjust.'.length) as SpatialAdjustment['kind'];
        // HDR Toning flattens, so any active layer will do; the rest act on a pixel layer.
        if (kind !== 'hdrToning' && (!active || active.kind !== 'pixel')) {
          flash(`Could not complete ${SPATIAL_LABEL[kind]} because the target layer is not a pixel layer.`);
          break;
        }
        const initial = defaultSpatial(kind);
        if (initial.kind === 'replaceColor') {
          const fg = store.foreground();
          initial.color = [fg.r, fg.g, fg.b];
        }
        store.openDialog('spatial', initial);
        break;
      }
      case 'filter.last':
        send({ t: 'lastFilter', ...filterColours() });
        break;
      case 'edit.fade':
        if (store.doc()?.fadeName) store.openDialog('fade');
        break;
      case 'image.applyImage':
        store.openDialog('applyImage');
        break;
      case 'image.calculations':
        store.openDialog('calculations');
        break;
      case 'fill.solid':
      case 'fill.gradient':
      case 'fill.pattern': {
        const fg = store.foreground();
        let initial: FillSummary;
        if (cmd === 'fill.solid') initial = { type: 'solid', color: [fg.r, fg.g, fg.b] };
        else if (cmd === 'fill.gradient') {
          const g = initialAdjustment('gradientMap');
          initial = {
            type: 'gradient',
            gradient: (g as Extract<Adjustment, { kind: 'gradientMap' }>).gradient,
            style: 'linear',
            angle: 90,
            scale: 100,
            reverse: false,
            offset: { x: 0, y: 0 },
          };
        } else initial = { type: 'pattern', patternId: 'umbra-checker', patternName: 'Checkerboard', scale: 100, phase: { x: 0, y: 0 } };
        store.openDialog('fillLayer', initial);
        break;
      }
      case 'edit.definePattern':
        store.openDialog('definePattern');
        break;
      case 'layer.clippingMask':
        // Toggles, as Ctrl+Alt+G does in Photoshop: create when unclipped, release when clipped.
        send({ t: 'layerCommand', command: 'clip' });
        break;
      case 'layer.duplicate':
        send({ t: 'layerCommand', command: 'duplicate' });
        break;
      case 'arrange.forward':
        send({ t: 'layerCommand', command: 'raise' });
        break;
      case 'arrange.backward':
        send({ t: 'layerCommand', command: 'lower' });
        break;
      case 'layer.group':
        send({ t: 'layerCommand', command: 'group' });
        break;
      case 'layer.ungroup':
        send({ t: 'layerCommand', command: 'ungroup' });
        break;
      case 'layer.mergeDown':
        send({ t: 'layerCommand', command: 'mergeDown' });
        break;
      case 'layer.mergeVisible':
        send({ t: 'layerCommand', command: 'mergeVisible' });
        break;
      case 'layer.flatten':
        send({ t: 'layerCommand', command: 'flatten' });
        break;
      case 'layer.stampVisible':
        send({ t: 'layerCommand', command: 'stampVisible' });
        break;

      // Image menu
      case 'image.imageSize':
        store.openDialog('imageSize');
        break;
      case 'image.canvasSize':
        store.openDialog('canvasSize');
        break;
      case 'image.rotate90cw':
        send({ t: 'imageCommand', command: 'rotate', angle: 90 });
        break;
      case 'image.rotate90ccw':
        send({ t: 'imageCommand', command: 'rotate', angle: 270 });
        break;
      case 'image.rotate180':
        send({ t: 'imageCommand', command: 'rotate', angle: 180 });
        break;
      case 'image.flipH':
        send({ t: 'imageCommand', command: 'flip', horizontal: true });
        break;
      case 'image.flipV':
        send({ t: 'imageCommand', command: 'flip', horizontal: false });
        break;
      case 'image.trim':
        send({ t: 'imageCommand', command: 'trim' });
        break;
      case 'image.revealAll':
        send({ t: 'imageCommand', command: 'revealAll' });
        break;

      case 'adjust.brightnessContrast':
      case 'adjust.levels':
      case 'adjust.curves':
      case 'adjust.exposure':
      case 'adjust.vibrance':
      case 'adjust.hueSaturation':
      case 'adjust.colorBalance':
      case 'adjust.blackWhite':
      case 'adjust.photoFilter':
      case 'adjust.channelMixer':
      case 'adjust.invert':
      case 'adjust.posterize':
      case 'adjust.threshold':
      case 'adjust.gradientMap':
      case 'adjust.desaturate':
      case 'adjust.selectiveColor':
      case 'adjust.colorLookup': {
        // Image ▸ Adjustments act on pixels, so the target must be a pixel layer — Photoshop
        // greys these out for groups and adjustment layers; here the command explains itself.
        const kind = cmd.slice('adjust.'.length) as Adjustment['kind'];
        const doc = store.doc();
        const active = doc?.layers.find((l) => l.id === doc.activeLayerIds[0]);
        if (!active || active.kind !== 'pixel') {
          flash(`Could not complete ${ADJUSTMENT_LABEL[kind]} because the target layer is not a pixel layer.`);
          break;
        }
        if (kind === 'invert' || kind === 'desaturate') {
          send({ t: 'applyAdjustment', adjustment: defaultAdjustment(kind) });
        } else {
          store.openDialog('adjustment', initialAdjustment(kind));
        }
        break;
      }
      case 'adjLayer.brightnessContrast':
      case 'adjLayer.levels':
      case 'adjLayer.curves':
      case 'adjLayer.exposure':
      case 'adjLayer.vibrance':
      case 'adjLayer.hueSaturation':
      case 'adjLayer.colorBalance':
      case 'adjLayer.blackWhite':
      case 'adjLayer.photoFilter':
      case 'adjLayer.channelMixer':
      case 'adjLayer.invert':
      case 'adjLayer.posterize':
      case 'adjLayer.threshold':
      case 'adjLayer.gradientMap':
      case 'adjLayer.selectiveColor':
      case 'adjLayer.colorLookup': {
        // Photoshop opens the Properties panel on the new layer rather than a dialog.
        const kind = cmd.slice('adjLayer.'.length) as Adjustment['kind'];
        send({ t: 'addAdjustmentLayer', adjustment: initialAdjustment(kind) });
        store.openPanel('properties');
        break;
      }

      default: {
        const info = COMMAND_BY_ID.get(cmd);
        store.setStatusMessage(
          info ? `${info.path.join(' ▸ ')} ▸ ${info.label} is not implemented yet.` : `Unknown command: ${cmd}`,
        );
        setTimeout(() => store.setStatusMessage(null), 4000);
      }
    }
  }

  const [amountPrompt, setAmountPrompt] = createSignal<{
    title: string;
    label: string;
    value: number;
    apply: (v: number) => void;
  } | null>(null);

  /** The small one-field dialogs the Select ▸ Modify commands share. */
  function promptAmount(title: string, label: string, value: number, apply: (v: number) => void): void {
    setAmountPrompt({ title, label, value, apply });
  }

  /** Handed the id of a LUT the user just loaded, so the editor that asked can select it. */
  function lutLoaded(id: string): void {
    window.dispatchEvent(new CustomEvent('umbra:lut-loaded', { detail: id }));
  }

  function flash(message: string): void {
    store.setStatusMessage(message);
    setTimeout(() => store.setStatusMessage(null), 4000);
  }

  /** The document a session starts with when there is nothing to recover. */
  function startDefaultDocument(): void {
    send({ t: 'synthetic', layers: 6, width: 2400, height: 1600 });
  }

  /** Resolve a Fill dialog's Contents choice to a 0…1 RGB triple. */
  function fillColor(contents: string): [number, number, number] {
    const toUnit = (c: { r: number; g: number; b: number }): [number, number, number] => [c.r, c.g, c.b];
    switch (contents) {
      case 'background':
        return toUnit(store.background());
      case 'black':
        return [0, 0, 0];
      case 'white':
        return [1, 1, 1];
      case 'gray50':
        // Photoshop's "50% Gray" is 128/255 encoded, not 0.5 linear.
        return [128 / 255, 128 / 255, 128 / 255];
      case 'transparent':
        return [0, 0, 0];
      default:
        return toUnit(store.foreground());
    }
  }

  /** Current document name with a .psd extension, for the Save dialog's default. */
  function psdName(): string {
    const name = store.doc()?.name ?? 'Untitled';
    return /\.psd$|\.psb$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.psd`;
  }

  /** Photoshop's [ and ] step by a size-dependent amount rather than a flat 1 px. */
  function stepFor(size: number): number {
    if (size < 10) return 1;
    if (size < 100) return 10;
    if (size < 200) return 25;
    return 50;
  }

  function stepTheme(dir: 1 | -1): void {
    const i = THEME_ORDER.indexOf(store.theme());
    store.setTheme(THEME_ORDER[Math.min(THEME_ORDER.length - 1, Math.max(0, i + dir))]!);
  }

  function cycleScreenMode(cmd: string): void {
    const order = ['standard', 'fullMenu', 'full'] as const;
    if (cmd.startsWith('screen.')) {
      const target = cmd.slice('screen.'.length) as (typeof order)[number];
      store.setScreenMode(target);
      return;
    }
    const i = order.indexOf(store.screenMode());
    store.setScreenMode(order[(i + 1) % order.length]!);
  }

  async function openFile(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.psd,.psb';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (/\.psb?$|\.psd$/i.test(file.name)) {
        // PSD goes to the engine as raw bytes; the worker parses and tiles it.
        const buffer = await file.arrayBuffer();
        client?.send({ t: 'openPsd', buffer, name: file.name }, [buffer]);
      } else {
        const bitmap = await createImageBitmap(file);
        client?.send({ t: 'openBitmap', bitmap, name: file.name }, [bitmap]);
      }
    };
    input.click();
  }

  // ---- keyboard -------------------------------------------------------------------------
  onMount(() => {
    /** Tool the user was on before a spring-loaded key was held. */
    let springFrom: string | null = null;
    let springKey: string | null = null;
    let springHeldSince = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      // Any modal swallows the shell's shortcuts, including the small Select ▸ Modify dialogs.
      if (store.dialog() || amountPrompt()) return;
      // A transform or crop box owns Enter, Escape and the arrow keys while it is open.
      if (transforming()) {
        const cropping = store.activeTool() === 'crop';
        if (e.key === 'Enter') {
          e.preventDefault();
          send(cropping ? { t: 'commitCrop' } : { t: 'commitTransform' });
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          send(cropping ? { t: 'cancelCrop' } : { t: 'cancelTransform' });
          return;
        }
      }
      // Delete / Backspace clear the selection's pixels, as Photoshop's do. (Photoshop's
      // Backspace on a Background layer fills with the background colour instead; with no
      // locked Background layer here yet, both keys clear.) With nothing selected they do
      // nothing — clearing a whole layer by accident is not a keystroke's job.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (store.doc()?.hasSelection) runCommand('edit.clear');
        return;
      }

      const arrow = ARROW_NUDGE[e.key];
      if (arrow && (transforming() || store.activeTool() === 'move')) {
        e.preventDefault();
        // Shift nudges by 10, as it does everywhere in Photoshop.
        const step = e.shiftKey ? 10 : 1;
        send({ t: 'nudge', dx: arrow[0] * step, dy: arrow[1] * step });
        return;
      }

      // Escape abandons an in-flight selection gesture; Enter commits one. Neither should
      // swallow the key when no gesture is running.
      if (client?.isSelecting && (e.key === 'Escape' || e.key === 'Enter')) {
        e.preventDefault();
        if (e.key === 'Escape') client.cancelSelect();
        else client.finishSelect();
        return;
      }

      const chord = chordFromEvent(e);

      // Tool letters (and Shift+letter to cycle within the group).
      if (!chord.ctrl && !chord.alt && !chord.meta && chord.key.length === 1) {
        const matches = cycleForKey(chord.key);
        if (matches.length > 0) {
          e.preventDefault();
          if (e.repeat) return;
          if (chord.shift) {
            const i = matches.findIndex((t) => t.id === store.activeTool());
            store.setActiveTool(matches[(i + 1) % matches.length]!.id);
          } else {
            // Remember where we came from so a HELD key springs back on release.
            springFrom = store.activeTool();
            springKey = chord.key;
            springHeldSince = performance.now();
            const g = groupOf(matches[0]!.id);
            const preferred = g ? store.groupDefaults[g.id] : undefined;
            store.setActiveTool(
              preferred && matches.some((t) => t.id === preferred) ? preferred : matches[0]!.id,
            );
          }
          return;
        }
      }

      const binding = keymap.lookup(e);
      if (binding) {
        e.preventDefault();
        // A shortcut must obey the same rule as the menu: a disabled command does nothing,
        // and says so, rather than being swallowed silently.
        if (!isEnabled(binding.target)) {
          const label = COMMAND_BY_ID.get(binding.target)?.label;
          if (label) store.setStatusMessage(`${label.replace(/…$/, '')} is not available yet.`);
          return;
        }
        runCommand(binding.target);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!springKey || e.key.toLowerCase() !== springKey) return;
      const held = performance.now() - springHeldSince;
      // A tap switches tools for good; a hold is spring-loaded and snaps back.
      if (held > 320 && springFrom) store.setActiveTool(springFrom);
      springKey = null;
      springFrom = null;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });
  });

  const isChecked = (cmd: string): boolean => {
    const panelId = PANEL_BY_COMMAND[cmd];
    if (panelId) return store.isPanelOpen(panelId);
    switch (cmd) {
      case 'view.rulers':
        return store.extras.rulers;
      case 'show.grid':
        return store.extras.grid;
      case 'show.guides':
        return store.extras.guides;
      case 'show.pixelGrid':
        return store.extras.pixelGrid;
      case 'view.extras':
        return store.extras.enabled;
      case 'panel.tools':
        return store.toolsVisible();
      case 'panel.options':
        return store.optionsVisible();
      case 'screen.standard':
        return store.screenMode() === 'standard';
      case 'screen.fullMenu':
        return store.screenMode() === 'fullMenu';
      case 'screen.full':
        return store.screenMode() === 'full';
      case 'mode.rgb':
      case 'mode.depth8':
        return true;
      default:
        return false;
    }
  };

  const isEnabled = (cmd: string): boolean => {
    if (PANEL_BY_COMMAND[cmd]) return true;
    if (cmd.startsWith('workspace.') && WORKSPACE_BY_ID.has(cmd.slice(10))) return true;
    const entry = COMMAND_BY_ID.get(cmd);
    // Keyboard-only commands (D, X, Q, [ and ], Tab…) are not menu items and are always
    // live; only a MENU command can be "not built yet".
    if (!entry) return true;
    // Built, but only meaningful in a state: there has to be a filter to repeat, a step to fade.
    if (cmd === 'filter.last') return !!store.doc()?.lastFilter;
    if (cmd === 'edit.fade') return !!store.doc()?.fadeName;
    return !!entry.done;
  };

  const shortcutRows = () =>
    ALL_TOOLS.filter((t) => t.key)
      .map((t) => ({ keys: t.key!.toUpperCase(), label: t.name }))
      .concat(keymap.all().map((b) => ({ keys: chordLabel(b.chord), label: COMMAND_BY_ID.get(b.target)?.label ?? b.target })));

  return (
    <div
      class="workspace"
      classList={{
        'hide-panels': !store.panelsVisible(),
        'hide-tools': !store.toolsVisible(),
        'hide-options': !store.optionsVisible(),
        'screen-full': store.screenMode() === 'full',
      }}
    >
      <Show when={store.screenMode() !== 'full'}>
        <div class="titlebar">
          <MenuBar menus={MENUS} onCommand={runCommand} isEnabled={isEnabled} isChecked={isChecked} />
          <span class="spacer" />
          <span class="titlebar-name">Umbra</span>
        </div>
      </Show>

      <Show when={store.optionsVisible() && store.screenMode() !== 'full'}>
        <OptionsBar
          onCommand={runCommand}
        />
      </Show>

      <div class="workspace-body">
        <Show when={store.toolsVisible()}>
          <ToolsPanel
            groups={TOOL_GROUPS}
            activeTool={store.activeTool()}
            groupDefaults={store.groupDefaults}
            doubleColumn={store.toolsDoubleColumn()}
            onToggleColumns={() => store.setToolsDoubleColumn(!store.toolsDoubleColumn())}
            onSelect={store.setActiveTool}
            foreground={rgbToCss(store.foreground())}
            background={rgbToCss(store.background())}
            onSwapColors={store.swapColors}
            onResetColors={store.resetColors}
            onPickColor={(which) => {
              setPickerTarget(which);
              store.openDialog('colorPicker');
            }}
            quickMask={quickMask()}
            onToggleQuickMask={() => runCommand('select.quickMask')}
            onCycleScreenMode={() => runCommand('view.cycleScreenMode')}
            onEditToolbar={() => runCommand('edit.toolbar')}
          />
        </Show>

        <div class="doc-column">
          <DocumentTabs
            onClose={() => runCommand('file.close')}
            onSelect={(id) => store.setActiveTab(id)}
          />
          <div class="doc-area" ref={docAreaRef} classList={{ 'with-rulers': store.extras.rulers }}>
            <canvas ref={canvasRef} class={cursorClass(store.activeTool())} />
            <SamplerMarkers />
            <Show when={store.extras.rulers}>
              <div class="ruler ruler-h" />
              <div class="ruler ruler-v" />
              <div class="ruler-corner" />
            </Show>
            <Show when={error()}>
              {(m) => <div class="doc-error">{m()}</div>}
            </Show>
          </div>
        </div>

        <Show when={store.panelsVisible()}>
          <Dock
            layout={store.layout}
            meta={PANEL_META}
            renderPanel={renderPanel}
            onActivate={(colId, groupId, panelId) =>
              store.setLayout(
                produce((l) => {
                  const g = l.columns.find((c) => c.id === colId)?.groups.find((x) => x.id === groupId);
                  if (g) {
                    g.active = panelId;
                    g.minimized = false;
                  }
                }),
              )
            }
            onToggleCollapse={(colId) =>
              store.setLayout(
                produce((l) => {
                  const c = l.columns.find((x) => x.id === colId);
                  if (c) c.collapsed = !c.collapsed;
                }),
              )
            }
            onToggleMinimize={(colId, groupId) =>
              store.setLayout(
                produce((l) => {
                  const g = l.columns.find((c) => c.id === colId)?.groups.find((x) => x.id === groupId);
                  if (g) g.minimized = !g.minimized;
                }),
              )
            }
            onClosePanel={store.closePanel}
            onMovePanel={(panelId, toColumn, toGroup, index) =>
              store.setLayout(
                produce((l) => {
                  for (const col of l.columns) {
                    for (const g of col.groups) {
                      const i = g.panels.indexOf(panelId);
                      if (i >= 0) {
                        g.panels.splice(i, 1);
                        if (g.active === panelId) g.active = g.panels[0] ?? '';
                      }
                    }
                  }
                  const target = l.columns.find((c) => c.id === toColumn)?.groups.find((g) => g.id === toGroup);
                  if (target) {
                    target.panels.splice(Math.min(index, target.panels.length), 0, panelId);
                    target.active = panelId;
                  }
                  for (const col of l.columns) col.groups = col.groups.filter((g) => g.panels.length > 0);
                  l.columns = l.columns.filter((c) => c.groups.length > 0);
                }),
              )
            }
            onResizeColumn={(colId, width) =>
              store.setLayout(
                produce((l) => {
                  const c = l.columns.find((x) => x.id === colId);
                  if (c) c.width = width;
                }),
              )
            }
            onPanelMenu={(panelId) => {
              store.setStatusMessage(`Panel menu for ${PANEL_META[panelId]?.title ?? panelId} arrives with that panel.`);
              setTimeout(() => store.setStatusMessage(null), 3000);
            }}
          />
        </Show>
      </div>

      <Show when={store.screenMode() !== 'full'}>
        <StatusBar onZoomChange={(pct) => send({ t: 'setZoom', zoom: pct / 100 })} />
      </Show>

      <Show when={store.dialog()?.id === 'newDocument'}>
        <NewDocumentDialog
          onCancel={store.closeDialog}
          onCreate={(w, h, name) => {
            store.closeDialog();
            send({ t: 'newDoc', width: w, height: h });
            store.setTabs([{ id: 1, name, dirty: false }]);
            store.setActiveTab(1);
          }}
        />
      </Show>
      <Show when={store.dialog()?.id === 'colorPicker'}>
        <ColorPickerDialog
          initial={pickerTarget() === 'foreground' ? store.foreground() : store.background()}
          onCancel={store.closeDialog}
          onPick={(c) => {
            store.closeDialog();
            if (pickerTarget() === 'foreground') store.setForeground(c);
            else store.setBackground(c);
          }}
        />
      </Show>
      <Show when={amountPrompt()}>
        {(p) => {
          // Read `apply` up front: clearing the signal first unmounts this Show, and reading
          // the accessor afterwards throws on a stale value.
          const apply = p().apply;
          return (
            <AmountDialog
              title={p().title}
              label={p().label}
              initial={p().value}
              onCancel={() => setAmountPrompt(null)}
              onApply={(v) => {
                setAmountPrompt(null);
                apply(v);
              }}
            />
          );
        }}
      </Show>
      <Show when={recovery()}>
        {(r) => (
          <Dialog
            title="Recover Document"
            width={380}
            okLabel="Recover"
            onCancel={() => {
              setRecovery(null);
              send({ t: 'discardRecovery' });
              startDefaultDocument();
            }}
            onOk={() => {
              setRecovery(null);
              send({ t: 'recover' });
            }}
          >
            <div class="sizedlg">
              <p>
                “{r().name}” was left unsaved when Umbra last closed, autosaved at{' '}
                {new Date(r().savedAt).toLocaleString()}.
              </p>
              <p class="dim">
                Cancel starts a new document instead and discards the autosave.
              </p>
            </div>
          </Dialog>
        )}
      </Show>
      <Show when={store.dialog()?.id === 'adjustment'}>
        <AdjustmentDialog
          initial={store.dialog()!.payload as Adjustment}
          send={(m) => send(m as Parameters<typeof send>[0])}
          onClose={store.closeDialog}
        />
      </Show>
      <Show when={store.dialog()?.id === 'spatial'}>
        <SpatialDialog
          initial={store.dialog()!.payload as SpatialAdjustment}
          send={(m) => send(m as Parameters<typeof send>[0])}
          onClose={store.closeDialog}
        />
      </Show>
      <Show when={store.dialog()?.id === 'filter'}>
        <FilterDialog id={store.dialog()!.payload as string} send={(m) => send(m as Parameters<typeof send>[0])} onClose={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'gallery'}>
        <GalleryDialog send={(m) => send(m as Parameters<typeof send>[0])} onClose={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'fade'}>
        <FadeDialog name={store.doc()?.fadeName ?? ''} send={(m) => send(m as Parameters<typeof send>[0])} onClose={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'applyImage'}>
        <ApplyImageDialog send={(m) => send(m as Parameters<typeof send>[0])} onClose={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'calculations'}>
        <CalculationsDialog send={(m) => send(m as Parameters<typeof send>[0])} onClose={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'fillLayer'}>
        <FillLayerDialog
          initial={store.dialog()!.payload as FillSummary}
          send={(m) => send(m as Parameters<typeof send>[0])}
          onClose={store.closeDialog}
        />
      </Show>
      <Show when={store.dialog()?.id === 'definePattern'}>
        <NameDialog
          title="Pattern Name"
          label="Name"
          initial={`Pattern ${store.patterns().length + 1}`}
          onCancel={store.closeDialog}
          onApply={(name) => {
            store.closeDialog();
            send({ t: 'definePattern', name });
            store.openPanel('patterns');
          }}
        />
      </Show>
      <Show when={store.dialog()?.id === 'fill'}>
        <FillDialog
          onCancel={store.closeDialog}
          onApply={(r: FillRequest) => {
            store.closeDialog();
            send({
              t: 'fill',
              color: fillColor(r.contents),
              mode: r.mode,
              opacity: r.opacity,
              preserveTransparency: r.preserveTransparency,
              clear: r.contents === 'transparent',
            });
          }}
        />
      </Show>
      <Show when={store.dialog()?.id === 'stroke'}>
        <StrokeDialog
          onCancel={store.closeDialog}
          onApply={(r: StrokeRequest) => {
            store.closeDialog();
            send({
              t: 'stroke',
              color: fillColor(r.contents),
              mode: r.mode,
              opacity: r.opacity,
              preserveTransparency: r.preserveTransparency,
              width: r.width,
              location: r.location,
            });
          }}
        />
      </Show>
      <Show when={store.dialog()?.id === 'imageSize'}>
        <ImageSizeDialog
          width={store.doc()?.width ?? 0}
          height={store.doc()?.height ?? 0}
          onCancel={store.closeDialog}
          onApply={(w, h, method) => {
            store.closeDialog();
            send({ t: 'imageCommand', command: 'imageSize', width: w, height: h, method });
          }}
        />
      </Show>
      <Show when={store.dialog()?.id === 'canvasSize'}>
        <CanvasSizeDialog
          width={store.doc()?.width ?? 0}
          height={store.doc()?.height ?? 0}
          onCancel={store.closeDialog}
          onApply={(w, h, anchor) => {
            store.closeDialog();
            send({ t: 'imageCommand', command: 'canvasSize', width: w, height: h, anchor });
          }}
        />
      </Show>
      <Show when={store.dialog()?.id === 'about'}>
        <AboutDialog onCancel={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'systemInfo'}>
        <SystemInfoDialog onCancel={store.closeDialog} />
      </Show>
      <Show when={store.dialog()?.id === 'shortcuts'}>
        <ShortcutsDialog rows={shortcutRows()} onCancel={store.closeDialog} />
      </Show>
    </div>
  );
}

function cursorClass(toolId: string): string {
  if (PAINT_TOOLS.has(toolId)) return 'cursor-paint';
  if (toolId === 'hand') return 'cursor-hand';
  if (toolId === 'zoom') return 'cursor-zoom';
  if (toolId === 'move') return 'cursor-move';
  if (TOOL_BY_ID.get(toolId)?.icon.startsWith('marquee')) return 'cursor-cross';
  return 'cursor-default';
}

/**
 * Colour sampler markers over the canvas: numbered targets at their document positions, kept
 * in place through pan, zoom and rotation by mapping through the view the engine reports.
 */
function SamplerMarkers() {
  const view = (): ViewState | null => {
    const s = store.stats();
    if (!s) return null;
    return {
      zoom: s.zoom,
      rotation: s.viewRotation,
      centre: { x: s.centreX, y: s.centreY },
      width: s.viewWidth,
      height: s.viewHeight,
      devicePixelRatio: 1,
    };
  };
  return (
    <For each={store.samplers()}>
      {(sm, i) => {
        const at = () => {
          const v = view();
          return v ? screenPointAtDoc(v, sm.x + 0.5, sm.y + 0.5) : null;
        };
        return (
          <Show when={at()}>
            {(p) => (
              <div class="sampler-marker" style={{ left: `${p().x}px`, top: `${p().y}px` }}>
                <span>{i() + 1}</span>
              </div>
            )}
          </Show>
        );
      }}
    </For>
  );
}
