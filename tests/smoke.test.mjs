import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { startMockGateway } from './mock-gateway.mjs';

// A 1x1 JPEG — the mock gateway never decodes it, it only needs to round-trip.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let mock;
let app;
let base;
let tmp;

async function listen(application) {
  await new Promise((r) => application.server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${application.server.address().port}`;
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  mock = await startMockGateway();
  tmp = mkdtempSync(join(tmpdir(), 'coursemate-'));

  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: mock.url,
    COURSEMATE_API_KEY: 'test-key',
    COURSEMATE_DATA_DIR: tmp,
    COURSEMATE_MODEL: 'auto',
    COURSEMATE_VISION_MODEL: 'auto',
    COURSEMATE_TOKEN: '',
  });

  app = createApp(cfg);
  base = await listen(app);
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  app.store.close();
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('health reports the gateway and an empty memory', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.gateway.key_configured, true);
  assert.equal(body.counters.decisions, 0);
});

test('the root is the landing page and the capture page lives at /desk', async () => {
  // A stranger on the product's own address gets the product, never the control
  // desk — so the desk's marker must be absent from the root, not just present
  // somewhere.
  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  const landing = await root.text();
  assert.match(landing, /CourseMate/);
  assert.doesNotMatch(landing, /getDisplayMedia/);

  const desk = await fetch(`${base}/desk`);
  assert.equal(desk.status, 200);
  const html = await desk.text();
  assert.match(html, /CourseMate/);
  assert.match(html, /getDisplayMedia/);
});

test('a session creates a memory partition for the course', async () => {
  const res = await post(`${base}/api/session`, { course: 'BIOL 201 Cell Biology' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.session_id, /^ses_/);
  assert.equal(body.course, 'BIOL 201 Cell Biology');
  globalThis.__sessionId = body.session_id;
});

test('a quiz screen becomes a validated answer, not a raw model string', async () => {
  const res = await post(`${base}/api/ingest/frame`, {
    session_id: globalThis.__sessionId,
    image_b64: TINY_JPEG,
    mime: 'image/jpeg',
    hash: 'abcd',
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.observation.screenType, 'quiz');
  assert.equal(body.decision.kind, 'quiz_answer');

  const p = body.decision.payload;
  assert.equal(p.chosen_index, 1, 'the chosen index survives validation');
  assert.equal(p.chosen_text, 'B) Chloroplast');
  assert.equal(p.question.options.length, 4);
  assert.ok(body.decision.confidence > 0.5);
  assert.equal(body.decision.needs_human, 0, 'a confident answer does not need a human');
  globalThis.__decisionId = body.decision.id;
});

test('the desk returns the decision for the UI', async () => {
  const res = await fetch(`${base}/api/desk?session_id=${globalThis.__sessionId}`);
  const body = await res.json();
  assert.equal(body.decisions.length, 1);
  assert.equal(body.decisions[0].payload.chosen_text, 'B) Chloroplast');
});

test('audio becomes a transcript line', async () => {
  const res = await post(`${base}/api/ingest/audio`, {
    session_id: globalThis.__sessionId,
    audio_b64: Buffer.from('fake webm bytes for the mock').toString('base64'),
    mime: 'audio/webm',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.transcript, /Photosynthesis/);
});

test('silent audio is dropped instead of stored', async () => {
  const before = app.store.totals().transcriptChars;
  mock.setTranscript('Thank you.');

  const res = await post(`${base}/api/ingest/audio`, {
    session_id: globalThis.__sessionId,
    audio_b64: Buffer.from('more bytes').toString('base64'),
    mime: 'audio/webm',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.skipped, true, 'whisper-style filler on silence is discarded');
  assert.equal(app.store.totals().transcriptChars, before, 'nothing was written to memory');

  mock.setTranscript('Photosynthesis converts light energy into chemical energy.');
});

test('a correction is recorded and immediately becomes a lesson', async () => {
  const res = await post(`${base}/api/correct`, {
    decision_id: globalThis.__decisionId,
    correct: false,
    truth: 'C) Ribosome',
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  const quiz = body.stats.find((s) => s.screen_type === 'quiz');
  assert.ok(quiz, 'stats include the quiz screen type');
  assert.equal(quiz.graded, 1);
  assert.equal(quiz.accuracy, 0);
  assert.ok(body.totals.lessons >= 1, 'a wrong answer with a truth creates a lesson');
});

test('reflection reviews performance and stores bounded drift', async () => {
  const res = await post(`${base}/api/reflect`, { course: 'BIOL 201 Cell Biology' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.lessons.length >= 1);
  assert.ok(body.lessons.every((l) => ['global', 'course', 'quiz', 'essay', 'notes'].includes(l.scope)));
  assert.equal(typeof body.assessment, 'string');
  assert.equal(body.drift.boldness, 0.05);
  assert.equal(body.drift.hedging, -0.05);

  const state = app.store.getPersonaState('BIOL 201 Cell Biology');
  assert.ok(state, 'drift is persisted per course');
  assert.equal(state.drift.boldness, 0.05);
});

test('drift is clamped so the persona cannot wander off', async () => {
  app.store.setPersonaState('BIOL 201 Cell Biology', {
    drift: { boldness: 0.9, humor: -0.8 },
  });
  const res = await fetch(`${base}/api/me?course=BIOL%20201%20Cell%20Biology`);
  const body = await res.json();
  assert.ok(body.persona.voice.boldness <= 1 && body.persona.voice.boldness >= 0);
  assert.ok(body.persona.voice.humor >= 0 && body.persona.voice.humor <= 1);
});

test('the dashboard aggregates lessons, stats and totals', async () => {
  const res = await fetch(`${base}/api/me?course=BIOL%20201%20Cell%20Biology`);
  const body = await res.json();
  assert.ok(body.lessons.length >= 1);
  assert.equal(body.totals.sessions, 1);
  assert.equal(body.totals.decisions, 1);
  assert.equal(body.stats[0].graded, 1);
});

test('a lecture slide becomes stored notes, not an answer', async () => {
  mock.setScreen('lecture');
  const res = await post(`${base}/api/ingest/frame`, {
    session_id: globalThis.__sessionId,
    image_b64: TINY_JPEG,
    mime: 'image/jpeg',
    hash: 'eeee',
  });
  const body = await res.json();
  assert.equal(body.observation.screenType, 'lecture');
  assert.equal(body.decision.kind, 'note');
  assert.equal(body.decision.payload.stored, true, 'substantive content is written to memory');
  assert.match(body.decision.payload.summary, /thylakoid/i);
});

test('an essay prompt produces a draft with a word count', async () => {
  mock.setScreen('essay_prompt');
  const res = await post(`${base}/api/ingest/frame`, {
    session_id: globalThis.__sessionId,
    image_b64: TINY_JPEG,
    mime: 'image/jpeg',
    hash: 'ffff',
  });
  const body = await res.json();
  assert.equal(body.decision.kind, 'essay');

  const p = body.decision.payload;
  assert.ok(p.prose.split(/\s+/).length > 20);
  assert.equal(p.target_words, 300);
  assert.ok(p.citations.length >= 1, 'it cites what it actually heard');
  assert.equal(typeof p.word_count, 'number');
});

test('a study pack exports flashcards and a summary as markdown', async () => {
  mock.setScreen('quiz');
  const res = await post(`${base}/api/study`, { course: 'BIOL 201 Cell Biology' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.degraded, false);
  assert.ok(body.flashcards.length >= 2);
  assert.ok(body.source.notes >= 1, 'the lecture note feeds the pack');
  assert.match(body.markdown, /# BIOL 201 Cell Biology — study pack/);
  assert.match(body.markdown, /## Flashcards/);
  assert.match(body.markdown, /\| thylakoid \|/);
  assert.match(body.markdown, /## Likely exam questions/);
});

test('a study pack still exports when the model is unreachable', async () => {
  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: 'http://127.0.0.1:9/v1', // nothing listens here
    COURSEMATE_API_KEY: 'x',
    COURSEMATE_DATA_DIR: join(tmp, 'offline'),
    COURSEMATE_TIMEOUT_MS: '1500',
  });
  const offline = createApp(cfg);
  const offlineBase = await listen(offline);

  // Seed a note directly so the fallback has material.
  offline.store.addNote({
    course: 'Offline 101',
    topic: 'entropy',
    facts: [{ claim: 'Entropy is a measure of dispersal', kind: 'definition' }],
  });

  const res = await post(`${offlineBase}/api/study`, { course: 'Offline 101' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.degraded, true);
  assert.ok(body.flashcards.length >= 1, 'raw notes become flashcards');
  assert.match(body.markdown, /degraded/);

  await new Promise((r) => offline.server.close(r));
  offline.store.close();
});

test('the persona file is reported and is the source of truth', async () => {
  const res = await fetch(`${base}/api/persona`);
  const body = await res.json();
  assert.equal(body.path, app.cfg.personaPath);
  assert.match(body.persona.voice.tone, /seminar/);
});

test('a hand-edited persona.json changes the agent', async () => {
  const dir = join(tmp, 'persona');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'persona.json');
  writeFileSync(
    file,
    JSON.stringify({ name: 'Ada', voice: { boldness: 0.9, humor: 0.8 }, writing: { banned: ['moist'] } }),
  );

  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: mock.url,
    COURSEMATE_API_KEY: 'test-key',
    COURSEMATE_DATA_DIR: dir,
    COURSEMATE_PERSONA_FILE: file,
  });
  const pApp = createApp(cfg);
  const pBase = await listen(pApp);

  const body = await (await fetch(`${pBase}/api/persona`)).json();
  assert.equal(body.persona.name, 'Ada');
  assert.equal(body.persona.voice.boldness, 0.9);
  assert.equal(body.persona.voice.humor, 0.8);
  assert.deepEqual(body.persona.writing.banned, ['moist'], 'arrays replace wholesale');
  assert.equal(body.persona.voice.formality, 0.4, 'unspecified traits keep the default');

  await new Promise((r) => pApp.server.close(r));
  pApp.store.close();
});

test('you can ask about the course from memory', async () => {
  const res = await post(`${base}/api/ask`, {
    course: 'BIOL 201 Cell Biology',
    question: 'What is most likely on the midterm?',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.answer, /thylakoid/i);
});

test('unknown routes and bad input fail loudly', async () => {
  const missing = await post(`${base}/api/nope`, {});
  assert.equal(missing.status, 404);

  const noCourse = await post(`${base}/api/session`, {});
  assert.equal(noCourse.status, 400);

  const badSession = await post(`${base}/api/ingest/frame`, {
    session_id: 'ses_missing',
    image_b64: TINY_JPEG,
  });
  assert.equal(badSession.status, 404);
});

test('a bearer token is enforced when configured', async () => {
  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: mock.url,
    COURSEMATE_API_KEY: 'test-key',
    COURSEMATE_DATA_DIR: join(tmp, 'auth'),
    COURSEMATE_TOKEN: 'sekrit',
  });
  const gated = createApp(cfg);
  const gatedBase = await listen(gated);

  const blocked = await fetch(`${gatedBase}/api/health`);
  assert.equal(blocked.status, 401);

  const allowed = await fetch(`${gatedBase}/api/health`, {
    headers: { Authorization: 'Bearer sekrit' },
  });
  assert.equal(allowed.status, 200);

  await new Promise((r) => gated.server.close(r));
  gated.store.close();
});

test('a purchased gateway key is accepted when gateway keys are enabled', async () => {
  // Stand in for the OmniRoute gateway: it knows exactly one key, the way a real
  // gateway knows the keys Magnate minted and nothing else.
  const { createServer } = await import('node:http');
  const gate = createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer bought-key';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [] } : { error: 'invalid key' }));
  });
  await new Promise((r) => gate.listen(0, '127.0.0.1', r));
  const gateUrl = `http://127.0.0.1:${gate.address().port}/v1`;

  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: gateUrl,
    COURSEMATE_API_KEY: 'test-key',
    COURSEMATE_DATA_DIR: join(tmp, 'gatewaykeys'),
    COURSEMATE_TOKEN: '',
    COURSEMATE_GATEWAY_KEYS: '1',
  });
  const app = createApp(cfg);
  const base = await listen(app);

  const anonymous = await fetch(`${base}/api/health`);
  assert.equal(anonymous.status, 401);

  const bought = await fetch(`${base}/api/health`, {
    headers: { Authorization: 'Bearer bought-key' },
  });
  assert.equal(bought.status, 200);

  const unknown = await fetch(`${base}/api/health`, {
    headers: { Authorization: 'Bearer not-a-key' },
  });
  assert.equal(unknown.status, 401);

  await new Promise((r) => app.server.close(r));
  app.store.close();
  await new Promise((r) => gate.close(r));
});

