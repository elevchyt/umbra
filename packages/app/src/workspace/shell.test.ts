import { describe, expect, it } from 'vitest';
import workspaceSource from './Workspace.tsx?raw';
import { MENUS, COMMANDS, COMMAND_BY_ID, type MenuNode } from '../menus/menus';
import { TOOL_GROUPS, ALL_TOOLS, TOOL_BY_ID, cycleForKey, groupOf } from '../tools/registry';
import { PANEL_META, PANEL_BY_COMMAND } from '../panels/registry';
import { WORKSPACES, DEFAULT_LAYOUT } from '../workspaces/layouts';
import { Keymap, parseChord, chordKey, chordLabel, EXTRA_BINDINGS, isTextEntry } from '../keymap/keymap';
import { ICONS } from '@umbra/ui/icons/icons';
import { parseNumeric, toPixels, fromPixels } from '@umbra/ui/widgets/numeric';
import { FILTER_BY_ID } from '@umbra/engine';

function walk(nodes: MenuNode[], fn: (n: MenuNode, path: string[]) => void, path: string[] = []) {
  for (const n of nodes) {
    if (n.separator) continue;
    fn(n, path);
    if (n.items) walk(n.items, fn, [...path, n.label ?? '']);
  }
}

describe('menu tree', () => {
  it('has the menus a Photoshop user expects, in order', () => {
    expect(MENUS.map((m) => m.label)).toEqual([
      'File',
      'Edit',
      'Image',
      'Layer',
      'Type',
      'Select',
      'Filter',
      'View',
      'Window',
      'Help',
    ]);
  });

  it('gives every leaf a command id', () => {
    const missing: string[] = [];
    walk(MENUS.flatMap((m) => m.items), (n, path) => {
      if (!n.items && !n.cmd && n.label && !n.label.startsWith('(')) {
        missing.push([...path, n.label].join(' > '));
      }
    });
    expect(missing).toEqual([]);
  });

  it('only repeats a command id for panel toggles', () => {
    // Photoshop lists the type panels under both Type ▸ Panels and Window, and both entries
    // do the same idempotent thing. Any OTHER repeated id would be a copy-paste mistake.
    const seen = new Map<string, number>();
    for (const c of COMMANDS) seen.set(c.cmd, (seen.get(c.cmd) ?? 0) + 1);
    const repeated = [...seen].filter(([, n]) => n > 1).map(([cmd]) => cmd);
    expect(repeated.filter((cmd) => !cmd.startsWith('panel.'))).toEqual([]);
  });

  it('parses every declared shortcut', () => {
    for (const c of COMMANDS) {
      if (!c.shortcut) continue;
      const chord = parseChord(c.shortcut);
      expect(chord.key, `${c.cmd} (${c.shortcut})`).not.toBe('');
    }
  });

  it('binds no chord to two different commands', () => {
    const byChord = new Map<string, string>();
    const clashes: string[] = [];
    for (const c of COMMANDS) {
      if (!c.shortcut) continue;
      const k = chordKey(parseChord(c.shortcut));
      const prev = byChord.get(k);
      if (prev && prev !== c.cmd) clashes.push(`${c.shortcut}: ${prev} vs ${c.cmd}`);
      byChord.set(k, c.cmd);
    }
    for (const b of EXTRA_BINDINGS) {
      const k = chordKey(parseChord(b.shortcut));
      const prev = byChord.get(k);
      if (prev && prev !== b.cmd) clashes.push(`${b.shortcut}: ${prev} vs ${b.cmd}`);
      byChord.set(k, b.cmd);
    }
    expect(clashes).toEqual([]);
  });

  it('carries the landmark Photoshop shortcuts', () => {
    const expected: Record<string, string> = {
      'file.new': 'Ctrl+N',
      'edit.undo': 'Ctrl+Z',
      'edit.freeTransform': 'Ctrl+T',
      'adjust.levels': 'Ctrl+L',
      'adjust.curves': 'Ctrl+M',
      'adjust.hueSaturation': 'Ctrl+U',
      'layer.viaCopy': 'Ctrl+J',
      'layer.group': 'Ctrl+G',
      'layer.mergeVisible': 'Ctrl+Shift+E',
      'select.all': 'Ctrl+A',
      'select.deselect': 'Ctrl+D',
      'select.inverse': 'Ctrl+Shift+I',
      'modify.feather': 'Shift+F6',
      'view.fit': 'Ctrl+0',
      'view.actual': 'Ctrl+1',
      'filter.liquify': 'Ctrl+Shift+X',
      'panel.layers': 'F7',
    };
    for (const [cmd, shortcut] of Object.entries(expected)) {
      expect(COMMAND_BY_ID.get(cmd)?.shortcut, cmd).toBe(shortcut);
    }
  });

  it('exposes every panel in the Window menu', () => {
    const windowMenu = MENUS.find((m) => m.label === 'Window')!;
    const cmds = new Set<string>();
    walk(windowMenu.items, (n) => {
      if (n.cmd) cmds.add(n.cmd);
    });
    for (const panelId of Object.keys(PANEL_META)) {
      expect(cmds.has(`panel.${panelId}`), `Window menu is missing ${panelId}`).toBe(true);
    }
  });

  it('maps every panel command to a known panel', () => {
    for (const [cmd, panelId] of Object.entries(PANEL_BY_COMMAND)) {
      expect(PANEL_META[panelId], cmd).toBeDefined();
    }
  });

  it('has the full Filter category set', () => {
    const filter = MENUS.find((m) => m.label === 'Filter')!;
    const categories = filter.items.filter((n) => n.items).map((n) => n.label);
    for (const c of ['Blur', 'Blur Gallery', 'Distort', 'Noise', 'Pixelate', 'Render', 'Sharpen', 'Stylize', 'Video', 'Other']) {
      expect(categories, `Filter ▸ ${c}`).toContain(c);
    }
  });

  it('lists all 11 Blur filters', () => {
    const filter = MENUS.find((m) => m.label === 'Filter')!;
    const blur = filter.items.find((n) => n.label === 'Blur')!;
    expect(blur.items).toHaveLength(11);
  });

  it('lists all 16 adjustment layer kinds', () => {
    const layer = MENUS.find((m) => m.label === 'Layer')!;
    const adj = layer.items.find((n) => n.label === 'New Adjustment Layer')!;
    expect(adj.items!.filter((n) => !n.separator)).toHaveLength(16);
  });
});

