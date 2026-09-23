/**
 * A small, explicitly typed Photoshop action-descriptor writer — for the formats whose keys
 * ag-psd's writer does not know (brush descriptors in ABR). Every value says its own type, so
 * nothing is guessed from the key.
 */
export type DV =
  | { t: 'obj'; cls: string; items: [string, DV][] }
  | { t: 'list'; items: DV[] }
  | { t: 'doub'; v: number }
  | { t: 'untf'; unit: '#Pxl' | '#Prc' | '#Ang'; v: number }
  | { t: 'text'; v: string }
  | { t: 'enum'; type: string; v: string }
  | { t: 'long'; v: number }
  | { t: 'bool'; v: boolean };

export const obj = (cls: string, items: [string, DV][]): DV => ({ t: 'obj', cls, items });
export const list = (items: DV[]): DV => ({ t: 'list', items });
export const doub = (v: number): DV => ({ t: 'doub', v });
export const px = (v: number): DV => ({ t: 'untf', unit: '#Pxl', v });
export const pct = (v: number): DV => ({ t: 'untf', unit: '#Prc', v });
export const ang = (v: number): DV => ({ t: 'untf', unit: '#Ang', v });
export const text = (v: string): DV => ({ t: 'text', v });
export const en = (type: string, v: string): DV => ({ t: 'enum', type, v });
export const long = (v: number): DV => ({ t: 'long', v });
export const bool = (v: boolean): DV => ({ t: 'bool', v });

export class ByteWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }
  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.length, v);
    this.length += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
  }
  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.length, v | 0);
    this.length += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v);
    this.length += 8;
  }
  sig(s: string): void {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 32);
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  /** Overwrite a uint32 written earlier (a length placeholder). */
  patch32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0);
  }
  pad(to: number): void {
    while (this.length % to) this.u8(0);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function unicode(w: ByteWriter, s: string): void {
  w.u32(s.length + 1);
  for (let i = 0; i < s.length; i++) w.u16(s.charCodeAt(i));
  w.u16(0);
}

/** A key or class id: four characters as an id (length 0), anything else spelled out. */
function idOrString(w: ByteWriter, s: string): void {
  if (s.length === 4) {
    w.u32(0);
    w.sig(s);
  } else {
    w.u32(s.length);
    for (let i = 0; i < s.length; i++) w.u8(s.charCodeAt(i));
  }
}

function value(w: ByteWriter, v: DV): void {
  switch (v.t) {
    case 'obj':
      w.sig('Objc');
      body(w, v.cls, v.items);
      return;
    case 'list':
      w.sig('VlLs');
      w.u32(v.items.length);
      for (const it of v.items) value(w, it);
      return;
    case 'doub':
      w.sig('doub');
      w.f64(v.v);
      return;
    case 'untf':
      w.sig('UntF');
      w.sig(v.unit);
      w.f64(v.v);
      return;
    case 'text':
      w.sig('TEXT');
      unicode(w, v.v);
      return;
    case 'enum':
      w.sig('enum');
      idOrString(w, v.type);
      idOrString(w, v.v);
      return;
    case 'long':
      w.sig('long');
      w.i32(v.v);
      return;
    case 'bool':
      w.sig('bool');
      w.u8(v.v ? 1 : 0);
      return;
  }
}

function body(w: ByteWriter, cls: string, items: [string, DV][]): void {
  unicode(w, '');
  idOrString(w, cls);
  w.u32(items.length);
  for (const [k, v] of items) {
    idOrString(w, k);
    value(w, v);
  }
}

/** A descriptor with its version (16), as ABR 'desc' and PSD blocks store them. */
export function writeDescriptor(w: ByteWriter, cls: string, items: [string, DV][]): void {
  w.u32(16);
  body(w, cls, items);
}
