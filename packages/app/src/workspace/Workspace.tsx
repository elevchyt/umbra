import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { produce } from 'solid-js/store';
import { MenuBar } from '@umbra/ui/menu/MenuBar';
import { ToolsPanel } from '@umbra/ui/workspace/ToolsPanel';
import { Dock } from '@umbra/ui/dock/Dock';
import { rgbToCss } from '@umbra/core/color';
import { EngineClient } from '../engine-client';
import { store, type ThemeName } from '../state/store';
import { MENUS, COMMAND_BY_ID } from '../menus/menus';
import { TOOL_GROUPS, TOOL_BY_ID, ALL_TOOLS, PAINT_TOOLS, SELECT_TOOLS, cycleForKey, groupOf } from '../tools/registry';
import { PANEL_META, PANEL_BY_COMMAND, renderPanel } from '../panels/panels';
import { WORKSPACE_BY_ID, DEFAULT_LAYOUT } from '../workspaces/layouts';
import { Keymap, EXTRA_BINDINGS, isTextEntry, chordFromEvent, chordLabel } from '../keymap/keymap';
import { OptionsBar } from './OptionsBar';
import { DocumentTabs, StatusBar } from './Chrome';
import { NewDocumentDialog, ColorPickerDialog, AboutDialog, SystemInfoDialog, ShortcutsDialog, ImageSizeDialog, CanvasSizeDialog, AmountDialog, FillDialog, StrokeDialog, type FillRequest, type StrokeRequest } from '../dialogs/Dialogs';

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
  shell?.reportSpikes?.({ pass, text });
}

export function Workspace() {
  let canvasRef!: HTMLCanvasElement;
  let docAreaRef!: HTMLDivElement;
  let client: EngineClient | undefined;

  const [brushSize, setBrushSize] = createSignal(60);
  const [brushHardness, setBrushHardness] = createSignal(0.6);
  const [brushOpacity, setBrushOpacity] = createSignal(100);
  const [brushFlow, setBrushFlow] = createSignal(100);
  const [pickerTarget, setPickerTarget] = createSignal<'foreground' | 'background'>('foreground');
  const [quickMask, setQuickMask] = createSignal(false);
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
          else client!.send({ t: 'synthetic', layers: 6, width: 2400, height: 1600 });
        },
        onStats: (s) => {
          // Dev aid: the live engine stats are awkward to inspect from the UI thread
          // otherwise, and view/atlas bugs are much easier to diagnose with them to hand.
          if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__umbraStats = s;
          store.setStats(s);
        },
        onDoc: (d) => {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

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
    if (!client) return;
    client.paintMode = PAINT_TOOLS.has(tool);
    client.selectTool = SELECT_TOOLS.has(tool) ? tool : null;
    client.sampleSize = tool === 'eyedropper' ? store.sampleSize() : null;
  });

  // Selection options live in the UI store; the engine needs them before the next gesture.
  createEffect(() => {
    const o = store.selectOptions;
    if (!client) return;
    client.selectOp = o.op;
    send({
      t: 'setSelectOptions',
      feather: o.feather,
      antialias: o.antialias,
      tolerance: o.tolerance,
      contiguous: o.contiguous,
    });
  });
  createEffect(() => {
    if (!client) return;
    client.brushSize = brushSize();
    client.brushHardness = brushHardness();
    const c = store.foreground();
    client.brushColor = [c.r, c.g, c.b, brushOpacity() / 100];
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
        setBrushSize((s) => Math.min(5000, s + stepFor(s)));
        break;
      case 'brush.sizeDown':
        setBrushSize((s) => Math.max(1, s - stepFor(s)));
        break;
      case 'brush.hardnessUp':
        setBrushHardness((h) => Math.min(1, h + 0.25));
        break;
      case 'brush.hardnessDown':
        setBrushHardness((h) => Math.max(0, h - 0.25));
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
    return !!COMMAND_BY_ID.get(cmd)?.done;
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
          brushSize={brushSize()}
          setBrushSize={setBrushSize}
          brushHardness={brushHardness()}
          setBrushHardness={setBrushHardness}
          brushOpacity={brushOpacity()}
          setBrushOpacity={setBrushOpacity}
          brushFlow={brushFlow()}
          setBrushFlow={setBrushFlow}
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
