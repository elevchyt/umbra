/**
 * History — docs/spec/03-architecture.md §6, modelled on Photoshop's History panel.
 *
 * A state is just a pointer to an immutable `Doc`. Because the document tree shares structure
 * and tiles, keeping 50 states costs the tiles that actually changed, not 50 documents.
 *
 * Linear by default: stepping back and then editing discards the redo tail, exactly as
 * Photoshop does unless "Allow Non-Linear History" is on.
 */
import type { Doc } from './document.js';

export interface HistoryState {
  readonly name: string;
  readonly doc: Doc;
  readonly time: number;
  /** Snapshots are pinned and never pushed out by the state limit. */
  readonly snapshot: boolean;
}

export interface HistoryOptions {
  /** Photoshop's default is 50; the preference range is 1–1000. */
  limit: number;
  nonLinear: boolean;
}

export class History {
  private states: HistoryState[] = [];
  private cursor = -1;
  private options: HistoryOptions = { limit: 50, nonLinear: false };

  constructor(initial: Doc, name = 'Open') {
    this.states = [{ name, doc: initial, time: Date.now(), snapshot: true }];
    this.cursor = 0;
  }

  configure(patch: Partial<HistoryOptions>): void {
    this.options = { ...this.options, ...patch };
    this.trim();
  }

  get current(): Doc {
    return this.states[this.cursor]!.doc;
  }

  get index(): number {
    return this.cursor;
  }

  list(): readonly HistoryState[] {
    return this.states;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.states.length - 1;
  }

  /** Name of the step that Undo would reverse, for the Edit menu label. */
  get undoName(): string | null {
    return this.canUndo ? this.states[this.cursor]!.name : null;
  }

  get redoName(): string | null {
    return this.canRedo ? this.states[this.cursor + 1]!.name : null;
  }

  push(name: string, doc: Doc, snapshot = false): void {
    if (!this.options.nonLinear) {
      // Editing after an undo throws away the redo tail.
      this.states.length = this.cursor + 1;
    }
    this.states.push({ name, doc, time: Date.now(), snapshot });
    this.cursor = this.states.length - 1;
    this.trim();
  }

  /**
   * Replace the top state instead of adding one. Used to coalesce a slider drag or a burst of
   * arrow-key nudges into a single history entry.
   */
  amend(name: string, doc: Doc): void {
    if (this.cursor < 0) return this.push(name, doc);
    const top = this.states[this.cursor]!;
    if (top.snapshot) return this.push(name, doc);
    this.states[this.cursor] = { ...top, name, doc, time: Date.now() };
  }

  undo(): Doc | null {
    if (!this.canUndo) return null;
    this.cursor--;
    return this.current;
  }

  redo(): Doc | null {
    if (!this.canRedo) return null;
    this.cursor++;
    return this.current;
  }

  /** Jump to any state, as clicking a row in the History panel does. */
  goto(index: number): Doc | null {
    if (index < 0 || index >= this.states.length) return null;
    this.cursor = index;
    return this.current;
  }

  /** Photoshop's Ctrl+Alt+Z: flip between the current state and the one before it. */
  toggleLast(): Doc | null {
    if (this.canUndo) return this.undo();
    return this.redo();
  }

  snapshot(name: string): void {
    const doc = this.current;
    this.states.push({ name, doc, time: Date.now(), snapshot: true });
    this.cursor = this.states.length - 1;
  }

  private trim(): void {
    // Snapshots are pinned; only ordinary states count against the limit.
    let ordinary = this.states.filter((s) => !s.snapshot).length;
    while (ordinary > this.options.limit) {
      const i = this.states.findIndex((s) => !s.snapshot);
      if (i < 0) break;
      this.states.splice(i, 1);
      if (this.cursor >= i) this.cursor--;
      ordinary--;
    }
  }
}
