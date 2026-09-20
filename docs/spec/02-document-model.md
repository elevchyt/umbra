# 02 — Document model

The model mirrors Photoshop's so that PSD maps 1:1 (see [07](07-file-formats.md)) and every
panel shows what a Photoshop user expects. Types below are the `core` package's public shape
(abridged).

## 1. Document

```ts
interface Doc {
  id; name; fileHandle?; dirty: boolean;
  width: number; height: number;              // px, 1 … 300 000 (PSB limit)
  resolution: { ppi: number; unit: 'ppi'|'ppcm' };      // metadata only; drives rulers/type pt size/print size
  mode: 'RGB'|'Grayscale'|'CMYK'|'Lab'|'Indexed'|'Bitmap'|'Duotone'|'Multichannel';
  depth: 8|16|32;                             // 1 for Bitmap; 32 only RGB/Gray
  profile: IccProfileRef | null;              // null = "Untagged RGB" as in the status bar
  root: LayerNode[];                          // top-most first, as displayed in Layers panel
  background?: true;                          // bottom layer flagged "Background" (locked, no transparency, italic name)
  channels: Channel[];                        // extra: alpha + spot channels (component channels are implicit)
  paths: SavedPath[]; workPath?: Path;        // Paths panel
  selection: Plane | null;                    // 8-bit (doc depth for 16) coverage, doc-bounds
  quickMask: boolean; quickMaskOpts;
  guides: Guide[]; grid; slices: Slice[]; rulersOrigin; counts; notes: Note[];
  layerComps: LayerComp[];
  activeLayerIds: Id[]; activeTarget: 'pixels'|'mask'|'vectorMask'|'smartFilterMask';
  activeChannels: ChannelSel;                 // composite or subset, for channel-targeted editing
  colorSamplers: Point[≤10]; 
  metadata: { xmp?, exif?, iptc? };           // carried through
  unknownPsdBlocks: OpaqueBlock[];            // image resources / tagged blocks we don't interpret → re-emitted on save
  animation?: FrameAnimation;                 // late milestone
}
```

Per-window **view state** (not in history): zoom (0.1 %…12 800 %), scroll, rotation (Rotate
View tool), screen mode, extras visibility, proof setup on/off, channel view, which document
tab/floating window. A document may have several views (Window ▸ Arrange ▸ New Window for…).

## 2. Layer tree

```ts
type LayerNode = PixelLayer | AdjustmentLayer | FillLayer | TypeLayer | ShapeLayer
               | SmartObjectLayer | GroupLayer | ArtboardLayer | FrameLayer;

interface LayerBase {
  id; name; visible: boolean; color: LabelColor;         // None, Red, Orange, Yellow, Green, Blue, Violet, Gray
  opacity: 0..100; fill: 0..100; blendMode: BlendMode;   // group default 'passThrough'
  clipped: boolean;                                      // clipping mask onto the nearest non-clipped layer below
  locks: { transparency, imagePixels, position, artboardNesting, all: boolean };
  mask?: RasterMask;  vectorMask?: VectorMask;
  effects?: LayerEffects;  effectsVisible: boolean;
  blending: AdvancedBlending;
  linkGroup?: Id;                                        // linked layers move/transform together
  psdExtra?: OpaqueBlock[];                              // unknown per-layer tagged blocks, preserved
}
interface RasterMask { plane: Plane; defaultColor: 0|255; enabled: boolean; linked: boolean;
                       density: 0..100; feather: 0..1000 /*px*/; }        // Properties ▸ Masks
interface VectorMask { path: Path; enabled; linked; density; feather; }
interface AdvancedBlending {
  channels: { r,g,b } | { c,m,y,k } | …;                 // per-channel participation
  knockout: 'none'|'shallow'|'deep';
  blendInteriorEffectsAsGroup: boolean;  blendClippedLayersAsGroup: boolean /*default true*/;
  transparencyShapesLayer: boolean /*true*/;  layerMaskHidesEffects: boolean;  vectorMaskHidesEffects: boolean;
  blendIf: { channel: 'gray'|'r'|'g'|'b'|…, thisLayer: [b0,b1,w0,w1], underlying: [b0,b1,w0,w1] }[];  // split sliders
}
```

