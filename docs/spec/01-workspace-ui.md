# 01 — Workspace & UI

Target: the **Essentials** workspace of current desktop Photoshop, as in the two reference
screenshots in the brief. Layout, names, ordering and behaviours are reproduced; artwork
(icons, cursors) is original.

## 1. Anatomy

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [logo] File Edit Image Layer Type Select Filter View Plugins-less Window Help   – □ ✕ │ ← Menu bar (in-app, frameless window; native menu on macOS)
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [⌂][tool icon ▾ preset] …tool-specific controls…                 [Share-less][🔍][▣▾] │ ← Options bar (height 40)
├──┬───────────────────────────────────────────────────────────────┬──┬────────────────┤
│  │ name.psd @ 59.4% (Layer, RGB/8) * ✕ │ other.png … │            │▸▸│ Color│Swatches│Gradients│Patterns ≡ │
│T │┌─ruler──────────────────────────────────────────────┐          │ic│ ─────────────── │
│o ││                                                    │          │on│ Properties│Adjustments│Libraries-less │
│o ││                canvas (pasteboard #282828)         │          │  │ ─────────────── │
│l ││                                                    │          │st│ Layers│Channels│Paths ≡ │
│s │└────────────────────────────────────────────────────┘          │ri│ …              │
│  │ 59.37% │ 1920 px × 1080 px (300 ppi) ▸ │◂ scrollbar ▸│          │p │ [⛓ fx ◐ ◑ 📁 ＋ 🗑] │
└──┴───────────────────────────────────────────────────────────────┴──┴────────────────┘
```

| Area | Behaviour |
|------|-----------|
| **Menu bar** | Custom-drawn for identical look on Linux/Windows; Alt-mnemonics; type-ahead; submenus; shortcut column right-aligned; ✓ / • states; items grey out by context exactly as PS (mode, depth, layer type, selection present…). Far right: window controls. |
| **Options bar** | Context = active tool. Leftmost: Home-less, **tool preset picker** (current tool icon + ▾; right-click → Reset Tool / Reset All Tools). Far right: search (commands, tools, panels, help), workspace switcher ▣▾ (Essentials, 3D-less, Graphic and Web, Motion-less, Painting, Photography, Reset…, New Workspace…, Delete…, Keyboard Shortcuts & Menus…). During modal sessions (transform, crop, type, place, warp) it shows the session's controls with **⊘ Cancel (Esc)** and **✓ Commit (Enter)**. Can be dragged free/docked bottom. |
| **Tools panel** | Single column (default) or double (toggle `▸▸` at top). Tool groups with ◢ corner mark; long-press or right-click opens flyout listing group tools + shortcut letter; Alt-click cycles. Below the tools: **⋯ Edit Toolbar…**, foreground/background swatches with ⇄ (X) and default ◩ (D), **Quick Mask** toggle (Q), **Screen Mode** (F). Rich tooltips (name + shortcut; optional). Dockable left/right or floating. |
| **Document area** | Tabs: `name @ zoom% (active layer, MODE/depth[#|*]) *dirty`; drag to reorder, drag out to float, drag between windows; middle-click close; `Ctrl+Tab` cycle. Window ▸ Arrange: Tile All Vertically/Horizontally, 2-up…6-up, Consolidate All to Tabs, Cascade, Float, Match Zoom/Location/Rotation/All, New Window for *doc*. Rulers (`Ctrl+R`) with draggable origin at the corner, drag from ruler = new guide (Alt toggles orientation, Shift snaps to ticks); right-click ruler = units. Pasteboard colour by right-click (Default, Black, Dark Gray, Medium Gray, Light Gray, Custom). Scrollbars; overscroll allowed. |
| **Status bar** | Zoom % field (editable, scrubby), info field with ▸ menu: Document Sizes (flattened/with layers), Document Profile, Document Dimensions, Measurement Scale-less, Scratch Sizes, Efficiency, Timing, Current Tool, 32-bit Exposure, Save Progress, Smart Objects, Layer Count. Click-hold = print-size preview box; Alt-click-hold = dimensions/channels/resolution. |
| **Panel docks** | Right side: one or more **columns**; each column is a vertical stack of **tab groups**; each group has tabs + panel menu ≡. Drag a tab: between groups (blue outline), between stack positions (blue horizontal line), to a new column (blue vertical line), or out to **float** (floating groups can themselves be stacked). Double-click tab = minimise group to its tab strip. Column header `▸▸` = **collapse to icons** (icon strip with labels optional; click icon = fly-out panel, auto-collapse per preference). Column width draggable; panel heights distribute by dragging separators. `Tab` hides all panels + bars; `Shift+Tab` hides panels only; hovering the screen edge temporarily reveals them. Window menu toggles each panel (✓). |
| **Contextual Task Bar** | Floating pill under selection/canvas with next-step buttons (e.g. with a selection: *Select and Mask, Feather-less, Invert, Create mask, Fill, Deselect*; with a type layer: font/size; no doc selection: *Select subject, Remove background*). ⋯ menu: Hide bar, Reset position, Pin position. Off by preference. Generative entries omitted. |
| **Screen modes** (`F` cycles) | Standard → Full Screen With Menu Bar → Full Screen (black, no chrome; panels on edge-hover). |
| **Home / start** | When no doc is open: minimalist start area with *New file*, *Open*, recent files grid (thumbs), drag-and-drop target. Preference to disable (shows empty workspace as legacy PS). |

### 1.1 Essentials default layout
Right column A (collapsed icons): History, Properties-duplicate-less, Comments-less → we ship
**History** and **Brush Settings/Brushes** icons. Right column B (expanded, ~ 320 px):
group 1 **Color · Swatches · Gradients · Patterns**; group 2 **Properties · Adjustments**;
group 3 **Layers · Channels · Paths**. Tools panel left, single column. Options bar on top.

## 2. Theming & visual language

- Four themes via `Preferences ▸ Interface ▸ Color Theme`; `Shift+F1`/`Shift+F2` darken/lighten.
  Tokens (theme 2 = default): chrome `#323232`, panel body `#3a3a3a`-ish raised `#424242`,
  pasteboard `#282828`, input wells `#262626`, borders `#1f1f1f`/`#4a4a4a`, text `#d6d6d6`,
  dim text `#9a9a9a`, **highlight blue `#2f80ed`-class** (selected layer row uses a lighter
  neutral grey like PS, accent selectable: blue default). Darkest: chrome `#1e1e1e`… Light
  themes `#b8b8b8`, `#f0f0f0`. Exact values tuned by eye against references; all in CSS
  variables; **strictly neutral greys** (R=G=B) so the UI never biases colour judgement.
- Type: system UI font, 11–12 px (UI Font Size pref: Tiny/Small/Medium/Large + "Scale UI to
  font"); tabular numbers in fields. Icon grid 16/20 px, 1.5 px strokes, monochrome with
  single accent; the tools sprite ≈ 70 icons, panels/buttons ≈ 150.
- Widgets (all custom, tiny, keyboard-complete): **scrubby number field** (drag label to
  scrub; ↑/↓ ±1, Shift ±10, Alt ±0.1; unit suffix parsing `px in cm mm pt pica %`; simple
  maths `+ - * /`), slider (+ popup slider on ▾ like Opacity), dropdown, combo, checkbox,
  radio, icon toggle, colour well, gradient well, pattern/brush/contour/shape pickers (grid
  popup with folders, search, size slider, ⚙ menu), angle dial, curve editor, tree list,
  virtualised rows, split button, tooltip, toast ("hold Alt for…") and rich tooltips-less.
- Cursors: Standard / Precise (`Caps Lock`) / Normal or Full-size brush tip outline with
  optional crosshair; all drawn on the overlay canvas (crisp at any DPI), OS cursor hidden.
- HiDPI: everything vector; canvas backing store at devicePixelRatio.

## 3. Menus (complete tree)

Shortcuts shown Windows/Linux style; macOS maps Ctrl→⌘, Alt→⌥. `…` opens a dialog. Items
marked † are late-milestone; ✗ = intentionally absent (listed so nobody "adds it back").

**File** — New… `Ctrl+N` · Open… `Ctrl+O` · Browse-in-Bridge ✗ · Open As… `Ctrl+Alt+Shift+O`
· Open as Smart Object… · Open Recent ▸ (list, Clear) · Close `Ctrl+W` · Close All
`Ctrl+Alt+W` · Close Others `Ctrl+Alt+P` · Save `Ctrl+S` · Save As… `Ctrl+Shift+S` · Save a
Copy… `Ctrl+Alt+S` · Revert `F12` · Export ▸ (Quick Export as PNG · Export As…
`Ctrl+Alt+Shift+W` · Export Preferences… · Save for Web (Legacy)… `Ctrl+Alt+Shift+S` ·
Artboards to Files…/PDF… · Layers to Files… · Layer Comps to Files…/PDF · Color Lookup
Tables… · Paths to SVG…) · Generate ✗ · Share ✗ · Place Embedded… · Place Linked… · Package…†
· Automate ▸ (Batch… · PDF Presentation… · Create Droplet ✗ · Crop and Straighten Photos ·
Contact Sheet II… · Conditional Mode Change… · Fit Image… · Lens Correction… · Merge to HDR
Pro…† · Photomerge…†) · Scripts ▸ (Image Processor… · Delete All Empty Layers · Flatten All
Layer Effects · Flatten All Masks · Script Events Manager…† · Load Files into Stack… ·
Statistics…† · Browse…) · Import ▸ (Variable Data Sets…† · Video Frames to Layers…† · Notes…)
· File Info… `Ctrl+Alt+Shift+I` · Print… `Ctrl+P` · Print One Copy · Exit `Ctrl+Q`.

**Edit** — Undo `Ctrl+Z` · Redo `Ctrl+Shift+Z` · Toggle Last State `Ctrl+Alt+Z` · Fade…
`Ctrl+Shift+F` · Cut `Ctrl+X` · Copy `Ctrl+C` · Copy Merged `Ctrl+Shift+C` · Paste `Ctrl+V` ·
Paste Special ▸ (Paste without Formatting · Paste in Place `Ctrl+Shift+V` · Paste Into
`Ctrl+Alt+Shift+V` · Paste Outside) · Clear · Search `Ctrl+F` · Check Spelling… · Find and
Replace Text… · Fill… `Shift+F5` (Contents: Foreground/Background/Color…/Content-Aware/
Pattern/History/Black/50% Gray/White; mode, opacity, preserve transparency; scripted
patterns†) · Stroke… · Content-Aware Fill… · Content-Aware Scale `Ctrl+Alt+Shift+C` · Puppet
Warp · Perspective Warp · Free Transform `Ctrl+T` · Transform ▸ (Again `Ctrl+Shift+T` ·
Scale · Rotate · Skew · Distort · Perspective · Warp · Split Warp Horizontally/Vertically/
Crosswise · Remove Warp Split · Convert warp anchor point · Toggle Guides · Rotate 180° / 90°
CW / 90° CCW · Flip Horizontal / Vertical) · Auto-Align Layers…† · Auto-Blend Layers…† · Sky
Replacement…† · Define Brush Preset… · Define Pattern… · Define Custom Shape… · Purge ▸
(Clipboard · Histories · All) · Adobe PDF Presets ✗ · Presets ▸ (Preset Manager… · Migrate ✗ ·
Export/Import Presets…) · Remote Connections ✗ · Color Settings… `Ctrl+Shift+K` · Assign
Profile… · Convert to Profile… · Keyboard Shortcuts… `Ctrl+Alt+Shift+K` · Menus…
`Ctrl+Alt+Shift+M` · Toolbar… · Preferences ▸ (General `Ctrl+K` · Interface · Workspace ·
Tools · History & Cache-less → Performance · Scratch Disks · Cursors · Transparency & Gamut ·
Units & Rulers · Guides, Grid & Slices · Type · File Handling · Export · Image Processing-less
· Technology-less).

**Image** — Mode ▸ (Bitmap · Grayscale · Duotone · Indexed Color… · RGB Color · CMYK Color ·
Lab Color · Multichannel · — · 8 / 16 / 32 Bits/Channel · — · Color Table…) · Adjustments ▸
(Brightness/Contrast… · Levels… `Ctrl+L` · Curves… `Ctrl+M` · Exposure… · — · Vibrance… ·
Hue/Saturation… `Ctrl+U` · Color Balance… `Ctrl+B` · Black & White… `Ctrl+Alt+Shift+B` ·
Photo Filter… · Channel Mixer… · Color Lookup… · — · Invert `Ctrl+I` · Posterize… ·
Threshold… · Gradient Map… · Selective Color… · — · Shadows/Highlights… · HDR Toning… · — ·
Desaturate `Ctrl+Shift+U` · Match Color… · Replace Color… · Equalize) · Auto Tone
`Ctrl+Shift+L` · Auto Contrast `Ctrl+Alt+Shift+L` · Auto Color `Ctrl+Shift+B` · Image Size…
`Ctrl+Alt+I` · Canvas Size… `Ctrl+Alt+C` · Image Rotation ▸ (180° · 90° CW · 90° CCW ·
Arbitrary… · Flip Canvas Horizontal/Vertical) · Crop · Trim… · Reveal All · Duplicate… ·
Apply Image… · Calculations… · Variables ▸† · Apply Data Set…† · Trap…✗ · Analysis ▸†.

**Layer** — New ▸ (Layer… `Ctrl+Shift+N` · Layer from Background… · Group… · Group from
Layers… · Artboard… · Artboard from Group/Layers… · Frame from Layers… · Layer Via Copy
`Ctrl+J` · Layer Via Cut `Ctrl+Shift+J`) · Copy CSS · Copy SVG · Duplicate Layer… · Delete ▸
(Layer · Hidden Layers) · Quick Export as PNG `Ctrl+Shift+'` · Export As… `Ctrl+Alt+Shift+'` ·
Rename Layer… · Layer Style ▸ (Blending Options… · Bevel & Emboss… · Stroke… · Inner Shadow… ·
Inner Glow… · Satin… · Color Overlay… · Gradient Overlay… · Pattern Overlay… · Outer Glow… ·
Drop Shadow… · Copy / Paste / Clear Layer Style · Global Light… · Create Layers · Hide All
Effects · Scale Effects…) · Smart Filter ▸ · New Fill Layer ▸ (Solid Color… · Gradient… ·
Pattern…) · New Adjustment Layer ▸ (the 16 kinds) · Layer Content Options… · Layer Mask ▸
(Reveal All · Hide All · Reveal Selection · Hide Selection · From Transparency · Delete ·
Apply · Enable/Disable · Link/Unlink) · Vector Mask ▸ (Reveal All · Hide All · Current Path ·
Delete · Enable/Disable · Link/Unlink) · Create Clipping Mask `Ctrl+Alt+G` · Mask All Objects†
· Smart Objects ▸ (Convert to Smart Object · New Smart Object via Copy · Reveal in Explorer ·
Update Modified Content · Update All Modified Content · Edit Contents · Relink to File… ·
Relink to Library ✗ · Replace Contents… · Export Contents… · Embed Linked / Embed All Linked ·
Convert to Linked… · Convert to Layers · Stack Mode ▸† · Rasterize) · Video Layers ✗ ·
Rasterize ▸ (Type · Shape · Fill Content · Vector Mask · Smart Object · Layer Style · Layer ·
All Layers) · New Layer Based Slice · Group Layers `Ctrl+G` · Ungroup Layers `Ctrl+Shift+G` ·
Hide Layers `Ctrl+,` · Arrange ▸ (Bring to Front `Ctrl+Shift+]` · Bring Forward `Ctrl+]` ·
Send Backward `Ctrl+[` · Send to Back `Ctrl+Shift+[` · Reverse) · Combine Shapes ▸ · Align ▸ ·
Distribute ▸ · Lock Layers… `Ctrl+/` · Link Layers · Select Linked Layers · Merge Down/Layers
`Ctrl+E` · Merge Visible `Ctrl+Shift+E` · Flatten Image · Matting ▸ (Color Decontaminate… ·
Defringe… · Remove Black Matte · Remove White Matte).

**Type** — More from Adobe Fonts ✗ · Panels ▸ (Character · Paragraph · Glyphs · Character
Styles · Paragraph Styles) · Anti-Alias ▸ · Orientation ▸ · OpenType ▸ · Extrude to 3D ✗ ·
Create Work Path · Convert to Shape · Rasterize Type Layer · Convert to Paragraph/Point Text ·
Warp Text… · Match Font…† · Font Preview Size ▸ · Language Options ▸ · Update All Text Layers
· Manage/Resolve Missing Fonts… · Paste Lorem Ipsum · Load/Save Default Type Styles.

**Select** — All `Ctrl+A` · Deselect `Ctrl+D` · Reselect `Ctrl+Shift+D` · Inverse
`Ctrl+Shift+I` · All Layers `Ctrl+Alt+A` · Deselect Layers · Find Layers `Ctrl+Alt+Shift+F` ·
Isolate Layers · Color Range… · Focus Area… · Subject (ML) · Sky (ML) · Select and Mask…
`Ctrl+Alt+R` · Modify ▸ (Border… · Smooth… · Expand… · Contract… · Feather… `Shift+F6`) · Grow
· Similar · Transform Selection · Edit in Quick Mask Mode · Load Selection… · Save Selection…
· New 3D Extrusion ✗.

**Filter** — Last Filter `Ctrl+Alt+F` · Convert for Smart Filters · Neural Filters ✗ · Filter
Gallery… · Adaptive Wide Angle…† · Camera Raw Filter… `Ctrl+Shift+A` (ours: "Develop…") · Lens
Correction… `Ctrl+Shift+R` · Liquify… `Ctrl+Shift+X` · Vanishing Point…† · 3D ✗ · Blur ▸ ·
Blur Gallery ▸ · Distort ▸ · Noise ▸ · Pixelate ▸ · Render ▸ · Sharpen ▸ · Stylize ▸ · Video ▸
(De-Interlace · NTSC Colors) · Other ▸ — full contents in [05 §B](05-adjustments-filters.md).

**View** — Proof Setup ▸ · Proof Colors `Ctrl+Y` · Gamut Warning `Ctrl+Shift+Y` · Pixel Aspect
Ratio ▸† · 32-bit Preview Options… · Zoom In `Ctrl++` · Zoom Out `Ctrl+-` · Fit on Screen
`Ctrl+0` · Fit Layer(s) on Screen · Fit Artboard · 100% `Ctrl+1` · 200% · Print Size · Actual
Size · Flip Horizontal (view only) · Pattern Preview† · Screen Mode ▸ · Extras `Ctrl+H` · Show
▸ (Layer Edges · Selection Edges · Target Path `Ctrl+Shift+H` · Grid `Ctrl+'` · Guides
`Ctrl+;` · Canvas Guides · Artboard Guides/Names · Count · Smart Guides · Slices · Notes ·
Pixel Grid · Brush Preview · Mesh · Edit Pins · All / None / Show Extras Options…) · Rulers
`Ctrl+R` · Snap `Ctrl+Shift+;` · Snap To ▸ · Lock Guides `Ctrl+Alt+;` · Clear Guides / Clear
Selected / Canvas Guides · New Guide… · New Guide Layout… · New Guides from Shape · Lock
Slices · Clear Slices.

**Window** — Arrange ▸ · Workspace ▸ · — · (alphabetical panel toggles) Actions `Alt+F9` ·
Adjustments · Brush Settings `F5` · Brushes · Channels · Character · Character Styles · Clone
Source · Color `F6` · Glyphs · Gradients · Histogram · History · Info `F8` · Layer Comps ·
Layers `F7` · Navigator · Notes · Paragraph · Paragraph Styles · Paths · Patterns · Properties
· Shapes · Styles · Swatches · Timeline† · Tool Presets · — · Options · Tools · Contextual Task
Bar · — · open documents list. (Libraries, Learn, Discover, Comments, Version History,
Materials, 3D, Measurement Log: ✗.)

**Help** — Umbra Help · Keyboard shortcut reference · What's new · System Info… (GPU, limits,
memory, versions — copyable) · GPU Compatibility… · About.

## 4. Panels

Each: tab title, body, bottom button bar (where PS has one), ≡ panel menu, optional
collapsed-icon. Panel menus contain PS's entries where meaningful + Close / Close Tab Group.

| Panel | Contents |
|-------|----------|
| **Layers** | Filter bar (Kind ▾ + pixel/adjust/type/shape/SO toggles + on/off switch); blend mode ▾ (hover-preview of modes on canvas, as modern PS), Opacity; Lock row (transparency ▦, pixels 🖌, position ✥, artboard nesting, all 🔒), Fill; rows = eye · [label colour on right-click eye] · thumbnail(s) (content, ⛓ link, mask, vector mask; SO/adjust/type badges) · name (dbl-click rename; dbl-click thumb = type edit/SO open/adjust props/fill picker; dbl-click empty = Layer Style) · fx ▾ with expandable effects list w/ per-effect eyes · smart filters sub-list · group twirl ▸ (Alt-click = recursive; Ctrl-click = all top-level) · clipping indent ↳. Drag reorder with insertion line / into-group highlight; Alt-drag duplicate; drag fx to move/copy styles; drag onto ＋/🗑. Bottom: Link · fx ▾ · Add Mask · New Fill/Adjustment ▾ · New Group · New Layer · Delete. Thumbnail size & bounds options in ≡ Panel Options. Virtualised for 1000s of layers. |
| **Channels** | Composite + components (`Ctrl+2`, `Ctrl+3…`), transient mask rows, alpha/spot; eyes; bottom: Load as selection · Save selection as channel · New · Delete. ≡: New Spot Channel, Duplicate, Merge Spot, Channel Options, Split/Merge Channels. |
| **Paths** | Saved paths, *Work Path* (italic), layer's shape/vector mask path (transient). Bottom: Fill path · Stroke path · Load as selection · Make work path from selection · Add mask · New · Delete. |
| **Properties** | Context-sensitive: *Document* (canvas size, mode, depth, rulers & grids, guides, quick actions) · *Pixel layer* (transform W/H/X/Y/angle/flip, align & distribute, quick actions Remove-Background(ML)/Select-Subject) · *Adjustment* (that adjustment's full UI + bottom row: clip-to-layer ⬓, view previous `\`, reset, eye, trash) · *Masks* (density, feather, Select and Mask…, Color Range…, Invert; load/apply/disable/delete) · *Type* (transform, character, paragraph, type options) · *Live Shape* (W/H/X/Y, fill, stroke + options, 4 corner radii w/ link, path ops) · *Smart Object* (embedded/linked info, Edit Contents, Convert to Linked/Layers, layer comp picker) · *Artboard*, *Frame*. |
| **Adjustments** | Presets gallery (grouped thumbnails: Portraits, Landscape, Photo Repair, Creative, B&W, Cinematic — original recipes; hover = live preview) + **Single adjustments** icon grid (16). Click = add adjustment layer. |
| **Color** | Modes via ≡: Hue Cube (default) · Brightness Cube · Color Wheel · Grayscale / RGB / HSB / CMYK / Lab / Web sliders; spectrum ramp strip; fg/bg wells; gamut ⚠ + web-safe cube indicators. |
| **Swatches / Gradients / Patterns / Shapes / Styles** | Recents row; folder groups; grid with size options (small/large thumb, list); search; drag to canvas/layer applies (gradient → gradient fill layer, pattern → pattern layer, style → layer); bottom: New group · New · Delete; ≡ import/export, legacy sets-less. |
| **Brushes** | Size slider, search, folders of presets with stroke previews, recent row; ≡: New Brush Preset…, view options (name/stroke/tip), Import/Export, Get more ✗. |
| **Brush Settings** | Left list with checkbox + 🔒 per section: *Brush Tip Shape* (tip grid, size, flip X/Y, angle/roundness dial, hardness, spacing ✓ %) · *Shape Dynamics* (size jitter + control [Off, Fade, Pen Pressure, Pen Tilt, Stylus Wheel, Rotation, Initial Direction, Direction] + minimum diameter, tilt scale, angle jitter + control, roundness jitter + control + minimum, flip X/Y jitter, brush projection) · *Scattering* (scatter % + both axes + control, count, count jitter + control) · *Texture* (pattern, invert, scale, brightness, contrast, texture each tip, mode, depth, minimum depth, depth jitter + control) · *Dual Brush* (mode, tip, size, spacing, scatter, count) · *Color Dynamics* (apply per tip, fg/bg jitter + control, hue/saturation/brightness jitter, purity) · *Transfer* (opacity jitter + control + min, flow jitter + control + min, wetness/mix for mixer) · *Brush Pose* (tilt X/Y, rotation, pressure + overrides) · Noise · Wet Edges · Build-up · Smoothing · Protect Texture. Bottom: live stroke preview. |
| **History** | Snapshots (top) + states; history-brush source column; drag slider; bottom: New doc from state · New snapshot · Delete. ≡ History Options (auto first snapshot, non-linear, show new-snapshot dialog, layer visibility undoable). |
| **Actions** | Sets ▸ actions ▸ steps ▸ parameters tree; ✓ include toggle; ▣ modal-dialog toggle; bottom: Stop · Record · Play · New Set · New Action · Delete. ≡ Button Mode, Insert Menu Item/Stop/Conditional/Path, Action Options (F-key), Playback Options, Load/Save/Replace/Reset. |
| **Info** | Two colour readouts (mode selectable ▾ each: Actual, Proof, Gray, RGB, Web, HSB, CMYK, Lab, Total Ink, Opacity; 8/16/32-bit), X/Y, W/H of selection/transform, angle/distance during drags, doc status lines, tool hints, up to 10 samplers. |
| **Histogram** | Compact / Expanded / All Channels views; channel ▾ (RGB, R, G, B, Luminosity, Colors); source ▾ (Entire Image, Selected Layer, Adjustment Composite); stats (Mean, Std Dev, Median, Pixels, Level, Count, Percentile, Cache Level); ⚠ refresh uncached. |
| **Navigator** | Thumbnail with red proxy view box (drag = pan, Ctrl-drag = zoom region), zoom field + slider + buttons. |
| **Character / Paragraph / Glyphs / Char & Para Styles** | per [02 §6](02-document-model.md#6-text-model); Character: family ▾ (search, filter, ★ favourites, live preview on hover), style ▾, size, leading, kerning, tracking, V/H scale, baseline shift, colour, faux/caps/super/sub/underline/strike row, OpenType row, language ▾, anti-alias ▾. |
| **Clone Source** | 5 source slots, offset X/Y, W/H scale (link), rotate, flip, frame-offset-less, overlay options (show, opacity, mode, clipped, auto-hide, invert). |
| **Layer Comps · Notes · Tool Presets · Timeline†** | as described in [02 §8]. |

## 5. Dialog conventions
Modal, draggable, remember position. **OK / Cancel**; holding **Alt** turns Cancel → **Reset**;
**Preview** ☑ (toggle `P`); canvas remains zoom/pannable (Space, Ctrl+Space, Ctrl +/−) while
a dialog is open; eyedropper sampling from canvas where relevant; preset ▾ + ⚙
(save/load/delete) on all adjustment-type dialogs; numeric fields accept ↑↓/Shift; Tab order
= visual order; Enter = OK, Esc = Cancel. Filter dialogs: 100 % preview pane with −/+ zoom and
drag-pan, click-hold in pane = show original.

Layer Style dialog: left list (Styles · Blending Options · 10 effects with ☑ and ＋ for
multi-instance; ▲▼🗑 at bottom), centre = selected page, right = OK / Cancel / New Style… /
☑ Preview + 100 px preview tile. **Make Default / Reset to Default** on each effect page.

New Document: left = Recent / Saved / Photo / Print / Art & Illustration / Web / Mobile /
Film & Video preset tabs w/ cards; right = Preset Details (name, W, H, units, orientation,
artboards ☑, resolution, colour mode + depth, background contents [White, Black, Background
Color, Transparent, Custom], advanced: colour profile, pixel aspect). Legacy compact dialog
by preference.

Color Picker: large SB field + hue strip (radio-selectable primary axis among H S B R G B L a
b), new/current swatches, ⚠ gamut / ⬚ web-safe, HSB, RGB, Lab, CMYK fields, `#` hex, Only Web
Colors ☑, Add to Swatches, Color Libraries ✗. Canvas eyedropper active while open.
**HUD colour picker**: `Shift+Alt+right-click` with paint tools (hue strip or wheel pref).

## 6. Input model & the "feel" shortcuts

**Tool keys** (Shift+key cycles within group; preference "Use Shift Key for Tool Switch"):
`V` Move/Artboard · `M` Marquees · `L` Lassos · `W` Object/Quick Selection/Magic Wand · `C`
Crop/Perspective Crop/Slice/Slice Select · `K` Frame · `I` Eyedropper/Color Sampler/Ruler/
Note/Count · `J` Spot Healing/Remove/Healing/Patch/Content-Aware Move/Red Eye · `B` Brush/
Pencil/Color Replacement/Mixer · `S` Clone/Pattern Stamp · `Y` History/Art History Brush · `E`
Erasers · `G` Gradient/Paint Bucket · (none) Blur/Sharpen/Smudge · `O` Dodge/Burn/Sponge ·
`P` Pens · `T` Type tools · `A` Path/Direct Selection · `U` Shapes · `H` Hand · `R` Rotate
View · `Z` Zoom · `D` default colours · `X` swap · `Q` Quick Mask · `F` screen mode · `/`
lock transparency.

**Spring-loaded & modifiers:** hold a tool key = temporary tool, release returns. `Space` =
Hand (bird's-eye: hold `H`+drag); `Ctrl+Space` = Zoom in (drag = scrubby zoom), `Alt+Space` =
Zoom out; `Alt`+wheel zoom at cursor, wheel = scroll V, `Shift`+wheel = H, `Ctrl`+wheel = H;
double-click Hand = fit, Zoom = 100 %. `Ctrl` = temporary Move (from most tools). With paint
tools: `Alt` = eyedropper; `[` `]` size; `Shift+[` `]` hardness; `,` `.` prev/next brush;
digits = opacity (`5`=50 %, `55`, `0`=100 %, `00`=0 %), `Shift`+digits = flow; `Shift+Alt+<key>`
paint blend modes (`N` normal, `M` multiply, `S` screen, `O` overlay…); `Alt+right-drag` ↔
size / ↕ hardness (or opacity per pref) with red HUD preview; `Shift`-click = straight line
from last dab; `Shift`-drag = axis constrain; right-click = brush preset popup. With Move or
any tool + layers: digits = layer opacity, `Shift`+digits = fill; `Shift +`/`Shift −` cycle
blend modes; arrows nudge 1 px (`Shift` 10 px); `Alt`-drag duplicate; `Ctrl`-click canvas =
auto-select; right-click canvas = layers-under-cursor list. Selections: `Shift` add, `Alt`
subtract, both = intersect; while dragging marquee `Space` repositions, `Shift` square, `Alt`
from centre. Fill: `Alt+Backspace` fg, `Ctrl+Backspace` bg, `Shift+Backspace` dialog,
`+Shift` variants preserve transparency. Layers: `Ctrl+J`, `Ctrl+E`, `Ctrl+Shift+Alt+E` stamp,
`Ctrl+G`, `Ctrl+Alt+G` clip, `Alt`-click between rows clip, `Ctrl`-click thumb = load
selection, `Alt`-click mask view, `Shift`-click mask disable, `\` overlay, `Ctrl+\` target
mask / `Ctrl+2` target composite, `Ctrl+I` invert, `Alt`-click eye solo, `Alt+[ ]` select
next/prev layer, `Ctrl+[ ]` move. Transform: `Ctrl+T`; modern default proportional scale
(`Shift` = free; "Use Legacy Free Transform" pref inverts), `Alt` from centre, `Ctrl`-drag
corner = distort, `Ctrl+Shift` side = skew, `Ctrl+Alt+Shift` = perspective, right-click =
mode menu, `Enter`/`Esc`. History: `Ctrl+Z` multi-undo (pref: legacy toggle mode),
`Ctrl+Shift+Z` redo, `Ctrl+Alt+Z` toggle last. View: `Ctrl+0`, `Ctrl+1`, `Ctrl+H` extras,
`Ctrl+R`, `Ctrl+;`, `Ctrl+'`, `Tab`, `Shift+Tab`, `F`. Pen tablets: pressure, tilt, rotation,
barrel button = right-click, eraser end = Eraser tool (auto-switch).

The keymap is data (`app/keymap/default.json`): contexts (global, tool:<id>, panel:<id>,
modal:<id>, text-editing), chords, spring-load flag; the Keyboard Shortcuts dialog edits it
with conflict warnings, sets, and "Summarize…" export — as in PS.
