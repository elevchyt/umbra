# What doesn't work yet

A running checklist of everything in Umbra that is visible in the UI but does not do what it
looks like it does. Tick things off as they land.

**Two kinds of entry, and the difference matters:**

- **§1 Broken** — it *looks* implemented and isn't. The engine can already do it, or the
  control is rendered as if it were live. These are bugs, they are cheap, and they are what
  makes the app feel unfinished. **Fix these first.**
- **§3–5 Not built yet** — genuinely scheduled for a later milestone. These are not bugs; the
  menu item exists because M1's exit criterion was that a Photoshop user finds everything
  where they expect it. They should be *disabled* rather than silently inert, which is itself
  an entry in §1.

Audited 2026-09-21 against `main` at M4(1/n), by cross-referencing all 505 menu commands
against their handlers and then clicking through the results. 84 commands are wired directly,
34 are panel toggles generated from the panel registry, and 387 do nothing. Regenerate with
the script at the bottom.

---

## 1. Broken — looks live, does nothing

- [ ] **Layers panel footer buttons are all hardcoded `disabled`** — link, layer style, add
      mask, new fill/adjustment layer, new group, new layer, delete layer. The engine
      implements `layerCommand` add/delete/duplicate/group/ungroup/merge/flatten already and
      the Layer menu uses it; only the buttons were never wired.
      `packages/app/src/panels/panels.tsx` ~line 212. **This is the "delete button".**
- [ ] **Layers panel lock buttons are hardcoded `disabled`** — transparency, pixels, position,
      all. `LayerLocks` exists on every layer and is honoured by fill, stroke, transform and
      the brush; nothing can set it. Same file, ~line 119.
- [ ] **Delete / Backspace do nothing.** No key binding at all. In Photoshop they clear the
      selection (Backspace fills with the background colour). `edit.clear` is implemented and
      works from the menu — it just has no key.
- [ ] **Navigator panel is a dead box.** The thumbnail never renders the document, and the
      zoom field and slider are `onChange={() => {}}`. Reading the zoom works; setting it
      does not.
- [ ] **Layers panel "Filter by layer kind" buttons** are inert (they are labelled M11, but
      they look like live toggles).
- [ ] **Move tool's Align buttons** in the options bar are disabled placeholders.
- [ ] **Every unimplemented menu item is silently inert rather than disabled.** Of 505 menu
      commands, 84 have a handler and 34 more are panel toggles generated from the panel
      registry — leaving **387 that do nothing at all when clicked**, with no feedback. They
      should be greyed out, the way Photoshop greys what does not apply. This one entry is
      most of why the app feels broken rather than unfinished, and it is a single change:
      disable any item whose command has no handler.
- [ ] **`layer.rename` is marked `done: true` in the menu data but has no handler** — the only
      place the `done:` flags and reality disagree.
- [ ] **Double-clicking a layer name does not rename it.** No inline edit anywhere.

## 2. Rough edges in things that DO work

- [ ] **Image Rotation does not re-fit the view.** Rotating 90° leaves the document hanging
      off the canvas; Image Size and Crop both re-fit, so this is just inconsistent.
- [ ] **Free Transform with a selection transforms the whole layer**, not the selected pixels.
      Needs the selection lifted into a floating layer first (M9).
- [ ] **Magic Wand / Paint Bucket "Sample Size" is not averaged** — the menu was removed
      rather than left dead, so the seed is always a single pixel.
- [ ] **Crash journal writes a full PSD every 30 s.** On a large document that is seconds of
      worker time. It is skipped during strokes and drags, but an incremental journal is the
      real answer.
- [ ] **Gradient presets are the three built-ins.** No stop editor; the preset dropdown cannot
      be extended.
- [ ] **Hue/Saturation has master sliders only** — the six per-colour ranges (Reds…Magentas)
      with their draggable band edges are not there.
- [ ] **PSD unknown-block pass-through is not implemented.** ag-psd discards blocks it does not
      model, so saving a PSD opened from Photoshop loses anything Umbra does not understand.

## 3. Menus — coverage

Counts are `wired / total`. "Wired" means the command reaches the engine; it does not promise
the feature is complete.

| Menu | Wired | Chiefly waiting on |
|---|---|---|
| File | 8 / 50 | export & automation (M11), place/linked (M5) |
| Edit | 21 / 69 | warps (M9), presets & colour settings (M10–M11), preferences (M11) |
| Image | 12 / 56 | **all 22 adjustments (M4, in progress)**, colour modes (M10) |
| Layer | 10 / 137 | layer styles (M6), smart objects (M5), adjustment/fill layers (M4), masks (M4), align & distribute (M9) |
| Type | 0 / 39 | all of type (M7) |
| Select | 14 / 24 | Color Range, Focus Area, Subject, Sky, Select and Mask (M9) |
| Filter | 0 / 8 | all filters (M5) |
| View | 12 / 61 | guides, grid, snapping, proof colours (M10–M11) |
| Window | 3 / 56 | multi-document window arrangement (M11) |
| Help | 4 / 5 | — |

