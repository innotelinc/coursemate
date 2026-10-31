import { randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix = 'id') => `${prefix}_${randomUUID().slice(0, 8)}`;

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(scope, msg, extra) {
  const line = `[${nowIso()}] ${scope.padEnd(8)} ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

export const warn = (scope, msg, extra) => {
  const line = `[${nowIso()}] ${scope.padEnd(8)} ${msg}`;
  if (extra !== undefined) console.warn(line, extra);
  else console.warn(line);
};

/**
 * Pull the first JSON object out of a model reply. Models wrap JSON in prose or
 * fences often enough that a bare JSON.parse is not good enough.
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  // Walk to the matching brace so trailing prose does not break parsing.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Hamming distance between two hex strings — used to spot a repeated screen. */
export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export const truncate = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s ?? '');
