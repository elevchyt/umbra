# 03 — Architecture

## 1. Decisions at a glance

| Area | Decision | Why |
|------|----------|-----|
| Shell | **Electron** (latest stable), single window per app instance, multi-doc tabs | Decided. Bundled Chromium = one known GPU stack (ANGLE), `EXT_texture_norm16`, OffscreenCanvas, SharedArrayBuffer, Local Font Access, pen pressure. Tauri/WebKitGTK is unreliable for GPU work on Linux+NVIDIA |
| Portability | Core is a pure web app; shell access only through `platform` interface | Same build runs as PWA (Photopea-style) for a zero-install "tiny" variant |
| Language | **TypeScript** (strict) everywhere; **GLSL ES 3.00** for GPU; WASM only for third-party C libs (HarfBuzz, lcms2, codecs) and, later, hot CPU kernels | Dev box has Node+pnpm only. One toolchain. Kernels sit behind an interface so Rust/WASM-SIMD can replace TS later without API change |
| GPU API | **WebGL2** baseline behind a thin `gpu/` abstraction (texture, framebuffer, program, pass). WebGPU backend is a post-1.0 option | WebGL2 is universal incl. PWA; our workload is fullscreen-quad fragment passes, which WebGL2 handles well |
| UI | **SolidJS** + hand-written CSS (no component library, no CSS framework), custom docking, custom menus, SVG sprite icons | Fine-grained reactivity, no VDOM, ~7 KB. A pro-tool UI is thousands of tiny live controls — VDOM diffing is the wrong shape |
| Build | pnpm workspace, Vite (UI + workers), electron-builder, Vitest, Playwright (Electron mode) | Standard, fast |
| State | Immutable persistent document tree + command bus; UI subscribes via signals | Free undo/snapshots, recordable actions, scriptable, testable |
| Threads | UI thread · **Engine worker** (owns document, GPU via OffscreenCanvas) · CPU kernel pool · Codec worker | Brush latency and canvas FPS are isolated from UI work and vice-versa |

## 2. Process & thread model

```
┌ Electron main ───────────────────────────────────────────────┐
│ window, native dialogs, file IO streams, recent files, menus │
│ (macOS only native menu), auto-update, scratch-dir mgmt      │
└──────────────▲───────────────────────────────────────────────┘
               │ contextBridge IPC (narrow, typed, no nodeIntegration)
┌ Renderer ────┴───────────────────────────────────────────────┐
│ UI thread:  SolidJS chrome, panels, dialogs, overlay canvas   │
│             (cursor, handles, guides, paths, rulers), input   │
│      │  postMessage: commands ↓   state patches / events ↑    │
│ Engine worker: Document store, history, compositor, GPU       │
│             (OffscreenCanvas per doc view), tool state machines│
│      │  job queue (SharedArrayBuffer tiles, transferables)    │
│ Kernel pool (N = cores − 2): CPU algorithms (flood fill, EDT, │
│             resample, PatchMatch, healing, histogram, filters │
│             CPU-reference paths)                              │
│ Codec worker(s): PSD/PSB, PNG/JPEG/WebP/AVIF/TIFF/…, presets  │
└───────────────────────────────────────────────────────────────┘
```

- App is served from a custom `app://` protocol with `COOP: same-origin` + `COEP: require-corp`
  → `crossOriginIsolated` → SharedArrayBuffer + WASM threads.
- Electron hardening: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  strict CSP (`default-src 'self'`; `wasm-unsafe-eval` only), no remote content at all.
- **Input path:** UI thread listens to `pointerrawupdate` + `getCoalescedEvents()` (full tablet
  rate, pressure, tiltX/Y, twist), packs samples into a ring buffer in a SharedArrayBuffer;
  engine worker drains it each frame. The **brush cursor** is drawn on the UI-thread overlay so
  it is never behind the pointer.
- **Overlay split:** anything needing pixel data (marching ants, quick-mask tint, pixel grid,
  transform preview) is rendered by the engine in GL. Anything geometric (handles, guides,
  rulers, path anchors, slices, crop shield, text caret) is UI-thread Canvas2D, driven by the
  shared view transform.

