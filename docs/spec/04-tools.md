# 04 — Tools

Every tool is a state machine in the engine worker: `(pointer/keyboard events, options,
modifiers) → overlay instructions + commands`. Tools declare: id, group, shortcut, cursor,
options-bar schema, valid targets (layer kinds / mask / channel / quick mask), and the
"can't use because…" message Photoshop shows (e.g. painting on a type layer → "rasterize?").
Options persist per tool; **Tool Presets** snapshot them.

Confidence tags as in [06]: **[doc]** published algorithm · **[fit]** tune against Photoshop.

## 1. Tools panel (top → bottom), groups and keys

| # | Group (key) | Tools |
|---|-------------|-------|
| 1 | Move (V) | Move · Artboard |
| 2 | Marquee (M) | Rectangular · Elliptical · Single Row · Single Column |
| 3 | Lasso (L) | Lasso · Polygonal Lasso · Magnetic Lasso · Selection Brush |
| 4 | Quick select (W) | Object Selection (ML pack) · Quick Selection · Magic Wand |
| 5 | Crop (C) | Crop · Perspective Crop · Slice · Slice Select |
| 6 | Frame (K) | Frame |
| 7 | Sample (I) | Eyedropper · Color Sampler · Ruler · Note · Count |
| 8 | Retouch (J) | Spot Healing Brush · Remove · Healing Brush · Patch · Content-Aware Move · Red Eye |
| 9 | Paint (B) | Brush · Pencil · Color Replacement · Mixer Brush (· Adjustment Brush†) |
| 10 | Stamp (S) | Clone Stamp · Pattern Stamp |
| 11 | History (Y) | History Brush · Art History Brush |
| 12 | Erase (E) | Eraser · Background Eraser · Magic Eraser |
| 13 | Fill (G) | Gradient · Paint Bucket |
| 14 | Focus (–) | Blur · Sharpen · Smudge |
| 15 | Tone (O) | Dodge · Burn · Sponge |
| 16 | Pen (P) | Pen · Freeform Pen · Curvature Pen · Add Anchor · Delete Anchor · Convert Point |
| 17 | Type (T) | Horizontal Type · Vertical Type · Vertical Type Mask · Horizontal Type Mask |
| 18 | Path select (A) | Path Selection · Direct Selection |
| 19 | Shape (U) | Rectangle · Ellipse · Triangle · Polygon · Line · Custom Shape |
| 20 | Hand (H) / Rotate View (R) | Hand · Rotate View |
| 21 | Zoom (Z) | Zoom |
| — | ⋯ Edit Toolbar · fg/bg colours (D, X) · Quick Mask (Q) · Screen Mode (F) | |

## 2. Navigation & utility

- **Move** — options: Auto-Select ☑ [Layer|Group], Show Transform Controls ☑, align (6) /
  distribute (6 + spacing 2) buttons, align-to [Selection|Canvas]. Drags active layers (or
  selection contents → floating pixels; Alt = duplicate). Snapping + Smart Guides (magenta
  lines, equal-spacing hints, Ctrl/Alt-hover measurements). Layer hit-test: top-most layer
  with α > 50 % under cursor, skipping locked/hidden. Arrow nudge.
- **Artboard** — draw/resize artboards, ＋ handles to add adjacent.
- **Hand / Zoom / Rotate View** — flick-pan inertia, scrubby zoom, animated zoom, zoom-all-
  windows ☑, Fit Screen / Fill Screen / 100 % buttons; rotate view with compass overlay,
  Shift = 15°, Reset View.
- **Eyedropper** — sample size (Point, 3×3 … 101×101 avg), Sample [Current Layer | Current &
  Below | All Layers | All no-adjustments | Current & below no-adj], sampling ring ☑.
  **Color Sampler** (≤10 persistent), **Ruler** (length/angle; Straighten Layer; Clear),
  **Note**, **Count**.
