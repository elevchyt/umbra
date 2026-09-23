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

First audited 2026-09-21; §1 cleared and recounted 2026-09-23; recounted again when M4
finished the same day. Of 505 menu commands, **146 are wired**, 34 are panel toggles
generated from the panel registry, and **325 are not built** — greyed out, correctly. Regenerate
with the script at the bottom; `shell.test.ts` fails if a menu item's `done:` flag and its
handler ever disagree.

---

## 1. Broken — looks live, does nothing

**All cleared 2026-09-23.** Kept for the record, with what each turned out to be.

- [x] **Layers panel footer buttons were all hardcoded `disabled`.** New layer, delete, new
      group and add mask now work (Alt-click Add Mask hides instead of reveals). Link, layer
      style and fill/adjustment layer are not built yet, so they stay disabled — but now look
      disabled and say why in their tooltip.
- [x] **Layers panel lock buttons were hardcoded `disabled`.** All four toggle, and show their
      state.
- [x] **Delete / Backspace did nothing.** They clear the selection now. With no selection they
      deliberately do nothing — clearing a whole layer by accident is not a keystroke's job.
- [x] **Navigator was a dead box.** It renders a scaled thumbnail (through the mip pyramid, so
      it costs about one viewport frame), outlines the visible area in red — as a rotated quad,
      so it stays right when the canvas is rotated — and click/drag pans. Zoom field and slider
      work.
- [x] **"Filter by layer kind" and the Move tool's Align buttons** are still not built (M11,
      M9), but disabled controls now visibly look disabled.
- [x] **Menu enablement.** ⚠ *The original entry here was wrong.* It said 387 menu items were
      "silently inert rather than disabled". In fact leaf items without `done:` were already
      greyed and unclickable — I had counted handlers, not clickability. The real problems were
      narrower: **submenu parents were always enabled** even when every child was dead (why
      Image ▸ Adjustments looked live), **keyboard shortcuts bypassed the check** and silently
      ran dead commands, and the **hand-maintained `done:` flags had drifted** in both
      directions. All three are fixed, and a test now enforces flag ⇔ handler.
- [x] **`layer.rename`** — the one item enabled with no handler. Also Window ▸ Options and
      Window ▸ Tools, which the new test found were enabled and dead.
- [x] **Double-click a layer name to rename it** in place; Enter or clicking away commits,
      Escape abandons.

### Found while clearing §1

These were not on the list. Most were found by verifying the fixes in the browser rather than
by tests — which is itself the recurring lesson of this project.

- [x] **Cropped PSD masks hid everything outside their rectangle.** Photoshop stores a mask
      cropped to its painted area with a white default ("reveal the rest"); the GPU drew only
      stored tiles, so the mask target stayed at 0 outside them. The CPU reference was right
      (`tileAt()` returns the default tile), which is why parity never caught it.
- [ ] **Follow-up: add a parity case for a cropped, white-default mask.** The fix above is
      verified by reasoning and the mask tests, not by the GPU≡CPU suite, which has no such case.
- [x] **Edit ▸ Transform ▸ Rotate 90° CW rotated the whole canvas.** That is Image ▸ Image
      Rotation's job; Edit ▸ Transform acts on the layer.
- [x] **Transform ▸ Again opened a fresh Free Transform** instead of repeating the last one.
- [x] **New layers were named "Layer"**, not "Layer 7". Photoshop numbers one past the highest in
      use and does not refill gaps; that is what happens now.
- [x] **Grouping twice could select the older group** — the new group was found afterwards by
      `name.startsWith('Group')`, which matched the first group in tree order.
- [x] **Startup could fit to a 0×0 viewport** and leave the document as a dot at 0.1%. The
      client sends `init` with the canvas size before layout can guarantee one. A fit against
      an unusable viewport is now completed by the first real resize. *Only ever observed in the
      automation browser, whose hidden pane delays layout — not confirmed in Electron.*
