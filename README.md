# Umbra

A lightweight Photoshop-class image editor: the same mental model, panels, shortcuts, layer
semantics and file format, in a package that is a fraction of the size, starts in under a
second, and is dark by default. Closest existing product is Photopea; Umbra aims for the same
fidelity with a GPU-first engine and a native desktop shell.

Working name — "Photoshop" never appears in the product.

## Status

**M0–M3 complete, M4 mostly landed.** Selections, painting, transforms, the clipboard, PSD
open/save, and adjustments — destructive and as adjustment layers — work; filters, layer
styles, vector and type do not.

> ### ⚠️ Read [`docs/not-working.md`](docs/not-working.md) first
>
> Most of the UI is present because M1's exit criterion was that a Photoshop user finds
> everything where they expect it — **337 of 505 menu commands are not built yet** (greyed out,
> not silently inert). That file is the running checklist, and it
> separates *broken* (cheap bugs) from *not built yet* (the roadmap). It carries the script
> that regenerates it, because the hand-maintained flags in the source have been wrong before.

| | |
|---|---|
| Tests | 422 across 22 files |
| GPU ≡ CPU parity | 108/108 cases (every blend mode, every adjustment), maxΔ = 1 |
| Payload | 150 KB UI + 139 KB worker, gzipped |
| Compositing | 100 layers at 4K, ~8 ms/frame |

## What works

Selections (marquees, lassos, magic wand, Quick Mask, the full Select ▸ Modify set, Save/Load
Selection), a brush engine with real opacity-vs-flow separation, Pencil and Eraser, Paint
Bucket and Gradient, Move and Free Transform, Crop, the clipboard, layers with all 27 blend
modes, masks, groups and clipping, the Channels and History panels, PSD open and save, and a
crash-recovery journal.

Adjustments: Brightness/Contrast, Levels, Curves, Exposure, Vibrance, Hue/Saturation, Color
Balance, Black & White, Photo Filter, Channel Mixer, Invert, Posterize, Threshold, Gradient
Map, Selective Color, Desaturate, Equalize and Auto Tone/Contrast/Color — as dialogs with live
preview and, for the fifteen Photoshop has as layers, as adjustment layers edited in
Properties and saved to PSD.

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
