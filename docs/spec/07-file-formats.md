# 07 — File formats

## 1. PSD / PSB (native)

References: Adobe Photoshop File Format Specification
(<https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/>) — incomplete (EngineData,
many descriptor blocks undocumented); `ag-psd` source + tests; `psd-tools` (Python) source;
observation of files.

### 1.1 Strategy
- **Start from `ag-psd`** (MIT, actively maintained, read+write, ~83 KB gz): vendored as
  `packages/psd` so we can extend it rather than wait on upstream; upstream what is generic.
  It already parses: layers/groups, raster + vector masks (incl. density/feather), 20+
  adjustment layers, layer effects (multi-instance), blending ranges, smart objects
  (`PlLd/SoLd` + linked files, warp, many smart filters), text (`TySh` + parsed EngineData),
  vector fill/stroke/origination, artboards, guides/slices/comps/resources, ABR, patterns.
- **Gaps we must close in our fork** (ordered): (1) tile-streaming decode straight into
  Planes, per-layer lazy (`useRawData`) so a 1 GB PSB never exists as one buffer;
  (2) **16-bit and 32-bit write**, 16-bit read into 0…32768 planes; (3) PSB > 2 GB (64-bit
  lengths, chunked IO through `platform.read/write` streams); (4) CMYK / Lab / Grayscale /
  Indexed / Bitmap / Duotone / Multichannel read + write; (5) Pattern Overlay effect data and
  zip-compressed patterns; (6) paragraph/character style sheets, vertical text write;
  (7) frame animation blocks; (8) **opaque pass-through** of every unknown image resource and
  additional-layer-info key (store bytes + key + position; re-emit unchanged) so re-saving
  never silently destroys data.
- The codec never renders. On **save** the engine supplies: every layer's raster (type,
  shape, fill and smart-object layers need their up-to-date rendered pixels or Photoshop
  prompts to update), the merged composite ("Maximize Compatibility", preference: always /
  ask / never), the thumbnail resource (1036), and updated smart-object previews.
- Runs in the codec worker; progress + cancel; hostile-file limits (dimension, layer count,
  allocation caps).

### 1.2 Mapping (model ⇄ PSD)

| Model | PSD location |
|-------|--------------|
| Size, mode, depth, channel count | Header |
| Indexed palette / duotone curves | Color Mode Data (duotone data preserved opaque) |
| Resolution, guides+grid, ICC (1039), thumbnail (1036), XMP (1060), EXIF (1058/1059), IPTC (1028), alpha names/ids/display info (1006/1045/1053/1077), layer comps (1065), slices (1050), paths (2000–2997, work path 1025, clipping path 2999), global light angle/altitude (1037/1049), print flags, count (1080), layer selection ids (1069), layer groups enabled (1072), onion/timeline (1075/4000+), pixel aspect (1064) | Image Resources |
| Layer records: bounds, channels, blend key (`norm`,`diss`,`dark`,`mul `,`idiv`,`lbrn`,`dkCl`,`lite`,`scrn`,`div `,`lddg`,`lgCl`,`over`,`sLit`,`hLit`,`vLit`,`lLit`,`pLit`,`hMix`,`diff`,`smud`,`fsub`,`fdiv`,`hue `,`sat `,`colr`,`lum `,`pass`), opacity, clipping, flags (transparency protected, hidden, pixel-data-irrelevant), mask data (+ real user mask, density/feather params), blending ranges (Blend If), name | Layer record |
| Unicode name `luni`, id `lyid`, group dividers `lsct`/`lsdk`, fill opacity `iOpa`, knockout `knko`, blend clipped `clbl`, blend interior `infx`, locks `lspf`, label colour `lclr`, transparency shapes `tsly`, mask-hides-fx `lmgm`/`vmgm`, effects `lfx2`/`lmfx` (+legacy `lrFX`), vector mask `vmsk`/`vsms`, vector stroke `vstk`, stroke content `vscg`, origination (live shapes) `vogk`, fills `SoCo`/`GdFl`/`PtFl`, type `TySh`, smart object `SoLd`/`SoLE`/`PlLd`, smart filters in `SoLd` `filterFX` + filter mask `FMsk`, linked data `lnkD`/`lnk2`/`lnk3`/`lnkE`, artboard `artb`/`artd`, frame `PxSc`-family, adjustment keys `brit`/`CgEd`,`levl`,`curv`,`expA`,`vibA`,`hue2`,`blnc`,`blwh`,`phfl`,`mixr`,`clrL`,`nvrt`,`post`,`thrs`,`grdm`,`selc`, layer metadata `shmd`, 16/32-bit layer blocks `Lr16`/`Lr32`, patterns `Patt`/`Pat2`/`Pat3`, text engine globals `Txt2`, filter mask, user mask `LMsk`, saving-merged-transparency `Mtrn`/`Mt16`/`Mt32` | Additional Layer Information |
| Merged composite (+ alpha/spot channels) | Image Data section |

