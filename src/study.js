import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, truncate, log, warn } from './util.js';
import { personaPrompt } from './persona.js';

/**
 * Study packs: turn a session's memory into something a human can revise from —
 * a summary, key terms, flashcards and the questions this material invites.
 * If the model is unavailable the export still succeeds from raw notes.
 */
export function makeStudy({ cfg, store, gateway, personaSource }) {
  async function build({ course, sessionId }) {
    const notes = store.notesForCourse(course, 80);
    const transcript = store.transcriptForCourse(course, 300);
    const decisions = store.recentDecisions(60, course);
    const stats = store.accuracyByScreenType();

    const material = {
      notes: notes.map((n) => ({ topic: n.topic, facts: n.facts })),
      transcript: truncate(transcript.map((t) => t.text).join(' '), 7000),
      questions_seen: decisions
        .filter((d) => d.payload?.question?.stem)
        .map((d) => d.payload.question.stem)
        .slice(0, 20),
    };

    let deck;
    try {
      deck = await ask(course, material);
    } catch (e) {
      warn('study', 'model unavailable, exporting from raw notes', e.message);
      deck = fromNotes(course, notes);
      deck.degraded = true;
    }

    const markdown = render({ course, deck, notes, transcript, decisions, stats, sessionId });
    return {
      course,
      generated_at: nowIso(),
      ...deck,
      markdown,
      source: {
        notes: notes.length,
        transcript_chars: transcript.reduce((n, t) => n + t.text.length, 0),
        decisions: decisions.length,
      },
    };
  }

  async function ask(course, material) {
    const persona = personaSource();
    const { text } = await gateway.complete({
      messages: [
        {
          role: 'system',
          content: `${personaPrompt(persona)}\n\nYou are turning a course's raw material into revision notes for the student who sat through it. Be concrete and faithful to the material.`,
        },
        {
          role: 'user',
          content: `Course: ${course}

NOTES TAKEN (topic + extracted facts):
${JSON.stringify(material.notes, null, 1) || '[]'}

TRANSCRIPT OF WHAT WAS SAID:
<<<${material.transcript || '(nothing captured)'}>>>

QUESTIONS ALREADY SEEN:
${material.questions_seen.join('\n') || '(none)'}

Build a study pack. Return ONLY JSON:
{
  "summary": "5-8 sentences covering what this course actually covered, in order",
  "key_terms": [ { "term": "...", "meaning": "... one sentence" } ],
  "flashcards": [ { "front": "a question", "back": "a short, checkable answer" } ],
  "likely_exam": [ "a question an examiner would plausibly set on this material" ],
  "gaps": [ "something the material implies but never explained" ]
}
Give 8-20 flashcards and 4-8 likely exam questions. Only use what is in the material; put anything you are unsure of in gaps instead of inventing it.`,
        },
      ],
      maxTokens: 2600,
      temperature: 0.4,
    });

    const parsed = extractJsonLoose(text) || {};
    return {
      summary: String(parsed.summary || '').trim(),
      key_terms: normArray(parsed.key_terms, (t) => ({
        term: String(t.term || t.name || '').trim(),
        meaning: String(t.meaning || t.definition || '').trim(),
      })).filter((t) => t.term),
      flashcards: normArray(parsed.flashcards, (c) => ({
        front: String(c.front || c.q || c.question || '').trim(),
        back: String(c.back || c.a || c.answer || '').trim(),
      })).filter((c) => c.front && c.back),
      likely_exam: normArray(parsed.likely_exam, (q) => String(q).trim()).filter(Boolean),
      gaps: normArray(parsed.gaps, (g) => String(g).trim()).filter(Boolean),
      degraded: false,
    };
  }

  /** No model? A pack built straight from the stored facts still beats nothing. */
  function fromNotes(course, notes) {
    return {
      summary: notes.length
        ? `Built from ${notes.length} stored note(s) without a model. Raw facts below.`
        : 'No notes were captured for this course yet.',
      key_terms: [],
      flashcards: notes.flatMap((n) =>
        n.facts.map((f) => ({ front: `${n.topic}: ${f.claim}`, back: `${f.kind} — recorded during the session` })),
      ).slice(0, 40),
      likely_exam: [],
      gaps: ['Model unavailable — summary and exam questions could not be generated.'],
    };
  }

  function render({ course, deck, notes, transcript, decisions, stats, sessionId }) {
    const lines = [];
    lines.push(`# ${course} — study pack`);
    lines.push('');
    lines.push(
      `_Generated ${nowIso()}_ · ${notes.length} notes · ${transcript.length} transcript lines · ${decisions.length} decisions${deck.degraded ? ' · **degraded (no model)**' : ''}`,
    );
    lines.push('');

    if (deck.summary) {
      lines.push('## Summary');
      lines.push(deck.summary);
      lines.push('');
    }

    if (deck.key_terms?.length) {
      lines.push('## Key terms');
      lines.push('');
      lines.push('| Term | Meaning |');
      lines.push('| --- | --- |');
      for (const t of deck.key_terms) lines.push(`| ${cell(t.term)} | ${cell(t.meaning)} |`);
      lines.push('');
    }

    if (deck.flashcards?.length) {
      lines.push(`## Flashcards (${deck.flashcards.length})`);
      lines.push('');
      deck.flashcards.forEach((c, i) => {
        lines.push(`**${i + 1}. ${c.front}**`);
        lines.push('');
        lines.push(c.back);
        lines.push('');
      });
    }

    if (deck.likely_exam?.length) {
      lines.push('## Likely exam questions');
      lines.push('');
      for (const q of deck.likely_exam) lines.push(`- ${q}`);
      lines.push('');
    }

    if (deck.gaps?.length) {
      lines.push('## Gaps — things to go and check');
      lines.push('');
      for (const g of deck.gaps) lines.push(`- ${g}`);
      lines.push('');
    }

    const graded = stats.filter((s) => s.graded > 0);
    if (graded.length) {
      lines.push('## How the agent did');
      lines.push('');
      for (const s of graded) lines.push(`- ${s.screen_type}: ${Math.round(s.accuracy * 100)}% agreed over ${s.graded}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`_Source session: ${sessionId || 'multiple'}. Produced by CourseMate — read it, don't trust it._`);
    return lines.join('\n');
  }

  function writeToDataDir(pack) {
    const dir = join(cfg.dataDir, 'study');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slug(pack.course)}.md`);
    writeFileSync(file, pack.markdown, 'utf8');
    log('study', `wrote ${file}`);
    return file;
  }

  return { build, writeToDataDir };
}

const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'course';

function normArray(value, map) {
  return Array.isArray(value) ? value.map(map) : [];
}

/** Tolerant JSON pull for replies that are not pure JSON. */
function extractJsonLoose(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export { slug };