describe('tool registry', () => {
  it('covers every Photoshop tool group', () => {
    expect(TOOL_GROUPS).toHaveLength(21);
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(60);
  });

  it('draws an icon for every tool', () => {
    const missing = ALL_TOOLS.filter((t) => !(t.icon in ICONS)).map((t) => `${t.id}:${t.icon}`);
    expect(missing).toEqual([]);
  });

  it('gives every tool a unique id', () => {
    expect(new Set(ALL_TOOLS.map((t) => t.id)).size).toBe(ALL_TOOLS.length);
  });

  it('uses a single lowercase letter for every shortcut', () => {
    // Groups may legitimately mix letters — Hand (H) and Rotate View (R) share one slot in
    // Photoshop too — so the invariant is about the letters themselves, not the grouping.
    for (const t of ALL_TOOLS) {
      if (t.key === undefined) continue;
      expect(t.key, t.id).toMatch(/^[a-z]$/);
    }
  });

  it('cycles tools that share a letter', () => {
    expect(cycleForKey('m').map((t) => t.id)).toEqual(['marqueeRect', 'marqueeEllipse']);
    expect(cycleForKey('l')).toHaveLength(4);
    expect(cycleForKey('b')).toHaveLength(4);
  });

  it('finds the group a tool belongs to', () => {
    expect(groupOf('magicWand')?.id).toBe('quickSelect');
    expect(groupOf('nope')).toBeUndefined();
    expect(TOOL_BY_ID.get('brush')?.name).toBe('Brush Tool');
  });

  it("matches Photoshop's shortcut letters", () => {
    const expected: Record<string, string> = {
      move: 'v',
      marqueeRect: 'm',
      lasso: 'l',
      magicWand: 'w',
      crop: 'c',
      frame: 'k',
      eyedropper: 'i',
      spotHealing: 'j',
      brush: 'b',
      cloneStamp: 's',
      historyBrush: 'y',
      eraser: 'e',
      gradient: 'g',
      dodgeTool: 'o',
      pen: 'p',
      typeHorizontal: 't',
      pathSelect: 'a',
      rectangle: 'u',
      hand: 'h',
      rotateView: 'r',
      zoom: 'z',
    };
    for (const [id, key] of Object.entries(expected)) {
      expect(TOOL_BY_ID.get(id)?.key, id).toBe(key);
    }
  });
});