Channel compression: raw, PackBits RLE (default write), ZIP, ZIP-with-prediction (read; write
for 16/32-bit). Layer rasters are bounds-cropped; masks carry their own rect + default colour.

### 1.3 Fidelity policy when opening
1. Anything we fully support → live, editable.
2. Parsed but not yet renderable (e.g. an unsupported smart filter, missing font, unknown
   adjustment) → layer shows a ⚠ badge, renders from the **raster stored in the PSD** for that
   layer, stays byte-preserved; editing it offers *Rasterize* or *Keep*.
3. Unknown blocks → carried through untouched.
A post-open report ("This document contains … which will be preserved but not editable") is
available from the status bar, never a blocking dialog unless data would be lost.

### 1.4 Validation
Corpus of real-world PSDs (incl. ag-psd & psd-tools fixtures, files authored in each PS
feature area) → (a) our composite vs the embedded Photoshop composite (SSIM / max-Δ
thresholds per feature tag); (b) read→write→read structural equality; (c) manual and scripted
open-in-Photoshop checks of saved files for the release checklist.

## 2. Other image formats

| Format | Open | Save / Export | Implementation |
|--------|------|---------------|----------------|
| PNG (8/16, iCCP, gAMA, APNG frames→layers) | ✔ | ✔ (Export As: size, transparency, 8-bit quantised "PNG-8", interlace, metadata) | 8-bit fast path: `ImageDecoder`; 16-bit/ICC: UPNG-class decoder in worker; encode: own deflate (fflate) + optional oxipng WASM |
| JPEG (baseline/progressive, CMYK/YCCK, EXIF orientation, ICC, XMP) | ✔ | ✔ quality 0–12 / 0–100 %, progressive, subsampling, embed profile, metadata options | decode: native, WASM when CMYK/ICC needed; encode: mozjpeg WASM (lazy) |
| WebP / AVIF / JPEG XL | ✔ | ✔ | native decode where possible; jSquash WASM encoders (lazy, AVIF ≈1.1 MB gz) |
| GIF (animated → frames/layers) | ✔ | ✔ (via Save for Web–style dialog: palette algorithm, colours, dither, transparency, matte, looping) | own LZW + quantiser (median-cut / octree / perceptual), dither (diffusion, pattern, noise) |
| TIFF (8/16/32, LZW/ZIP/JPEG, layers-in-TIFF = PSD block tag 37724, alpha, ICC, CMYK) | ✔ | ✔ (flat or with layers) | UTIF-class parser extended; layered TIFF reuses the PSD layer codec |
| BMP, TGA, ICO/CUR, PBM/PGM/PPM, DDS (read), HDR (Radiance), OpenEXR (basic, 32-bit docs) | ✔ | BMP/TGA/ICO/HDR/EXR ✔ | small own codecs |
| Camera RAW (DNG, CR2/CR3, NEF, ARW, RAF, ORF, RW2 …) | ✔ → opens in the Camera-Raw-style dialog | — | LibRaw WASM, **optional download** (LGPL, size) |
| HEIC/HEIF | ✔ | — | libheif WASM, optional download (patents/size) |
| SVG | ✔ (rasterise at chosen size, or as smart object; simple paths → shape layers) | ✔ Export As SVG for shape/type layers | native `<img>` rasterisation in isolated context; own path importer |
| PDF (pages → docs / smart object), AI (PDF-compatible), EPS (preview only) | ✔ | PDF export (flattened image; multi-artboard) | pdf.js lazy chunk; tiny PDF writer |
| PSD-adjacent: PSDT templates, PDD, PSB | ✔ | PSB ✔ | same codec |
| Others' natives: XCF (GIMP), ORA (OpenRaster), KRA (Krita), Procreate*, Sketch/XD/Figma* | ORA/KRA/XCF read (post-1.0); * non-goal | ORA write (post-1.0) | — |