### Specifically, in the menus you are most likely to reach for

- [ ] **Image ▸ Adjustments — the whole 22-item submenu is dead.** M4 is in progress; the
      kernel exists and is tested, nothing is wired to the UI yet. *This is almost certainly
      what "all image options don't work" meant.*
- [ ] **Image ▸ Mode** — 2 of 12. Only RGB and 8 bits/channel, which are the current state, so
      nothing changes. Grayscale, CMYK, Lab, 16/32-bit are M10.
- [ ] **Image ▸ Auto Tone / Auto Contrast / Auto Color** — greyed, correctly; M4.
- [ ] **Image ▸ Duplicate, Apply Image, Calculations** — M4.
- [ ] **Layer ▸ New ▸ Layer Via Copy / Via Cut** — the clipboard exists; these two are a
      trivial composition of it and are worth doing early.
- [ ] **Layer ▸ Layer Mask ▸ …** — 0 of 9. Masks render and transform correctly; nothing can
      create one from the UI. Reveal All / Hide All / Reveal Selection / Hide Selection are
      each a few lines against machinery that already exists.
- [ ] **Select ▸ Reselect** — history keeps the previous selection; nothing restores it.
- [ ] **Edit ▸ Transform ▸ Rotate 180 / 90 CCW / Flip H / Flip V** — the matrix kernel does all
      four; only "Rotate 90° CW" is wired.
- [ ] **Edit ▸ Preferences ▸ …** — 2 of 13.
- [ ] **View ▸ Show ▸ …** and **View ▸ Snap To ▸ …** — the store has `extras` flags for rulers,
      grid, guides, pixel grid, selection edges and layer edges; only selection edges is
      honoured by the renderer.

## 4. Tools — 18 of 69 implemented

Working: Move, Rectangular/Elliptical/Single Row/Single Column Marquee, Lasso, Polygonal Lasso,
Magic Wand, Crop, Eyedropper, Brush, Pencil, Eraser, Gradient, Paint Bucket, Hand, Rotate View,
Zoom.

- [ ] Healing family — Spot Healing, Healing Brush, Patch, Content-Aware Move, Red Eye, Remove (M8)
- [ ] Clone Stamp, Pattern Stamp (M8)
- [ ] History Brush, Art History Brush (M8)
- [ ] Blur, Sharpen, Smudge, Dodge, Burn, Sponge (M8)
- [ ] Background Eraser, Magic Eraser (M8)
- [ ] Color Replacement, Mixer Brush (M8)
- [ ] Pen family and Path/Direct Selection (M7)
- [ ] Type family — 4 tools (M7)
- [ ] Shape family — 6 tools (M7)
- [ ] Object Selection, Quick Selection, Magnetic Lasso, Selection Brush (M9)
- [ ] Perspective Crop, Slice, Slice Select (M11)
- [ ] Artboard, Frame, Color Sampler, Ruler, Note, Count (M11)

## 5. Panels

Working: Layers, Color, Swatches, Info, Properties, History, Channels.

- [ ] **Adjustments** — placeholder (M4)
- [ ] **Histogram** — placeholder (M4)
- [ ] **Brushes** — placeholder; was scoped to M3 and did not land
- [ ] **Brush Settings** — placeholder (M8)
- [ ] **Paths** — placeholder (M7)
- [ ] **Navigator** — renders, but see §1: it is not interactive

---

## Keeping this file honest

The `done:` flags in `packages/app/src/menus/menus.ts` are hand-maintained and were wrong once
already. Trust this instead, and regenerate it:

```bash
cd packages/app && node --input-type=module -e "
import { readFileSync } from 'node:fs';
const menus = readFileSync('src/menus/menus.ts', 'utf8');
const ws = readFileSync('src/workspace/Workspace.tsx', 'utf8');
const handled = new Set([...ws.matchAll(/case '([^']+)':/g)].map(m => m[1]));
const rows = [...menus.matchAll(/\{\s*label:\s*'([^']*)'\s*,\s*cmd:\s*'([^']*)'/g)];
const missing = rows.filter(r => !handled.has(r[2]) && !r[2].startsWith('panel.'));
console.log(\`\${rows.length - missing.length} of \${rows.length} wired\`);
for (const m of missing) console.log('  ', m[2].padEnd(34), m[1]);
"
```

A command counts as wired when `runCommand` has a `case` for it. That is necessary, not
sufficient — it says the click reaches the engine, not that the result is right. The only way
to know the second thing is to click it, which is how §1 and §2 were found.
