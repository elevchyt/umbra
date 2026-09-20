# 06 — Compositing math

Normative for both the GPU compositor and the CPU reference (`kernels/composite`). All values
normalised to 0…1. `Cb, αb` backdrop colour/alpha; `Cs, αs` source colour/alpha (straight,
not premultiplied); `B(Cb,Cs)` blend function. Blending operates on **encoded** channel
values (document space) — Photoshop's default — except: 32-bit docs (linear), and when
*Blend RGB Colors Using Gamma 1.0* is enabled (decode → blend → encode around §1).

Confidence tags: **[doc]** publicly documented (PDF 1.7 / ISO 32000-1 §11.3.5, W3C
Compositing & Blending L1) · **[obs]** established by community reverse-engineering, verify
with goldens · **[fit]** must be fitted against Photoshop output.

## 1. General equation **[doc]**
```
αr = αs + αb·(1 − αs)
Cr = [ (1 − αs)·αb·Cb + αs·( (1 − αb)·Cs + αb·B(Cb, Cs) ) ] / αr
```
i.e. where the backdrop is transparent the source shows unblended. `αs` here is the
*effective* source alpha of §3.

## 2. Blend functions (menu order, PSD key)

Separable (per channel) **[doc]** unless tagged:

| Group | Mode | `B(b, s)` |
|-------|------|-----------|
| Normal | Normal `norm` | `s` |
| | Dissolve `diss` | `s`, but αs is thresholded against a fixed per-pixel hash noise: `αs' = (αs > noise(x,y)) ? 1 : 0`; pattern is position-stable in document space, regenerated only by seed **[fit]** |
| Darken | Darken `dark` | `min(b,s)` |
| | Multiply `mul ` | `b·s` |
| | Color Burn `idiv` | `s==0 ? 0 : 1 − min(1,(1−b)/s)` (b==1 → 1) |
| | Linear Burn `lbrn` | `max(0, b+s−1)` |
| | Darker Color `dkCl` | whole pixel: `lum(s) < lum(b) ? s : b` (non-separable, Lum of §2.1) **[obs]** |
| Lighten | Lighten `lite` | `max(b,s)` |
| | Screen `scrn` | `b+s−b·s` |
| | Color Dodge `div ` | `s==1 ? 1 : min(1, b/(1−s))` (b==0 → 0) |
| | Linear Dodge (Add) `lddg` | `min(1, b+s)` |
| | Lighter Color `lgCl` | `lum(s) > lum(b) ? s : b` **[obs]** |
| Contrast | Overlay `over` | `HardLight(s, b)` = `b≤.5 ? 2bs : 1−2(1−b)(1−s)` |
| | Soft Light `sLit` | `s≤.5 ? 2bs + b²(1−2s) : 2b(1−s) + √b·(2s−1)` (community "Photoshop" form). Algebraically identical to the PDF/W3C form except where `s>.5 ∧ b≤.25`, where W3C swaps `√b` for `((16b−12)b+4)b`. **[fit]**: the ramp test in that corner decides which one ships |
| | Hard Light `hLit` | `s≤.5 ? 2bs : 1−2(1−b)(1−s)` |
| | Vivid Light `vLit` | `s≤.5 ? ColorBurn(b, 2s) : ColorDodge(b, 2s−1)` **[obs]** |
| | Linear Light `lLit` | `clamp(b + 2s − 1)` **[obs]** |
| | Pin Light `pLit` | `s≤.5 ? min(b, 2s) : max(b, 2s−1)` **[obs]** |
| | Hard Mix `hMix` | `(b + s ≥ 1) ? 1 : 0` at 100 % fill; see §3.2 **[obs]** |
| Inversion | Difference `diff` | `|b−s|` |
| | Exclusion `smud` | `b+s−2bs` |
| | Subtract `fsub` | `max(0, b−s)` **[obs]** |
| | Divide `fdiv` | `s==0 ? 1 : min(1, b/s)` **[obs]** |
| Component | Hue `hue ` | `SetLum(SetSat(s, Sat(b)), Lum(b))` |
| | Saturation `sat ` | `SetLum(SetSat(b, Sat(s)), Lum(b))` |
| | Color `colr` | `SetLum(s, Lum(b))` |
| | Luminosity `lum ` | `SetLum(b, Lum(s))` |
| Group only | Pass Through `pass` | §4 |
| Paint tools only | Behind | paint only where layer is transparent: composite stroke *under* existing layer pixels |
| | Clear | stroke erases (αlayer ·= 1 − αstroke); also Fill/Stroke/Bucket/Line |

### 2.1 Non-separable helpers **[doc]**
```
Lum(C) = 0.3 R + 0.59 G + 0.11 B
ClipColor(C): l=Lum(C); n=min(C); x=max(C)
   if n<0: C = l + (C−l)·l/(l−n);   if x>1: C = l + (C−l)·(1−l)/(x−l)
SetLum(C,l) = ClipColor(C + (l − Lum(C)))
Sat(C) = max(C) − min(C)
SetSat(C,s): scale so that max−min = s keeping mid proportion; if max==min → 0
```
CMYK docs: component modes operate on CMY with K taken from backdrop (Hue/Sat/Color) or
source (Luminosity) per PDF spec §11.3.5.3; Lab/Gray: component & Darker/Lighter Color modes
are disabled in the UI, as in Photoshop (Gray also disables Hue…Luminosity).