- **Crop** — ratio presets ▾ (Ratio, W×H×Resolution, Original, 1:1, 4:5, 5:7, 2:3, 16:9; swap
  ⇄; Clear), Straighten (draw a line), overlay ▾ (Rule of Thirds, Grid, Diagonal, Triangle,
  Golden Ratio, Golden Spiral; `O` cycles), ⚙ (classic mode, auto-centre preview, shield
  colour/opacity), **Delete Cropped Pixels** ☑ (off = non-destructive, layers keep hidden
  pixels), Content-Aware ☑ (fills new empty corners; uses PatchMatch), fill ▾. Image moves
  under a fixed crop box (modern) or box moves (classic). **Perspective Crop** — 4-corner quad
  → homography rectify. **Slice / Slice Select** — basic.
- **Frame** — rect/ellipse frames; drop image → smart object masked by frame.

## 3. Selection tools
Shared options: mode buttons [new|add|subtract|intersect], Feather px, Anti-alias ☑, Select
and Mask… button. All write a coverage plane via `selection.combine(op, plane)`.

- **Marquees** — Style [Normal | Fixed Ratio | Fixed Size]; analytic AA for ellipse.
- **Lasso / Polygonal** — scanline polygon fill with AA; Alt toggles between them mid-gesture;
  Backspace removes last vertex; double-click/Enter closes.
- **Magnetic Lasso** — Intelligent Scissors **[doc]** (Mortensen–Barrett live-wire; Dijkstra
  over cost `0.43 fZ + 0.43 fD + 0.14 fG` in a Width-limited window); options Width,
  Contrast, Frequency (auto-anchors), pen pressure → width.
- **Selection Brush** — paint selection with a brush (shows rubylith overlay), add/subtract,
  size/hardness/opacity.
- **Magic Wand** — Sample Size, Tolerance 0–255, Anti-alias, Contiguous, Sample All Layers.
  Scanline flood fill in kernel pool; metric starts as per-channel max-abs-diff vs seed
  **[fit]**; AA as boundary smoothing **[fit]**. Same kernel serves Paint Bucket, Magic
  Eraser, Grow, Similar.
- **Quick Selection** — brush-driven progressive region growing: per-stroke fg/bg colour
  models + graph-cut on a downsampled grid, refined at edges (Paint Selection, Liu 2009
  **[doc]**); Auto-Enhance = narrow-band guided-filter matting; Sample All Layers.
- **Object Selection / Select Subject / Sky** — optional ML pack (ONNX Runtime Web, WebGPU →
  WASM fallback). Rectangle/Lasso prompt modes, hover-to-preview object finder. Default
  candidates: MobileSAM-class promptable (~40 MB) + u2netp-class salient (~5 MB); licence-
  checked. Without the pack the tools show a "Download model pack" sheet.
- **Quick Mask (Q)** — selection ↔ temporary alpha channel painted with any tool; overlay
  colour/opacity, masked-vs-selected areas option (double-click icon).
- **Select and Mask workspace** — modal workspace: tools (Quick Selection, Refine Edge Brush,
  Brush, Object Selection, Lasso, Hand, Zoom); View Mode ▾ (Onion Skin O, Marching Ants M,
  Overlay V, On Black A, On White T, Black & White K, On Layers Y; `F` cycles, `X` disables),
  Show Edge / Show Original / High-Quality Preview, transparency/opacity slider; Refine Mode
  [Color Aware | Object Aware]; Edge Detection (Radius, Smart Radius); Global Refinements
  (Smooth 0–100, Feather 0–1000 px, Contrast 0–100 %, Shift Edge ±100 %); Clear / Invert;
  Output (Decontaminate Colors + Amount; Output To: Selection, Layer Mask, New Layer, New
  Layer with Mask, New Document, New Document with Mask); Remember Settings. Matting: trimap
  from radius band → Shared Matting on GPU for interactivity, closed-form/KNN refinement on
  commit **[doc]**; decontaminate = multi-level foreground estimation.
- **Color Range** — Select ▾ (Sampled Colors, Reds…Magentas, Highlights/Midtones/Shadows,
  Skin Tones, Out of Gamut), Fuzziness 0–200, Localized Color Clusters + Range %, +/−
  eyedroppers, preview modes (None, Grayscale, Black/White Matte, Quick Mask), Invert.
  Falloff linear in Lab distance **[fit]**.

## 4. Paint engine (shared by all brush-based tools)

