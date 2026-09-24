import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Select, Checkbox, Button } from '@umbra/ui/widgets/controls';
import {
  hsbToRgb,
  rgbToHsb,
  rgbToHex,
  hexToRgb,
  rgbToCss,
  rgbToLab,
  rgbToCmyk,
  outOfCmykGamut,
  isWebSafe,
  nearestWebSafe,
  type RGB,
} from '@umbra/core/color';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { store } from '../state/store';

/**
 * Dialog framework — spec 01 §5.
 *
 * Modal, draggable by the title bar, Enter commits, Escape cancels, and holding Alt turns
 * Cancel into Reset. Those conventions are shared by every Photoshop dialog, so they live
 * here rather than in each one.
 */
export function Dialog(props: {
  title: string;
  children: JSX.Element;
  onOk?: () => void;
  onCancel: () => void;
  onReset?: () => void;
  okLabel?: string;
  width?: number;
  footer?: JSX.Element;
  /**
   * Let clicks through to the canvas — for dialogs with eyedroppers, which in Photoshop are
   * modal to the rest of the app but not to the image.
   */
  passThrough?: boolean;
}) {
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [altHeld, setAltHeld] = createSignal(false);

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onCancel();
      }
      if (e.key === 'Enter' && props.onOk) {
        const t = e.target as HTMLElement;
        if (t.tagName !== 'TEXTAREA') {
          e.stopPropagation();
          props.onOk();
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    onCleanup(() => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    });
  });

  const startDrag = (e: PointerEvent) => {
    const el = (e.currentTarget as HTMLElement).parentElement!;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => setPos({ x: ev.clientX - dx, y: ev.clientY - dy });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div class="dialog-scrim" classList={{ 'pass-through': props.passThrough }}>
      <div
        class="dialog"
        style={{
          width: `${props.width ?? 420}px`,
          ...(pos() ? { left: `${pos()!.x}px`, top: `${pos()!.y}px`, transform: 'none' } : {}),
        }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <div class="dialog-title" onPointerDown={startDrag}>
          <span>{props.title}</span>
          <button type="button" class="dialog-close" onClick={props.onCancel} title="Close">
            <Icon name="close" size={12} />
          </button>
        </div>
        <div class="dialog-body">{props.children}</div>
        <div class="dialog-footer">
          {props.footer}
          <span class="spacer" />
          <Show when={props.onOk}>
            <Button primary onClick={props.onOk} width={78}>
              {props.okLabel ?? 'OK'}
            </Button>
          </Show>
          <Button
            onClick={altHeld() && props.onReset ? props.onReset : props.onCancel}
            width={78}
            title="Hold Alt to reset the dialog"
          >
            {altHeld() && props.onReset ? 'Reset' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- New Document ---------------------------------------------------------------------

interface DocPreset {
  group: string;
  name: string;
  w: number;
  h: number;
  ppi: number;
}

const PRESETS: DocPreset[] = [
  { group: 'Photo', name: 'Landscape, 4×6', w: 1800, h: 1200, ppi: 300 },
  { group: 'Photo', name: 'Portrait, 4×6', w: 1200, h: 1800, ppi: 300 },
  { group: 'Photo', name: 'Full HD', w: 1920, h: 1080, ppi: 72 },
  { group: 'Print', name: 'A4', w: 2480, h: 3508, ppi: 300 },
  { group: 'Print', name: 'Letter', w: 2550, h: 3300, ppi: 300 },
  { group: 'Web', name: 'Web Large, 1920×1080', w: 1920, h: 1080, ppi: 72 },
  { group: 'Web', name: 'Web Medium, 1440×900', w: 1440, h: 900, ppi: 72 },
  { group: 'Mobile', name: 'iPhone-class, 1170×2532', w: 1170, h: 2532, ppi: 72 },
  { group: 'Mobile', name: 'Android-class, 1080×2340', w: 1080, h: 2340, ppi: 72 },
  { group: 'Art & Illustration', name: 'Poster, 2000×3000', w: 2000, h: 3000, ppi: 300 },
];

export function NewDocumentDialog(props: { onCreate: (w: number, h: number, name: string, background: 'white' | 'black' | 'transparent') => void; onCancel: () => void }) {
  const [name, setName] = createSignal('Untitled-1');
  const [w, setW] = createSignal(1920);
  const [h, setH] = createSignal(1080);
  const [ppi, setPpi] = createSignal(72);
  const [group, setGroup] = createSignal('Web');
  const [background, setBackground] = createSignal<'white' | 'black' | 'transparent'>('white');

  const groups = [...new Set(PRESETS.map((p) => p.group))];
  const shown = createMemo(() => PRESETS.filter((p) => p.group === group()));

  return (
    <Dialog
      title="New Document"
      width={760}
      okLabel="Create"
      onOk={() => props.onCreate(Math.round(w()), Math.round(h()), name(), background())}
      onCancel={props.onCancel}
    >
      <div class="newdoc">
        <div class="newdoc-groups">
          <For each={groups}>
            {(g) => (
              <button
                type="button"
                class="newdoc-group"
                classList={{ active: group() === g }}
                onClick={() => setGroup(g)}
              >
                {g}
              </button>
            )}
          </For>
        </div>

        <div class="newdoc-presets">
          <For each={shown()}>
            {(p) => (
              <button
                type="button"
                class="newdoc-preset"
                classList={{ active: w() === p.w && h() === p.h }}
                onClick={() => {
                  setW(p.w);
                  setH(p.h);
                  setPpi(p.ppi);
                }}
              >
                <div class="newdoc-preset-thumb" style={{ 'aspect-ratio': `${p.w} / ${p.h}` }} />
                <div class="newdoc-preset-name">{p.name}</div>
                <div class="newdoc-preset-dims dim">
                  {p.w} × {p.h} px
                </div>
              </button>
            )}
          </For>
        </div>

        <div class="newdoc-details">
          <div class="newdoc-details-head">Preset Details</div>
          <input
            class="newdoc-name"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div class="newdoc-row">
            <NumberField label="Width" value={w()} onChange={setW} min={1} max={300000} suffix="px" width={72} />
          </div>
          <div class="newdoc-row">
            <NumberField label="Height" value={h()} onChange={setH} min={1} max={300000} suffix="px" width={72} />
          </div>
          <div class="newdoc-row">
            <NumberField label="Resolution" value={ppi()} onChange={setPpi} min={1} max={10000} suffix="ppi" width={72} />
          </div>
          <div class="newdoc-row">
            <Select
              label="Color Mode"
              value="rgb8"
              options={[
                { value: 'rgb8', label: 'RGB Color, 8 bit' },
                { value: 'rgb16', label: 'RGB Color, 16 bit', disabled: true },
                { value: 'gray8', label: 'Grayscale, 8 bit', disabled: true },
              ]}
              onChange={() => {}}
              width={150}
            />
          </div>
          <div class="newdoc-row">
            <Select
              label="Background"
              value={background()}
              options={[
                { value: 'white', label: 'White' },
                { value: 'black', label: 'Black' },
                { value: 'transparent', label: 'Transparent' },
              ]}
              onChange={setBackground}
              width={150}
            />
          </div>
          <div class="newdoc-note dim">
            16-bit, Grayscale and CMYK documents arrive with the colour work in M10.
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---- Color Picker -----------------------------------------------------------------------

export function ColorPickerDialog(props: {
  initial: RGB;
  onPick: (c: RGB) => void;
  onCancel: () => void;
}) {
  const [color, setColor] = createSignal<RGB>(props.initial);
  const [webOnly, setWebOnly] = createSignal(false);
  const hsb = createMemo(() => rgbToHsb(color()));
  const lab = createMemo(() => rgbToLab(color()));
  const cmyk = createMemo(() => rgbToCmyk(color()));

  const apply = (c: RGB) => setColor(webOnly() ? nearestWebSafe(c) : c);
  const setHsb = (patch: Partial<{ h: number; s: number; b: number }>) =>
    apply(hsbToRgb({ ...hsb(), ...patch }));

  const pickInField = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const update = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      setHsb({ s: x * 100, b: (1 - y) * 100 });
    };
    update(e);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const pickHue = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const update = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      setHsb({ h: y * 360 });
    };
    update(e);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <Dialog
      title="Color Picker"
      width={540}
      onOk={() => props.onPick(color())}
      onCancel={props.onCancel}
    >
      <div class="picker">
        <div
          class="picker-field"
          style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${rgbToCss(hsbToRgb({ h: hsb().h, s: 100, b: 100 }))})` }}
          onPointerDown={pickInField}
        >
          <span
            class="picker-cursor"
            style={{ left: `${hsb().s}%`, top: `${100 - hsb().b}%` }}
          />
        </div>

        <div class="picker-hue" onPointerDown={pickHue}>
          <span class="picker-hue-cursor" style={{ top: `${(hsb().h / 360) * 100}%` }} />
        </div>

        <div class="picker-readouts">
          <div class="picker-compare">
            <div class="picker-new" style={{ background: rgbToCss(color()) }} title="new" />
            <div class="picker-old" style={{ background: rgbToCss(props.initial) }} title="current" />
          </div>
          <Show when={outOfCmykGamut(color())}>
            <div class="picker-warn" title="Out of CMYK gamut">
              <Icon name="warning" size={13} /> out of gamut
            </div>
          </Show>
          <Show when={!isWebSafe(color())}>
            <button type="button" class="picker-warn" title="Snap to the nearest web-safe colour" onClick={() => setColor(nearestWebSafe(color()))}>
              <Icon name="grid" size={13} /> not web safe
            </button>
          </Show>

          <div class="picker-fields">
            <NumberField label="H" value={Math.round(hsb().h)} onChange={(h) => setHsb({ h })} min={0} max={360} width={44} suffix="°" />
            <NumberField label="S" value={Math.round(hsb().s)} onChange={(s) => setHsb({ s })} min={0} max={100} width={44} suffix="%" />
            <NumberField label="B" value={Math.round(hsb().b)} onChange={(b) => setHsb({ b })} min={0} max={100} width={44} suffix="%" />
            <NumberField label="R" value={Math.round(color().r * 255)} onChange={(r) => apply({ ...color(), r: r / 255 })} min={0} max={255} width={44} />
            <NumberField label="G" value={Math.round(color().g * 255)} onChange={(g) => apply({ ...color(), g: g / 255 })} min={0} max={255} width={44} />
            <NumberField label="B " value={Math.round(color().b * 255)} onChange={(b) => apply({ ...color(), b: b / 255 })} min={0} max={255} width={44} />
            <NumberField label="L" value={Math.round(lab().l)} onChange={() => {}} min={0} max={100} width={44} />
            <NumberField label="a" value={Math.round(lab().a)} onChange={() => {}} min={-128} max={127} width={44} />
            <NumberField label="b " value={Math.round(lab().b)} onChange={() => {}} min={-128} max={127} width={44} />
          </div>

          <div class="picker-cmyk dim">
            C {cmyk().c.toFixed(0)}% M {cmyk().m.toFixed(0)}% Y {cmyk().y.toFixed(0)}% K {cmyk().k.toFixed(0)}%
          </div>

          <div class="picker-hex">
            <span>#</span>
            <input
              value={rgbToHex(color())}
              spellcheck={false}
              onChange={(e) => {
                const c = hexToRgb(e.currentTarget.value);
                if (c) apply(c);
                else e.currentTarget.value = rgbToHex(color());
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <Checkbox checked={webOnly()} onChange={(v) => { setWebOnly(v); if (v) setColor(nearestWebSafe(color())); }} label="Only Web Colors" />
        </div>
      </div>
    </Dialog>
  );
}

// ---- Small informational dialogs ---------------------------------------------------------

export function AboutDialog(props: { onCancel: () => void }) {
  return (
    <Dialog title="About Umbra" width={380} onCancel={props.onCancel}>
      <div class="about">
        <div class="about-title">Umbra</div>
        <p class="dim">A lightweight image editor with a Photoshop-compatible workflow.</p>
        <p class="dim">
          Not affiliated with or endorsed by Adobe. "Photoshop" and "Adobe" are trademarks of
          Adobe Inc.; this application reads and writes the PSD file format for interoperability.
        </p>
      </div>
    </Dialog>
  );
}

export function SystemInfoDialog(props: { onCancel: () => void }) {
  const s = () => store.stats();
  const text = createMemo(() => {
    const st = s();
    return [
      `User agent: ${navigator.userAgent}`,
      `Cores: ${navigator.hardwareConcurrency}`,
      `Cross-origin isolated: ${globalThis.crossOriginIsolated}`,
      `SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}`,
      st ? `Atlas: ${st.atlasResident}/${st.atlasCapacity} across ${st.atlasPages} pages (${(st.atlasBytes / 1e6).toFixed(0)} MB)` : '',
      st ? `Tile RAM: ${(st.tileBytes / 1e6).toFixed(1)} MB` : '',
      st ? `Frame: ${st.frameMs.toFixed(2)} ms, ${st.drawCalls} draw calls` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return (
    <Dialog title="System Info" width={560} onCancel={props.onCancel}>
      <textarea class="sysinfo" readOnly value={text()} onKeyDown={(e) => e.stopPropagation()} />
    </Dialog>
  );
}

export function ShortcutsDialog(props: { rows: { keys: string; label: string }[]; onCancel: () => void }) {
  return (
    <Dialog title="Keyboard Shortcut Reference" width={560} onCancel={props.onCancel}>
      <div class="shortcuts">
        <For each={props.rows}>
          {(r) => (
            <div class="shortcuts-row">
              <kbd>{r.keys}</kbd>
              <span>{r.label}</span>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}

// ---- Image Size / Canvas Size --------------------------------------------------------------

export function ImageSizeDialog(props: {
  width: number;
  height: number;
  onApply: (w: number, h: number, method: string) => void;
  onCancel: () => void;
}) {
  const [w, setW] = createSignal(props.width);
  const [h, setH] = createSignal(props.height);
  const [link, setLink] = createSignal(true);
  const [method, setMethod] = createSignal('bicubic');
  const ratio = props.height === 0 ? 1 : props.width / props.height;

  return (
    <Dialog
      title="Image Size"
      width={380}
      onOk={() => props.onApply(Math.max(1, Math.round(w())), Math.max(1, Math.round(h())), method())}
      onCancel={props.onCancel}
    >
      <div class="sizedlg">
        <div class="dim">
          Original: {props.width} × {props.height} px
        </div>
        <NumberField
          label="Width"
          value={w()}
          onChange={(v) => {
            setW(v);
            // Constrain Proportions, on by default as in Photoshop.
            if (link()) setH(Math.round(v / ratio));
          }}
          min={1}
          max={300000}
          suffix="px"
          width={78}
        />
        <NumberField
          label="Height"
          value={h()}
          onChange={(v) => {
            setH(v);
            if (link()) setW(Math.round(v * ratio));
          }}
          min={1}
          max={300000}
          suffix="px"
          width={78}
        />
        <Checkbox checked={link()} onChange={setLink} label="Constrain Proportions" />
        <Select
          label="Resample"
          value={method()}
          options={[
            { value: 'bicubic', label: 'Bicubic (smooth gradients)' },
            { value: 'bicubicSmoother', label: 'Bicubic Smoother (enlargement)' },
            { value: 'bicubicSharper', label: 'Bicubic Sharper (reduction)' },
            { value: 'bilinear', label: 'Bilinear' },
            { value: 'nearest', label: 'Nearest Neighbour (hard edges)' },
          ]}
          onChange={setMethod}
          width={220}
        />
      </div>
    </Dialog>
  );
}

const ANCHORS = [
  ['topLeft', 'top', 'topRight'],
  ['left', 'center', 'right'],
  ['bottomLeft', 'bottom', 'bottomRight'],
] as const;

export function CanvasSizeDialog(props: {
  width: number;
  height: number;
  onApply: (w: number, h: number, anchor: string) => void;
  onCancel: () => void;
}) {
  const [w, setW] = createSignal(props.width);
  const [h, setH] = createSignal(props.height);
  const [anchor, setAnchor] = createSignal<string>('center');

  return (
    <Dialog
      title="Canvas Size"
      width={340}
      onOk={() => props.onApply(Math.max(1, Math.round(w())), Math.max(1, Math.round(h())), anchor())}
      onCancel={props.onCancel}
    >
      <div class="sizedlg">
        <div class="dim">
          Current: {props.width} × {props.height} px
        </div>
        <NumberField label="Width" value={w()} onChange={setW} min={1} max={300000} suffix="px" width={78} />
        <NumberField label="Height" value={h()} onChange={setH} min={1} max={300000} suffix="px" width={78} />
        <div class="anchor-label dim">Anchor</div>
        <div class="anchor-grid">
          <For each={ANCHORS.flat()}>
            {(a) => (
              <button
                type="button"
                class="anchor-cell"
                classList={{ active: anchor() === a }}
                title={a}
                onClick={() => setAnchor(a)}
              />
            )}
          </For>
        </div>
      </div>
    </Dialog>
  );
}

/** One-field dialog shared by Select ▸ Modify and similar simple commands. */
export function AmountDialog(props: {
  title: string;
  label: string;
  initial: number;
  unit?: string;
  min?: number;
  max?: number;
  onApply: (value: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal(props.initial);
  return (
    <Dialog title={props.title} width={280} onOk={() => props.onApply(value())} onCancel={props.onCancel}>
      <div class="sizedlg">
        <NumberField
          label={props.label}
          value={value()}
          onChange={setValue}
          min={props.min ?? 0}
          max={props.max ?? 1000}
          suffix={props.unit ?? 'px'}
          width={70}
        />
      </div>
    </Dialog>
  );
}

const FILL_CONTENTS = [
  { value: 'foreground', label: 'Foreground Color' },
  { value: 'background', label: 'Background Color' },
  { value: 'color', label: 'Color…' },
  { value: 'black', label: 'Black' },
  { value: 'gray50', label: '50% Gray' },
  { value: 'white', label: 'White' },
  { value: 'transparent', label: 'Transparent' },
];

const BLEND_OPTIONS = BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough').map((m) => ({
  value: m as BlendMode,
  label: BLEND_LABEL[m as BlendMode],
}));

export interface FillRequest {
  contents: string;
  mode: BlendMode;
  opacity: number;
  preserveTransparency: boolean;
}

/** Edit ▸ Fill — spec 04 §7. Layout follows Photoshop: Contents, then Blending. */
export function FillDialog(props: { onApply: (r: FillRequest) => void; onCancel: () => void }) {
  const [contents, setContents] = createSignal('foreground');
  const [mode, setMode] = createSignal<BlendMode>('normal');
  const [opacity, setOpacity] = createSignal(100);
  const [preserve, setPreserve] = createSignal(false);

  return (
    <Dialog
      title="Fill"
      width={340}
      onCancel={props.onCancel}
      onOk={() =>
        props.onApply({
          contents: contents(),
          mode: mode(),
          opacity: opacity() / 100,
          preserveTransparency: preserve(),
        })
      }
    >
      <div class="dialog-section">
        <div class="dialog-section-title">Contents</div>
        <Select label="Use" value={contents()} options={FILL_CONTENTS} onChange={setContents} width={160} />
      </div>
      <div class="dialog-section">
        <div class="dialog-section-title">Blending</div>
        <Select label="Mode" value={mode()} options={BLEND_OPTIONS} onChange={setMode} width={160} />
        <NumberField label="Opacity" value={opacity()} onChange={setOpacity} min={0} max={100} suffix="%" width={56} />
        <Checkbox
          checked={preserve()}
          onChange={setPreserve}
          label="Preserve Transparency"
          // Filling transparent pixels is the only thing Transparent CAN do.
          disabled={contents() === 'transparent'}
        />
      </div>
    </Dialog>
  );
}

export interface StrokeRequest extends FillRequest {
  width: number;
  location: 'inside' | 'center' | 'outside';
}

/** Edit ▸ Stroke — spec 04 §7. */
export function StrokeDialog(props: { onApply: (r: StrokeRequest) => void; onCancel: () => void }) {
  const [width, setWidth] = createSignal(3);
  const [location, setLocation] = createSignal<'inside' | 'center' | 'outside'>('inside');
  const [mode, setMode] = createSignal<BlendMode>('normal');
  const [opacity, setOpacity] = createSignal(100);
  const [preserve, setPreserve] = createSignal(false);

  return (
    <Dialog
      title="Stroke"
      width={340}
      onCancel={props.onCancel}
      onOk={() =>
        props.onApply({
          contents: 'foreground',
          width: width(),
          location: location(),
          mode: mode(),
          opacity: opacity() / 100,
          preserveTransparency: preserve(),
        })
      }
    >
      <div class="dialog-section">
        <div class="dialog-section-title">Stroke</div>
        <NumberField label="Width" value={width()} onChange={setWidth} min={1} max={250} suffix="px" width={56} />
      </div>
      <div class="dialog-section">
        <div class="dialog-section-title">Location</div>
        <Select
          label=""
          value={location()}
          options={[
            { value: 'inside', label: 'Inside' },
            { value: 'center', label: 'Center' },
            { value: 'outside', label: 'Outside' },
          ]}
          onChange={(v) => setLocation(v as 'inside' | 'center' | 'outside')}
          width={120}
        />
      </div>
      <div class="dialog-section">
        <div class="dialog-section-title">Blending</div>
        <Select label="Mode" value={mode()} options={BLEND_OPTIONS} onChange={setMode} width={160} />
        <NumberField label="Opacity" value={opacity()} onChange={setOpacity} min={0} max={100} suffix="%" width={56} />
        <Checkbox checked={preserve()} onChange={setPreserve} label="Preserve Transparency" />
      </div>
    </Dialog>
  );
}

/** A one-line name prompt — Edit ▸ Define Pattern's "Pattern Name", and the like. */
export function NameDialog(props: { title: string; label: string; initial: string; onApply: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = createSignal(props.initial);
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  return (
    <Dialog title={props.title} width={320} onOk={() => props.onApply(value().trim() || props.initial)} onCancel={props.onCancel}>
      <label class="field">
        <span class="field-label">{props.label}</span>
        <input ref={input} class="text-input" type="text" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
      </label>
    </Dialog>
  );
}