test('a key the gateway stops accepting is refused on the very next request', async () => {
  // The promise CourseMate sells is that a key dies when its term does, and the
  // sweep is what ends it. A cached "yes" would keep a deleted key working for
  // the length of the cache, so nothing is cached but a refusal.
  const { createServer } = await import('node:http');
  let live = true;
  const gate = createServer((req, res) => {
    const ok = live && req.headers.authorization === 'Bearer term-key';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [] } : { error: 'invalid key' }));
  });
  await new Promise((r) => gate.listen(0, '127.0.0.1', r));
  const gateUrl = `http://127.0.0.1:${gate.address().port}/v1`;

  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: gateUrl,
    COURSEMATE_API_KEY: 'test-key',
    COURSEMATE_DATA_DIR: join(tmp, 'revocation'),
    COURSEMATE_TOKEN: '',
    COURSEMATE_GATEWAY_KEYS: '1',
  });
  const app = createApp(cfg);
  const base = await listen(app);

  const before = await fetch(`${base}/api/health`, {
    headers: { Authorization: 'Bearer term-key' },
  });
  assert.equal(before.status, 200);

  live = false; // the sweep deleted the key on the gateway

  const after = await fetch(`${base}/api/health`, {
    headers: { Authorization: 'Bearer term-key' },
  });
  assert.equal(after.status, 401);

  await new Promise((r) => app.server.close(r));
  app.store.close();
  await new Promise((r) => gate.close(r));
});