### 4.1 Stroke pipeline
```
raw pointer samples (coalesced, pressure/tilt/twist, timestamps)
 → smoothing (0–100 %; modes: Pulled String, Stroke Catch-up, Catch-up on Stroke End, Adjust for Zoom; leash overlay)
 → path resampler: a dab every spacing% × diameter of arc length (remainder carried across segments); Shift-click lines
 → per-dab dynamics: value = base · control(pressure|tilt|fade|direction|…) · (1 − jitter·rand), floored at minimum
 → dab rasteriser (GPU instanced quads): computed round tip (hardness, roundness, angle) or sampled tip from mip chain;
   × texture × dual-brush mask × noise; scatter/count; colour dynamics per dab or per stroke
 → stroke buffer S (single channel + optional colour):  S ← S + d·flow·(1 − S)
 → each frame: layer = blend(layerAtStrokeStart, colour, α = S·opacity, paintMode)   within dirty rect, through selection,
   transparency lock, channel locks
 → pointer-up: commit touched tiles as one history state
```
- Overlap inside one stroke never exceeds Opacity; Flow builds asymptotically; Airbrush emits
  dabs on a timer while stationary; Build-up; Wet Edges = curve on S lowering interior
  **[fit]**. Hardness profile: measured radial falloff **[fit]** (start: smoothstep-like from
  `h·R` to `R`). Size 1–5000 px.
- Pressure buttons on the options bar (opacity ◉, size ◉) override Brush Settings.
  Symmetry ▾ (Vertical, Horizontal, Dual Axis, Diagonal, Wavy, Circle, Spiral, Parallel Lines,
  Radial n, Mandala n) — path-defined axes, strokes mirrored in the dab stage.
- Paint targets: pixel layer colour, layer mask, vector-less, alpha/spot channel, quick mask,
  smart-filter mask. On masks colours collapse to grey.
- Determinism: jitter PRNG seeded per stroke and stored in the command → replayable
  (actions, tests).

### 4.2 Tools on the engine
| Tool | Options bar | Specifics |
|------|-------------|-----------|
| **Brush** | preset ▾, Brush Settings ▤, Mode ▾ (27 − group-only + Behind, Clear), Opacity, ◉, Flow, airbrush, Smoothing + ⚙, angle, ◉ size, symmetry | — |
| **Pencil** | + Auto Erase ☑ | aliased dabs (threshold 50 %) |
| **Color Replacement** | Mode (Hue/Saturation/Color/Luminosity), Sampling (Continuous/Once/Background Swatch), Limits (Discontiguous/Contiguous/Find Edges), Tolerance, AA | per-dab colour-distance mask × component blend |
| **Mixer Brush** | current load swatch, load ⟳ / clean ✕ after each stroke, preset ▾ (Dry…Very Wet, Heavy Mix), Wet, Load, Mix, Flow, Sample All Layers | reservoir model **[fit]**: `res ← lerp(res, canvas, wet)`; `canvas ← lerp(canvas, res, flow·mask)`; load drains with distance |
| **Eraser** | Mode [Brush|Pencil|Block], Opacity, Flow, Erase to History ☑ | α·(1−S·op); on Background paints bg colour |
| **Background Eraser** | Sampling, Limits, Tolerance, Protect Foreground Color | colour-to-alpha within dab |
| **Magic Eraser** | Tolerance, AA, Contiguous, Sample All Layers, Opacity | wand mask → clear |
| **Clone Stamp** | + Aligned ☑, Sample ▾ (Current / Current & Below / All Layers), ignore adjustments ◐ | source snapshot at stroke start; Clone Source panel affine; overlay preview clipped to brush |
| **Pattern Stamp** | pattern ▾, Aligned, Impressionist | |
| **Healing Brush** | Source [Sampled|Pattern], Aligned, Sample ▾, Diffusion 1–7 | clone then gradient-domain blend: Poisson solve per stroke region on GPU (multigrid/Jacobi) or mean-value coordinates for interactivity **[doc]** (Georgiev 2004; Pérez 2003) |
| **Spot Healing** | Type [Content-Aware | Create Texture | Proximity Match], Sample All Layers | content-aware = PatchMatch fill of the stroke region |
| **Remove** | size, Sample All Layers, Remove after each stroke ☑ | PatchMatch-based large-region fill (no cloud) |
| **Patch** | Patch [Normal | Content-Aware], Source/Destination, Transparent, Diffusion / Structure 1–7, Color 0–10 | lasso region → drag → Poisson blend or PatchMatch |
| **Content-Aware Move** | Mode [Move|Extend], Structure, Color, Sample All Layers, Transform on Drop | |
| **Red Eye** | Pupil Size, Darken Amount | local red-region detect → desaturate + darken |
| **History Brush** | standard brush opts | paints from History source state's plane |
| **Art History Brush** | Style ▾ (Tight Short … Loose Curl), Area, Tolerance | stylised strokes following source gradients |
| **Blur / Sharpen** | Mode, Strength, Sample All Layers, Protect Detail | per-dab local convolution, accumulative |
| **Smudge** | Strength, Sample All Layers, Finger Painting | carried patch buffer **[doc]**: paint buffer at new pos with mask·strength; `buffer ← lerp(canvasPatch, buffer, strength)` |
| **Dodge / Burn** | Range [Shadows|Midtones|Highlights], Exposure, airbrush, Protect Tones | start from GIMP-style range curves; Protect Tones hue-preserving **[fit]** |
| **Sponge** | Mode [Saturate|Desaturate], Flow, Vibrance ☑ | |
| **Adjustment Brush**† | adjustment ▾ | creates adjustment layer + paints its mask |