describe('keymap', () => {
  it('parses modifiers and keys', () => {
    expect(parseChord('Ctrl+Shift+N')).toEqual({ key: 'n', ctrl: true, alt: false, shift: true, meta: false });
    expect(parseChord('F7').key).toBe('f7');
    expect(parseChord('Shift+F6')).toMatchObject({ key: 'f6', shift: true });
    expect(parseChord('Ctrl+Alt+Shift+K')).toMatchObject({ ctrl: true, alt: true, shift: true, key: 'k' });
  });

  it("handles Photoshop's awkward Ctrl++ zoom binding", () => {
    expect(parseChord('Ctrl++')).toMatchObject({ ctrl: true, key: '+' });
    expect(parseChord('Ctrl+-')).toMatchObject({ ctrl: true, key: '-' });
  });

  it('round-trips a chord through its label', () => {
    for (const s of ['Ctrl+Z', 'Ctrl+Shift+Z', 'Shift+F6', 'Alt+F9']) {
      expect(chordLabel(parseChord(s))).toBe(s);
    }
  });

  it('looks a binding up from a keyboard event', () => {
    const km = new Keymap();
    km.add('Ctrl+Shift+N', 'layer.new');
    const hit = km.lookup({ key: 'N', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false } as KeyboardEvent);
    expect(hit?.target).toBe('layer.new');
    const miss = km.lookup({ key: 'N', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } as KeyboardEvent);
    expect(miss).toBeUndefined();
  });

  it('treats form controls as text entry so letter shortcuts do not fire while typing', () => {
    expect(isTextEntry({ tagName: 'INPUT' } as HTMLElement)).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA' } as HTMLElement)).toBe(true);
    expect(isTextEntry({ tagName: 'SELECT' } as HTMLElement)).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true } as HTMLElement)).toBe(true);
    expect(isTextEntry({ tagName: 'DIV' } as HTMLElement)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('workspace layouts', () => {
  it('ships the built-in presets', () => {
    expect(WORKSPACES.map((w) => w.id)).toEqual(['essentials', 'painting', 'photography', 'graphicWeb']);
  });

  it('references only known panels', () => {
    for (const w of WORKSPACES) {
      for (const col of w.layout.columns) {
        for (const g of col.groups) {
          for (const p of g.panels) expect(PANEL_META[p], `${w.id}: ${p}`).toBeDefined();
          expect(g.panels, `${w.id}: active tab must be one of the group's panels`).toContain(g.active);
        }
      }
    }
  });

  it('puts Layers, Color and Properties in the default workspace', () => {
    const panels = DEFAULT_LAYOUT.columns.flatMap((c) => c.groups.flatMap((g) => g.panels));
    expect(panels).toContain('layers');
    expect(panels).toContain('color');
    expect(panels).toContain('properties');
  });
});

describe('numeric field parsing', () => {
  it('reads plain numbers', () => {
    expect(parseNumeric('42')).toBe(42);
    expect(parseNumeric('  -3.5 ')).toBe(-3.5);
    expect(parseNumeric('1,5')).toBe(1.5); // comma decimal separator
  });

  it('evaluates simple arithmetic left to right', () => {
    expect(parseNumeric('100+20')).toBe(120);
    expect(parseNumeric('200/4')).toBe(50);
    expect(parseNumeric('3*4')).toBe(12);
    expect(parseNumeric('10-2-3')).toBe(5);
  });

  it('converts unit suffixes to the field unit', () => {
    expect(parseNumeric('2in', { unit: 'px', ppi: 72 })).toBe(144);
    expect(parseNumeric('2.54cm', { unit: 'px', ppi: 100 })).toBeCloseTo(100, 6);
    expect(parseNumeric('72pt', { unit: 'px', ppi: 72 })).toBe(72);
    expect(parseNumeric('50%', { unit: 'px', basis: 800 })).toBe(400);
  });

  it('rejects text it cannot understand', () => {
    expect(parseNumeric('abc')).toBeNull();
    expect(parseNumeric('')).toBeNull();
    expect(parseNumeric('12ft')).toBeNull();
  });

  it('round-trips unit conversion', () => {
    for (const unit of ['in', 'cm', 'mm', 'pt', 'pica'] as const) {
      const px = toPixels(3, unit, 300);
      expect(fromPixels(px, unit, 300)).toBeCloseTo(3, 9);
    }
  });

  it('never divides by zero', () => {
    expect(parseNumeric('10/0')).toBe(10);
  });
});

/**
 * `done: true` is what greys a menu item in or out, and it is maintained by hand — which has
 * already gone wrong once in each direction (a dead item left enabled, working ones left
 * greyed). This makes the flag and the code unable to disagree: a menu command is `done`
 * exactly when `runCommand` has a case for it.
 */
describe('menu enablement matches the handlers', () => {
  // `?raw` rather than node:fs: this is a browser package, and Vite's raw import keeps Node's
  // types out of it while giving the test the file's text.
  const source = workspaceSource;
  // Only runCommand's own cases count — `isChecked` switches on command ids too, and a
  // command that merely shows a tick has not been implemented.
  const start = source.indexOf('function runCommand(');
  const end = source.indexOf('\n  }\n', start);
  const body = source.slice(start, end);
  const handled = new Set([...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]!));
  const menuCommands = COMMANDS.filter(
    (c) => !PANEL_BY_COMMAND[c.cmd] && !c.cmd.startsWith('workspace.') && !FILTER_BY_ID.has(c.cmd),
  );

  it('every filter menu item is enabled exactly when the registry implements it', () => {
    const filterItems = COMMANDS.filter((c) => /^(blur|distort|noise|pixelate|render|sharpen|stylize|video|other)\./.test(c.cmd));
    const wrong = filterItems.filter((c) => !!c.done !== FILTER_BY_ID.has(c.cmd)).map((c) => c.cmd);
    expect(wrong).toEqual([]);
    // And every registered filter has a menu item — a filter nobody can reach is dead code.
    const reachable = new Set(filterItems.map((c) => c.cmd));
    expect([...FILTER_BY_ID.keys()].filter((id) => !reachable.has(id))).toEqual([]);
  });

  it('every enabled menu item has a handler', () => {
    const dead = menuCommands.filter((c) => c.done && !handled.has(c.cmd)).map((c) => c.cmd);
    expect(dead).toEqual([]);
  });

  it('every handled menu item is enabled', () => {
    const hidden = menuCommands.filter((c) => !c.done && handled.has(c.cmd)).map((c) => c.cmd);
    expect(hidden).toEqual([]);
  });
});