test('the desk can see which session is actually being captured', async () => {
  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);
  const body = await res.json();

  const mine = body.sessions.find((s) => s.id === globalThis.__sessionId);
  assert.ok(mine, 'the session that just ingested is listed');
  assert.equal(mine.course, 'BIOL 201 Cell Biology');
  assert.equal(mine.live, true, 'it saw a frame a moment ago');
  assert.ok(mine.idle_seconds <= 5);
  assert.equal(body.live_window_seconds, 60);
});

test('ingest into a session from a previous lecture is refused', async () => {
  // A broadcast that outlived its lecture is the case that used to keep writing
  // into a session nobody was watching. It answers exactly like an unknown id,
  // because the phone relies on 404 meaning "stop sending".
  const stale = app.store.createSession({ course: 'BIOL 201 Cell Biology', persona: null });
  app.store.raw
    .prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 9 * 3_600_000).toISOString(), stale.id);

  const res = await post(`${base}/api/ingest/frame`, {
    session_id: stale.id,
    image_b64: TINY_JPEG,
    mime: 'image/jpeg',
  });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /expired/);
});

test('pruning forgets old lectures and keeps what belongs to the course', async () => {
  const old = app.store.createSession({ course: 'BIOL 201 Cell Biology', persona: null });
  app.store.addTranscript({
    sessionId: old.id,
    course: 'BIOL 201 Cell Biology',
    ts: 1,
    text: 'a lecture from last month',
  });
  app.store.raw
    .prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), old.id);

  const lessons = app.store.totals().lessons;
  const removed = app.store.pruneSessions(14);

  assert.ok(removed.sessions >= 1);
  assert.ok(removed.transcripts >= 1);
  assert.equal(app.store.getSession(old.id), null, 'the old session is gone');
  assert.equal(app.store.getSession(globalThis.__sessionId).id, globalThis.__sessionId, 'the current lecture survives');
  assert.equal(app.store.totals().lessons, lessons, 'lessons are course-scoped, so they are kept');
});
