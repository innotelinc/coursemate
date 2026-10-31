import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, extractJson, log, warn, truncate, clamp } from './util.js';
import {
  DEFAULT_PERSONA, mergePersona, applyDrift, personaPrompt, lessonsPrompt,
} from './persona.js';

const SCREEN_TYPES = ['lecture', 'slide', 'video', 'quiz', 'test', 'essay_prompt', 'reading', 'syllabus', 'other'];

/**
 * The brain turns pixels and audio into decisions. It never submits anything by
 * itself — it produces answer cards, drafts and notes for a human to act on.
 */
export function makeBrain({ cfg, store, gateway, personaSource }) {
  const basePersona = () => (personaSource ? personaSource() : mergePersona(DEFAULT_PERSONA, {}));

  function context(course, sessionId) {
    const lessons = store.lessons({ course, limit: 12 });
    const stats = store.accuracyByScreenType();
    const persona = applyDrift(basePersona(), store.getPersonaState(course)?.drift || {});
    return { lessons, stats, persona, lessonsText: lessonsPrompt(lessons, stats) };
  }

  // ── 1. Look at the screen and work out what it is ──────────────────────────
  async function triage({ session, image, recentTranscript }) {
    const { persona, lessonsText } = context(session.course, session.id);

    const prompt = `You are looking at a screenshot from a student's device during a course called "${session.course}".
This could be any platform — a university LMS, Coursera, Udemy, YouTube, a PDF, an ebook, a live video call — so judge only by what is visible.

Recent audio from the session (may be empty, may be garbled):
<<<
${truncate(recentTranscript, 1200) || '(none)'}
>>>

${lessonsText ? `Standing lessons:\n${lessonsText}\n` : ''}

Return ONLY a JSON object with exactly these keys:
{
  "screen_type": one of ${JSON.stringify(SCREEN_TYPES)},
  "topic": short noun phrase for what the screen is about,
  "visible_text": the meaningful readable text, cleaned up, max 1200 characters. Preserve question text, answer options, instruction text, slide bullets and code EXACTLY as written. Drop navigation chrome, menus, timestamps and adverts,
  "question": if there is a question being asked of the student, otherwise null:
     { "stem": "...", "kind": "mcq" | "multi" | "short" | "essay" | "code" | "other",
       "options": ["A) ...", "B) ..."],   // [] when there are no options
       "lettering": "A" | "1" | "none" }
  "word_target": integer word count demanded by an essay prompt, or null,
  "confidence": 0.0-1.0 that you identified the screen correctly
}
Never invent text that is not visible. If the screen is unclear, say so with low confidence.`;

    const { text } = await gateway.vision({
      image,
      prompt,
      system: personaPrompt(persona),
      maxTokens: 1400,
      temperature: 0.1,
    });

    const parsed = extractJson(text) || {};
    const screenType = SCREEN_TYPES.includes(parsed.screen_type) ? parsed.screen_type : 'other';
    return {
      screenType,
      topic: String(parsed.topic || '').slice(0, 200),
      visibleText: String(parsed.visible_text || '').slice(0, 4000),
      question: normaliseQuestion(parsed.question),
      wordTarget: Number.isFinite(parsed.word_target) ? parsed.word_target : null,
      confidence: clamp(Number(parsed.confidence) || 0.4, 0, 1),
    };
  }

  // ── 2. Decide what to do about it ─────────────────────────────────────────
  async function processFrame({ session, image, hash, ts = Date.now() / 1000 }) {
    const recent = store.transcriptWindow(session.id, cfg.transcriptWindow);
    const recentTranscript = recent.map((r) => r.text).join(' ');

    const obs = await triage({ session, image, recentTranscript });

    const observationId = store.addObservation({
      sessionId: session.id,
      ts,
      hash,
      screenType: obs.screenType,
      topic: obs.topic,
      text: obs.visibleText,
    });

    if (cfg.keepFrames && image?.b64) {
      try {
        const ext = (image.mime || '').includes('png') ? 'png' : 'jpg';
        writeFileSync(join(cfg.framesDir, `${observationId}.${ext}`), Buffer.from(image.b64, 'base64'));
      } catch (e) {
        warn('brain', 'could not persist frame', e.message);
      }
    }

    let decision;
    try {
      if (['quiz', 'test'].includes(obs.screenType) && obs.question) {
        decision = await answerQuestion({ session, obs, recentTranscript, testMode: obs.screenType === 'test' });
      } else if (obs.screenType === 'essay_prompt') {
        decision = await draftEssay({ session, obs, recentTranscript });
      } else if (['lecture', 'slide', 'video', 'reading', 'syllabus'].includes(obs.screenType)) {
        decision = await takeNotes({ session, obs, recentTranscript });
      } else {
        decision = {
          kind: 'observation',
          payload: { note: 'Nothing actionable on screen.', topic: obs.topic },
          confidence: obs.confidence,
        };
      }
    } catch (e) {
      warn('brain', 'route failed', e.message);
      decision = {
        kind: 'error',
        payload: { error: String(e.message || e), screen_type: obs.screenType },
        confidence: 0,
      };
    }

    const needsHuman = decision.confidence < cfg.confidenceFloor || decision.payload?.needs_human === true;

    const payload = { ...decision.payload, screen_type: obs.screenType, topic: obs.topic };
    const id = newId('dec');

    store.addDecision({
      id,
      sessionId: session.id,
      observationId,
      ts,
      kind: decision.kind,
      screenType: obs.screenType,
      payload,
      confidence: decision.confidence,
      needsHuman,
    });

    // The wire shape matches the rows the desk reads back, so the UI has one
    // contract whether a card arrives from ingest or from a refresh.
    const wire = {
      id,
      session_id: session.id,
      observation_id: observationId,
      ts,
      kind: decision.kind,
      screen_type: obs.screenType,
      payload,
      confidence: decision.confidence,
      needs_human: needsHuman ? 1 : 0,
    };

    if (cfg.mode === 'auto' && cfg.actionWebhook && decision.kind !== 'observation') {
      postWebhook(cfg.actionWebhook, { session_id: session.id, course: session.course, decision: wire });
    }

    log('brain', `${obs.screenType} → ${decision.kind} (${(decision.confidence ?? 0).toFixed(2)})`, obs.topic);
    return { observation: { id: observationId, ...obs }, decision: wire };
  }

  // ── quiz / test ───────────────────────────────────────────────────────────
  async function answerQuestion({ session, obs, recentTranscript, testMode }) {
    const { persona, lessonsText } = context(session.course, session.id);
    const notes = store.notesForCourse(session.course, 25);
    const q = obs.question;

    const prompt = `The student is being asked this question in "${session.course}"${testMode ? ' (this is a graded test — accuracy matters more than speed)' : ''}:

QUESTION: ${q.stem}
${q.options.length ? `OPTIONS:\n${q.options.map((o, i) => `${i}. ${o}`).join('\n')}` : '(no options — free response)'}

Anything else visible on screen that may be relevant:
<<<${truncate(obs.visibleText, 2000)}>>>

What was said out loud in the lecture just before this:
<<<${truncate(recentTranscript, 1800) || '(nothing captured)'}>>>

Your own notes from earlier in this course:
<<<${notes.map((n) => `- ${n.topic}: ${JSON.stringify(n.facts)}`).join('\n') || '(none yet)'}>>>

${lessonsText}

Work it out yourself first, then answer. Return ONLY JSON:
{
  "chosen_index": integer index into OPTIONS, or null for free response,
  "answer_text": the answer to give — for multiple choice repeat the chosen option's text, for free response write the full answer,
  "work": your reasoning in 1-3 sentences,
  "evidence": "lecture" | "general_knowledge" | "notes" | "mixed",
  "confidence": 0.0-1.0,
  "needs_human": true if you would not stake a grade on this
}`;

    const { text } = await gateway.complete({
      messages: [
        { role: 'system', content: `${personaPrompt(persona)}\n\nYou are answering a course question. Be correct first, personable second.` },
        { role: 'user', content: prompt },
      ],
      maxTokens: 900,
      temperature: 0.2,
    });

    const parsed = extractJson(text) || {};
    const idx = Number.isInteger(parsed.chosen_index) ? parsed.chosen_index : null;

    // Guard: never emit an option that was not on screen.
    const validIdx = idx !== null && q.options.length > 0 && idx >= 0 && idx < q.options.length ? idx : null;
    if (q.options.length > 0 && validIdx === null) {
      return {
        kind: 'quiz_answer',
        confidence: 0.2,
        payload: {
          question: q,
          answer_text: parsed.answer_text || '',
          work: parsed.work || '',
          ambiguity: 'The model did not pick a valid visible option.',
          needs_human: true,
        },
      };
    }

    return {
      kind: 'quiz_answer',
      confidence: clamp(Number(parsed.confidence) || 0.5, 0, 1),
      payload: {
        question: q,
        chosen_index: validIdx,
        chosen_text: validIdx !== null ? q.options[validIdx] : null,
        answer_text: parsed.answer_text || (validIdx !== null ? q.options[validIdx] : ''),
        work: parsed.work || '',
        evidence: parsed.evidence || 'mixed',
        needs_human: parsed.needs_human === true,
        test_mode: Boolean(testMode),
      },
    };
  }

  // ── essay ─────────────────────────────────────────────────────────────────
  async function draftEssay({ session, obs, recentTranscript }) {
    const { persona, lessonsText } = context(session.course, session.id);
    const notes = store.notesForCourse(session.course, 40);
    const transcript = store.transcriptForCourse(session.course, 250);
    const target = obs.wordTarget || 800;

    const prompt = `Write the essay this prompt asks for, for the course "${session.course}".

PROMPT AS IT APPEARS ON SCREEN:
<<<${truncate(obs.visibleText, 2500)}>>>

TARGET LENGTH: about ${target} words.

Course material you have actually seen or heard in this course — use it, and prefer it over general knowledge:
LECTURE TRANSCRIPT:
<<<${truncate(transcript.map((t) => t.text).join(' '), 6000) || '(nothing captured)'}>>>

YOUR NOTES:
<<<${truncate(notes.map((n) => `- ${n.topic}: ${JSON.stringify(n.facts)}`).join('\n'), 2500) || '(none)'}>>>

${lessonsText}

Rules:
- Argue something. A thesis in the first two sentences.
- Ground claims in the course material above where you can; say plainly when you are drawing on general knowledge instead.
- Do not use the banned phrases listed in your voice instructions.
- No headers unless the prompt asks for them. No bullet lists in the prose.

Return ONLY JSON:
{
  "title": "...",
  "thesis": "one sentence",
  "prose": "the full essay, paragraphs separated by \\n\\n",
  "word_count": integer,
  "citations": ["short quote or idea from the lecture this rests on", ...],
  "confidence": 0.0-1.0
}`;

    const { text } = await gateway.complete({
      messages: [
        { role: 'system', content: personaPrompt(persona) },
        { role: 'user', content: prompt },
      ],
      maxTokens: Math.min(6000, 400 + target * 2),
      temperature: 0.7,
    });

    const parsed = extractJson(text) || {};
    const prose = String(parsed.prose || '').trim();
    if (!prose) {
      return { kind: 'essay', confidence: 0.1, payload: { error: 'No essay produced.', needs_human: true } };
    }
    const words = prose.split(/\s+/).filter(Boolean).length;
    return {
      kind: 'essay',
      confidence: clamp(Number(parsed.confidence) || 0.6, 0, 1),
      payload: {
        title: parsed.title || 'Untitled',
        thesis: parsed.thesis || '',
        prose,
        word_count: words,
        target_words: target,
        citations: Array.isArray(parsed.citations) ? parsed.citations.slice(0, 8) : [],
      },
    };
  }

  // ── notes ─────────────────────────────────────────────────────────────────
  async function takeNotes({ session, obs, recentTranscript }) {
    const prompt = `You are the student in "${session.course}". You just saw this screen and heard this audio.

SCREEN (${obs.screenType}):
<<<${truncate(obs.visibleText, 2600)}>>>

AUDIO JUST BEFORE:
<<<${truncate(recentTranscript, 1400) || '(silent)'}>>>

Extract what is worth remembering. Return ONLY JSON:
{
  "topic": "short noun phrase",
  "summary": "2-4 sentences a student would actually write down",
  "facts": [ { "claim": "...", "kind": "definition" | "example" | "process" | "date" | "formula" | "person" | "claim" } ],
  "key_terms": ["...", "..."],
  "confident": true if this is substantive course content rather than a menu, loading screen or advert
}`;

    const { text } = await gateway.complete({
      messages: [
        { role: 'system', content: 'You are a precise note-taker. Never invent content that was not on screen or in the audio.' },
        { role: 'user', content: prompt },
      ],
      maxTokens: 900,
      temperature: 0.2,
    });

    const parsed = extractJson(text) || {};
    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 12) : [];

    if (parsed.confident !== false && facts.length) {
      store.addNote({
        course: session.course,
        sessionId: session.id,
        topic: parsed.topic || obs.topic,
        facts,
      });
    }

    return {
      kind: 'note',
      confidence: parsed.confident === false ? 0.25 : 0.8,
      payload: {
        topic: parsed.topic || obs.topic,
        summary: parsed.summary || '',
        key_terms: Array.isArray(parsed.key_terms) ? parsed.key_terms.slice(0, 10) : [],
        fact_count: facts.length,
        stored: parsed.confident !== false && facts.length > 0,
      },
    };
  }

  // ── listen ────────────────────────────────────────────────────────────────
  async function processAudio({ session, audio, ts = Date.now() / 1000 }) {
    const { text } = await gateway.transcribe({ audio });
    const clean = String(text || '').trim();
    // Whisper hallucinates stock phrases on silence; drop the obvious ones.
    const junk = /^(thank you\.?|thanks for watching\.?|you\.?|\.+|bye\.?)$/i;
    if (!clean || clean.length < 3 || junk.test(clean)) return { skipped: true };

    store.addTranscript({ sessionId: session.id, course: session.course, ts, text: clean });
    return { transcript: clean, ts };
  }

  // ── ask me anything about this course ─────────────────────────────────────
  async function ask({ course, question, sessionId }) {
    const { persona, lessonsText } = context(course, sessionId);
    const notes = store.notesForCourse(course, 60);
    const transcript = store.transcriptForCourse(course, 300);

    const { text } = await gateway.complete({
      messages: [
        { role: 'system', content: `${personaPrompt(persona)}\n\nYou are being asked about a course you have been sitting in on. Answer from what you actually saw and heard; say when you are going beyond it.` },
        {
          role: 'user',
          content: `Course: ${course}

Notes:
${truncate(notes.map((n) => `- ${n.topic}: ${JSON.stringify(n.facts)}`).join('\n'), 4000) || '(none)'}

Transcript:
${truncate(transcript.map((t) => t.text).join(' '), 5000) || '(none)'}

${lessonsText}

Question: ${question}`,
        },
      ],
      maxTokens: 1200,
      temperature: 0.5,
    });

    return { answer: text.trim() };
  }

  // ── learn from a correction ───────────────────────────────────────────────
  function recordCorrection({ decisionId, correct, truth, note }) {
    const decision = store.getDecision(decisionId);
    if (!decision) throw new Error(`unknown decision ${decisionId}`);
    store.addCorrection({ decisionId, correct, truth, note });

    // Immediate, cheap learning: a correction that names the right answer
    // becomes a lesson without waiting for a reflection pass.
    if (!correct && (truth || note)) {
      const scope = decision.screen_type === 'essay_prompt' ? 'essay' : 'quiz';
      store.upsertLesson({
        scope,
        course: store.getSession(decision.session_id)?.course,
        text: `${decision.screen_type}: when asked "${truncate(decision.payload?.question?.stem || decision.payload?.topic || 'a question', 120)}", the right answer was "${truncate(truth || note, 200)}".`,
        delta: 0.3,
      });
    }
    return { stats: store.accuracyByScreenType(), totals: store.totals() };
  }

  // ── reflect: the self-evolution pass ──────────────────────────────────────
  async function reflect({ course, sessionId }) {
    const decisions = store.recentDecisions(60, course);
    if (!decisions.length) return { lessons: [], drift: {}, note: 'Nothing to reflect on yet.' };

    const corrections = store.raw
      .prepare(`SELECT c.*, d.screen_type, d.payload FROM corrections c JOIN decisions d ON d.id = c.decision_id ORDER BY c.id DESC LIMIT 40`)
      .all();

    const material = decisions.map((d) => ({
      screen_type: d.screen_type,
      kind: d.kind,
      topic: d.payload?.topic,
      question: d.payload?.question?.stem,
      answered: d.payload?.chosen_text || truncate(d.payload?.thesis || d.payload?.summary || '', 120),
      confidence: d.confidence,
    }));

    const history = corrections.map((c) => ({
      screen_type: c.screen_type,
      agreed: c.correct === 1,
      truth: c.truth,
      note: c.note,
    }));

    const { persona } = context(course, sessionId);

    const { text } = await gateway.complete({
      messages: [
        { role: 'system', content: 'You are reviewing your own performance as a student agent. Be blunt and specific. Vague self-praise is useless.' },
        {
          role: 'user',
          content: `Course: ${course}

Your recent decisions:
${JSON.stringify(material, null, 1)}

Human corrections (agreed = true means the human confirmed you were right):
${JSON.stringify(history, null, 1)}

Your current voice settings:
${JSON.stringify(persona.voice)}

Return ONLY JSON:
{
  "lessons": [ { "scope": "global" | "course" | "quiz" | "essay" | "notes", "text": "imperative, specific, under 200 chars" } ],
  "drift": { "hedging": -0.1, "boldness": 0.05, "formality": 0.0, "humor": 0.0 },
  "assessment": "3-5 sentences on how you are actually doing, in your own voice"
}
Maximum 6 lessons. Only write a lesson you can justify from the data above. drift values must be between -0.15 and 0.15 and may be omitted.`
        },
      ],
      maxTokens: 1400,
      temperature: 0.4,
    });

    const parsed = extractJson(text) || {};
    const lessons = Array.isArray(parsed.lessons) ? parsed.lessons.slice(0, 6) : [];

    const stored = [];
    for (const l of lessons) {
      const scope = ['global', 'course', 'quiz', 'essay', 'notes'].includes(l.scope) ? l.scope : 'global';
      const body = String(l.text || '').trim();
      if (!body) continue;
      const id = store.upsertLesson({
        scope,
        course: scope === 'global' ? null : course,
        text: body.slice(0, 300),
        delta: 0.25,
      });
      stored.push({ id, scope, text: body });
    }

    const drift = {};
    for (const [k, v] of Object.entries(parsed.drift || {})) {
      if (['hedging', 'boldness', 'formality', 'humor'].includes(k) && Number.isFinite(v)) {
        drift[k] = clamp(v, -0.15, 0.15);
      }
    }
    if (Object.keys(drift).length) {
      const prior = store.getPersonaState(course) || { drift: {} };
      const merged = { ...(prior.drift || {}) };
      for (const [k, v] of Object.entries(drift)) merged[k] = (merged[k] || 0) + v;
      // Keep total drift within a coherent band so the persona cannot wander off.
      for (const k of Object.keys(merged)) merged[k] = clamp(merged[k], -0.25, 0.25);
      store.setPersonaState(course, { drift: merged, updated_at: new Date().toISOString() });
    }

    log('reflect', `${stored.length} lessons, drift keys: ${Object.keys(drift).join(',') || 'none'}`);
    return {
      lessons: stored,
      drift,
      assessment: parsed.assessment || '',
      stats: store.accuracyByScreenType(),
    };
  }

  return { processFrame, processAudio, ask, recordCorrection, reflect, triage };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function normaliseQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const stem = String(q.stem || '').trim();
  if (!stem) return null;
  const kind = ['mcq', 'multi', 'short', 'essay', 'code', 'other'].includes(q.kind) ? q.kind : 'other';
  const options = Array.isArray(q.options)
    ? q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 20)
    : [];
  return { stem: stem.slice(0, 2000), kind, options };
}

function postWebhook(url, body) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => warn('webhook', 'delivery failed', e.message));
}