Brush presets: `.abr` import (tips + all dynamics), Brushes panel groups, live stroke
thumbnails rendered by the same engine, Define Brush Preset from selection (grey → tip).

## 5. Fill tools
- **Gradient** — two modes as modern PS: **Gradient** (creates live on-canvas gradient fill
  layer with draggable stops widget) and **Classic gradient** (paints pixels). Options:
  gradient ▾ + editor, style [Linear | Radial | Angle | Reflected | Diamond], Mode, Opacity,
  Reverse, Dither, Transparency, Method [Perceptual (Oklab) | Linear | Classic | Smooth |
  Stripes]. Gradient model: colour stops + opacity stops + midpoints + smoothness; noise
  gradients (roughness, colour model, ranges, restrict, transparency, seed). Gradients baked
  to 1-D LUT textures (≥ 4096 entries, 16F) then evaluated in a shader; dither = blue-noise
  sub-LSB. Midpoint & smoothness functions **[fit]**. Gradient Editor dialog exact layout
  (presets grid, name, type solid/noise, smoothness, stop strip with opacity stops above /
  colour stops below, location %, delete).
- **Paint Bucket** — fill [Foreground | Pattern], Mode, Opacity, Tolerance, AA, Contiguous,
  All Layers. Wand kernel with graded alpha.

## 6. Vector tools
- **Pen** — mode ▾ [Shape | Path | Pixels-less for pen]; Make: Selection… / Mask / Shape;
  path operations ▾ (New Layer, Combine, Subtract, Intersect, Exclude, Merge Shape
  Components); path alignment ▾; arrangement ▾; ⚙ (thickness, colour, Rubber Band);
  Auto Add/Delete ☑; Align Edges ☑. Click = corner, drag = smooth, Alt-drag handle = break,
  Alt-click anchor = convert, Ctrl = Direct Selection, Shift = 45°, Esc ends, Backspace deletes.