| Layer type | Payload | Notes |
|-----------|---------|-------|
| **Pixel** | `plane` (colour+alpha), unbounded extent | The "Background" layer is a pixel layer with the `background` doc flag: always bottom, locked, no alpha, no mask/opacity/mode; *Layer from Background* converts it |
| **Adjustment** | `{kind, params}` — one of the 16 adjustment-layer kinds in [05](05-adjustments-filters.md) | Has a mask by default (white). Blend mode / opacity apply to adjusted-vs-backdrop mix. Clippable |
| **Fill** | Solid Color `{color}`, Gradient `{gradient, style, angle, scale, reverse, dither, align, offset, method}`, Pattern `{patternRef, scale, angle, linked, offset}` | Infinite extent, shaped by mask / vector mask |
| **Type** | Rich text model (§6) + transform + warp; cached raster | Rasterize Type → pixel layer; Convert to Shape; Create Work Path |
| **Shape** | `path` (vector mask semantics) + fill (none/solid/gradient/pattern) + stroke `{width, align in/center/out, caps, joins, dashes, fill}` + live-shape params (rect w/ 4 corner radii, ellipse, polygon/star, line, triangle, custom) | Path operations per sub-path: combine, subtract, intersect, exclude |
| **Smart Object** | `source`: embedded (`Doc` or opaque bytes+decoded raster) or linked (path); `transform` (affine/perspective quad + warp); `smartFilters: {filterId, params, blendMode, opacity, enabled}[]` + one filter mask | Double-click opens the embedded doc as a tab; saving it re-renders the parent. Instances share a source unless *New Smart Object via Copy*. Convert to Layers, Rasterize, Replace Contents, Relink, Export Contents |
| **Group** | `children`, `expanded` | `passThrough` default; any other mode → isolated. Can carry mask, vector mask, effects, clipping (modern PS), opacity |
| **Artboard** | Group + `rect` + background (white/black/transparent/custom) | Clips children; canvas becomes the union; per-artboard export. Basic support |
| **Frame** | `shape` (rect/ellipse/any path) + one content layer (usually SO) | Basic support: acts as vector-mask'd smart object |

### Layer operations (all commands; all undoable)
New / duplicate (`Ctrl+J` = layer via copy, from selection if any; `Ctrl+Shift+J` via cut) /
delete / rename / reorder (`Ctrl+[ ]`, `Ctrl+Shift+[ ]`) / group (`Ctrl+G`) / ungroup /
select (click, Shift/Ctrl multi, `Alt+[ ]`, `Alt+, .`, Auto-Select on canvas, right-click
canvas layer list) / link / lock / hide others (Alt-click eye) / merge down / merge visible
/ **stamp visible** (`Ctrl+Shift+Alt+E`) / flatten / rasterize (type, shape, SO, style, fill
content, vector mask) / convert to SO / align & distribute / Auto-Align* / Auto-Blend* /
create & release clipping mask (`Ctrl+Alt+G`, Alt-click between rows) / layer via
selection / Matting (Defringe, Remove Black/White Matte) / filter layers by
Kind·Name·Effect·Mode·Attribute·Color·Smart Object·Selected·Artboard / isolate.
(*late milestone)