### 2.1 `platform` interface (the only shell-specific code)

```ts
interface Platform {
  openFiles(opts): Promise<FileHandle[]>;   saveFile(opts): Promise<FileHandle|null>;
  read(h): ReadableStream<Uint8Array>;      write(h): WritableStream<Uint8Array>;
  recentFiles: …;  scratch: ScratchStore;   fonts(): Promise<FontFace[]>;   // queryLocalFonts()
  clipboard: { readImage, writeImage };      menu?: NativeMenuBridge;         // macOS
  displayProfile(): Promise<ArrayBuffer|null>;  // ICC of current monitor
  onOpenRequest(cb);                          // file association / drag onto dock
}
```
Implementations: `platform-electron` (IPC), `platform-web` (File System Access API, OPFS).

## 3. Repository layout

```
umbra/
  docs/spec/                      ← this spec
  packages/
    core/        document model types, command definitions, descriptors, geometry, colour math (no DOM, no GPU)
    engine/      store, history, tile store, compositor, render graph, gpu/ abstraction, shaders/, tool state machines
    kernels/     CPU algorithms (pure functions on typed arrays) + worker pool
    psd/         PSD/PSB reader+writer (starts from ag-psd, see 07), preset formats
    codecs/      thin wrappers around WASM codecs, lazy-loaded
    text/        harfbuzz shaping, paragraph composer, font registry
    color/       lcms2-wasm wrapper, profile registry, LUT baking
    ui/          Solid components: workspace, docking, menus, panels, dialogs, widgets, icons
    app/         composition root, keymap, preferences, workspaces, i18n strings
    shell-electron/   main, preload, packaging
    shell-web/        PWA entry, service worker
    testkit/     golden-image runner, PSD fixtures, pixel-diff, perf harness
```
Dependency rule: `core ← kernels ← engine ← app → ui`; `ui` never imports `engine`
(talks through the command/state protocol only).

## 4. Pixel storage

### 4.1 Planes and tiles
- Every raster is a **Plane** = sparse grid of **256×256 tiles** + bounds rect + channel
  layout + bit depth. Layers are unbounded in extent (pixels may live outside the canvas,
  like Photoshop); absent tile = transparent / default value.
- Tile = immutable, ref-counted `ArrayBuffer` slice. Writing = copy-on-write → new tile id.
  This gives O(changed tiles) undo and free layer duplication.
- Channel layouts: `RGBA`, `GA`, `CMYKA`, `LabA`, `A` (masks, channels, selection).
  **Alpha is stored straight (un-premultiplied)**, as in PSD, for lossless round-trip.
  Every kernel that filters spatially premultiplies internally.
- Sample types: `u8`; `u16` with Photoshop's **0…32768** range for 16-bit docs; `f32`
  (linear, scene-referred) for 32-bit docs.
- Cold tiles are compressed (LZ4-class, in kernel pool) and, past the RAM budget, spilled to
  the **scratch store** (Electron: temp dir files; web: OPFS). Uniform tiles (single value)
  are stored as 1 pixel.

### 4.2 GPU residency
- Tile textures live in a **paged atlas**: tiles are packed 8×8 into 2048×2048 pages, and the
  pages form one `TEXTURE_2D_ARRAY`, managed by an LRU keyed by tile identity. Upload on
  demand, dirty-rect sub-uploads during strokes.
  **M0 finding:** one tile per array layer does not work. `MAX_ARRAY_TEXTURE_LAYERS` is 2048
  on mainstream hardware, and a 100-layer 4K document needs ~2400 resident tiles at fit-zoom,
  so a one-tile-per-layer atlas thrashed (437k evictions, 374 ms/frame, 3 fps). Paging raises
  the ceiling to 64 × pages. Pages are allocated lazily and grown by doubling, because
  `texStorage3D` commits its memory up front and a blank document must not reserve a GB.
- Atlas residency is tracked **per draw batch, not per frame**: a tile is only sampled by its
  own layer's draw call, so its slot is reusable once that call is issued. That is what lets
  an atlas smaller than "all visible tiles of all layers" work at all.
