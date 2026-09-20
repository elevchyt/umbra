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
    <div class="dialog-scrim">
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

export function NewDocumentDialog(props: { onCreate: (w: number, h: number, name: string) => void; onCancel: () => void }) {
  const [name, setName] = createSignal('Untitled-1');
  const [w, setW] = createSignal(1920);
  const [h, setH] = createSignal(1080);
  const [ppi, setPpi] = createSignal(72);
  const [group, setGroup] = createSignal('Web');
  const [background, setBackground] = createSignal('white');

  const groups = [...new Set(PRESETS.map((p) => p.group))];
  const shown = createMemo(() => PRESETS.filter((p) => p.group === group()));

  return (
    <Dialog
      title="New Document"
      width={760}
      okLabel="Create"
      onOk={() => props.onCreate(Math.round(w()), Math.round(h()), name())}
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
