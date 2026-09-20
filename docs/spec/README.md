# Umbra — a lightweight Photoshop-class image editor

> **Working name:** "Umbra" (placeholder; rename freely). "Photoshop" / "PS" never appear in the product.
> **Status:** specification, pre-implementation. **Date:** 2026-09-20.

Umbra is a desktop raster editor that reproduces the *philosophy, workflow and UI* of Adobe
Photoshop — the same mental model, the same panels, the same shortcuts, the same layer
semantics, the same file format — in a package that is a fraction of the size, starts in under
a second, and is dark by default. The closest existing product is Photopea; Umbra aims for the
same fidelity with a GPU-first engine and a native desktop shell.

## Spec map

| # | Document | Contents |
|---|----------|----------|
| — | [README.md](README.md) | Vision, principles, scope, non-goals, glossary |
| 01 | [01-workspace-ui.md](01-workspace-ui.md) | Workspace anatomy, menus, panels, dialogs, shortcuts, theming |
| 02 | [02-document-model.md](02-document-model.md) | Document, layers, masks, channels, selections, styles, smart objects, history |
| 03 | [03-architecture.md](03-architecture.md) | Tech stack, process model, pixel engine, tiles, GPU compositor, memory, undo |
| 04 | [04-tools.md](04-tools.md) | Every tool: behaviour, options bar, modifiers, algorithms |
| 05 | [05-adjustments-filters.md](05-adjustments-filters.md) | Every adjustment and filter: parameters, ranges, math |
| 06 | [06-compositing-math.md](06-compositing-math.md) | Blend modes, opacity/fill, groups, clipping, Blend If, layer-effect rendering |
| 07 | [07-file-formats.md](07-file-formats.md) | PSD/PSB read+write mapping, other codecs, presets (ABR/GRD/ASL/ACV/CUBE…) |
| 08 | [08-roadmap.md](08-roadmap.md) | Milestones, acceptance criteria, test strategy, risks |

## Product principles

1. **Photoshop muscle memory must just work.** A Photoshop user sits down and is productive in
   zero minutes. Same tool letters, same modifier keys, same menu locations, same panel names,
   same dialog layouts, same terminology. When in doubt, *do what Photoshop does* — including
   its quirks (e.g. Fill vs Opacity on the 8 special blend modes, Ctrl+Z toggling vs stepping
   per the modern default, Alt-click mask to view it).
2. **Non-destructive by default.** Adjustment layers, masks, smart objects, smart filters,
   layer styles, live shapes, editable type. Destructive variants exist (Image ▸ Adjustments)
   exactly as in Photoshop.
3. **PSD is the native format.** Open → edit → save PSD must round-trip everything we
   understand *and preserve everything we don't* (unknown blocks are carried through
   byte-for-byte). A PSD saved by Umbra opens correctly in Photoshop.
4. **Lightweight is a feature.** Budgets (enforced in CI, see [03](03-architecture.md#budgets)):
   app payload (JS+CSS+WASM+icons) ≤ 3 MB gzipped core, cold start to usable canvas ≤ 1.0 s,
   idle RAM with a blank 1920×1080 doc ≤ 250 MB (Electron included), 60 fps pan/zoom on a
   100-layer 4K document, brush latency ≤ 16 ms.
5. **Dark by default.** Four UI brightness themes like Photoshop (darkest → light), default =
   second-darkest (`#323232` chrome — see screenshot 2 in the brief). Neutral greys only; the
   UI never tints the artwork.
6. **GPU-first, CPU-correct.** Everything the user sees in real time (compositing, adjustments,
   most filters, brush dabs, transforms) runs on the GPU. Every GPU path has a CPU reference
   implementation used for tests, export at sizes beyond GPU limits, and fallback.
7. **Offline, private, no account.** No telemetry, no cloud, no login. Generative/cloud features
   of Photoshop are out of scope; on-device ML (Select Subject, Object Selection) is an
   optional downloadable model pack.
8. **Web-portable core.** The editor is a pure web app (TypeScript + WebGL2 + WASM) with a thin
   `platform` abstraction. Electron is the shipping shell; the same core can run as a PWA.

## Scope

**In scope (v1.0 = "everything a photographer / designer / digital painter uses daily"):**
full workspace UI; all selection, paint, retouch, vector, type, navigation tools; layers of
every type incl. groups, clipping, masks, vector masks, adjustment & fill layers, smart objects
& smart filters, artboards (basic), frames (basic); all 27 blend modes; all 10 layer effects;
all 22 adjustments; the complete Filter menu incl. Filter Gallery, Liquify, Camera-Raw-style
filter, Lens Correction, Blur Gallery; channels, alpha & spot channels; paths; history +
snapshots + history brush; actions (record/play); 8/16/32-bit; RGB, Grayscale, CMYK (via ICC),
Lab, Indexed, Bitmap, Duotone (open/convert); ICC colour management & soft proofing; PSD/PSB
read/write and the common interchange formats; preset formats (ABR, GRD, PAT, ASL, ACO/ASE,
ACV, ALV, CUBE, CSH, ATN read).

**Explicit non-goals:** Generative Fill / Firefly / Neural Filters that need a server; Creative
Cloud Libraries sync; 3D; video timeline (frame animation *is* in scope, late); Adobe Bridge;
plug-in binary compatibility (8BF); scripting compatibility with ExtendScript/UXP (we expose
our own JS scripting API shaped after the action descriptor model); Vanishing Point (post-1.0);
printing colour separations workflows beyond CMYK conversion + proof.

## Legal guard-rails

- No Adobe trademarks, names, logos, splash art, or icon artwork. All icons are drawn
  originally (same *metaphors* — a lasso is a lasso — different artwork), shipped as one SVG
  sprite.
- Layout, menu structure, terminology and shortcuts are functional and not protectable as
  such (cf. *Lotus v. Borland*); Photopea, Affinity, Krita and GIMP/PhotoGIMP all rely on this.
- The PSD format is documented publicly by Adobe; we implement from the spec and from clean
  observation of files. No Adobe code, no decompilation.
- Fonts: ship only OFL fonts; otherwise use the user's system fonts.

## Glossary

| Term | Meaning |
|------|---------|
| **Backdrop** | Accumulated composite of everything below the layer being blended |
| **Fill** | Layer "Fill" opacity: affects layer pixels but not its layer effects |
| **Dab / stamp** | One brush tip impression; a stroke is a sequence of dabs |
| **Tile** | Fixed-size (256² px) block of a raster plane; unit of storage, undo and upload |
| **Plane** | A single-purpose raster: layer colour, layer mask, channel, selection, cache |
| **Descriptor** | Photoshop's key/value action-parameter structure; our command payload format mirrors it |
| **Smart object (SO)** | Layer embedding a whole document / file, rendered through a transform |
| **Effects / styles** | The 10 layer effects (Drop Shadow … Stroke); a *style* is a saved set |