Dialogs: **Save** `Ctrl+S`, **Save As** `Ctrl+Shift+S` (formats that keep layers), **Save a
Copy** `Ctrl+Alt+S` (flattening formats), **Export ▸ Export As…** `Ctrl+Alt+Shift+W`
(multi-asset, scale sets @1x/@2x, format options, canvas size, metadata, colour-space convert
to sRGB, live preview + file size), **Quick Export as PNG**, **Save for Web (Legacy)**
`Ctrl+Alt+Shift+S` (2-up/4-up, optimise to size, colour table editor), **Layers to Files**,
**Artboards to Files/PDF**, **Layer Comps to Files**, **Color Lookup Tables…**, **Paths to
SVG** (in place of Illustrator). Place Embedded / Place Linked, Open As Smart Object, Open
Recent, Revert `F12`, File Info (XMP editor), Automate ▸ Batch / Create Droplet-less /
Crop and Straighten Photos / Contact Sheet / Photomerge* / Merge to HDR* / Image Processor /
Load Files into Stack / Fit Image (* late).

## 3. Presets

| Kind | Formats read | Write | Notes |
|------|--------------|-------|-------|
| Brushes | `.abr` v1, v2, v6–v10 (sampled tips + computed tips + full dynamics descriptors), `.tpl` tool presets (read) | `.abr` v6+ | ag-psd has an ABR reader to extend; Krita/GIMP parsers as references |
| Gradients | `.grd` v3 & v5 (solid + noise gradients, colour/opacity stops, midpoints, smoothness, method), `.ggr`, SVG/CSS gradients | `.grd` v5 | |
| Patterns | `.pat` (incl. zip-compressed, all depths/modes) | `.pat` | |
| Styles | `.asl` (descriptor-based; embedded patterns) | `.asl` | Krita's ASL code is a good reference |
| Swatches | `.aco` v1/v2, `.ase`, `.act` (colour table), GPL, CSS/hex paste | `.aco`, `.ase` | |
| Contours / curves-type | `.shc` contours, `.acv` curves, `.amp` arbitrary map, `.alv` levels, `.ahu` hue/sat, `.blw` B&W, `.cha` channel mixer, `.asv` selective colour, `.eap` exposure, `.hdt`, `.pfl`-less | same | small binary formats, documented in the PSD spec appendix or trivially observable |
| LUTs | `.cube`, `.3dl`, `.look` (read), `.csp`, ICC abstract/device-link profiles | `.cube`, `.3dl`, `.csp`, ICC (Export ▸ Color Lookup Tables) | |
| Custom shapes | `.csh` | `.csh` | |
| Actions | `.atn` (read; steps mapped to our commands where a mapping exists, others flagged) | own JSON (+ `.atn` post-1.0) | descriptor parser shared with PSD codec |
| Keyboard shortcuts / workspaces / menus | own JSON; import `.kys` (best-effort) | own JSON | |
| Kernels | `.acf` Custom filter | `.acf` | |
| ICC profiles | `.icc`/`.icm` v2 + v4 | embed/export | bundle only freely-licensed profiles (sRGB, Display P3, Adobe-RGB-compatible (ClayRGB-style), ProPhoto-compatible, Gray Gamma 1.8/2.2, a free CMYK set e.g. from ECI/ICC registry where licence permits redistribution). **Never bundle Adobe's profiles or presets.** |

Default preset libraries (brushes, gradients, patterns, shapes, styles, swatches) are
**original content** organised to feel familiar (General / Dry Media / Wet Media / Special
Effects brush groups; Basics / Blues / Purples… gradient groups) — same organisation, no
copied assets.