## 3. Opacity, Fill, masks — the effective source

Per layer, per pixel:
```
m   = rasterMaskTerm · vectorMaskTerm                       (each term = 1 if absent/disabled)
rasterMaskTerm = 1 − density·(1 − blurGauss(mask, feather))
content α:   αc = αpixels · (fill) · m · blendIf(Cs, Cb)     (§5)
effects α:   rendered per §6, multiplied by m unless "Layer Mask Hides Effects" says otherwise
layer result = composite(effects-under, content, effects-over)   then  · opacity
```
- **Opacity** scales everything (content + effects). **Fill** scales content only.
- Locked channels (Advanced Blending R/G/B boxes): after blending, restore excluded channels
  from backdrop.

### 3.1 The "special 8" **[obs → fit]**
For Color Burn, Linear Burn, Color Dodge, Linear Dodge, Vivid Light, Linear Light, Hard Mix,
Difference, **Fill is applied inside the blend function** instead of as coverage, so
Fill 50 % ≠ Opacity 50 %:
```
αs_blend = αpixels·m·opacity            (fill NOT included in coverage)
Cs'      = mix(N, Cs, fill)             N = mode's neutral colour:
           black: Color Dodge, Linear Dodge, Difference
           white: Color Burn, Linear Burn
           50 % grey: Vivid Light, Linear Light
B'(b,s)  = B(b, Cs')
```
### 3.2 Hard Mix with Fill **[fit]**
`B(b,s,f) = clamp( (b + f·s − f) / (1 − f) )` for `f<1` (→ step at `b+s≥1` as `f→1`; identity
at `f=0`). Starting hypothesis; the golden matrix (fill 10…100 % × grey ramps) is the judge.
All of §3.1 must be validated the same way before M2 exit.

## 4. Groups

- **Isolated** (any mode ≠ Pass Through): children composite onto a *transparent* fresh
  accumulator → result `(Cg, αg)` → treated as a pixel layer with the group's mode, opacity,
  fill-less, mask, effects (effects use αg as shape).
- **Pass Through**: children composite directly onto the parent's accumulator `A0 → A1`;
  then group opacity & mask `k = opacity·m` apply as `A = mix(A0, A1, k)` (premultiplied
  lerp, colour and alpha). Adjustment layers inside therefore affect everything below the
  group — the defining Photoshop behaviour. A pass-through group with effects, or that is a
  clipping base/clipped, is forced isolated (as PS does).
- **Artboards**: isolated + clipped to rect + background fill.

