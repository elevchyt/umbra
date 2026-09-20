# 05 — Adjustments & filters

All entries are registry definitions ([03 §8](03-architecture.md#8-filters--adjustments-framework)):
one definition → menu item, dialog, Properties-panel UI, adjustment layer / smart filter,
action step, PSD mapping, GPU + CPU implementation, golden tests.

Tags: **[exact]** formula known · **[fit]** must be fitted to Photoshop output (method: push a
HALD identity CLUT / grey ramps / impulse / step edge through real PS and fit — see
[08](08-roadmap.md#test-strategy)). Primary numeric reference: Gerald Bakker, *Photoshop by
the Numbers*. GPL projects (GIMP/GEGL/Krita/darktable) are read for ideas only.

# A. Adjustments

"Layer" column: available as adjustment layer (PSD key). All others are destructive only.
Every dialog: Preset ▾ ⚙, Preview ☑, Alt = Reset; Auto button where PS has one.

| Adjustment | Layer | Parameters (range) | Math |
|------------|-------|--------------------|------|
| **Brightness/Contrast** | `brit`/`CgEd` | Brightness −150…150, Contrast −50…100, Use Legacy ☑, Auto | Legacy **[exact]**: `v+b`; `127.5+(v−127.5)·k`, `k = c>0 ? 100/(100−c) : (100+c)/100`. Modern = highlight-protecting curve pivoting at 128 **[fit]** |
| **Levels** | `levl` | per channel (RGB, R, G, B): input black 0–253, gamma 0.10–9.99, white 2–255; output black/white 0–255; eyedroppers (black/grey/white point); Auto + Options | **[exact]** `out = oB + (oW−oB)·clamp((v−iB)/(iW−iB))^(1/γ)`; channel then master order **[fit]**. Baked to LUT |
| **Curves** | `curv` | per channel ≤16 points, or pencil-drawn 256-map; input/output fields; show: channel overlays, histogram, baseline, intersection; grid 4×4/10×10 (Alt-click); light(0–255) vs pigment % display; on-image tool; eyedroppers; Auto | interpolating cubic spline (natural, clamped to [0,1], flat beyond endpoints) → 256/32769 LUT **[fit ±1]**; `.acv`/`.amp` |
| **Exposure** | `expA` | Exposure −20…20, Offset −0.5…0.5, Gamma 0.01–9.99, eyedroppers | **[exact-ish]** 8/16-bit: `lin=v^2.2; lin=max(0, lin·2^E + O); out = (lin^(1/2.2))^(1/G)`; 32-bit: no 2.2 wrap, no clamp |
| **Vibrance** | `vibA` | Vibrance ±100, Saturation ±100 | nonlinear saturation boost weighted to low-sat pixels, skin-hue protection **[fit]** via HALD; start `S' = S·(1+k(1−S)^p)` |
| **Hue/Saturation** | `hue2` | Master + Reds/Yellows/Greens/Cyans/Blues/Magentas: Hue ±180, Saturation ±100, Lightness ±100; range bar with 4 draggable angles per colour (default reds 315/345/15/45), +/− eyedroppers; Colorize ☑ (H 0–360, S 0–100 def 25, L); on-image tool | PS-specific HSL variant **[fit]** (best-known RE in [agent notes] — saturation as chroma scaling around `L=(max+min)/2`, lightness last as lerp to white/black); ranges = linear hue-angle ramps weighting all three sliders |
| **Color Balance** | `blnc` | Shadows/Midtones/Highlights × (Cyan–Red, Magenta–Green, Yellow–Blue) ±100; Preserve Luminosity ☑ | tonal-weight curves + per-channel shift, then restore Lum **[fit]** (start from the well-known a=.25, b=.333, scale=.7 model) |
| **Black & White** | `blwh` | Reds, Yellows, Greens, Cyans, Blues, Magentas −200…300 (defaults 40/60/40/60/20/80); Tint ☑ + colour (H/S); Auto; on-image tool | `grey = min + (mid−min)·w_secondary + (max−mid)·w_primary` **[fit]**; tint = colorize |
| **Photo Filter** | `phfl` | Filter ▾ (Warming 85/LBA/81, Cooling 80/LBB/82, colours…) or Color; Density 1–100 %; Preserve Luminosity ☑ | `mix(v, v·colour, density)` then SetLum **[fit]** |
| **Channel Mixer** | `mixr` | Output channel ▾; source R/G/B −200…200 %; Constant ±200 %; Total readout ⚠; Monochrome ☑; presets | **[exact]** matrix + constant |
| **Color Lookup** | `clrL` | 3DLUT File ▾ / Abstract ▾ / Device Link ▾ (load `.cube .3dl .look .csp .icc`); Dither ☑ | **[exact]** 3-D LUT, **tetrahedral** interpolation; ships with original LUT set |
| **Invert** | `nvrt` | — | `1−v` |
| **Posterize** | `post` | Levels 2–255 | **[exact]** `floor(v·n)/(n−1)` (8-bit: `floor(v8·n/256)·255/(n−1)`) |
| **Threshold** | `thrs` | Level 1–255 (histogram slider) | `Lum ≥ t` → white |
| **Gradient Map** | `grdm` | gradient ▾, Dither, Reverse, Method | `gradient(Lum(C))` via 1-D LUT |
| **Selective Color** | `selc` | Colors ▾ (Reds, Yellows, Greens, Cyans, Blues, Magentas, Whites, Neutrals, Blacks) × C/M/Y/K ±100 %; Relative / Absolute | **[exact]** — fully reverse-engineered (pkh.me; same author's FFmpeg `selectivecolor`): range membership by max/min channel, scale Ω, `φ = clip(((−1−adj)·K − adj)·m, −v, 1−v)·Ω`, `m = 1` abs / `1−v` rel |
| **Shadows/Highlights** | — (smart filter OK) | Shadows & Highlights: Amount 0–100 %, Tone (Tonal Width) 0–100 %, Radius 0–2500 px; Color ±100; Midtone ±100; Black/White Clip 0–50 %; Show More ☑ | edge-aware blurred-luminance mask → tonal ramp → mask-driven gamma; colour compensation; midtone contrast **[fit]** |
| **HDR Toning** | — | Method ▾ (Local Adaptation: Edge Glow radius/strength/smooth edges, Gamma, Exposure, Detail, Shadow, Highlight, Vibrance, Saturation, Toning Curve; Exposure & Gamma; Highlight Compression; Equalize Histogram) | base/detail decomposition (bilateral / local Laplacian **[doc]**), flattens doc like PS |
| **Desaturate** | — | — | `(max+min)/2` |
| **Match Color** | — | Luminance 1–200, Color Intensity 1–200, Fade 0–100, Neutralize; Source doc/layer; use selection in source/target for stats; save/load statistics | Reinhard statistical transfer in Lab-like space **[doc]** |
| **Replace Color** | — | Color Range part (fuzziness, eyedroppers, localized) + Hue/Sat/Lightness + result swatch | composition of Color Range mask and H/S |
| **Equalize** | — | (with selection: whole image based on selection / selection only) | histogram CDF remap |
| *Newer layer kinds*† | yes | Color & Vibrance-style, Clarity & Dehaze, Grain (present in 2025–26 releases; parameters to be inventoried before implementing) | reuse Develop-filter kernels (§B.9) |

**Auto Tone / Auto Contrast / Auto Color** + *Auto Color Correction Options* dialog
(algorithms: Enhance Monochromatic Contrast, Enhance Per Channel Contrast, Find Dark & Light
Colors, Enhance Brightness and Contrast; Snap Neutral Midtones; target colours & clip %
default 0.10 %).

**Apply Image** (source doc/layer/channel, invert, blending mode incl. Add/Subtract with
scale/offset, opacity, preserve transparency, mask) and **Calculations** (two sources →
new channel/selection/doc) reuse the blend functions of [06].

Fusion rule: consecutive unmasked LUT-able adjustments (Levels, Curves, Invert, Posterize,
Threshold-less, B/C, Exposure) concatenate into one LUT per channel; matrix-type (Channel
Mixer) fuse as matrices; everything else chains in one fragment shader.

# B. Filters

Conventions: all filters operate on premultiplied data where spatial; respect selection
(feather-blended), active channels, transparency lock; edge mode = replicate unless noted;
declare ROI padding for tiled execution; GPU first, CPU reference; *smart-filter capable*
unless marked ✗SF. Ranges follow current PS (widened ones adopted).

## B.1 Top of menu
Last Filter · Convert for Smart Filters · **Filter Gallery…** (B.10) · Adaptive Wide Angle…†
· **Develop…** (Camera-Raw-style, B.9) · **Lens Correction…** · **Liquify…** · Vanishing
Point…† (post-1.0).

## B.2 Blur
| Filter | Parameters | Implementation |
|--------|-----------|----------------|
| Average | — | mean of selection/layer |
| Blur / Blur More | — | fixed 3×3 / 5×5-class kernels **[fit]** |
| Box Blur | Radius 1–2000 | running sums / 2-pass GPU |
| Gaussian Blur | Radius 0.1–1000 px | separable; σ(radius) **[fit]** by step-edge erf fit; large radii: downsample pyramid + bilinear-tap merge (GPU), 3× box or IIR (CPU) |
| Lens Blur ✗SF-less | Depth Map source ▾ (none/transparency/mask/alpha), Blur Focal Distance, Invert; Iris shape (tri…octagon), Radius 0–100, Blade Curvature, Rotation; Specular Brightness, Threshold; Noise amount, uniform/gaussian, mono | scatter-as-gather bokeh with N-gon aperture, CoC from depth, highlight boost in pseudo-linear space |
| Motion Blur | Angle, Distance 1–2000 | AA line kernel |
| Radial Blur | Amount 1–100, Spin/Zoom, Draft/Good/Best, centre picker | 1-D blur in polar / log-polar space |
| Shape Blur | Radius, shape ▾ | kernel = custom shape |
| Smart Blur | Radius, Threshold, Quality, Mode (Normal/Edge Only/Overlay Edge) | thresholded selective average **[fit]** |
| Surface Blur | Radius 1–100, Threshold 2–255 | triangular-range bilateral: `w = max(0, 1−|I−Ic|/(2.5T))` **[fit]** |

**Blur Gallery** (modal workspace, on-canvas pin widgets, multiple pins, Effects tab: bokeh
light/colour/range; Motion effects; Noise tab; save mask to channel): Field Blur, Iris Blur,
Tilt-Shift, Path Blur, Spin Blur — spatially-varying blur radius field → variable-radius
gather on GPU.

## B.3 Distort (inverse mapping, bicubic sampling; falloffs **[fit]**)
Displace (H/V scale %, map PSD, Stretch/Tile, Wrap/Repeat edge; `d = (map−128)/128·scale`) ·
Pinch (±100 %) · Polar Coordinates (R→P / P→R) · Ripple (Amount ±999, Size S/M/L) · Shear
(curve editor, wrap/repeat) · Spherize (±100 %, Normal/H only/V only) · Twirl (±999°:
`θ' = θ + α(1−r/R)²`) · Wave (generators 1–999, wavelength min/max, amplitude min/max, scale
H/V, Sine/Triangle/Square, Randomize seed, wrap/repeat) · ZigZag (Amount, Ridges, Around
Center / Out From Center / Pond Ripples). (Diffuse Glow, Glass, Ocean Ripple live in the
Gallery.)

## B.4 Noise
Add Noise (Amount 0.1–400 %, Uniform/Gaussian, Monochromatic; scale **[fit]**) · Despeckle ·
Dust & Scratches (Radius 1–500, Threshold 0–255: `|median−v| > t ? median : v` **[exact]**) ·
Median (Radius 1–500; constant-time histogram median, Perreault–Hébert / Weiss **[doc]**) ·
Reduce Noise (Strength, Preserve Details, Reduce Color Noise, Sharpen Details, Remove JPEG
Artifact; Advanced per-channel) — luma NLM/wavelet + chroma blur **[fit]**.

## B.5 Pixelate
Color Halftone (Max Radius 4–127, 4 screen angles 108/162/90/45) · Crystallize (Cell 3–300;
jittered-grid Voronoi via jump flooding) · Facet · Fragment · Mezzotint (10 types) · Mosaic
(Cell 2–200) · Pointillize (Cell 3–300, bg colour).

## B.6 Render
Clouds / Difference Clouds (fg/bg multi-octave lattice noise, 256-period; Alt = high
contrast; statistical match only) · Fibers (Variance, Strength, Randomize) · Lens Flare
(Brightness 10–300 %, 4 lens types, centre picker) · Lighting Effects† (removed from current PS together with 3D — verify; kept here as an optional late item: Spot/Point/Infinite
lights, presets, texture channel + height, gloss/metallic/exposure/ambience) · Flame†,
Picture Frame†, Tree† (scripted generators; post-1.0).

## B.7 Sharpen
Sharpen / Sharpen More / Sharpen Edges (fixed kernels **[fit]**) · **Unsharp Mask** (Amount
1–500 %, Radius 0.1–1000, Threshold 0–255: `v + a·(v−G_r(v))` where `|v−G| ≥ t`) · **Smart
Sharpen** (Amount 1–500 %, Radius 0.1–64, Reduce Noise 0–100 %, Remove ▾ Gaussian / Lens
Blur / Motion Blur + angle; Shadows & Highlights: Fade Amount, Tonal Width, Radius; Legacy /
More Accurate) — USM / few-iteration Richardson–Lucy with disc or line PSF + halo suppression
**[fit]** · Shake Reduction ✗ (removed from PS).

## B.8 Stylize & Other & Video
**Stylize:** Diffuse (Normal/Darken Only/Lighten Only/Anisotropic) · Emboss (Angle, Height
1–100, Amount 1–500 %: `0.5 + a·(I(p−d) − I(p+d))`) · Extrude (Blocks/Pyramids, Size, Depth
random/level-based, solid front faces, mask incomplete) · Find Edges (inverted Sobel) · Oil
Paint (Stylization, Cleanliness, Scale, Bristle Detail, Lighting ☑ angle, Shine — structure-
tensor flow + LIC smear + bump shading; anisotropic-Kuwahara-class **[fit]**) · Solarize ·
Tiles (Number, Max Offset %, fill empty with ▾) · Trace Contour (Level, Lower/Upper) · Wind
(Wind/Blast/Stagger, From Left/Right).
**Other:** Custom (5×5 kernel, Scale, Offset; `.acf`) · High Pass (Radius 0.1–1000:
`v − G_r(v) + 0.5`) · HSB/HSL (parametric colour-space swap) · Maximum / Minimum (Radius
0.2–500, Preserve Squareness / Roundness — morphological via EDT for roundness) · Offset
(H/V px, Set to Transparent / Repeat Edge / Wrap Around).
**Video:** De-Interlace · NTSC Colors.

## B.9 Workspaces
- **Develop… (Camera-Raw-style filter; also the RAW-open dialog)** — panels: *Basic*
  (Profile-less; WB ▾ + Temp/Tint (absolute K for RAW, ±100 relative otherwise; Robertson
  isotherms + Bradford per the public DNG SDK **[doc]**), Exposure ±5, Contrast, Highlights,
  Shadows, Whites, Blacks (image-adaptive local tone mapping, local-Laplacian family
  **[fit]**), Texture, Clarity, Dehaze (dark-channel prior **[doc]**), Vibrance, Saturation) ·
  *Curve* (parametric 4-region + point, per channel; hue-preserving application per DNG SDK) ·
  *Detail* (Sharpening amount/radius/detail/masking; Noise Reduction luma/colour) · *Color
  Mixer* (HSL, 8 bands) · *Color Grading* (3-way wheels + blending/balance) · *Optics*
  (distortion, vignette, defringe) · *Geometry* (Upright-less manual: vertical, horizontal,
  rotate, aspect, scale, offset) · *Effects* (Grain amount/size/roughness, Vignette
  amount/midpoint/roundness/feather/highlights, style) · *Calibration*†. Tools: crop, spot
  heal, masks† (brush / linear / radial gradient local adjustments), red-eye, before/after
  views, presets, histogram with clipping warnings. Pipeline in linear wide-gamut space.
- **Liquify** — tools: Forward Warp W, Reconstruct R, Smooth E, Twirl Clockwise C (Alt =
  CCW), Pucker S, Bloat B, Push Left O, Freeze Mask F, Thaw Mask D, Hand, Zoom; brush Size
  1–15000, Density, Pressure, Rate, Stylus Pressure, Pin Edges; Load/Save Mesh, Reconstruct
  Options (amount), Mask Options (from selection/transparency/layer mask; invert/none/all),
  View Options (image, mesh size/colour, mask colour, backdrop layer + opacity). Backward
  displacement field on a coarse grid; per-dab field updates per
  [agent math]: forward `D(x) ← D(x−wδ) − wδ`, pucker/bloat `D ∓= w·k·(x−c)`, twirl rotation,
  reconstruct `D *= 1−w·k`, all × (1−freeze); single final bicubic resample from the
  original. Face-Aware ✗.
- **Lens Correction** — Auto (lensfun-style DB†) + Custom: Remove Distortion ±100, Chromatic
  Aberration (R/C, G/M, B/Y fringe), Vignette amount/midpoint, Transform (vertical/horizontal
  perspective, angle, scale), grid, edge ▾.
- **Content-Aware Fill** — sampling-area brush (green overlay; Auto / Rectangular / Custom),
  Color Adaptation ▾, Rotation Adaptation ▾, Scale ☑, Mirror ☑, Output To ▾ (Current Layer /
  New Layer / Duplicate Layer), live preview pane. PatchMatch + coarse-to-fine voting
  (Barnes 2009, Wexler 2007, Darabi 2012 **[doc]**) in kernel pool, WASM-SIMD candidate #1.

## B.10 Filter Gallery (47 effects, stackable effect layers, 8-bit RGB/Gray only like PS)
Dialog: left preview with zoom; centre category folders with thumbnails; right parameter
pane + effect-layer stack (eye, new, delete, reorder).
- **Artistic (15):** Colored Pencil, Cutout, Dry Brush, Film Grain, Fresco, Neon Glow, Paint
  Daubs, Palette Knife, Plastic Wrap, Poster Edges, Rough Pastels, Smudge Stick, Sponge,
  Underpainting, Watercolor.
- **Brush Strokes (8):** Accented Edges, Angled Strokes, Crosshatch, Dark Strokes, Ink
  Outlines, Spatter, Sprayed Strokes, Sumi-e.
- **Distort (3):** Diffuse Glow, Glass, Ocean Ripple.
- **Sketch (14):** Bas Relief, Chalk & Charcoal, Charcoal, Chrome, Conté Crayon, Graphic Pen,
  Halftone Pattern, Note Paper, Photocopy, Plaster, Reticulation, Stamp, Torn Edges, Water
  Paper. (use fg/bg colours)
- **Stylize (1):** Glowing Edges. **Texture (6):** Craquelure, Grain, Mosaic Tiles,
  Patchwork, Stained Glass, Texturizer.
Each has 2–4 sliders with PS's names/ranges. No exact public algorithms → built from a
shared toolkit (Kuwahara variants, posterize + edge darkening, directional smears, halftone
screens, emboss/bump lighting, procedural paper textures) and tuned by eye **[fit, low
priority, tolerance = "recognisably the same effect"]**.

## B.11 Fade, blending options, masks
**Edit ▸ Fade** (opacity + mode) after any filter, paint stroke, or adjustment. Smart filters:
per-filter Blending Options (mode, opacity), reorder, enable eye, one shared filter mask,
double-click to re-edit parameters. Filters unavailable for the current mode/depth are
greyed exactly as in PS (e.g. Gallery in 16-bit).