- [x] **Crash recovery could destroy work.** The prompt appeared *after* the default document,
      seconds into a session, and said recovering would leave the current document untouched.
      It replaced it — there is only one document. It is now asked before any document exists.
- [x] **A recovered journal was never cleared**, so the same autosave was offered on every
      launch.
- [x] **The journal snapshotted untouched documents** — about 1.9 s of worker time per snapshot
      for a 2400×1600 six-layer document, spent on something with nothing to recover. It now
      waits for the first edit.
- [x] **Stored mask tiles never reached the GPU (found in M4, broken since M3).** The atlas
      uploaded every tile as RGBA8; a mask tile is one byte per pixel, so WebGL rejected the
      upload and the slot drew whatever it held before. Every mask with stored pixels —
      Reveal/Hide Selection, From Transparency, PSD masks — rendered wrong; only masks with
      nothing stored looked right. The console had been printing
      `texSubImage3D: ArrayBufferView not big enough` the whole time.
- [x] **Mip levels lost a plane's default (found in M4).** Every downsampled level defaulted
      to 0, so a white-default mask read as black below level 1: zoomed out, everything near
      a painted mask tile was hidden.
- [x] **Parity follow-up done:** document-parity cases now render real documents (tile store,
      atlas, stored-tile masks, adjustment and fill layers) against the CPU reference, and
      any WebGL error raised during the run fails it. The two bugs above fail those cases.
- [ ] **Parity does not cover mip levels.** It renders at 1:1; the mip default is covered by a
      unit test instead.
- [ ] **A journal write failed with a `DOMException` once, cause not established.** It was logged
      as `[object DOMException]`; it now logs the name and message. Leading suspect: two windows
      writing the one journal — there is one per origin, not per window. Needs a real repro.

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
- [x] **Hue/Saturation colour ranges** — the six ranges with Photoshop's draggable range bar,
      read from and written to PSD. (Its saturation model changed on the way: see the roadmap.)
- [x] **Mask targeting.** Click a mask thumbnail to paint into the mask (it is framed);
      adjustment and fill layers always target theirs. Brush, pencil, eraser, Edit ▸ Fill,
      Delete and the Gradient tool write grey into it, with a live preview.
- [ ] **Paint Bucket on a mask, and Alt-click to view a mask on its own**, are not built.
- [x] **Presets and Last Used** in every adjustment dialog and Properties (built-ins for
      Curves, Levels, Exposure, Black & White, Hue/Saturation, Channel Mixer).
- [x] **Levels/Curves eyedroppers, Auto and Auto Color Correction Options; Curves pencil mode
      and on-image tool** (and on-image for Hue/Saturation and Black & White).
- [ ] **Auto Options has no target colours** (the shadow/midtone/highlight swatches), and
      Ctrl+Alt+L-style "open with last settings" shortcuts are not bound — use Last Used.
- [ ] **A pencil-drawn Curves channel saves to PSD as 16 points** (a PSD's curves are points;
      ag-psd does not read or write the map form).
- [ ] **Gradient Map offers six preset gradients**, not the gradient editor — the same gap as
      the Gradient tool's (above). No Dither or Method either.
- [ ] **Color Lookup: 3DLUT files only** — Abstract and Device Link profiles are ICC, which is
      not modelled; Dither is ignored.
- [ ] **Pattern fill scale is not saved to PSD** — ag-psd does not model it; it reopens at 100%.
- [ ] **Apply Image always preserves transparency** and has no Mask option; Calculations cannot
      output a new document, and Match Color cannot use another document — both need
      multi-document support (M11), as does Image ▸ Duplicate.
- [ ] **Applying a non-table adjustment to a big layer blocks the worker** for about 200 ms on
      a 2400×1600 layer (Hue/Saturation, Vibrance, Color Balance, …; the table-shaped ones are
      ~20 ms). The dialog's preview is a GPU pass and does not pay this; only OK does. The
      spatial ones (Shadows/Highlights, HDR Toning, …) preview on the CPU at a few hundred ms.