## 5. Blend If **[obs]**
For each enabled channel row (Gray = `Lum` using the doc's grey conversion; or R/G/B):
```
ramp(v; b0,b1,w0,w1) = smooth-less linear trapezoid:
   v<b0 → 0 ; b0..b1 → (v−b0)/(b1−b0) ; b1..w0 → 1 ; w0..w1 → 1−(v−w0)/(w1−w0) ; v>w1 → 0
blendIf = Π_rows ramp(Cs_row; thisLayer) · ramp(Cb_row; underlying)
```
(unsplit slider ⇒ `b0==b1`, hard threshold). "Underlying" reads the backdrop *as composited
so far within the current isolation scope*. Multiplies content coverage (and effects shape
when *Transparency Shapes Layer* is on).

## 6. Clipping groups **[obs]**
Base layer `L0` with clipped layers `L1…Ln` (each `clipped = true` directly above):
1. `T = L0.content` (colour + αbase, with L0's fill but **without** L0 opacity/mode; interior
   effects included if "Blend Interior Effects as Group").
2. If `L0.blendClippedLayersAsGroup` (default **on**): composite `L1…Ln` onto `T` colour
   using each one's own mode/opacity, with **alpha locked to αbase**; then blend `T` to the
   backdrop with `L0`'s mode and opacity.
   If **off**: each `Li` blends directly to the backdrop with its own mode, its coverage
   multiplied by αbase; `L0` blends first with its own mode.
3. L0's exterior effects (drop shadow, outer glow, outside stroke) are drawn from αbase as usual.

## 7. Knockout **[obs]**
`shallow`: before blending this layer, replace the backdrop inside its shape (`αc` at fill
100 %) with the backdrop as it was at the entry of the nearest enclosing group (pass-through
groups count as boundaries only when they are the immediate parent—PS rule); `deep`: with the
document's bottom (Background layer or transparency). Then blend content with `fill`.
Classic use: Fill 0 % + knockout = punch a hole through the group.

## 8. Adjustment & fill layers
Adjustment: `Cs = f(Cb)` evaluated on the backdrop *within the current scope*, `αs = m·opacity
(·blendIf)`, result alpha **unchanged** (`αr = αb`; no coverage is added), blended with the
layer's mode: `Cr = mix(Cb, B(Cb, f(Cb)), αs)`. Clipped adjustment: evaluated on the clip
temp `T` only. Fill layers: infinite source with `αs = m·fill·opacity`, obey §1.

## 9. Layer effects rendering **[obs/fit]**

Let `S` = layer shape alpha (content α at fill 100 %, after masks unless hidden-by-mask
options; for groups: αg). Stack order, bottom → top:

`Drop Shadow(s) → Outer Glow → layer content @fill → Pattern Overlay → Gradient Overlay →
Color Overlay → Satin → Inner Glow → Inner Shadow(s) → Stroke(s) → Bevel & Emboss
(shadow + highlight)` — i.e. the Layer Style dialog list read bottom-to-top (top of list =
front). Starting hypothesis **[fit]**: the Stroke/Bevel interleave and multi-instance order
are pinned by goldens and by comparing with PS's own *Create Layers* output. Interior
effects merge into content *before* the layer's mode/fill only when "Blend Interior Effects
as Group" is on.

Open reference implementations to study (ideas only — GPL): Krita `libs/image/layerstyles`
(`kis_ls_*_filter.cpp`, bump-map based bevel), psd-tools `composite/effects.py` (MIT).

Primitives:
- `blur(x, size)`: PS "size" ≈ box-blur-approximated Gaussian; start with 2–3 iterated box
  blurs of total width = size px **[fit]** — finite support ≈ size, so "size = σ" is wrong;
  measure with an impulse. `spread/choke p%`: two candidate models — (a) Krita's: dilate by
  `round(size·p)` px then blur the remaining `size·(1−p)`; (b) blur by size then remap
  `α' = clamp(α_blur / (1−p))`. Both give a hard edge at p = 100 %; intermediate spreads on
  a disc decide **[fit]**.
- `EDT(S)`: exact Euclidean distance transform — GPU **jump flooding** at interactive time,
  exact Felzenszwalb/Meijster on CPU for export. Sub-pixel accurate using α as coverage.
- `contour(x)`: 256-entry LUT from the contour curve, optionally anti-aliased; applied to the
  blurred matte. `noise`: per-pixel hash dither on α. `jitter`: gradient-position hash.

| Effect | Recipe |
|--------|--------|
| Drop Shadow | `M = contour(blur(spread(S), size))` offset by `(−cos θ, sin θ)·distance`; colour·`M`·opacity, blend mode onto backdrop; if *Layer Knocks Out* : `M ·= (1 − S_fill100)` |
| Inner Shadow | `M = contour(blur(choke(1−S), size))` offset, clipped to `S`; blended onto content |
| Outer Glow | softer: as drop shadow w/o offset; precise: `M = contour(1 − EDT_out/size)`; colour or gradient(M); range/jitter reshape M |
| Inner Glow | same, inside; source edge (from boundary inward) or centre (inverted) |
| Satin | `A = blur(S shifted +d)`, `B = blur(S shifted −d)`; `M = contour(|A − B|)` (invert option), clipped to S |
| Color / Gradient / Pattern Overlay | fill clipped to `S`, own mode+opacity onto content; gradient aligned to layer bounds or doc, scale/angle/offset; pattern phase linked to layer origin |
| Stroke | `d = signed EDT`; coverage = AA band: outside `0<d≤w`, inside `−w≤d<0`, centre `|d|≤w/2`; fill colour/gradient (shape-burst = gradient along `d`)/pattern. Drawn over content; "overprint" blends against content |
| Bevel & Emboss | height field `H`: Inner Bevel `min(EDT_in, size)`, Outer Bevel `size − min(EDT_out,size)`, Emboss both halves, Pillow mirrored; technique Smooth = blur(H, …), Chisel Hard = exact EDT, Chisel Soft = EDT + light blur; then `soften` blur. Normal `n = normalize(−∂H/∂x·depth, −∂H/∂y·depth, 1)`; light `l` from angle/altitude; `I = gloss(n·l)`; highlights = `max(0, I−I₀)`, shadows = `max(0, I₀−I)` (`I₀` = flat-surface intensity) composited with their own colour/mode/opacity; Contour sub-effect reshapes `H` profile over `range`; Texture adds pattern luminance·depth to `H`. Stroke Emboss uses the stroke band as the shape |

Global Light supplies θ/altitude where "Use Global Light" is checked. Effects are cached per
layer keyed by (shape tiles hash, params, scale); *Scale Effects* and Image Size scale all px
parameters.

## 10. View pipeline
`composite (doc space, RGBA16F) → [channel view / mask overlay / quick-mask tint] →
[proof LUT] → display LUT → [gamut warning] → checkerboard under α → dither → canvas`.
Transparency checkerboard size/colours per preference. Pixel grid above 500 %.

## 11. Bit-depth notes
8-bit docs: layer data u8; accumulators 16F; quantise at readback with PS-like rounding.
16-bit: 0…32768 **[obs]** (so 50 % = 16384 exactly); Info panel shows 0…32768 in 16-bit
readout mode. 32-bit: linear floats, no clamp in Normal/Add/Multiply etc.; modes unavailable
in 32-bit are greyed as in PS (e.g. Color Burn/Dodge, Overlay family partly, Dissolve OK).
