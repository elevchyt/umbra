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

**Progress (selections done, painting in progress).** The selection stack is complete end to
end: kernel (`@umbra/kernels/selection` — rect/ellipse/polygon/line rasterising with
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

Quick Mask, Grow/Similar, Fill…/Stroke…/Clear, the Eyedropper and brush engine v1 followed.
Further findings:

5. **The transparency checkerboard covered the whole viewport.** The pass that was meant to
   clip it to the canvas rect existed but had never been wired up, so a document's edge was
   invisible and every measurement taken off a screenshot was wrong — which cost real time
   during the stroke-duplication hunt above before it was spotted.

6. **Opacity vs flow needs a stroke buffer.** Dabs now accumulate in their own plane at the
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

Still to do in M3: Transform Selection, Save/Load Selection + Channels panel, Paint Bucket,
Gradient, clipboard, Crop, History panel completeness, crash-recovery journal, and the Move
tool and Free Transform deferred out of M2. Known gaps in what is built: the eraser has no
live preview (the stroke overlay cannot subtract until the compositor takes a per-layer erase
input), and the Magic Wand's Sample Size is not yet averaged.

### M4 — Adjustments (L)
All adjustments in [05 §A](05-adjustments-filters.md) as destructive commands **and**
adjustment layers; Properties panel UIs (Curves editor with point/pencil modes, on-image
targeted adjustment tool, eyedroppers, Auto options dialog, per-channel, presets); Adjustments
panel (icon grid + presets); Histogram panel (channels, expanded/all-channels view, stats,
cached-data warning); Info panel (dual readouts, before/after during adjustment, samplers);
fill layers (solid/gradient/pattern); PSD read/write for all of them; adjustment fusion in
the compositor.
**Exit:** adjustment golden suite vs Photoshop within ±2/255 (±1 where formula is documented).

### M5 — Filters I + Smart Objects (XL)
Filter framework (registry, auto-dialogs with zoomable preview + on-canvas preview, selection/
channel/mask awareness, tiled ROI execution, Last Filter, Fade), all Blur / Sharpen / Noise /
Stylize / Pixelate / Distort / Render / Other filters, Filter Gallery (47 effects, stackable
effect layers dialog). Smart objects: convert, embedded edit in tab, linked, place, transform
non-destructively, **smart filters** with mask + per-filter blending options; PSD read/write.
**Exit:** each filter has a golden test at 3 parameter sets; smart-filter PSDs from Photoshop
render within threshold for supported filters.

### M6 — Layer styles + advanced blending (L)
All 10 effects + multi-instance, Layer Style dialog (exact layout: left list w/ checkboxes,
Blending Options page incl. Blend If split sliders, knockout, channel boxes), contour editor,
global light, Styles panel, copy/paste/scale/create-layers, `.asl` import/export, PSD
read/write, effects cache in compositor (distance transforms via jump-flood on GPU).
**Exit:** style golden suite (each effect × key parameter sweeps) visually matches
(SSIM ≥ 0.98) Photoshop renders.

### M7 — Vector + Type (XL)
Pen / Freeform / Curvature Pen, Add/Delete/Convert Point, Path & Direct Selection, Paths panel,
shape tools with live-shape properties, custom shapes (`.csh`), path operations / alignment /
arrangement, vector masks, fill/stroke path. Text engine (HarfBuzz lazy chunk), point/paragraph/
on-path/in-shape type, Character / Paragraph / Glyphs / Character-Paragraph Styles panels,
Warp Text, convert to shape/work path, rasterize, font menu with preview + search + favourites,
missing-font flow, Match-Font-less. PSD `TySh`/EngineData + vector blocks read/write.
**Exit:** type golden suite (Latin, RTL, CJK, Indic; kerning/tracking/leading/justification
cases) within layout tolerance of ≤ 1 px glyph position vs Photoshop raster for bundled fonts.

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
3. Whether a licensed Photoshop install is available to generate parity goldens (strongly
   recommended; otherwise rely on embedded composites in third-party PSDs + Photopea
   cross-checks).
4. ML model pack: which segmentation model (MobileSAM-class ~40 MB vs U²-Net-class ~5 MB).
