/**
 * Keymap engine — spec 01 §6.
 *
 * The keymap is DATA, not a switch statement, because Edit ▸ Keyboard Shortcuts has to be
 * able to rewrite it and Actions has to be able to record what a chord dispatched.
 *
 * Two behaviours matter for the feel and are easy to get wrong:
 *  - **Spring-loaded tools**: holding a tool letter switches to it and RELEASING switches
 *    back, but only if the key was held rather than tapped.
 *  - **Text fields win**: while a text input has focus, single-letter shortcuts must not fire,
 *    or typing "vector" in a layer name would change tools six times.
 */

export interface Chord {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface Binding {
  chord: Chord;
  /** Command id, or a tool id when `kind` is 'tool'. */
  target: string;
  kind: 'command' | 'tool' | 'action';
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  return: 'enter',
  space: ' ',
  plus: '+',
  minus: '-',
  '=': '+',
};

/** Parse "Ctrl+Shift+N" into a chord. */
export function parseChord(text: string): Chord {
  const parts = text.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  // A trailing "+" (as in "Ctrl++") leaves an empty tail; restore it.
  const chord: Chord = { key: '', ctrl: false, alt: false, shift: false, meta: false };
  if (text.trim().endsWith('++')) chord.key = '+';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') chord.ctrl = true;
    else if (p === 'alt' || p === 'option') chord.alt = true;
    else if (p === 'shift') chord.shift = true;
    else if (p === 'cmd' || p === 'meta' || p === 'command') chord.meta = true;
    else chord.key = KEY_ALIASES[p] ?? p;
  }
  return chord;
}

export function chordFromEvent(e: KeyboardEvent): Chord {
  let key = e.key.toLowerCase();
  if (key === 'escape') key = 'escape';
  if (key === '=') key = '+';
  return { key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

export function chordKey(c: Chord): string {
  return `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}${c.meta ? 'M' : ''}|${c.key}`;
}

export function chordLabel(c: Chord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Cmd');
  // F-keys and named keys read as "F6"/"Escape", not "f6"/"escape".
  const key =
    c.key === ' ' ? 'Space'
    : c.key.length === 1 ? c.key.toUpperCase()
    : /^f\d{1,2}$/.test(c.key) ? c.key.toUpperCase()
    : c.key.charAt(0).toUpperCase() + c.key.slice(1);
  parts.push(key);
  return parts.join('+');
}

export class Keymap {
  private readonly byChord = new Map<string, Binding>();

  add(shortcut: string, target: string, kind: Binding['kind'] = 'command'): void {
    const chord = parseChord(shortcut);
    if (!chord.key) return;
    this.byChord.set(chordKey(chord), { chord, target, kind });
  }

  lookup(e: KeyboardEvent): Binding | undefined {
    return this.byChord.get(chordKey(chordFromEvent(e)));
  }

  /** Every binding, for the shortcut reference dialog. */
  all(): Binding[] {
    return [...this.byChord.values()];
  }

  conflicts(): Binding[][] {
    // The map is keyed by chord, so a conflict can only appear while editing; kept for the
    // Keyboard Shortcuts dialog in M11.
    return [];
  }
}

/** Shortcuts that are not menu items — the ones that define the tool feel. */
export const EXTRA_BINDINGS: { shortcut: string; cmd: string }[] = [
  { shortcut: 'd', cmd: 'color.defaults' },
  { shortcut: 'x', cmd: 'color.swap' },
  { shortcut: 'q', cmd: 'select.quickMask' },
  { shortcut: 'f', cmd: 'view.cycleScreenMode' },
  { shortcut: 'Shift+f', cmd: 'view.cycleScreenModeBack' },
  { shortcut: 'tab', cmd: 'view.togglePanels' },
  { shortcut: 'Shift+tab', cmd: 'view.toggleSidePanels' },
  { shortcut: '[', cmd: 'brush.sizeDown' },
  { shortcut: ']', cmd: 'brush.sizeUp' },
  { shortcut: 'Shift+[', cmd: 'brush.hardnessDown' },
  { shortcut: 'Shift+]', cmd: 'brush.hardnessUp' },
  { shortcut: 'Shift+F1', cmd: 'view.themeDarker' },
  { shortcut: 'Shift+F2', cmd: 'view.themeLighter' },
  { shortcut: 'Ctrl+Alt+0', cmd: 'view.actual' },
];

/** True when the event target is a text-entry surface and must keep the keystroke. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}
