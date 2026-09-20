import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { produce } from 'solid-js/store';
import { MenuBar } from '@umbra/ui/menu/MenuBar';
import { ToolsPanel } from '@umbra/ui/workspace/ToolsPanel';
import { Dock } from '@umbra/ui/dock/Dock';
import { rgbToCss } from '@umbra/core/color';
import { EngineClient } from '../engine-client';
import { store, type ThemeName } from '../state/store';
import { MENUS, COMMAND_BY_ID } from '../menus/menus';
import { TOOL_GROUPS, TOOL_BY_ID, ALL_TOOLS, PAINT_TOOLS, cycleForKey, groupOf } from '../tools/registry';
import { PANEL_META, PANEL_BY_COMMAND, renderPanel } from '../panels/panels';
import { WORKSPACE_BY_ID, DEFAULT_LAYOUT } from '../workspaces/layouts';
import { Keymap, EXTRA_BINDINGS, isTextEntry, chordFromEvent, chordLabel } from '../keymap/keymap';
import { OptionsBar } from './OptionsBar';
import { DocumentTabs, StatusBar } from './Chrome';
import { NewDocumentDialog, ColorPickerDialog, AboutDialog, SystemInfoDialog, ShortcutsDialog } from '../dialogs/Dialogs';

const THEME_ORDER: ThemeName[] = ['darkest', 'dark', 'medium', 'light'];

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
        onContextLost: () => store.setContextLost(true),
        onContextRestored: () => store.setContextLost(false),
        onError: (m) => {
          setError(m);
          if (location.hash) reportToShell(false, `ERROR: ${m}`);
        },
      });
      client.paintMode = PAINT_TOOLS.has(store.activeTool());
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
    if (client) client.paintMode = PAINT_TOOLS.has(store.activeTool());
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
      case 'select.quickMask':
        setQuickMask((v) => !v);
        break;

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

      default: {
        const info = COMMAND_BY_ID.get(cmd);
        store.setStatusMessage(
          info ? `${info.path.join(' ▸ ')} ▸ ${info.label} is not implemented yet.` : `Unknown command: ${cmd}`,
        );
        setTimeout(() => store.setStatusMessage(null), 4000);
      }
    }
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
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const bitmap = await createImageBitmap(file);
      client?.send({ t: 'openBitmap', bitmap, name: file.name }, [bitmap]);
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
      if (store.dialog()) return;

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
            onToggleQuickMask={() => setQuickMask((v) => !v)}
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
