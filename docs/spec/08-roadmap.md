# 08 — Roadmap, acceptance, testing, risks

Order is chosen so that (a) the architecture is proven under load before features pile on,
(b) there is a usable editor early (end of M3), (c) PSD fidelity is tested continuously from
M2, (d) every later milestone is mostly *additive registry entries* (tools, filters,
adjustments, panels) on a stable core.

Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3–5 weeks, XL ≈ 6+ weeks of focused work.

## Milestones

### M0 — Foundations & de-risking spikes (M) — ✅ **COMPLETE** (2026-09-20)
Repo/monorepo, CI with size budgets, Electron shell (`app://`, COOP/COEP, sandbox), engine
worker + OffscreenCanvas, `gpu/` abstraction, tile store (COW, refcount), open PNG/JPEG → one
layer → pan/zoom/rotate view with mip pyramid, perf harness.
**Spikes that must pass:** input ring-buffer → dab latency ≤ 16 ms; `EXT_texture_norm16`
path + fallback; 100 synthetic layers @ 4K at 60 fps pan; ag-psd streaming into tiles for a
500 MB PSD without a > 1 GB heap spike; context-loss recovery from CPU tiles.
**Exit:** budgets table in [03 §9](03-architecture.md#9-budgets) measured and green for what exists.

**Outcome — all 5 spikes pass** (`pnpm spikes`; 33 unit tests via `pnpm test`). Numbers in
[03 §9.1](03-architecture.md#91-measured-at-m0-nvidia-gtx-1650-angleopengl-1600900-viewport).
Four findings changed the design:
1. **Paged atlas required.** One tile per array layer hit `MAX_ARRAY_TEXTURE_LAYERS` (2048) at
   ~2400 needed tiles and collapsed to 3 fps. Tiles are now packed 8×8 into 2048² pages.
2. **`EXT_texture_norm16` is not colour-renderable** on the reference GPU — RGBA16 stores and
   samples, RGBA16F accumulates.
3. **`gl.finish()` does not synchronise** a worker/OffscreenCanvas context; all timings use a
   `readPixels` barrier plus a load-scaling sanity check.
4. **Stroke termination must travel in the input ring, not as a message.** A `strokeEnd`
   message races the ring (messages are immediate, samples drain on the next tick) and silently
   truncated strokes whenever frames were slow. `FLAG_UP` is now the sole terminator.

Also built beyond the stated scope: a PSD→tiles reader on a vendored-ready ag-psd
(`packages/psd`) with a canvas-free ImageData path, and the payload budget gate
(`pnpm budget`).

### M1 — Workspace shell (L) — ✅ **COMPLETE** (2026-09-20)
Everything in [01](01-workspace-ui.md) that is chrome: in-app menu bar with full menu tree
(unimplemented items disabled), options bar, tools panel (1/2-column, flyouts, all icons),
docking system (tab groups, collapse-to-icons, floating, drag-dock with blue drop zones,
workspaces save/reset), document tabs + floating doc windows + Arrange, status bar, rulers,
4 themes, keymap engine with Photoshop defaults + spring-loaded tools, dialog framework
(numeric scrubby sliders, arrow-key increments, unit parsing, Preview checkbox, Alt = Reset),
colour picker dialog (HSB/RGB/Lab/CMYK/hex, web-only, libraries-less), Color / Swatches /
Navigator / History / Layers (basic) / Properties (shell) panels, New Document dialog.
**Exit:** a Photoshop user can find every menu item and panel where they expect it;
screenshot-diff against reference layout metrics.

**Outcome.** Shell is running in Electron and in the browser. Built: in-app menu bar with the
complete tree (10 menus, ~600 commands, unimplemented items disabled), options bar contextual
on the tool, tools panel (21 groups / 60+ tools, flyouts, corner marks, colour wells, quick
mask, screen mode), column/tab-group docking with collapse-to-icons and tab dragging, document
tab strip, status bar with a selectable info field, 4 themes, keymap engine with Photoshop
defaults and spring-loaded tools, dialog framework (drag, Enter/Esc, Alt = Reset) with New
Document / Colour Picker / About / System Info / Shortcut Reference, and Layers, Color,
Swatches, Navigator, Info, Properties, History panels. 65 unit tests, payload 60 KB gzipped.

Findings:
1. **Submenus cannot live inside a scrollable menu panel.** Long menus need `overflow-y: auto`,
   which establishes a clipping context an absolutely-positioned submenu cannot escape. Every
   menu panel is now portalled with fixed positioning, which also allows viewport flipping.
2. **HMR is incompatible with a transferred OffscreenCanvas.** `solid-refresh` remounted the
   workspace, and because `transferControlToOffscreen()` cannot be repeated the remount
   silently orphaned the live engine and left a second, empty one driving the canvas — the
   document rendered from the wrong view origin. HMR is disabled for the app (`solid({ hot:
   false })`); dev now matches production.
3. **A full-screen scrim must honour Escape.** The tool flyout's scrim stayed up after Escape
   and swallowed the next click anywhere in the app.
4. **Signed-number tokenising breaks field arithmetic.** `[-+]?\d+` makes "100+20" tokenise as
   ["100", "+20"], so the operator is lost; numbers are now tokenised unsigned with the leading
   sign folded in afterwards.

Deferred from M1 (tracked, not silently dropped): floating document windows and Window ▸
Arrange, panel context menus, Preferences dialog (theme is on Shift+F1/F2 for now), ruler ticks
and guide dragging (the ruler gutters render but are not yet graduated), and a designer pass
over the icon set.

### M2 — Layer core + compositing + PSD I (XL) — ✅ **COMPLETE** (2026-09-20)
Layer tree commands, Layers panel complete (thumbnails, drag reorder, filter bar, locks,
opacity/fill scrubbing, context menus), all 27 blend modes, opacity/fill (incl. special-8),
pass-through vs isolated groups, clipping masks, raster masks (density/feather, view/disable/
overlay), Move tool (auto-select, show transform controls, align/distribute), Free Transform
(affine + perspective/distort/skew, interpolation choice), CPU reference compositor, golden
test runner. **PSD open/save**: pixel layers, groups, masks, modes, clipping, unknown-block
pass-through, composite + thumbnail write. Flatten / merge / stamp. Image Size, Canvas Size,
Image Rotation, Trim, Reveal All, Duplicate.
**Exit:** blend-mode golden suite passes GPU≡CPU≡Photoshop (±1/255); 50-file PSD corpus
(pixel/group/mask only) renders within threshold and round-trips losslessly; files open in
Photoshop without warnings.

**Done so far (2026-09-20).**
- **Compositing engine, GPU ≡ CPU.** All 27 blend functions, the general compositing equation,
  masks with density, pass-through vs isolated groups, clipping groups, Blend If, per-channel
  participation and the special-8 Fill model exist twice: once as the CPU reference
  (`@umbra/kernels`) and once in GLSL. `pnpm parity` diffs them over **83 cases** — each mode
  across the full backdrop × source matrix — and passes at maxΔ=1 (rounding).
- **Document model + history.** Immutable layer tree with groups, raster masks, locks, label
  colours and advanced blending; structural sharing so undo is a pointer swap. Linear history
  with snapshots, coalescing (`amend`) and a state limit.
- **PSD open.** Streaming reader (one decoded layer resident at a time) building the tree with
  nested groups, masks, blend modes, opacity/fill and clipping. Unsupported features are
  recorded and surfaced rather than silently dropped.
- **Live UI.** Layers panel drives the real document: nesting, group twirls, mask thumbnails,
  clipping indicators, visibility, opacity and blend-mode edits, undo/redo.

**Also done.**
- **PSD save.** Each layer is cropped to its tight non-transparent bounds and written with its
  mask, blend mode, opacity, fill, visibility and clipping. The merged composite comes from the
  CPU reference compositor, so what another application shows for a file we wrote is what our
  own renderer shows. Round trip verified: tree, attributes and **rendered pixels** survive
  save→open (maxΔ ≤ 2/255, all of it opacity quantising to a byte), and a second round trip is
  stable.
- **Layer tree commands.** New, delete, duplicate (sharing tiles), reorder, group, ungroup,
  merge down, merge visible, flatten, stamp visible — all pure `Doc → Doc`, each one history
  state.
- **Image commands.** Image Size (nearest/bilinear/three bicubic variants, premultiplied with
  overshoot clamped), Canvas Size with the 9 anchors, 90/180/270 rotation, flips, Trim,
  Reveal All — with dialogs for the two that need them.

**Deliberately deferred to M3, not done:** Move tool and Free Transform. Both are interactive
tools rather than document plumbing, and both are far more useful next to selections, so they
move to the milestone that builds those. The resampling they need already exists here.

**Still owed against the letter of the exit criterion:** the 50-file real-world corpus and the
GPU≡CPU≡**Photoshop** comparison. The first two equivalences are proven; the third needs
reference images from a licensed Photoshop install (open question 3) and cannot be verified
here. Unknown-block pass-through is also not implemented — ag-psd discards blocks it does not
model, so a round trip through Umbra currently drops them. That needs the vendored codec fork
and is the main remaining PSD risk.

**Findings.**
1. **The general compositor costs 4× the M0 renderer.** Every layer needs the backdrop as a
   texture, so a full-viewport pass per layer took the 100-layer document from 6.4 to 27 ms.
   Restored to **7.7 ms (129 fps)** by batching runs of plain Normal layers into one scratch
   target with fixed-function blending and a single blend pass — the fast path spec 03 §5.2
   anticipated.
2. **The batcher must not swallow a clipping base.** Batching a layer that has a clipped layer
   above it orphans the clipped layer. Caught only after the parity suite was extended to
   exercise the fast path, which it initially did not — the first version of that extension sat
   after a `return` and silently tested nothing.
3. **Image commands must respect channel layout.** Every canvas command is applied to a
   layer's mask as well as its pixels, and a mask is single-channel. Code assuming RGBA read
   four bytes per pixel out of a one-byte-per-pixel tile and silently destroyed the mask.
   Caught while reading the code during an unrelated investigation, not by a test — the tests
   that now cover it were written afterwards.
4. **`psd` must not depend on `engine`.** The reader originally tiled its own output, which
   would have made a cycle once the engine opened files. It now streams plain bitmaps and the
   engine tiles them, preserving the one-decoded-layer-at-a-time property.

### M3 — Selections + basic painting = first usable alpha (XL)
Marquees, lassos (free, polygonal), Magic Wand, Quick Mask, full Select ▸ Modify, Transform
Selection, Save/Load Selection + Channels panel, marching ants shader. Brush engine v1 (round
+ sampled tips, size/hardness/spacing/angle/roundness, opacity/flow/airbrush, smoothing,
pressure→size/opacity, all paint blend modes incl. Behind/Clear), Pencil, Eraser, Paint
Bucket, Gradient tool (classic + all 5 styles + editor), Eyedropper (+ sample size/layers),
Hand/Zoom/Rotate View, Crop (+ straighten, overlays, delete-cropped-pixels, content-aware
later), Fill… / Stroke… dialogs, clipboard (copy, copy merged, paste, paste in place, paste
into), History panel complete (snapshots, non-linear option), crash-recovery journal.
**Exit:** dogfood-able for basic photo compositing & painting; latency budgets green.

**M3 complete.** The selection stack is complete end to end: kernel (`@umbra/kernels/selection` — rect/ellipse/polygon/line rasterising with
anti-aliased coverage, combine ops, exact Felzenszwalb distance transform behind
Expand/Contract/Border, three-box-pass Feather, majority-vote Smooth, scanline flood fill
behind the Magic Wand, boundary tracing), engine state (selection lives on `Doc`, so undo
restores it with the pixels), the marching-ants pass, GPU stroke clipping in the dab shader,
and the UI (tool registry, options bar with the four combine modes and the wand's
tolerance/contiguous, Select ▸ All/Deselect/Inverse and all five Modify dialogs). Verified in
the browser: a marquee drag draws ants, Expand 200 px rounds the corners as a true Euclidean
distance should, a brush stroke crossing the selection edge is clipped exactly at it, and the
wand selects a contiguous band from a composited gradient.

Findings.

1. **`PlaneWriter.mutable()` was not actually copy-on-write.** `Tile.expand()` returns the
   tile's OWN buffer for a full (non-uniform) tile — only the uniform case allocates — and
   `mutable()` wrapped that buffer in a new `Tile` without copying. The new tile therefore
   shared pixels with the source, so painting one cell wrote through to every other cell,
   plane and layer holding that same `Tile` object. Found by painting one stroke on the
   synthetic benchmark document and getting two: the fixture repeats one tile along diagonals,
   so the stroke also appeared at the cells sharing the painted tiles' buffers, offset by
   exactly (+3, −1) tiles. This would equally have corrupted duplicated layers (advertised as
   free precisely because they share tiles), PSDs with repeated tiles, and anything the mip
   cache shares. Fixed with `Tile.expandCopy()`; two regression tests in `plane.test.ts` cover
   the aliased-cell and two-writers cases, and both fail against the old code.

   The lesson worth keeping: "immutable value that shares structure" is only true while every
   write goes through a real copy. A single accessor that returns the live buffer for
   performance silently converts the whole design into aliased mutable state.

2. **The mip cache memoised on tile identity while the brush mutates tiles in place.** A live
   stroke deliberately keeps ONE `Tile` object so its GPU atlas slice stays put, so identity
   alone is not a content key. `Tile` now carries a `rev` counter bumped by `mutable()` and by
   the stroke-end readback, and the cache keys on `id.rev`.

3. **Atlas growth reset residency mid-batch.** The tile drawer collects slot indices into an
   instance buffer and issues one instanced draw at the end; `grow()` reallocated the array
   texture and cleared `slots`, so every index already written into that buffer pointed at a
   cell some later tile was about to be uploaded into. Growth now blits the old pages into the
   larger texture and keeps slot numbers (slot → page/x/y is a pure function and growth only
   appends pages). The blit rather than a CPU re-upload is deliberate: mid-stroke, the newest
   dabs exist only in the atlas.

4. **Solid's `<Show>` accessor is invalid once the condition clears.** The Modify dialogs read
   `p().apply(v)` after `setAmountPrompt(null)` and threw, so OK silently did nothing while
   the dialog closed. The callback is now captured before the signal is cleared. Worth
   remembering as a shape, not a one-off: in any `Show` callback, read what you need up front.

Quick Mask, Grow/Similar, Fill…/Stroke…/Clear, the Eyedropper and brush engine v1 followed,
then the Move tool and Free Transform (deferred out of M2), the clipboard, the Paint Bucket and
Gradient, Crop, the Channels panel with Save/Load Selection, the History panel and the
crash-recovery journal. **M3 is complete.**

Further findings:

5. **The transparency checkerboard covered the whole viewport.** The pass that was meant to
   clip it to the canvas rect existed but had never been wired up, so a document's edge was
   invisible and every measurement taken off a screenshot was wrong — which cost real time
   during the stroke-duplication hunt above before it was spotted.

6. **Opacity vs flow needs a stroke buffer.** Dabs accumulate in their own plane at the
   brush's FLOW and are composited onto the layer once at its OPACITY. Painting each dab
   straight onto the layer, which is the obvious implementation, lets a slow stroke darken
   without limit and makes 50% opacity mean nothing. The buffer is also what gives Behind and
   Clear somewhere to act: they operate on alpha rather than colour, so they cannot go through
   the blend table, and the eraser is simply the brush in Clear mode.

7. **An effect that returns early subscribes to nothing.** Three effects read
   `if (!client) return;` before touching any store value, and since `client` is not up on the
   first run they registered no dependencies and never ran again — the engine kept painting
   with the brush it had at startup while the options bar showed the new settings. Reading
   every value before the guard fixes it. The same file also has the related trap: spreading a
   Solid store goes through `ownKeys` and does not subscribe to the individual properties, so
   `{ ...store.brush }` looks reactive and is not.

8. **Console history outlives a reload.** Two rounds of the debugging above were spent reading
   stale log lines from a previous page load as if they were current. Anything logged for a
   one-shot diagnostic needs a token that ties it to the run.

9. **PSD saving had never run outside the tests, and did not work.** `writePsdBuffer` wraps its
   result in a Node `Buffer` and throws without one, so File ▸ Save As failed in the worker —
   which is every real invocation. The node tests passed throughout because they have a
   `Buffer`. It surfaced only when the crash journal (which saves a PSD) was verified in the
   browser. `writePsdUint8Array` is the browser-safe entry point.

   The lesson is the M0 one again in a different costume: a test that exercises a path in an
   environment the product never runs in proves less than it appears to.

10. **A live Move or Transform must not rewrite pixels.** The layer's tiles are drawn THROUGH
    the matrix instead, so dragging a 4K layer costs nothing and the pixels are resampled
    exactly once, on commit. The same idea makes a whole-pixel move lossless: `shiftPlane`
    re-keys tiles and reuses the tile objects outright when the offset is a multiple of the
    tile size. A Move that resampled would soften a layer slightly on every nudge — the kind
    of bug a user notices after an hour and cannot explain.

11. **The eraser cannot be an overlay layer.** There is no colour that subtracts, so a live
    erase previews as a temporary multiplier on the target layer's mask: coverage starts at 1
    and the stroke's alpha takes it down, which is exactly what the committed erase does.

**Known gaps carried into M4.** With a selection active, Photoshop's Free Transform acts on
the selected pixels only; that needs the selection lifted into a floating layer, so for now it
transforms the whole layer. The Magic Wand's Sample Size is not averaged. The crash journal
writes a full PSD on a 30-second timer, which for a large document is seconds of worker time —
it is skipped during strokes and drags, but an incremental journal is the real answer. Gradient
presets are the three built-ins; the stop editor arrives with the preset manager.

### M4 — Adjustments (L)
All adjustments in [05 §A](05-adjustments-filters.md) as destructive commands **and**
adjustment layers; Properties panel UIs (Curves editor with point/pencil modes, on-image
targeted adjustment tool, eyedroppers, Auto options dialog, per-channel, presets); Adjustments
panel (icon grid + presets); Histogram panel (channels, expanded/all-channels view, stats,
cached-data warning); Info panel (dual readouts, before/after during adjustment, samplers);
fill layers (solid/gradient/pattern); PSD read/write for all of them; adjustment fusion in
the compositor.
**Exit (revised, open question 3 answered "no Photoshop").** There is no pixel oracle, so the
bar is split. Documented adjustments — Levels, Curves, Exposure, Invert, Posterize, Threshold,
Channel Mixer, Gradient Map, Black & White, Photo Filter, Desaturate — must match their own
published definition exactly, tested against an independent implementation of the formula.
Proprietary ones — Vibrance, Selective Color, Shadows/Highlights, Auto Tone/Contrast/Color,
HDR Toning, Match Color — are approximated, tagged `[fit]`, and must state in the code what
the approximation is and what evidence would settle it. Every adjustment must additionally be
self-consistent: identity parameters are a no-op, the destructive command and the adjustment
layer agree to ±1/255, and a round trip through PSD preserves the parameters.

**Status (2026-09-23): complete**, with the deferrals below. All 22 Image ▸ Adjustments
(per-pixel ones previewed on the GPU, the four spatial ones — Shadows/Highlights, Replace
Color, Match Color, HDR Toning — on the CPU), Auto Tone/Contrast/Color with Auto Color
Correction Options, all 16 adjustment layers, Solid/Gradient/Pattern fill layers, Apply Image
and Calculations; Curves (points, pencil, on-image, eyedroppers, Auto), Levels (histogram,
eyedroppers, Auto), Hue/Saturation colour ranges, presets and Last Used everywhere; the
Adjustments, Properties, Histogram (incl. All Channels View), Info (readouts, samplers,
before/after) and Patterns panels; mask targeting; adjustment fusion; PSD read/write for
every adjustment and fill kind. Exit: every kind passes destructive ≡ layer within 1/255 and a
PSD parameter round trip (CPU tests), GPU ≡ CPU parity is 126/126 including real documents
through the renderer, and each proprietary model says what it is in the code.

Deferred, with reasons: the newer layer kinds (Clarity & Dehaze, Grain, …) reuse the Develop
filter kernels and move to M5; Color Lookup's Abstract/Device Link lookups are ICC profiles
(M10, colour management); anything that needs a second open document — Image ▸ Duplicate,
Match Color from another image, Calculations into a new document — moves to M11.

**Findings.**

1. **A 3-D LUT is not good enough for adjustment layers.** Measured against the kernels on
   200 000 random colours, a 52³ table was off by up to 7 levels for a Hue/Saturation hue shift,
   and 86³ still by 2: the function creases along hue-sector boundaries that do not line up
   with the grid. Every non-table adjustment therefore has a GLSL transcription of its kernel,
   and the parity suite checks each over 4 096 exact 8-bit colours.
2. **The dialog preview is an adjustment layer.** Image ▸ Adjustments previews by drawing the
   adjustment as a temporary *clipped* adjustment layer over the target: clipped, it sees only
   the target's pixels and is shaped by its alpha, which is what applying it does. A slider step
   costs a GPU pass instead of ~200 ms of CPU on a 2400×1600 layer; OK runs the kernel once.
   Checked in the browser by diffing the Navigator's pixels: max Δ 3, mean 0.08.
3. **Inputs are quantised to 8 bits on both sides.** A composited backdrop is float; without
   quantising, 127.9996/255 lands either side of a Threshold or Posterize step depending on
   which side of the diff computed it. Threshold also compares with a 1e-3 epsilon, because on
   8-bit input the luminance is often *exactly* an integer and float32 must agree with float64.
4. **Two re-mount bugs that would have broken every drag.** The editor switched on
   `props.value.kind` inside JSX, which tracks the whole value and re-created the editor on each
   change; the Properties panel was keyed on the layer *object*, new with every summary. Either
   replaces the slider under the pointer mid-drag. Neither showed in a test; both showed the
   moment a scripted drag checked `element.isConnected`.
5. **PSD details.** An untouched (all-white) adjustment mask is stored as no pixels and read
   back as no mask, so opening restores the reveal-all mask; Exposure's float32 fields need
   rounding back (0.8 → 0.800000011920929); ag-psd reads Hue/Saturation's Colorize fields as
   the master record's `a…d`. The decoded record is kept on the layer, so anything not modelled
   — colour ranges, preset names — is written back unchanged.
6. **Painting fell back to another layer.** With a group (now also an adjustment layer)
   active, the brush, fill and copy silently used the topmost pixel layer. They refuse now;
   painting an adjustment layer's mask waits for mask targeting.
7. **`pnpm typecheck` had never worked** — it ran `tsc -b` with no root tsconfig. It now checks
   each package.
8. **Stored mask tiles had never reached the GPU.** The atlas uploaded every tile as RGBA8; a
   mask tile is one byte per pixel, so WebGL rejected the upload and the slot drew whatever
   it held before. Since M3, every mask with stored pixels — Reveal/Hide Selection, From
   Transparency, masks read from PSDs — rendered wrong, and the only symptom in the console
   was a warning nobody read. The parity suite could not see it: it paints masks from
   procedural patterns straight into scratch targets and never touches the tile store. It
   was found by painting an adjustment layer's mask and diffing the result. Fixed by
   widening single-channel tiles on upload; guarded by new *document* parity cases that
   render real documents through the DocumentRenderer, and by failing any parity run that
   leaves a WebGL error pending.
9. **Mip levels dropped their plane's default.** Every downsampled level defaulted to 0, so a
   white-default mask read as black from level 2 down: zoomed out, everything near a painted
   mask tile was hidden. Each level now keeps its source's default.
10. **Hue/Saturation's saturation changed model.** `s + (1 − s)·v` for positive values tinted
    greys red (their hue reads as 0°) and pushed faint colours to full saturation at +100.
    Saturation now scales, `s·(1 + v)`, so greys stay grey and −100 is still a neutral;
    Vibrance's Saturation slider follows. Colour ranges are weighted sums on top.
11. **Three preview strategies, chosen by what the operation is.** Per-pixel adjustments draw
    as a temporary clipped adjustment layer on the GPU. The four spatial ones and Apply Image
    compute a preview document on the CPU, and the worker keeps only the newest request so a
    drag never queues behind itself. New Fill Layer creates the layer on open, folds the final
    content into that creation step on OK (`History.amend`), and undoes it on Cancel.
12. **Fusion is exact, and tested as such.** Table entries are k/255 and the pass-by-pass
    path quantises between steps, so composing the tables is bit-identical; the parity suite
    renders its fusion cases both ways and requires identical GPU output. What it cannot make
    identical is GPU vs CPU after a partial-alpha blend followed by a step function: float16
    accumulators and float64 reference values round differently at byte boundaries.
13. **UI work tied to animation frames stalls in a hidden window.** Info readouts and dialog
    preview coalescing ran on `requestAnimationFrame`; they now use timers, which is also
    more correct — neither is frame work. The verification lessons are in
    `docs/not-working.md`: dev hooks (`__umbraSend`, `__umbraProbe`, `__umbraThumb`), driving
    ticks by message, and never trusting a canvas from a stalled pane.

### M5 — Filters I + Smart Objects (XL)
Filter framework (registry, auto-dialogs with zoomable preview + on-canvas preview, selection/
channel/mask awareness, tiled ROI execution, Last Filter, Fade), all Blur / Sharpen / Noise /
Stylize / Pixelate / Distort / Render / Other filters, Filter Gallery (47 effects, stackable
effect layers dialog). Smart objects: convert, embedded edit in tab, linked, place, transform
non-destructively, **smart filters** with mask + per-filter blending options; PSD read/write.
**Exit:** each filter has a golden test at 3 parameter sets; smart-filter PSDs from Photoshop
render within threshold for supported filters.
**Exit (revised, no Photoshop — as for M4).** Every filter and every Filter Gallery effect runs
at three parameter sets with a sanity check (premultiplied, finite) and a golden checksum —
regression nets, not an oracle — and passes the region contract: a crop grown by the declared
pad reproduces the full run within 1/255, which is what makes the preview box exact.
Documented filters (Gaussian, Box, Median, Maximum/Minimum, High Pass, Custom, Offset,
De-Interlace, Twirl's formula, Displace's) are tested against their definitions; the rest are
`[fit]` and say so in their `model`. Smart objects must render as the destructive filter
would, scale down and up losslessly, and survive PSD round trips (placement, contents,
instances, nesting, every mapped filter descriptor through the codec). PSDs written by
Photoshop open showing Photoshop's own stored rendering, exactly, until an object is edited.

**Status (2026-09-23): complete**, with the deferrals below. 58 filters in the registry
(Blur incl. Lens Blur, Distort, Noise, Pixelate, Render bar Flame/Picture Frame/Tree,
Sharpen, Stylize, Video, Other) with auto-generated dialogs, a zoomable before/after preview
box, on-canvas preview, Last Filter and Edit ▸ Fade; the Filter Gallery with all 47 effects in
six folders and stackable effect layers; smart objects (convert, New via Copy, instances,
Edit Contents in a tab, Place Embedded, Open as Smart Object, Convert to Layers, Rasterize,
lossless transforms through every geometric command) with smart filters (edit, reorder,
per-filter blending, eye, a paintable filter mask seeded from the selection); PSD read/write
of all of it. 727 tests.

Deferred, with reasons: linked smart objects (Place Linked, Relink, Update Modified, Embed/
Convert to Linked), Replace/Export Contents and Stack Mode need file watching or a second
open document (M11); smart-filter masks in PSD and perspective/warped placements (M9, with
the warps); GPU execution of filters (smart objects re-render on the CPU, ≈2 s for a
canvas-sized blurred object on a 2400×1600 document); Clarity/Dehaze/Grain adjustment
layers wait for the Develop kernels; Flame, Picture Frame and Tree are post-1.0.

**Findings.**
1. **Randomness must be keyed to the document, not the buffer.** Every noise, texture, seed
   grid and hatch reads `hash2(documentX, documentY, seed)`, never a sequential PRNG over the
   buffer; otherwise the preview box (a crop) and OK (the whole layer) disagree. The pad test
   enforces it for all 105 filters and effects.
2. **Region-of-interest is a contract, and it is testable.** Each filter declares how far an
   output pixel reads (`pad`, or `'full'` for Twirl-like ones). The test crops, grows by the
   pad, runs, and compares to the full run; a wrong pad fails at once. Summed-area tables and
   floating sums stay within the tolerance; running box blurs past σ 12 would not, which is
   why thresholds are only ever applied after exact convolutions.
3. **The Filter Gallery is one filter whose parameter is its stack.** Encoding the effect
   layers as JSON in a single registry parameter gave the gallery the preview box, on-canvas
   preview, Last Filter, Fade and smart-filter support without a line of special casing.
4. **A smart object is a pixel layer that knows how to remake its pixels.** It carries its
   rendered plane, so the compositor, clipboard, journal and PSD writer needed no new case;
   geometric commands compose their matrix into the transform and re-render from the
   contents, which is what makes scale-down-and-up lossless.
5. **Lend the filter mask the layer-mask slot.** Rather than teach brush, fill, gradient,
   filters and Apply Image a third target, a filter-mask edit swaps the filter mask into
   `mask`, runs the ordinary operation, swaps it back and re-renders.
6. **Every smart object in a PSD carries a warp.** ag-psd (and Photoshop) write a "custom"
   envelope whose mesh is the regular grid; only a mesh off that grid is a real warp.
7. **Open shows the file's rendering; decode later.** Embedded PNG/JPEG contents need the
   browser's asynchronous decoder, but a smart object opens showing the pixels Photoshop
   stored, so contents can arrive after the document opens with nothing re-rendered — and
   filters Umbra lacks keep showing until the object is edited.
8. **Photoshop's filter descriptors do not carry every setting.** Clouds' high contrast (an
   Alt-click there), Wind's randomness, Maximum/Minimum's Preserve and Radial Blur's centre
   come back at defaults; the codec round-trip test lists them explicitly.

### M6 — Layer styles + advanced blending (L)
All 10 effects + multi-instance, Layer Style dialog (exact layout: left list w/ checkboxes,
Blending Options page incl. Blend If split sliders, knockout, channel boxes), contour editor,
global light, Styles panel, copy/paste/scale/create-layers, `.asl` import/export, PSD
read/write, effects cache in compositor (distance transforms via jump-flood on GPU).
**Exit:** style golden suite (each effect × key parameter sweeps) visually matches
(SSIM ≥ 0.98) Photoshop renders.
**Exit (revised, no Photoshop — as for M4 and M5).** Each effect is pinned by behavioural
tests (a drop shadow falls away from the light by its distance, a stroke is a ring of its
width on the right side of the edge, an inner bevel is lit on the lit side and flat
elsewhere, glows stay outside or inside, spread hardens, knockout removes what it covers),
the distance transform is exact against brute force, and the whole style goes through both
compositors in GPU ≡ CPU parity documents. Styles and Blending Options round-trip through PSD
and .asl. The Photoshop comparison waits for a machine with Photoshop, and the recipes that
would change are tagged `[fit]` in `kernels/src/effects/render.ts`.

**Status (2026-09-23): complete**, with the deferral below. All ten effects with multi-instance,
Photoshop's defaults, contours (twelve presets, an editor), global light; the Layer Style
dialog (Styles page, Blending Options with split Blend If sliders, knockout, channels, fill,
every effect page, New Style, Make/Reset to Default, preview tile, live canvas preview);
effect rows and the fx menu in the Layers panel; Copy/Paste/Clear Style, Create Layers, Hide
All Effects, Scale Effects (and Image Size scales styles), Rasterize Layer Style; the Styles
panel with .asl read/write; effects on groups and smart objects; PSD read/write of styles and
Blending Options. GPU knockout and multi-range Blend If brought the GPU up to the CPU
reference. Parity 131/131; 755 tests.

Deferred: the GPU effects path (jump-flood distance transform). Effects are computed on the
CPU and cached per layer — 0.3–0.7 s for a canvas-sized layer with shadow, stroke and bevel
on 2400×1600 — which is correct and fast enough to edit with, but a brush stroke shows its
effects only when it ends.

**Findings.**
1. **Effects as generated layers.** A layer with a style is drawn as itself plus generated
   pixel layers, each with its effect's mode and the shape baked into its coverage. Neither
   compositor needed an effects node: the GPU path, the CPU reference, merge, flatten, export
   composites and smart-object contents all draw them for free, and parity covers them.
2. **Layer opacity applies once, to content and effects together.** Scaling each generated
   layer by the layer's opacity let a 50 % layer under a 50 % overlay show 75 %; below full
   opacity the lot now goes in a pass-through group, which cross-fades exactly as Photoshop
   does.
3. **A distance field from pixel centres is biased on curves.** Distances to the nearest
   inside pixel's centre made a 4 px outside stroke 6 % too wide on a disc; correcting by
   that pixel's coverage (how far through it the edge passes) brought it within 2 %.
4. **Knockout at Fill 0 did nothing.** The CPU reference only knocked out where the layer
   drew at its fill, so the classic hole-punch never punched. Knockout now replaces the
   backdrop inside the shape at Fill 100 % × opacity, on both compositors.
5. **`renderToBuffer` had its own layer walk.** The readback the Magic Wand, sampling and
   the parity suite use built its layer list separately and missed the effects; parity
   caught it at 255 on the first run.
6. **ag-psd dropped the last excluded channel.** Its `brst` reader stopped one entry short,
   so a single restriction never read back; fixed in a pnpm patch of the vendored codec.
7. **.asl is PSD's own parts.** A style library is patterns in PSD's `Patt` format and styles
   as the same effects descriptor a layer carries, so ag-psd's descriptor and pattern codecs,
   reached by deep import, read and write it with no parser of our own.

### M7 — Vector + Type (XL)
Pen / Freeform / Curvature Pen, Add/Delete/Convert Point, Path & Direct Selection, Paths panel,
shape tools with live-shape properties, custom shapes (`.csh`), path operations / alignment /
arrangement, vector masks, fill/stroke path. Text engine (HarfBuzz lazy chunk), point/paragraph/
on-path/in-shape type, Character / Paragraph / Glyphs / Character-Paragraph Styles panels,
Warp Text, convert to shape/work path, rasterize, font menu with preview + search + favourites,
missing-font flow, Match-Font-less. PSD `TySh`/EngineData + vector blocks read/write.
**Exit:** type golden suite (Latin, RTL, CJK, Indic; kerning/tracking/leading/justification
cases) within layout tolerance of ≤ 1 px glyph position vs Photoshop raster for bundled fonts.

**Revised exit (2026-09-23), as for M4–M6: there is no Photoshop to take rasters from.** The
golden suite checks each behaviour against its own definition instead: metrics kerning
tightens AV and numeric kerning disables it; ligatures form and can be turned off; tracking
adds exactly 1/1000 em per character; auto leading is 120 %; paragraph type wraps inside its
box, justifies all but the last line to the exact measure and hides what overflows; bidi
reorders Hebrew with embedded Latin; Arabic joins and forms lam-alef; Devanagari reorders the
i-matra; CJK advances a full em, breaks between ideographs and honours kinsoku; vertical type
stands CJK upright; carets and hit tests round-trip; a type layer's outline path fills to
the same pixels it draws (< 0.5 %); shapes, vector masks and type round-trip through PSD. The
≤ 1 px comparison against Photoshop stays open until real PSD rasters are available.

**Status (2026-09-23): complete**, with the deferrals below. Vector: Pen, Freeform and
Curvature Pen, anchor tools, Path/Direct Selection, the Paths panel, Fill/Stroke Path, Make
Selection/Work Path; six shape tools (Shape/Path/Pixels) with live-shape properties; Combine
Shapes, Merge Shape Components, Path Alignment/Arrangement; custom shapes with `.csh`; vector
masks; PSD `vmsk`/`vscg`/`vstk`/`vogk`. Type: a new `@umbra/text` package — HarfBuzz (lazy
WASM), a font registry with fallback, script itemisation, bidi, a single-line composer, outlines,
caret geometry, Warp Text — and type layers with in-place editing, point/paragraph/path/area
type, the Character, Paragraph, Glyphs and Styles panels, the font menu, Type Mask, and PSD
`TySh` (keeping Photoshop's pixels until edited). Parity 133/133; 840 tests.

Deferred: the Every-line Composer and hyphenation; optical kerning; paragraph-box handles;
writing path/area type to PSD (ag-psd cannot); Photoshop's custom warps; Match Font (a
non-goal); spell check and Find/Replace; font previews in the menu. `docs/not-working.md` lists
them with the smaller gaps.

**Findings.**
1. **Vector masks are raster masks at draw time.** Folding a vector mask's coverage into the
   layer's mask (`prepareLayers`, cached per layer) meant neither compositor, merge, export
   nor the parity suite needed to know vector masks exist — the same trick as M6's effects.
2. **Shape and type layers carry their pixels.** Like smart objects they are drawn as pixel
   layers from a plane re-rendered on the CPU whenever their vectors change, and geometry
   composes into their vectors (or transform) so a rotate re-renders crisply instead of
   resampling. Type opened from a PSD keeps Photoshop's own rendering until it is edited,
   which is also how missing fonts stay faithful.
3. **Traced outlines need even-odd.** Make Work Path from a ring selection filled the hole:
   every traced contour was a union. Traced contours never cross, so XOR-ing them is exactly
   even-odd; glyph contours convert the same way for Convert to Shape.
4. **Small caps were upper-cased away.** Upper-casing lowercase letters before shaping (for
   synthesised small caps) meant a font's own `smcp` never saw a lowercase letter; now only
   synthesised small caps upper-case.
5. **A type session is one history step, and nothing interleaves with it.** Any other command
   that commits first closes the session as its own step, so Undo never lands halfway
   through someone's typing and a cancelled session never discards another command's work.
6. **A raw U+2028 is a line break to the parser.** Written into a regular expression it broke
   the module twice — the text arrived through a tool that turned `\u2028` escapes into the
   character. A test now scans every source for raw line and paragraph separators.
7. **Scripted key presses can be empty.** The browser automation sends `key: ''` for names it
   does not know ('Return', 'period'), which looked like Enter and Ctrl+Shift+> were broken;
   'Enter' and '>' work. Check the event before blaming the handler.

### M8 — Retouching + full brush engine (XL)
Clone Stamp (+ Clone Source panel: 5 sources, offset/scale/rotate, overlay), Pattern Stamp,
Healing Brush, Spot Healing (content-aware / create texture / proximity), Patch (normal +
content-aware), Content-Aware Move, Red Eye, Remove-tool-equivalent (PatchMatch based),
Content-Aware Fill workspace, Dodge / Burn / Sponge, Blur / Sharpen / Smudge, Mixer Brush,
Color Replacement, Background / Magic Eraser, History / Art History Brush. Brush Settings
panel complete (all dynamics, dual brush, texture, colour dynamics, transfer, pose, noise, wet
edges, build-up, smoothing modes, symmetry painting), Brushes panel w/ groups + live stroke
previews, `.abr` import/export, tool presets.
**Exit:** ABR corpus imports with correct tips+dynamics; painting perf budgets green with
dynamics enabled; healing/PatchMatch results qualitatively on par (blind A/B review set).

**Revised exit (2026-09-23), as for M4–M7.** There is no Photoshop to run, but a Photoshop
2020 install on the dev box's Windows partition gives a real ABR corpus. `abr-corpus.test.ts`
reads its three brush files in place (they are Adobe's, so they stay out of the repository):
643 presets, 268 sampled tips and 44 texture patterns. Every sampled tip decodes, every preset
keeps its dynamics, texture and dual brush, and every preset survives a write-and-read round
trip. The 135 bristle, erodible and airbrush presets draw their generated tips (added
2026-09-24; before that they were drawn round). Perf: in
the Electron spikes harness, a 500 px sampled tip on a 4K layer with every Brush Settings
section on paints input→pixels at **2.56 ms p95** (plain round brush 1.51 ms;
budget 16 ms). There is no Photoshop to A/B against, so healing and PatchMatch are checked by what they must do:
- Spot Healing removes a dark blemish from a ramp with all three types.
- Patch carries the source's texture while taking the destination's tone.
- Content-Aware Fill continues a 6 px stripe pattern through the hole row for row, with no
  seam (checked in the browser).
- A 90×90 hole in 400×300 fills in about 180 ms.

**Status (2026-09-23): complete**, with the deferrals below.
- **Brush engine:** every Brush Settings section (after the ABR model: shape dynamics,
  scattering, texture, dual brush, colour dynamics, transfer, pose, noise, wet edges,
  build-up, smoothing modes, protect texture) is drawn on the GPU. Sampled tips live in a
  texture array, and each stroke is seeded, so it is repeatable. Symmetry painting has
  all ten of Photoshop's types (six at first; see the follow-up).
- **Brushes panel:** groups and live previews.
- **`.abr`:** read in v1/v2 and v6+, written as v6.2.
- **Presets:** Define Brush Preset and tool presets.
- **Retouching:** all 20 tools, the Clone Source panel and Edit ▸ Content-Aware Fill.
  - Healing is a Poisson membrane (Pérez 2003 / Georgiev 2004), solved coarse to fine.
  - Content-aware fills are PatchMatch (Barnes 2009) with Wexler EM voting.

Parity 133/133; 873 tests (884 after the follow-ups). Nothing from M8 remains deferred.

Follow-up (2026-09-24), each of these was deferred above and is now built:
- **Physical tips.** Bristle, erodible and airbrush tips are generated from their settings
  (`kernels/src/brush/physical.ts`, `[fit]`). Each is a small family of bitmaps, chosen per
  dab by pressure, wear or at random, so they need nothing new in the GPU dab path.
- **Live healing.** The Healing Brush heals the area under each frame's new dabs, with what it
  has already healed as the boundary, so the pieces join without seams. It commits what it
  showed.
- **Clone Source overlay.** When Clipped, it is sampled under the brush on the CPU. Otherwise
  it is the whole source drawn through the clone mapping on the GPU, clipped to the canvas.

  The overlay's matrix is checked to be the exact inverse of the stamp's mapping.
- **`.tpl` tool presets** (`engine/src/tpl.ts`). A painting preset's brush descriptor is
  rewritten into a one-brush `.abr` in memory and read by the brush-library path, so each
  dynamic is read exactly as in a brush library. Gradients and shape styles go through the
  PSD fill-layer and vector-stroke converters. Every preset in Photoshop 2020's three `.tpl`
  files loads.
- **Five more symmetry types.**
  - Parallel Lines is two linear reflections with an offset.
  - Wavy, Circle and Spiral mirror in their own coordinates: across the wave (v′ = 2f(u) − v),
    across the circle, and along the ray about the nearest turn.
  - A path mirrors through the nearest point of its curve.

  Where a curve's mapping stretches the stroke, the mirror is filled in from between the
  source's dabs.
- **The Content-Aware Fill workspace.**
  - A session in the engine holds the sampling area as a canvas-size mask, drawn on the canvas
    with the Quick Mask tint shader.
  - Auto and Rectangular follow the selection as the Lasso changes it, and the Sampling Brush
    makes the area Custom.
  - A debounced preview runs at up to 360 px; OK runs at full size.
  - Rotation Adaptation, Scale and Mirror are Generalized PatchMatch (Barnes et al. 2010):
    each match also carries an angle, a scale and a reflection, and propagation and random
    search explore them.
  - Tests fill a hole whose only possible source is a mirrored or turned copy of its
    surroundings. With the option on, the error is under half of the plain fill's.
  - In the browser, a striped image with a disc removed matches untouched stripes pixel for
    pixel.

**Findings.**
1. **Healing needs a boundary where both images are known.** The membrane took its
   boundary difference from the pixels *outside* the pasted region, but every caller only
   has the source inside it and filled the outside with the destination, so the difference
   was zero everywhere and Patch, Healing Brush and Proximity Match were plain pastes. Unit
   tests passed because they checked texture, not tone. It was caught in the browser, where
   a patch came out the source's exact colour. The region's own edge ring is now the
   boundary, and a test checks that a patch takes the destination's tone.
2. **A real corpus finds what round-tripping our own files cannot.** Photoshop's own `.abr`
   files turned up three problems:
   - ag-psd threw on a tool preset's Sponge mode (`BlnM.Dstt`, which is not a blend mode).
   - ag-psd had no reader for indexed-colour texture patterns.
   - Every preset was named by localisation key (`$$$/Presets/Brushes/Pencil=Pencil`).

   Our writer also invented tool options for presets that had none. All four are fixed:
   the first two in `patches/`.
3. **A stroke can arrive before the previous one finishes painting.** With frames
   throttled, the next stroke's begin message overtook the last stroke's queued samples.
   The new stroke now waits for its own first (FLAG_DOWN) sample.
4. **Carrying tools need dense dabs.** Smudge, Blur, Sharpen and the Mixer Brush pick up
   what they deposit. At a round brush's 25 % spacing they left ridges, so their spacing is
   capped at 10 %.
5. **Bind every sampler unit, always.** A draw with a `sampler2DArray` and a `sampler2D`
   both left on unit 0 is a GL error even if one is never read. The dab shader binds every
   unit on every draw.
6. **The payload budget has been over since M7.** The total is 3.25 MB against 3 MB, and
   ≈2.5 MB of it is the bundled Noto Sans styles. Core UI is 255 KB and the worker 67 KB,
   both well inside budget. Loading the Bold/Italic files on first use, or synthesising
   them, would bring it back; that is a product call, so it is left open here.
7. **ag-psd misreads the physical tips.** It divides bristle qualities by 100 a second
   time: Photoshop stores 31 % as the percentage 0.31, so ag-psd returns 0.0031. It also
   calls tip type 1 "erodible flat", but that type is Photoshop's Airbrush. For erodible tips,
   the lead's shape (point, flat, round, square or triangle) is carried in the bristle-shape
   index. Every airbrush preset in the corpus confirmed this reading. The importer corrects
   for all of it, and the writer produces what Photoshop does.
8. **Reflecting across a curve's nearest point is not a mirror.** For Wavy, the nearest
   point of a wave to a point past the crest's curvature is on the slope, so the mapping
   folds over. Wavy and Spiral are mirrored in their own coordinates instead, and a test
   checks that each curved symmetry is its own inverse. The exception is a circle past twice
   its radius, where the mirror crosses the centre.
9. **`e.currentTarget` is null after an `await`.** Three file inputs (Load Tool Presets,
   Load Brushes, Load LUT) cleared themselves after awaiting the file and threw. They now keep
   the element in a variable first.
10. **`.dialog-button` was never styled.** Several buttons (Clone Source's Reset Transform,
    Load Shapes, Add Fonts, …) rendered as bare browser buttons. It was noticed only when the
    Content-Aware Fill workspace's OK looked disabled. The class now shares `.button`'s rules.

### M9 — Advanced selection + advanced transform (XL)
Quick Selection, Magnetic Lasso, Color Range, Focus Area, **Select and Mask** workspace (all
view modes, Refine Edge brush, global refinements, decontaminate, output options), Object
Selection / Select Subject / Sky via optional ONNX model pack (on-device), Warp (presets +
custom grid splits), Perspective Warp, Puppet Warp, Content-Aware Scale, Perspective Crop,
Liquify (all tools, freeze/thaw mask, mesh save/load, reconstruct; face-aware is non-goal),
Auto-Align / Auto-Blend Layers, Sky Replacement-less.
**Exit:** matting quality reviewed on hair/fur set; warps round-trip through PSD smart objects.

### M10 — Depth, colour management, colour modes, pro photo filters (XL)
16-bit & 32-bit throughout (every tool/filter declares depth support; unsupported are greyed
exactly like PS), lcms2: Color Settings, Assign/Convert Profile, Proof Setup/Colors, Gamut
Warning, display profile; modes Gray, Lab, CMYK, Indexed, Bitmap, Duotone, Multichannel with
conversion dialogs; spot channels; Camera-Raw-style filter (Basic, Curve, Detail, Color Mixer,
Color Grading, Optics, Geometry, Effects, Calibration-less; also the RAW-open dialog), Lens
Correction, Adaptive Wide Angle-less, HDR Toning, Merge to HDR, Blur Gallery (Field, Iris,
Tilt-Shift, Path, Spin), Lens Blur, Lighting Effects, Shadows/Highlights, Match/Replace Color,
Apply Image, Calculations.
**Exit:** ICC conversions match lcms reference exactly; 16-bit golden suite; CMYK PSDs open &
save natively.

### M11 — Automation, export, document extras (L)
Actions panel (record/play/edit steps, modal toggles, button mode, stops, insert menu item,
`.atn` import), Batch, Image Processor, scripting API + script runner, Export As, Save for Web,
Quick Export, Layers/Artboards/Comps to Files, Generate-assets-less; Layer Comps, Artboards,
Frames, Slices, Notes, Count, Ruler; frame animation (Timeline panel, frame mode only) + GIF/
APNG/WebP export; Preferences complete; Keyboard Shortcuts & Menus editor; Tool-preset &
preset manager import/export; Contact Sheet, Crop & Straighten, Photomerge (basic).

### M12 — Hardening → 1.0 (L)
Performance pass against all budgets, memory-pressure & scratch-disk torture tests, GPU
blocklist/fallbacks, accessibility (keyboard reachability, contrast, screen-reader labels for
chrome), i18n plumbing check, installers (AppImage/deb/rpm, NSIS, dmg — signing), auto-update,
file associations, PWA build, user docs, licence audit, final PSD corpus sign-off.

## Test strategy

| Layer | What | Tooling |
|-------|------|---------|
| Unit | colour math, blend functions, geometry, descriptors, text layout, codec round-trips | Vitest (node) |
| Kernel golden | every CPU kernel/filter/adjustment vs stored PNG/16-bit goldens | testkit pixel-diff (max Δ, RMSE, SSIM) |
| GPU≡CPU | each compositor feature & GPU filter vs CPU reference, in headless Electron w/ real GL (+ SwiftShader run in CI) | Playwright-Electron + testkit |
| **Photoshop parity** | goldens exported **from real Photoshop** for the feature-matrix PSDs (one PSD per feature × parameter sweep, with PS's own composite embedded). Generated once by script on a licensed PS install; stored in `testkit/fixtures` via Git LFS | testkit |
| PSD corpus | real-world files: render diff vs embedded composite, round-trip, open-in-PS checklist | testkit + manual per release |
| UI | layout metrics, keymap, menu tree completeness vs the inventory in [01], dialog tab order, interaction scripts (draw→undo→redo) | Playwright |
| Perf | budgets table; tracked per commit, fail on > 10 % regression | perf harness |
| Fuzz | PSD/ABR/GRD/ASL parsers with mutated inputs; never crash, never over-allocate | custom fuzzer in CI nightly |

**Definition of done for any feature:** command(s) + descriptor schema → UI → undo/redo →
recordable in Actions → PSD read/write (if it persists) → golden tests → keymap/menu entry →
greyed-out rules by mode/depth/target identical to Photoshop.

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Rendering parity is unbounded** (layer styles, text, special-8 fill, Blend If, smart filters): formulas are partly undocumented | Photoshop-generated golden matrix from M2; tolerance tiers; ⚠ fallback to stored raster (07 §1.3) so files always *look* right even when not yet editable |
| 2 | **Memory**: 16-bit, 100+ layers, history | Tile COW + compression + scratch spill from M0; GPU LRU; budgets in CI; never hold whole-layer buffers |
| 3 | **WebGL2 limits**: no framebuffer fetch, `readPixels` stalls, context loss, 16-bit formats | Ping-pong w/ dirty rects + fast paths; CPU mirror of active layer; rebuild-from-tiles; norm16→32F fallback; `gpu/` abstraction keeps WebGPU door open |
| 4 | **Text parity & fonts** | HarfBuzz; keep PS raster until edited; substitution UI; layout goldens |
| 5 | **ag-psd gaps / single maintainer** | Vendored fork from day one; own the codec long-term |
| 6 | **Scope** — "everything" is ~10 product-years at Adobe | Registry-driven architecture makes breadth cheap; strict milestone exits; non-goals list; late milestones are independent and parallelisable |
| 7 | **Electron size vs "tiny"** | App payload ≤ 3 MB so the PWA build *is* the tiny edition; Electron trimmed (locales, no native modules); shell is swappable (Tauri-CEF later) |
| 8 | **Patents / licences** (content-aware algorithms, HEVC, LibRaw LGPL, ICC profiles, fonts) | Use published academic algorithms (PatchMatch 2009, seam carving 2007, Poisson 2003); optional-download packs for encumbered codecs; licence audit in M12 |
| 9 | **Trade dress** | Original name, icon, icon set, presets; nominative "PSD-compatible" wording only |

## Open questions (do not block M0–M2)
1. Product name + icon.
2. Licence of Umbra itself (MIT / GPL / proprietary) — affects which reference code (Krita =
   GPL, GIMP = GPL) may be *read for ideas only* vs adapted. Default assumption: permissive;
   therefore **no GPL code is copied**, only papers/specs/MIT-Apache sources.
3. ~~Whether a licensed Photoshop install is available to generate parity goldens.~~
   **Answered 2026-09-21: no Photoshop.** So there is no pixel oracle, and the strategy is:
   implement every documented formula exactly and test it against its own definition; for the
   proprietary ones, approximate, tag `[fit]`, and record in the code what the guess is and
   what would settle it. Cross-checks come from embedded composites in third-party PSDs and
   from Photopea. M4's exit criterion softens accordingly — see M4.
4. ML model pack: which segmentation model (MobileSAM-class ~40 MB vs U²-Net-class ~5 MB).
