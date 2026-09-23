# Umbra

A lightweight Photoshop-class image editor: the same mental model, panels, shortcuts, layer
semantics and file format, in a package that is a fraction of the size, starts in under a
second, and is dark by default. Closest existing product is Photopea; Umbra aims for the same
fidelity with a GPU-first engine and a native desktop shell.

Working name — "Photoshop" never appears in the product.

## Status

**M0–M8 complete.** Selections, painting, transforms, the clipboard, PSD open/save, all of
Photoshop's adjustments (destructive and as adjustment layers), fill layers, masks, the
Filter menu (58 filters and the 47-effect Filter Gallery), smart objects and smart filters,
layer styles and advanced blending, the Pen tools, paths, shape layers and vector masks,
type (HarfBuzz shaping, point/paragraph/path/area type, Warp Text), the full brush engine
(every Brush Settings section, `.abr` import/export) and the retouching tools (clone, heal,
patch, content-aware fill and move, dodge/burn, smudge, mixer brush…) work. Advanced
selection and warps (M9) do not yet.

> ### ⚠️ Read [`docs/not-working.md`](docs/not-working.md) first
>
> Most of the UI is present because M1's exit criterion was that a Photoshop user finds
> everything where they expect it — **253 of 504 menu commands are not built yet** (greyed out,
> not silently inert). That file is the running checklist, and it
> separates *broken* (cheap bugs) from *not built yet* (the roadmap). It carries the script
> that regenerates it, because the hand-maintained flags in the source have been wrong before.

| | |
|---|---|
| Tests | 755 across 35 files |
| GPU ≡ CPU parity | 131/131 cases — every blend mode, every adjustment, fill layers, and real documents through the renderer |
| Payload | 203 KB UI + 195 KB worker, gzipped |
| Compositing | 100 layers at 4K, ~8 ms/frame |

## What works

Selections (marquees, lassos, magic wand, Quick Mask, the full Select ▸ Modify set, Save/Load
Selection), a brush engine with real opacity-vs-flow separation, Pencil and Eraser, Paint
Bucket and Gradient, Move and Free Transform, Crop, the clipboard, layers with all 27 blend
modes, masks, groups and clipping, the Channels and History panels, PSD open and save, and a
crash-recovery journal.

Adjustments: all 22 of Image ▸ Adjustments plus Auto Tone/Contrast/Color, as dialogs with
live preview, presets, eyedroppers and on-image tools, and all 16 as adjustment layers edited
in Properties and saved to PSD. Solid Color, Gradient and Pattern fill layers; painting into
layer masks; Apply Image and Calculations; the Info (with before/after), Histogram,
Adjustments and Patterns panels; the Color Sampler tool.

Filters: 58 across Blur (with Lens Blur), Distort, Noise, Pixelate, Render, Sharpen, Stylize,
Video and Other, each with a zoomable before/after preview box and on-canvas preview, plus
Last Filter and Edit ▸ Fade; the Filter Gallery's 47 effects with stackable effect layers.
Smart objects: Convert, Place Embedded, Open as Smart Object, Edit Contents in a tab,
instances, lossless transforms, Convert to Layers, Rasterize — and smart filters with
per-filter blending and a paintable filter mask, all saved to and read from PSD.

Layer styles: all ten effects (five of them multi-instance) in Photoshop's Layer Style dialog,
Blending Options with Blend If and knockout, the Styles panel with .asl libraries, Create
Layers, Scale Effects, Global Light — rendered identically by the GPU and the CPU reference,
and saved to PSD.

## Running it

```bash
pnpm install
pnpm dev          # Electron shell
```

The web core runs standalone too:

```bash
pnpm --filter @umbra/app dev
```

Requires Node 24+ and pnpm. No Rust toolchain.

```bash
pnpm test         # vitest
pnpm typecheck    # all packages
```

## Layout

```
packages/
  core/            geometry, pixel formats, blend vocabulary, colour
  kernels/         pure algorithms — blending, selection, brush, gradient, matrices, adjustments
  engine/          tiles, GPU compositor, document, history, commands, PSD
  psd/             ag-psd wrapper
  ui/              Solid components, docking, widgets, icons
  app/             composition root — menus, panels, tools, workspace
  shell-electron/  desktop shell
  testkit/         fixtures
```

Dependency rule: `core ← kernels ← engine ← app → ui`. `ui` never imports `engine`.

## Design notes

The spec in [`docs/spec/`](docs/spec/) is the product definition — nine documents describing
Photoshop's behaviour precisely enough to implement against, with `[doc]` marking published
algorithms and `[fit]` marking anything that needs fitting against real output.

[`docs/spec/08-roadmap.md`](docs/spec/08-roadmap.md) carries the milestone plan and, more
usefully, a **Findings** section per milestone recording what actually changed the design —
including the mistakes. A copy-on-write bug that was not copying, a parity suite that sat
after a `return` and silently tested nothing, a PSD save that had never run outside the tests.
They are written down rather than quietly fixed because the same classes of error keep
recurring.

There is no licensed Photoshop available to generate golden images, so adjustments with a
published formula are implemented exactly and tested against their own definition, and the
proprietary ones are approximated, tagged `[fit]`, and state in the code what would settle
them.