- Formats: 8-bit → `RGBA8`; 16-bit → `RGBA16` (`EXT_texture_norm16`), fallback `RGBA32F`;
  32-bit → `RGBA32F` (fallback `RGBA16F` for display only). Masks → `R8`/`R16`.
  5-channel (CMYKA) = colour texture + `R8/R16` alpha texture.
  **M0 finding:** on the reference box (NVIDIA/ANGLE) `EXT_texture_norm16` is present and
  `RGBA16` works for *storage and sampling*, but is **not colour-renderable**
  (`checkFramebufferStatus` fails). 16-bit therefore stores `RGBA16` and accumulates into
  `RGBA16F`, which is exactly what §5.2 already specifies; `caps.norm16Renderable` records
  the distinction so no pass assumes it.
- **Mip pyramid:** each plane lazily maintains down-sampled levels (÷2, ÷4, … like Photoshop's
  "cache levels"), built on GPU, invalidated per tile. Zoom < 100 % composites from the
  nearest level ≥ target resolution.
- VRAM budget default = min(50 % of reported/estimated VRAM, 2 GB); evict LRU tiles, then
  cached group composites.

## 5. Compositor

### 5.1 Render graph
The layer tree compiles to a render graph whose nodes are: *tile source*, *mask combine*,
*adjustment* (pure per-pixel function of backdrop), *blend* (mode, opacity, fill, Blend If,
channel restrictions, knockout), *isolated group* (own accumulator), *pass-through group*
(shares parent accumulator; its own mask/opacity applied by lerp against the pre-group
backdrop), *clip group* (base + clipped layers → temp → blend), *effects* (per-layer style
passes, cached), *smart object* (cached transformed render + smart filter stack),
*view transform + colour management + dither*. Semantics are specified in
[06](06-compositing-math.md).

### 5.2 Execution
- WebGL cannot read the framebuffer it writes, so general blending uses **two ping-pong
  accumulators** (`RGBA16F`, premultiplied, viewport- or region-sized). Each blend node draws
  only its **dirty ∩ visible** rect: sample accumulator A + source → write B; swap lazily
  (copy only the touched rect).
- Fast paths: (a) runs of Normal-mode, no-Blend-If pixel layers use fixed-function blending
  with no ping-pong; (b) adjustment layers without masks fuse into one shader (LUT
  concatenation for 1-D curves-type adjustments; analytic chain otherwise); (c) fully opaque
  tile occlusion culling; (d) invisible / 0 % / empty-tile skip.
- **Caches:** every group and every "run below the active layer" keeps a cached composite
  texture per mip level, invalidated by tile-dirty events bubbling up the tree. While
  painting, only `cached-below → active layer (+live stroke buffer) → layers above` is
  re-evaluated, and only inside the stroke's dirty rect.
- Shaders are generated from snippets (blend function × source kind × mask kinds × channel
  layout) and compiled lazily with `KHR_parallel_shader_compile`; the 27 blend functions live
  in one `blend.glsl` selected by `switch` on a uniform for the generic path, specialised
  variants for hot modes.
- **Viewport-driven:** we composite only what is on screen at the resolution needed. Zoom
  ≥ 100 % composites 1:1 and magnifies with nearest-neighbour (pixel grid shown > 500 %).
  Full-resolution composite happens for export / flatten / merge / stamp, tiled in
  4096² regions to respect `MAX_TEXTURE_SIZE`, or on the CPU reference path.
- Final pass: doc-space → display via baked 3-D LUT (33³ / 65³, from lcms2) + optional proof
  LUT + gamut-warning + blue-noise dither to the 8/10-bit canvas.

### 5.3 CPU reference compositor
`kernels/composite` implements identical semantics in TS on typed arrays. Used for: golden
tests (GPU vs CPU must agree within ±1/255), headless/scripting, and machines where the
context is lost. It is *the* executable definition of [06](06-compositing-math.md).

## 6. Document store, commands, history

- The document is an **immutable tree** (plain frozen objects, structural sharing). Planes
  are referenced by id; tile maps are persistent (HAMT-style) so a stroke touching 12 tiles
  creates 12 new tiles + O(log n) map nodes.
