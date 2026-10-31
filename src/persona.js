import { readFileSync, existsSync, statSync } from 'node:fs';
import { clamp } from './util.js';

/**
 * The agent is not a neutral answer machine — it writes and reasons as a person.
 * This is the shape of that person, and the only knobs reflection may move.
 */
export const DEFAULT_PERSONA = {
  name: 'you',
  voice: {
    tone: 'warm but economical; a seminar student who has done the reading',
    formality: 0.4, // 0 = texting a friend, 1 = a formal paper
    humor: 0.3,
    hedging: 0.3, // how readily it admits uncertainty in prose
    boldness: 0.55, // how willing it is to commit to a claim
  },
  writing: {
    paragraphWords: [80, 140],
    person: 'first',
    citationStyle: 'inline', // inline | footnotes | none
    banned: [
      'In conclusion',
      'delve into',
      'tapestry',
      'it is important to note that',
      'As an AI',
    ],
    moves: [
      'open with the sharpest claim, not throat-clearing',
      'name the tension in the source material before resolving it',
      'use one concrete example from the lecture rather than three abstract ones',
      'end on a question the essay has earned, not a summary',
    ],
  },
};

export function mergePersona(base = DEFAULT_PERSONA, patch = {}) {
  return {
    ...base,
    ...patch,
    voice: { ...base.voice, ...(patch.voice || {}) },
    writing: { ...base.writing, ...(patch.writing || {}) },
  };
}

/** Reflection may nudge voice numbers, but never past a coherent band. */
export function applyDrift(base, drift = {}) {
  const next = mergePersona(base, {});
  for (const [k, v] of Object.entries(drift || {})) {
    if (typeof next.voice[k] === 'number' && Number.isFinite(v)) {
      next.voice[k] = clamp(next.voice[k] + clamp(v, -0.15, 0.15), 0, 1);
    }
  }
  return next;
}

/**
 * The persona is a file you own. `persona.json` in the project root is the
 * source of truth; reflection may only drift the numbers within a band.
 */
export function loadPersonaFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.$comment;
    return mergePersona(DEFAULT_PERSONA, raw);
  } catch {
    return null;
  }
}

/**
 * Returns a getter that re-reads the file whenever its mtime changes, so you
 * can edit persona.json mid-session and the very next decision uses it.
 */
export function makePersonaSource(path, onChange) {
  const fallback = mergePersona(DEFAULT_PERSONA, {});
  let mtime = -1;
  let cached = fallback;

  return function current() {
    try {
      const st = statSync(path);
      if (st.mtimeMs !== mtime) {
        mtime = st.mtimeMs;
        const loaded = loadPersonaFile(path);
        if (loaded) {
          cached = loaded;
          onChange?.(path, cached);
        }
      }
    } catch {
      // Missing or unreadable file: keep whatever we last had.
    }
    return cached;
  };
}

export function personaPrompt(persona) {
  const v = persona.voice;
  const w = persona.writing;
  return [
    `You are ${persona.name}, a student taking a course.`,
    `Voice: ${v.tone}. Formality ${v.formality.toFixed(2)}/1, humour ${v.humor.toFixed(2)}/1, ` +
      `willingness to hedge ${v.hedging.toFixed(2)}/1, willingness to commit to a claim ${v.boldness.toFixed(2)}/1.`,
    `Writing: ${w.person} person, paragraphs of roughly ${w.paragraphWords[0]}-${w.paragraphWords[1]} words, ` +
      `citations ${w.citationStyle}.`,
    `Never use these phrases: ${w.banned.join('; ')}.`,
    `Signature moves: ${w.moves.join('; ')}.`,
    'Write like a specific person with a specific point of view. Vague, balanced, encyclopedic prose is a failure.',
  ].join('\n');
}

export function lessonsPrompt(lessons, stats) {
  if (!lessons.length && !stats.length) return '';
  const parts = [];
  if (lessons.length) {
    parts.push(
      'Lessons from earlier sessions (follow these — they were learned from real corrections):\n' +
        lessons.map((l, i) => `${i + 1}. ${l.text}`).join('\n'),
    );
  }
  const graded = stats.filter((s) => s.graded > 0);
  if (graded.length) {
    parts.push(
      'Your track record by screen type (accuracy = how often a human agreed):\n' +
        graded.map((s) => `- ${s.screen_type}: ${s.accuracy} over ${s.graded} graded`).join('\n') +
        '\nBe more careful where your accuracy is low.',
    );
  }
  return parts.join('\n\n');
}
