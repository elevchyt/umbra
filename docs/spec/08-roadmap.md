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

### M1 — Workspace shell (L)
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

### M2 — Layer core + compositing + PSD I (XL)
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