- **Every mutation is a Command**: `{ id: 'layer.setOpacity', desc: {...}, target }`.
  Commands are pure `(doc, desc) → doc'` plus optional async kernel/GPU jobs that produce
  tiles. The same descriptors feed: menu items, shortcuts, **Actions** recording/playback,
  the scripting API, tests, and crash-recovery journal.
- **History** = list of `{name, docRoot, selectionRoot, time}` (default 50 states,
  preference 1–1000), exactly Photoshop's linear model: stepping back then acting discards
  the redo tail (unless "Allow Non-Linear History"). **Snapshots** pin a root. **History
  Brush / Fill from History / Art History** read planes from the designated source state.
  Non-recorded changes match Photoshop (zoom, panel state, colour picks, visibility toggles
  optional via "Make Layer Visibility Changes Undoable").
- Coalescing: slider drags, nudge bursts and typing collapse into one state.
- Interactive modes (Free Transform, Crop, Type editing, Select & Mask, Liquify, dialogs with
  Preview) run as **modal sessions**: they hold a preview override in the render graph and
  commit one command on ✓ / Enter, nothing on Esc.
- **Crash safety:** journal of commands + new tiles appended to the scratch store; on next
  launch offer recovery (Photoshop's auto-recovery equivalent), interval default 10 min for
  full checkpoints.

## 7. Vector, text, colour subsystems

- **Vector rasterisation:** paths (shape layers, vector masks, type outlines, pen paths,
  selections-from-path) are rasterised to **coverage planes** with `OffscreenCanvas` 2D
  `Path2D` fill (fast, high-quality AA, zero bytes of code), then coloured/stroked by the
  engine at document bit depth. Path booleans (unite/subtract/intersect/exclude) via a
  compact polygon-clipping lib on flattened curves, keeping original curves where untouched.
- **Text:** `harfbuzzjs` (WASM, ~400 KB gz, lazy-loaded on first type use) for shaping;
  own paragraph composer (single-line composer first, every-line later), own caret/selection
  editing model (no `contenteditable`). Glyph outlines → `Path2D` → coverage plane with the
  four anti-alias modes approximated by coverage gamma/dilation. Fonts via Local Font Access
  (`queryLocalFonts`, granted by Electron permission handler) + user-loaded files + bundled
  OFL fallback.
- **Colour management:** `lcms2` WASM (lazy). Per-document ICC profile; working-space
  defaults sRGB / Gray Gamma 2.2 / a bundled free CMYK profile; Assign / Convert to Profile;
  display transform and soft-proof baked into 3-D LUTs for the final shader; CPU conversions
  for mode changes and export. Blending happens on encoded values (Photoshop default), with
  the "Blend RGB Colors Using Gamma 1.0" option; 32-bit docs blend linear.
- **Colour modes:** engine is channel-layout-agnostic from day one, but milestones deliver
  RGB → Gray → Lab → CMYK → Indexed/Bitmap/Duotone/Multichannel (see [08](08-roadmap.md)).

## 8. Filters & adjustments framework

One declarative registry drives menus, dialogs, smart filters, actions and tests:

```ts
defineFilter({
  id: 'gaussianBlur', menu: 'Filter/Blur/Gaussian Blur…', psKey: 'GsnB',
  params: { radius: { type:'px', min:0.1, max:1000, default:1, scale:'log' } },
  dialog: 'auto',                       // auto-generated slider dialog with preview, or custom component
  gpu: (ctx, src, p) => …,              // returns texture; may be multi-pass
  cpu: (tiles, p) => …,                 // reference implementation
  bounds: (rect, p) => grow(rect, 3*p.radius),   // region-of-interest for tiled execution
  supports: { depths:[8,16,32], modes:['RGB','Gray','CMYK','Lab'], smart:true },
})
```
Adjustments use the same shape with `perPixel: true`, which lets the compositor fuse them
and lets one definition serve both *Image ▸ Adjustments* (destructive) and adjustment layers.
Filters respect selection (feathered blend), active channels, layer transparency lock, mask
targeting, and register "Last Filter" (Ctrl+Alt+F... per keymap) + Fade (Edit ▸ Fade).

## 9. Budgets

| Metric | Budget | How enforced |
|--------|--------|--------------|
| Core payload (JS+CSS+icons, gz) | ≤ 1.5 MB | size-limit in CI |
| Lazy chunks total (WASM: harfbuzz, lcms2, codecs; gz) | ≤ 3 MB, each loaded on first use | size-limit |
| Optional ML model pack | separate download, never bundled | — |
| Installer (Electron, per-OS) | ≤ 95 MB; strip unused locales, no native node modules, asar, max compression | CI artifact check |
| Cold start → interactive blank doc | ≤ 1.0 s (dev box) | perf harness |
| Open 100 MB / 50-layer PSD | ≤ 3 s to first composite, progressive | perf harness |
| Pan/zoom | 60 fps, 100 layers @ 4K | perf harness |
| Brush: input → pixels | ≤ 16 ms p95, 500 px soft brush on 4K layer | perf harness |
| Idle RAM, blank 1080p doc | ≤ 250 MB total app | perf harness |

### 9.1 Measured at M0 (NVIDIA GTX 1650, ANGLE/OpenGL, 1600×900 viewport)

| Metric | Budget | Measured |
|--------|--------|----------|
| Core payload (gz) | ≤ 1.5 MB | 8.6 KB |
| Engine worker (gz) | ≤ 1.5 MB | 13.4 KB |
| Pan, 100 layers @ 3840×2160 | ≤ 16.7 ms/frame | **6.4–7.0 ms (142–157 fps)** |
| — scaling check | linear in layer count | 10L 1.06 ms · 50L 4.16 ms · 200L 16.9 ms |
| Engine-side input → pixels, 500 px brush | ≤ 16 ms p95 | 0.17 ms median, 0.63 ms p95 (lower bound) |
| Atlas VRAM, 100 layers @ fit | ≤ 2 GB | 537 MB (32 pages), 0 thrash |
| CPU tile RAM, same document | — | 328 MB incl. mip pyramids |
| PSD read peak (lazy vs eager) | 500 MB file < 1 GB spike | 1.6× file size → ~810 MB projected |

**Measurement warning — `gl.finish()` is not a barrier here.** On a worker/OffscreenCanvas
context, timing a render loop around `gl.finish()` reported 0.2 ms/frame for the 100-layer
document, i.e. ~450 GPixel/s on a card capable of ~50. Nothing ever read the backbuffer, so
the driver was free to drop earlier frames' rasterisation. Every timed measurement must end
with a **`readPixels` round trip**, and every perf claim must be accompanied by a scaling
check that cost grows with load. The perf harness enforces both.

How we stay small: no UI/component/CSS frameworks; no lodash-style utility deps; icons as
one SVG sprite; dialogs auto-generated from the registry; filters are mostly GLSL strings;
codecs and rarely-used subsystems (Liquify, Camera-Raw-style filter, Filter Gallery, text,
lcms) are separate lazy chunks; the platform's own decoders (`createImageBitmap`,
`ImageDecoder`) handle PNG/JPEG/WebP/AVIF/GIF *decode* for free.

## 10. Preferences, workspaces, i18n, scripting

- Preferences mirror Photoshop's dialog sections (General, Interface, Workspace, Tools,
  History & Cache → "Performance", Cursors, Transparency & Gamut, Units & Rulers, Guides/Grid/
  Slices, Type, Scratch). Stored as JSON in userData; **keymap** and **menus** are
  user-customisable (Edit ▸ Keyboard Shortcuts…) and stored as diffs from the default set.
- Workspaces: serialised dock layout JSON; built-in presets Essentials (default), Photography,
  Painting, Graphic and Web, Motion-less equivalents; "Reset Essentials".
- All strings in a message catalogue from day one (English only shipped initially).
- Scripting: `app.activeDocument…` convenience DOM over the command bus +
  `executeAction(id, descriptor)`; scripts run in a sandboxed worker. `.atn` action files are
  importable where every step maps to a known command.