- **Freeform Pen** (+ Magnetic ☑: width/contrast/frequency; curve fit px) — fit Béziers to
  freehand (Schneider's algorithm **[doc]**). **Curvature Pen** — click points, auto-smooth
  (κ-curves, Yan 2017 **[doc]**), double-click = corner.
- **Add/Delete Anchor, Convert Point**; **Path Selection** (whole sub-paths; align/distribute;
  path ops; Alt-drag duplicate) / **Direct Selection** (anchors/handles; marquee; nudge).
- **Shapes** — Rectangle (4 live radii, on-canvas radius widgets), Ellipse, Triangle
  (radius), Polygon (sides, star ratio, smooth corners/indents), Line (weight, arrowheads),
  Custom Shape (▾ picker, `.csh`). Options: mode ▾ [Shape | Path | Pixels], Fill ▾ (none /
  solid / gradient / pattern + picker), Stroke ▾ + width + options (align, caps, corners,
  dashes, presets), W/H link, path ops, align, arrange, ⚙ (unconstrained / square / fixed
  size / proportional / from centre). Click canvas = Create dialog. On-canvas transform &
  rotate handles. Boolean ops: flatten-free curve booleans via a compact path-ops lib
  (Skia-PathOps-class WASM lazy chunk, or polygon clipping on flattened curves as fallback);
  stored non-destructively as per-subpath ops (PSD semantics), *Merge Shape Components* bakes.
- Rasterisation: `Path2D` → coverage plane ([03 §7]); stroke alignment inside/outside via
  double-width stroke ∩/− fill coverage.

## 7. Type tools
Click = point type, drag = paragraph box, click on path = type on path, click inside closed
shape = area type; **Type Mask** variants produce a selection. Options bar: orientation ⇅,
family ▾, style ▾, size ▾, anti-alias ▾, align ×3, colour, Warp Text…, Character/Paragraph
panel toggle, ⊘ / ✓. Editing: own caret + selection model (word/line/paragraph by click
count, Shift-arrows, Ctrl-arrows), IME via hidden input proxy, clipboard (rich within app,
plain from outside), undo inside the edit session, spell check†, Find/Replace. While
editing, Ctrl shows the transform box; commits on Ctrl+Enter / tool change. Type-specific
shortcuts per [01 §6]. Layout/shaping per [03 §7], model per [02 §6]. Warp Text dialog: Style
▾ (Arc, Arc Lower, Arc Upper, Arch, Bulge, Shell Lower, Shell Upper, Flag, Wave, Fish, Rise,
Fisheye, Inflate, Squeeze, Twist), H/V, Bend, Horizontal/Vertical Distortion — applied to
glyph outlines (vector-exact), generators for each style **[fit]** (extract control grids
from PSDs via "convert to custom warp").

## 8. Transform sessions
- **Free Transform** (`Ctrl+T`) on layers, multi-layers, selections' pixels, paths, masks,
  smart objects (non-destructive, accumulates). Options bar: reference point ☑ 3×3 + X/Y (Δ
  toggle), W/H % + link, angle, H/V skew, interpolation ▾ (Nearest, Bilinear, Bicubic,
  Bicubic Smoother, Bicubic Sharper, Bicubic Automatic, Preserve-Details-less), warp toggle,
  ⊘ ✓. Right-click: Free Transform, Scale, Rotate, Skew, Distort, Perspective, Warp,
  Content-Aware Scale, Puppet Warp, rotate/flip items. Interactive preview = GPU textured
  quad/mesh; commit = single high-quality resample from the *original* pixels (premultiplied,
  Keys bicubic with area-aware prefilter on minification; `a` per mode **[fit]** by impulse
  test), homography closed-form **[doc]**.
- **Warp** — presets (the 15 above) + Custom; grid ▾ (default 1×1 patch = 4×4 control points;
  3×3, 4×4, 5×5, custom), split warp H/V/cross, per-point handles; bicubic Bézier patch
  evaluation **[doc]**, rendered as a tessellated mesh (64² per patch); stored in PSD warp
  descriptors (incl. quilt warp).
- **Perspective Warp** — layout mode (draw/snapped quads) → warp mode (drag pins, auto
  straighten buttons); per-quad homographies with shared edges + mesh blend.
- **Puppet Warp** — mesh from layer α (Density: fewer/normal/more; Expansion px; Show Mesh),
  pins with depth ↑↓ and rotate (Auto/Fixed), Mode [Rigid | Normal | Distort]; ARAP solver
  (Igarashi 2005 **[doc]**) with prefactored sparse system in kernel pool.
- **Content-Aware Scale** — seam carving with forward energy **[doc]**; Amount %, Protect ▾
  (alpha channel), protect skin tones.
- **Liquify, Select and Mask, Content-Aware Fill, Blur Gallery, Camera-Raw-style filter,
  Filter Gallery** are modal *workspaces* sharing one frame: left tool strip, centre canvas,
  right properties, OK/Cancel — specified in [05](05-adjustments-filters.md).