- [ ] **Auto Color's "Snap Neutral Midtones" is a stand-in** (per-channel gamma toward the mean
      colour); Photoshop searches for near-neutral pixels. Tagged `[fit]` in `kernels/auto.ts`.
      Shadows/Highlights, Replace Color, Match Color and HDR Toning are `[fit]` models too.
- [ ] **Step adjustments after a partial blend can differ GPU vs CPU by a step.** Accumulators
      are float16 on the GPU and float64 in the reference; a value within rounding distance of
      a byte boundary quantises differently, and a Posterize/Threshold step magnifies it. Only
      at such boundary pixels; it would show in export (CPU) vs screen (GPU).
- [ ] **Newer adjustment layers** (Color & Vibrance-style, Clarity & Dehaze, Grain) are left
      for M5 — spec 05 says they reuse the Develop filter kernels, which arrive there.
- [ ] **PSD unknown-block pass-through is not implemented.** ag-psd discards blocks it does not
      model, so saving a PSD opened from Photoshop loses anything Umbra does not understand.

## 3. Menus — coverage

Counts are `wired / total`. "Wired" means the command reaches the engine; it does not promise
the feature is complete.

| Menu | Wired | Chiefly waiting on |
|---|---|---|
| File | 8 / 50 | export & automation (M11), place/linked (M5) |
| Edit | 26 / 69 | warps (M9), presets & colour settings (M10–M11), preferences (M11) |
| Image | 37 / 56 | colour modes (M10), Duplicate and Arbitrary rotation (M11), variables (M11) |
| Layer | 41 / 137 | layer styles (M6), smart objects (M5), align & distribute (M9), type & shapes (M7) |
| Type | 5 / 39 | all of type (M7) — the 5 are its panel toggles |
| Select | 15 / 24 | Color Range, Focus Area, Subject, Sky, Select and Mask (M9) |
| Filter | 60 / 74 | Convert for Smart Filters (M5), Blur Gallery, Liquify, Lens Correction, Develop (later), Flame/Picture Frame/Tree |
| View | 12 / 61 | guides, grid, snapping, proof colours (M10–M11) |
| Window | 32 / 56 | multi-document window arrangement (M11) |
| Help | 4 / 5 | — |

"Wired" counts a `runCommand` case or a generated panel toggle. An earlier version of this table
counted every `case` in `Workspace.tsx`, which included `isChecked`'s — a tick mark is not an
implementation.

### Specifically, in the menus you are most likely to reach for

- [x] **Filter ▸ Blur, Distort, Noise, Pixelate, Render (Clouds, Difference Clouds, Fibers,
      Lens Flare), Sharpen, Stylize, Video and Other — 58 filters**, from one registry
      (`kernels/src/filters/`), with Photoshop's preview box, on-canvas Preview, Last Filter
      (Ctrl+Alt+F) and Edit ▸ Fade. Every one runs on the CPU; the proprietary ones
      are `[fit]` models documented in each filter's `model`. Distort's centred filters act on
      the selection's bounds; Displace and Lens Blur take their map from a layer of the same
      document (a separate file waits on M11). Clouds' Alt-click for high contrast
      is not wired: Clouds runs at once with a fresh seed.
- [x] **Filter ▸ Filter Gallery — all 47 effects** in six folders with thumbnails, a stack of
      effect layers (eye, new, delete, reorder), the shared preview box, and on-canvas
      preview. Every effect is `[fit]` — Photoshop publishes none of them — built from a
      shared toolkit (`kernels/src/filters/gallery/kit.ts`) and judged by eye on a contact
      sheet; spec 05's bar is "recognisably the same effect". Neon Glow's colour swatch is a
      list of presets. Unlike Photoshop the gallery is not limited to 8-bit documents (Umbra
      has only 8-bit so far).

