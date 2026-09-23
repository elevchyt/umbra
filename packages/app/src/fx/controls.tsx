/** Small controls the Layer Style dialog's pages share. */
import { For, createMemo } from 'solid-js';
import { Checkbox, Select } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { CONTOUR_PRESETS, contourLut, type Contour, type Gradient, type PatternOverlayEffect } from '@umbra/engine';
import { gradientCss, gradientPresets } from '../adjust/editors';
import { PatternPicker } from '../adjust/fill';

export type Rgb = [number, number, number];

export const MODES = BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough').map((m) => ({ value: m as BlendMode, label: BLEND_LABEL[m as BlendMode] }));

const hex = (c: Rgb) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const unhex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export function Swatch(props: { value: Rgb; onChange: (c: Rgb) => void; title?: string }) {
  return <input type="color" class="fx-swatch" title={props.title ?? 'Set colour'} value={hex(props.value)} onInput={(e) => props.onChange(unhex(e.currentTarget.value))} />;
}

/** Blend mode select with the colour swatch beside it, as the effect pages lay them out. */
export function ModeRow(props: { mode: BlendMode; onMode: (m: BlendMode) => void; color?: Rgb; onColor?: (c: Rgb) => void; label?: string }) {
  return (
    <div class="fx-row">
      <Select value={props.mode} label={props.label ?? 'Blend Mode'} width={130} options={MODES} onChange={props.onMode} />
      {props.color && props.onColor ? <Swatch value={props.color} onChange={props.onColor} /> : null}
    </div>
  );
}

/** A slider with its number: the dialog's basic row. */
export function Slide(props: { label: string; value: number; min: number; max: number; suffix?: string; step?: number; precision?: number; onChange: (v: number) => void }) {
  return (
    <div class="fx-row fx-slide">
      <span class="fx-label">{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onInput={(e) => props.onChange(Number(e.currentTarget.value))} />
      <NumberField value={props.value} min={props.min} max={props.max} step={props.step ?? 1} precision={props.precision ?? 0} suffix={props.suffix} width={52} onChange={props.onChange} />
    </div>
  );
}

/** The angle dial: drag the needle, or type. */
export function AngleRow(props: { label?: string; angle: number; onAngle: (a: number) => void; global?: boolean; onGlobal?: (g: boolean) => void }) {
  let dial!: SVGSVGElement;
  const drag = (e: PointerEvent) => {
    const set = (ev: PointerEvent) => {
      const r = dial.getBoundingClientRect();
      const a = (Math.atan2(-(ev.clientY - (r.top + r.height / 2)), ev.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
      props.onAngle(Math.round(a));
    };
    set(e);
    const up = () => {
      window.removeEventListener('pointermove', set);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', set);
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="fx-row">
      <span class="fx-label">{props.label ?? 'Angle'}</span>
      <svg ref={dial} class="fx-dial" viewBox="-12 -12 24 24" width="26" height="26" onPointerDown={drag}>
        <circle r="11" />
        <line x1="0" y1="0" x2={Math.cos((props.angle * Math.PI) / 180) * 10} y2={-Math.sin((props.angle * Math.PI) / 180) * 10} />
      </svg>
      <NumberField value={props.angle} min={-180} max={180} suffix="°" width={52} onChange={props.onAngle} />
      {props.onGlobal ? <Checkbox checked={!!props.global} label="Use Global Light" onChange={props.onGlobal} /> : null}
    </div>
  );
}

/** A contour: preset list with a drawing of the curve, and Anti-aliased. */
export function ContourRow(props: { label?: string; contour: Contour; onContour: (c: Contour) => void; aa?: boolean; onAa?: (v: boolean) => void }) {
  const path = createMemo(() => {
    const lut = contourLut(props.contour);
    let d = '';
    for (let i = 0; i < 256; i += 5) d += `${i === 0 ? 'M' : 'L'}${(i / 255) * 28 + 1},${29 - lut[i]! * 28}`;
    return d;
  });
  const index = () => CONTOUR_PRESETS.findIndex((c) => c.name === props.contour.name);
  return (
    <div class="fx-row">
      <span class="fx-label">{props.label ?? 'Contour'}</span>
      <svg class="fx-contour" viewBox="0 0 30 30" width="30" height="30">
        <path d={path()} />
      </svg>
      <Select
        value={index()}
        width={150}
        options={[...CONTOUR_PRESETS.map((c, i) => ({ value: i, label: c.name })), ...(index() < 0 ? [{ value: -1, label: props.contour.name || 'Custom' }] : [])]}
        onChange={(i) => i >= 0 && props.onContour(CONTOUR_PRESETS[i]!)}
      />
      {props.onAa ? <Checkbox checked={!!props.aa} label="Anti-aliased" onChange={props.onAa} /> : null}
    </div>
  );
}

export function GradientRow(props: { gradient: Gradient; reverse: boolean; onGradient: (g: Gradient) => void; onReverse?: (r: boolean) => void }) {
  const presets = gradientPresets();
  const index = () => presets.findIndex((p) => p.name === props.gradient.name);
  return (
    <div class="fx-row">
      <span class="fx-label">Gradient</span>
      <div class="gradient-preview fx-gradient" style={{ background: gradientCss(props.gradient, props.reverse) }} />
      <Select
        value={index()}
        width={150}
        options={[...presets.map((p, i) => ({ value: i, label: p.name ?? `Gradient ${i + 1}` })), ...(index() < 0 ? [{ value: -1, label: props.gradient.name ?? 'Custom' }] : [])]}
        onChange={(i) => i >= 0 && props.onGradient(presets[i]!)}
      />
      {props.onReverse ? <Checkbox checked={props.reverse} label="Reverse" onChange={props.onReverse} /> : null}
    </div>
  );
}

export type PatternRef = PatternOverlayEffect['pattern'];

/** A pattern picker whose choice travels by id; the engine fills in the pixels. */
export function PatternRow(props: { pattern: PatternRef; onPattern: (p: PatternRef) => void }) {
  return (
    <div class="fx-col">
      <span class="fx-label">Pattern{props.pattern ? `: ${props.pattern.name}` : ''}</span>
      <PatternPicker selected={props.pattern?.id} onPick={(p) => props.onPattern({ id: p.id, name: p.name, width: p.width, height: p.height, data: new Uint8Array(0) })} />
    </div>
  );
}

export function Group(props: { title: string; children: unknown }) {
  return (
    <fieldset class="fx-group">
      <legend>{props.title}</legend>
      {props.children as never}
    </fieldset>
  );
}

export function Radio<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="fx-row fx-radio">
      <For each={props.options}>
        {(o) => (
          <label>
            <input type="radio" checked={props.value === o.value} onChange={() => props.onChange(o.value)} />
            {o.label}
          </label>
        )}
      </For>
    </div>
  );
}
