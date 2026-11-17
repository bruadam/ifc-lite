/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `${{ … }}` expressions, a small subset of GitHub Actions' language:
 *
 *   literals      'text'  42  true  false  null
 *   paths         event  changed.ifc  matrix.model  steps.ids.outputs.failed
 *   operators     ==  !=  <  <=  >  >=  &&  ||  !  ( )
 *   functions     success() failure() always() contains(a, b) startsWith(a, b)
 *                 endsWith(a, b) join(list, sep) length(x) fromJSON(text)
 *
 * Evaluated by a hand-written parser, never `eval`: workflow files come from
 * branches anyone can push to.
 */

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^']|'')*')|(==|!=|<=|>=|&&|\|\||[<>!(),])|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_*-]+)*))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`cannot parse expression near "${src.slice(pos)}"`);
    pos = TOKEN.lastIndex;
    if (m[1] !== undefined) tokens.push({ kind: 'lit', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: 'lit', value: m[2].slice(1, -1).replace(/''/g, "'") });
    else if (m[3] !== undefined) tokens.push({ kind: 'op', value: m[3] });
    else tokens.push({ kind: 'id', value: m[4] });
  }
  return tokens;
}

function lookup(ctx, path) {
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'null') return null;
  let value = ctx;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

function truthy(v) {
  return !(v === false || v === 0 || v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0));
}

function loose(v) {
  return typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined ? v : String(v).toLowerCase();
}

function callFunction(name, args, ctx) {
  const status = ctx.__status ?? 'success';
  switch (name) {
    case 'success': return status === 'success';
    case 'failure': return status === 'failure';
    case 'always': return true;
    case 'cancelled': return false;
    case 'contains':
      return Array.isArray(args[0]) ? args[0].map(loose).includes(loose(args[1])) : String(args[0] ?? '').toLowerCase().includes(String(args[1] ?? '').toLowerCase());
    case 'startsWith': return String(args[0] ?? '').toLowerCase().startsWith(String(args[1] ?? '').toLowerCase());
    case 'endsWith': return String(args[0] ?? '').toLowerCase().endsWith(String(args[1] ?? '').toLowerCase());
    case 'join': return Array.isArray(args[0]) ? args[0].join(args[1] ?? ',') : String(args[0] ?? '');
    case 'length': return Array.isArray(args[0]) || typeof args[0] === 'string' ? args[0].length : 0;
    case 'fromJSON': return JSON.parse(String(args[0]));
    default: throw new Error(`unknown function ${name}()`);
  }
}

/** Evaluate one expression (without the `${{ }}` wrapper) against `ctx`. */
export function evaluate(src, ctx) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const take = (value) => {
    const t = tokens[i];
    if (!t || (value !== undefined && t.value !== value)) throw new Error(`expected ${value ?? 'a value'} in "${src}"`);
    i++;
    return t;
  };

  function primary() {
    const t = take();
    if (t.kind === 'lit') return t.value;
    if (t.kind === 'op' && t.value === '(') { const v = or(); take(')'); return v; }
    if (t.kind === 'op' && t.value === '!') return !truthy(primary());
    if (t.kind === 'id') {
      if (peek()?.value === '(') {
        take('(');
        const args = [];
        if (peek()?.value !== ')') {
          args.push(or());
          while (peek()?.value === ',') { take(','); args.push(or()); }
        }
        take(')');
        return callFunction(t.value, args, ctx);
      }
      return lookup(ctx, t.value);
    }
    throw new Error(`unexpected "${t.value}" in "${src}"`);
  }
  function comparison() {
    let left = primary();
    while (['==', '!=', '<', '<=', '>', '>='].includes(peek()?.value)) {
      const op = take().value;
      const right = primary();
      const a = loose(left);
      const b = loose(right);
      left = op === '==' ? a === b : op === '!=' ? a !== b
        : op === '<' ? Number(left) < Number(right) : op === '<=' ? Number(left) <= Number(right)
          : op === '>' ? Number(left) > Number(right) : Number(left) >= Number(right);
    }
    return left;
  }
  function and() {
    let left = comparison();
    while (peek()?.value === '&&') { take(); const right = comparison(); left = truthy(left) ? right : left; }
    return left;
  }
  function or() {
    let left = and();
    while (peek()?.value === '||') { take(); const right = and(); left = truthy(left) ? left : right; }
    return left;
  }

  const value = or();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i].value}" in "${src}"`);
  return value;
}

const WHOLE = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/;
const PART = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * Interpolate every `${{ }}` in a value tree. A string that is exactly one
 * expression keeps the expression's type (so a matrix can be a list);
 * embedded expressions are stringified, lists joined with spaces.
 */
export function interpolate(value, ctx) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return evaluate(whole[1], ctx);
    return value.replace(PART, (_, src) => {
      const v = evaluate(src, ctx);
      return Array.isArray(v) ? v.join(' ') : v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.flatMap((v) => {
    const out = interpolate(v, ctx);
    return Array.isArray(out) && typeof v === 'string' && WHOLE.test(v) ? out : [out];
  });
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, ctx)]));
  }
  return value;
}

/** An `if:` condition: bare (`event == 'push'`) or wrapped (`${{ … }}`). Missing means `success()`. */
export function condition(src, ctx) {
  if (src === undefined || src === null) return ctx.__status === undefined || ctx.__status === 'success';
  if (typeof src === 'boolean') return src;
  const whole = WHOLE.exec(String(src));
  const expr = whole ? whole[1] : String(src);
  const usesStatus = /\b(success|failure|always|cancelled)\s*\(/.test(expr);
  const result = truthy(evaluate(expr, ctx));
  // As in GitHub Actions: a condition with no status function implies success() &&.
  return usesStatus ? result : result && (ctx.__status === undefined || ctx.__status === 'success');
}