- [x] **Image ▸ Adjustments — all 22.** The per-pixel ones preview on the GPU (the adjustment
      drawn as a clipped layer); Shadows/Highlights, Replace Color, Match Color and HDR Toning
      preview on the CPU. Every dialog has Preview, Alt = Reset, Preset and Last Used.
- [x] **Layer ▸ New Adjustment Layer — all 16**, the Adjustments panel, editing in Properties,
      PSD round trip, and fusion of plain table adjustments into one GPU pass.
- [x] **Layer ▸ New Fill Layer ▸ Solid Color / Gradient / Pattern**, with PSD round trip
      (patterns embedded), Edit ▸ Define Pattern and a Patterns panel.
- [x] **Image ▸ Apply Image and Calculations.**
- [x] **Layer ▸ Create Clipping Mask** (Ctrl+Alt+G, toggles to Release).
- [ ] **Image ▸ Mode** — 2 of 12. Only RGB and 8 bits/channel, which are the current state, so
      nothing changes. Grayscale, CMYK, Lab, 16/32-bit are M10.
- [x] **Image ▸ Auto Tone / Auto Contrast / Auto Color** — Levels computed from the layer's
      histogram with Photoshop's default 0.1% clip; Auto Color's midtone snap is `[fit]`.
- [ ] **Image ▸ Duplicate** — needs more than one open document (M11).
- [x] **Layer ▸ New ▸ Layer Via Copy / Via Cut** (Ctrl+J / Ctrl+Shift+J). They do not touch
      the clipboard, as Photoshop's do not.
