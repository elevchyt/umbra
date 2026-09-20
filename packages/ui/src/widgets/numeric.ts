/**
 * Unit conversion and field-text parsing for NumberField.
 *
 * Kept separate from the component so the parsing rules — which carry all the Photoshop-like
 * behaviour (unit suffixes, arithmetic) — can be tested without a DOM.
 */

export type Unit = 'px' | '%' | 'in' | 'cm' | 'mm' | 'pt' | 'pica';

/** Conversion to pixels at a given resolution (ppi). */
const PER_INCH: Record<Exclude<Unit, 'px' | '%'>, number> = {
  in: 1,
  cm: 2.54,
  mm: 25.4,
  pt: 72,
  pica: 6,
};

export function toPixels(value: number, unit: Unit, ppi: number, basis = 0): number {
  if (unit === 'px') return value;
  if (unit === '%') return (value / 100) * basis;
  return (value / PER_INCH[unit]) * ppi;
}

export function fromPixels(px: number, unit: Unit, ppi: number, basis = 0): number {
  if (unit === 'px') return px;
  if (unit === '%') return basis === 0 ? 0 : (px / basis) * 100;
  return (px / ppi) * PER_INCH[unit];
}

const UNIT_RE = /^\s*([-+]?[\d.,]+(?:\s*[-+*/]\s*[\d.,]+)*)\s*(px|%|in|cm|mm|pt|picas?)?\s*$/i;

/**
 * Parse a field's text. Returns pixels when a unit is given, otherwise a bare number in the
 * field's own unit. `null` means "unparseable — keep the old value".
 */
export function parseNumeric(
  text: string,
  opts: { unit?: Unit; ppi?: number; basis?: number } = {},
): number | null {
  const m = UNIT_RE.exec(text);
  if (!m) return null;
  const expr = m[1]!.replace(/,/g, '.');
  const value = evalArithmetic(expr);
  if (value === null || !Number.isFinite(value)) return null;

  const suffix = m[2]?.toLowerCase();
  if (!suffix) return value;
  const unit = (suffix.startsWith('pica') ? 'pica' : suffix) as Unit;
  if (unit === (opts.unit ?? 'px')) return value;
  // Convert through pixels into the field's own unit.
  const px = toPixels(value, unit, opts.ppi ?? 72, opts.basis ?? 0);
  return fromPixels(px, opts.unit ?? 'px', opts.ppi ?? 72, opts.basis ?? 0);
}

/**
 * Left-to-right evaluation of + - * / over literals — deliberately not a full expression
 * parser, and deliberately NOT precedence-aware (Photoshop's fields behave the same way).
 *
 * Numbers are tokenised WITHOUT a sign: a pattern like `[-+]?\d+` looks right but makes
 * "100+20" tokenise as ["100", "+20"], losing the operator. A leading sign is folded in
 * afterwards instead.
 */
function evalArithmetic(expr: string): number | null {
  const tokens = expr.match(/\d*\.?\d+|[-+*/]/g);
  if (!tokens || tokens.length === 0) return null;

  let i = 0;
  let sign = 1;
  if (tokens[0] === '-' || tokens[0] === '+') {
    sign = tokens[0] === '-' ? -1 : 1;
    i = 1;
  }
  let acc = sign * Number(tokens[i]);
  if (!Number.isFinite(acc)) return null;
  tokens.splice(0, i + 1);
  tokens.unshift(String(acc));
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const rhs = Number(tokens[i + 1]);
    if (!Number.isFinite(rhs)) return null;
    if (op === '+') acc += rhs;
    else if (op === '-') acc -= rhs;
    else if (op === '*') acc *= rhs;
    else if (op === '/') acc = rhs === 0 ? acc : acc / rhs;
    else return null;
  }
  return acc;
}