### Mask operations
Add reveal-all / hide-all (Alt-click icon) / from selection (reveal/hide) / from transparency;
vector mask from current path (Ctrl-click icon); **Alt-click thumb = view mask**,
**Shift-click = disable (red ✕)**, **`\` = rubylith overlay**, **Ctrl-click = load as
selection** (+Shift add, +Alt subtract, +Shift+Alt intersect); link toggle; apply; delete;
invert (`Ctrl+I`); density & feather (non-destructive, Properties panel); Select and Mask…;
Color Range… from Properties; unlink to move mask vs content independently.

## 3. Layer effects (styles)

`effects` holds, in Photoshop's fixed render order, zero-or-more instances (modern PS allows
up to 10 instances of Stroke, Inner Shadow, Color Overlay, Gradient Overlay, Drop Shadow):

| Effect | Parameters |
|--------|------------|
| **Bevel & Emboss** | style (Outer/Inner Bevel, Emboss, Pillow Emboss, Stroke Emboss), technique (Smooth, Chisel Hard, Chisel Soft), depth 1–1000 %, direction up/down, size 0–250 px, soften 0–16 px, angle, altitude, use global light, gloss contour + AA, highlight mode/colour/opacity, shadow mode/colour/opacity; **Contour** sub-effect (contour, AA, range); **Texture** sub-effect (pattern, scale, depth ±1000 %, invert, link) |
| **Stroke** | size 1–250 px, position outside/inside/center, blend mode, opacity, overprint, fill type colour/gradient/pattern (+shape-burst gradient style) |
| **Inner Shadow** | mode, colour, opacity, angle (global light), distance 0–30000, choke 0–100 %, size 0–250, contour + AA, noise 0–100 % |
| **Inner Glow** | mode, opacity, noise, colour or gradient, technique softer/precise, source centre/edge, choke, size, contour + AA, range, jitter |
| **Satin** | mode, colour, opacity, angle, distance, size, contour + AA, invert |
| **Color Overlay** | mode, colour, opacity |
| **Gradient Overlay** | mode, dither, opacity, gradient, reverse, style (linear/radial/angle/reflected/diamond), align with layer, angle, scale 10–150 %, method (perceptual/linear/classic/smooth/stripes) |
| **Pattern Overlay** | mode, opacity, pattern, angle, scale 1–1000 %, link with layer, snap to origin |
| **Outer Glow** | mode, opacity, noise, colour or gradient, technique, spread, size, contour + AA, range, jitter |
| **Drop Shadow** | mode, colour, opacity, angle (global light), distance, spread, size, contour + AA, noise, **layer knocks out drop shadow** |

Doc-level **Global Light** (angle, altitude). Commands: copy/paste/clear layer style, scale
effects, **Create Layers** (explode effects into real layers), hide all effects, Styles panel
presets (`.asl`). Rendering algorithm: [06 §6](06-compositing-math.md).

## 4. Channels

- Component channels are views of the composite (RGB → R, G, B; + composite row). Selecting a
  subset targets painting/filters/adjustments to those channels and shows them in grayscale
  (or in colour, per preference).
- **Alpha channels**: `{name, plane, colorIndicates: masked|selected, overlayColor, opacity}`.
  Save Selection / Load Selection (new / add / subtract / intersect, invert, cross-document
  when dimensions match). Ctrl-click channel = load as selection.
- **Spot channels**: `{name, color, solidity}` — composited on top for preview; exported in PSD/TIFF.
- Transient rows shown like Photoshop: active layer's *Layer Mask*, *Quick Mask*.
- Split / Merge Channels, Duplicate channel to new doc, Apply Image…, Calculations… (Image menu).

## 5. Selection

- A selection is a **coverage plane** (0–255; doc bit depth for 16-bit) — not a shape. Marching
  ants are drawn at the 50 % iso-contour (warning dialog "no pixels are more than 50 %
  selected" reproduced).
- Combination modes on every selection tool: new / add (Shift) / subtract (Alt) / intersect
  (Shift+Alt); feather and anti-alias options per tool.
- Commands: All `Ctrl+A`, Deselect `Ctrl+D`, Reselect `Ctrl+Shift+D`, Inverse `Ctrl+Shift+I`,
  All Layers, Color Range…, Focus Area*, Subject* / Sky* (ML pack), Select and Mask…
  `Ctrl+Alt+R`, Modify ▸ Border / Smooth / Expand / Contract / Feather `Shift+F6` (each with
  "apply effect at canvas bounds"), Grow, Similar, Transform Selection, Edit in Quick Mask `Q`,
  Load/Save Selection, New 3D-less. Selection ↔ path (Make Work Path tolerance 0.5–10 px;
  Make Selection feather/AA).
- Moving: selection tools drag the *outline*; Move tool (or Ctrl) drags the *pixels* (float).
  Floating selections exist implicitly during move/transform and are dropped on deselect, as in PS.
- Selection affects: paint tools, fills, filters, adjustments (adjustment layer created with an
  active selection gets that selection as its mask), copy/cut/paste, Paste Into
  (`Ctrl+Alt+Shift+V` → new layer with mask), crop, new-layer-via-copy.

## 6. Text model

```ts
interface TextData {
  kind: 'point'|'paragraph'|'onPath'|'inShape';  box?: Rect; pathRef?;
  orientation: 'horizontal'|'vertical';  transform: Matrix;  warp?: WarpSpec /*15 styles: Arc…Twist, bend, h/v distortion*/;
  antiAlias: 'none'|'sharp'|'crisp'|'strong'|'smooth';
  runs: { text, style: CharStyle }[];  paragraphs: { range, style: ParaStyle }[];
}
CharStyle: font (family/style/postscript name), size, leading (auto|pt), kerning (metrics|optical|number),
  tracking, vertical/horizontal scale, baseline shift, colour, faux bold/italic, all caps, small caps,
  super/subscript, underline, strikethrough, ligatures & OpenType features (liga, dlig, swsh, salt, onum, frac, ordn, titl, ss01-20),
  language, fill/stroke (from PSD), variable-font axes.
ParaStyle: align (left/center/right), justify (last left/center/right/all), indents (left/right/first line),
  space before/after, hyphenate + hyphenation settings, justification settings (word/letter/glyph spacing, auto-leading %),
  composer (single-line | every-line), roman hanging punctuation.
```
Maps to/from PSD `TySh`/EngineData. Missing fonts: keep the PSD's raster preview until the
user edits the layer, then prompt to substitute (Photoshop behaviour).

## 7. Paths

`Path = { subpaths: { closed, op: 'add'|'subtract'|'intersect'|'exclude', knots: {in, anchor, out, smooth: boolean}[] }[], fillRule }`
— identical to PSD path records. Used by: Paths panel (saved paths, Work Path, shape/vector
mask path of the active layer, clipping path flag), Pen tools, shape layers, vector masks, type
on path, selections ↔ paths, Fill Path / Stroke Path (with any paint tool + simulate pressure).

## 8. Other document-scoped objects

- **Guides** (h/v, per-artboard, colour), New Guide Layout (columns/rows/gutters/margins), Smart
  Guides (live measurement hints while moving), **Grid** (gridline every N unit, subdivisions),
  **Snap** + Snap To (guides, grid, layers, slices, document bounds).
- **Layer comps**: record visibility / position / appearance (style+mode) per layer; apply,
  update, cycle, export.
- **Notes**, **Count tool** groups, **Color samplers** (≤10, shown in Info panel), **Ruler
  tool** measurement (with Straighten Layer), **Slices** (basic, for export).
- **Presets (app-scoped, not doc):** brushes, tool presets, swatches, gradients, patterns,
  styles, contours, custom shapes, curves/levels/etc. adjustment presets, LUTs, export
  presets, workspaces, keymaps. All organised in folders/groups as in modern PS panels,
  importable from Adobe preset files ([07](07-file-formats.md#presets)).