- [x] **Layer ▸ Layer Mask ▸ …** — 7 of 9: Reveal All, Hide All, Reveal Selection, Hide
      Selection, From Transparency, Delete, Apply, and Enable/Disable (also Shift-click on the
      mask thumbnail, which shows Photoshop's red cross when disabled).
- [ ] **Layer ▸ Layer Mask ▸ Link** — `linked` exists on the mask, but transforms always move
      mask and layer together, so the toggle would currently be a lie.
- [x] **Select ▸ Reselect** (Ctrl+Shift+D) — restores what the last Deselect dropped, and refuses
      after a crop or resize, when it would describe pixels that are no longer there.
- [x] **Edit ▸ Transform ▸ Rotate 180 / 90 CW / 90 CCW / Flip H / Flip V** — on the layer, about
      its own centre. Lossless: nearest-neighbour about a half-pixel-rounded pivot, and a test
      proves four quarter turns and two flips return the exact original pixels.
- [x] **Edit ▸ Transform ▸ Again** (Ctrl+Shift+T) — repeats the last Free Transform, pivot
      included, so rotate-then-Again continues round the same point.
- [ ] **Edit ▸ Preferences ▸ …** — 2 of 13.
- [ ] **View ▸ Show ▸ …** and **View ▸ Snap To ▸ …** — the store has `extras` flags for rulers,
      grid, guides, pixel grid, selection edges and layer edges; only selection edges is
      honoured by the renderer.

## 4. Tools — 19 of 69 implemented

Working: Move, Rectangular/Elliptical/Single Row/Single Column Marquee, Lasso, Polygonal Lasso,
Magic Wand, Crop, Eyedropper, Color Sampler, Brush, Pencil, Eraser, Gradient, Paint Bucket,
Hand, Rotate View, Zoom.

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
- [ ] Artboard, Frame, Ruler, Note, Count (M11)

## 5. Panels

Working: Layers, Color, Swatches, Info, Properties, History, Channels, Navigator, Adjustments,
Histogram, Patterns.

- [x] **Adjustments** — one button per adjustment-layer kind (Color Lookup missing)
- [x] **Properties** — edits the active adjustment layer; one history step per gesture
- [x] **Histogram** — Colors / Luminosity / R / G / B / All Channels View, with mean, std dev,
      median, pixel count. Whole image only (no per-layer source); it is computed exactly, so
      there is no cache warning to show.
- [x] **Info** — RGB and CMYK under the pointer, position, up to ten colour samplers, and
      before/after pairs while a dialog previews. The panel options (choosing the second
      readout's colour model) are not built.
- [x] **Properties** — adjustment layers and fill layers.
- [x] **Patterns** — the pattern library; clicking one applies it to an active pattern fill.
- [ ] **Brushes** — placeholder; was scoped to M3 and did not land
- [ ] **Brush Settings** — placeholder (M8)
- [ ] **Paths** — placeholder (M7)
- [x] **Navigator** — thumbnail, view rectangle, click/drag to pan, zoom field and slider

---

## Verifying in the automation browser

The built-in browser pane is usually **hidden**, and a hidden pane throttles
`requestAnimationFrame` hard — measured at 5 callbacks in 2 s, sometimes none. Umbra renders on
rAF ticks, so in that pane the canvas can sit unrendered for a minute and `__umbraStats` stays
frozen at whatever it last said. That produced at least four false alarms in this project
("blank canvas", "stuck at 0 tiles", "60 fps" that was a stale reading).

What stays trustworthy there is anything driven by **worker messages**, which are not
frame-bound: the Layers panel, dialogs, document summaries, thumbnails. Verify through the DOM,
and treat any canvas screenshot or timing taken in a hidden pane as unconfirmed.

Two tools for that, in dev builds:

- `window.__umbraDoc` is the latest document summary (layers, adjustment parameters, history
  names) exactly as the panels receive it. `__umbraSend(msg)` sends any engine message;
  `__umbraProbe` and `__umbraThumb` are the latest Info readouts and rendered thumbnail.
- The engine accepts `{ t: 'tick' }` as a message, so a script can drive frames itself: with
  `pointerrawupdate` events (not `pointermove`, which Chromium's client ignores for strokes)
  and ticks sent in between, a brush stroke runs even while the pane is stalled.
- The Navigator coalesces its thumbnail requests on animation frames, so in a stalled pane its
  canvas can be several edits behind — ask with `requestThumbnail` and read `__umbraThumb`.
- The **Navigator's canvas** is a real 2-D canvas filled from a worker message, so its pixels
  can be read with `getImageData` and diffed — that is how M4's "the dialog's preview matches
  what OK commits" was checked (max Δ 3 through the mip-scaled thumbnail, mean 0.08).

And one trap: synthetic `PointerEvent`s have no live pointer, so `setPointerCapture` throws on
them. Drag handlers here use window listeners instead, which also makes them scriptable.

## Keeping this file honest

The `done:` flags in `packages/app/src/menus/menus.ts` are hand-maintained and were wrong once
already. Trust this instead, and regenerate it:

```bash
cd packages/app && node --input-type=module -e "
import { readFileSync } from 'node:fs';
const menus = readFileSync('src/menus/menus.ts', 'utf8');
const ws = readFileSync('src/workspace/Workspace.tsx', 'utf8');
const body = ws.slice(ws.indexOf('function runCommand('), ws.indexOf('\\n  }\\n', ws.indexOf('function runCommand(')));
const handled = new Set([...body.matchAll(/case '([^']+)':/g)].map(m => m[1]));
const rows = [...menus.matchAll(/\{\s*label:\s*'([^']*)'\s*,\s*cmd:\s*'([^']*)'/g)];
const missing = rows.filter(r => !handled.has(r[2]) && !r[2].startsWith('panel.'));
console.log(\`\${rows.length - missing.length} of \${rows.length} wired\`);
for (const m of missing) console.log('  ', m[2].padEnd(34), m[1]);
"
```

A command counts as wired when `runCommand` has a `case` for it. That is necessary, not
sufficient — it says the click reaches the engine, not that the result is right. The only way
to know the second thing is to click it, which is how §1 and §2 were found.
