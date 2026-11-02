import { DatabaseSync } from 'node:sqlite';
import { nowIso, newId } from './util.js';

/**
 * Everything the agent remembers lives here: what it saw, what it heard, what
 * it decided, how you corrected it, and the lessons it drew from that.
 */
export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      course TEXT NOT NULL,
      persona TEXT,
      started_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts REAL NOT NULL,
      hash TEXT,
      screen_type TEXT,
      topic TEXT,
      text TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_obs_session ON observations(session_id, ts);

    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      course TEXT,
      ts REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_tr_session ON transcripts(session_id, ts);

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      observation_id TEXT,
      ts REAL NOT NULL,
      kind TEXT NOT NULL,
      screen_type TEXT,
      payload TEXT NOT NULL,
      confidence REAL,
      needs_human INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_dec_session ON decisions(session_id, ts);

    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT NOT NULL,
      ts REAL NOT NULL,
      correct INTEGER NOT NULL,
      truth TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_corr_decision ON corrections(decision_id);

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course TEXT NOT NULL,
      session_id TEXT,
      ts REAL NOT NULL,
      topic TEXT,
      facts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_notes_course ON notes(course, ts);

    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      course TEXT,
      text TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_lessons_scope ON lessons(scope, course);

    CREATE TABLE IF NOT EXISTS persona_state (
      course TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      token TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      bundle_id TEXT,
      added_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);

  const q = (sql) => db.prepare(sql);

  return {
    raw: db,
    close: () => db.close(),

    // ── sessions ──────────────────────────────────────────────────────────────
    createSession({ course, persona }) {
      const id = newId('ses');
      q('INSERT INTO sessions (id, course, persona, started_at, last_seen_at) VALUES (?,?,?,?,?)')
        .run(id, course, JSON.stringify(persona ?? null), nowIso(), nowIso());
      return { id, course };
    },
    getSession(id) {
      return q('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
    },
    touchSession(id) {
      q('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
    },
    recentSessions(limit = 10) {
      return q('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
    },

    /**
     * Forgets lectures older than `days`: the session plus its observations,
     * transcripts and decisions. Notes, lessons and persona drift stay, because
     * they belong to the course rather than to one sitting in it.
     */
    pruneSessions(days) {
      const cutoff = new Date(Date.now() - Math.max(0, days) * 86_400_000).toISOString();
      const ids = q('SELECT id FROM sessions WHERE started_at < ?').all(cutoff).map((r) => r.id);
      if (!ids.length) return { sessions: 0, observations: 0, transcripts: 0, decisions: 0 };

      const marks = ids.map(() => '?').join(',');
      return {
        observations: q(`DELETE FROM observations WHERE session_id IN (${marks})`).run(...ids).changes,
        transcripts: q(`DELETE FROM transcripts WHERE session_id IN (${marks})`).run(...ids).changes,
        decisions: q(`DELETE FROM decisions WHERE session_id IN (${marks})`).run(...ids).changes,
        sessions: q(`DELETE FROM sessions WHERE id IN (${marks})`).run(...ids).changes,
      };
    },

    // ── push devices ───────────────────────────────────────────────────────
    addDevice({ token, platform, bundleId }) {
      const now = new Date().toISOString();
      q(`INSERT INTO devices (token, platform, bundle_id, added_at, last_seen_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET
           platform = excluded.platform,
           bundle_id = excluded.bundle_id,
           last_seen_at = excluded.last_seen_at`)
        .run(token, platform || 'ios', bundleId || '', now, now);
      return token;
    },
    devices() {
      return q('SELECT * FROM devices ORDER BY last_seen_at DESC').all();
    },
    removeDevice(token) {
      q('DELETE FROM devices WHERE token = ?').run(token);
    },
    countDevices() {
      return q('SELECT COUNT(*) AS n FROM devices').get()?.n ?? 0;
    },

    // ── observations & transcript ─────────────────────────────────────────────
    addObservation(o) {
      const id = newId('obs');
      q('INSERT INTO observations (id, session_id, ts, hash, screen_type, topic, text) VALUES (?,?,?,?,?,?,?)')
        .run(id, o.sessionId, o.ts, o.hash ?? null, o.screenType ?? null, o.topic ?? null, o.text ?? null);
      return id;
    },
    lastObservationHash(sessionId) {
      const row = q('SELECT hash FROM observations WHERE session_id = ? ORDER BY ts DESC LIMIT 1').get(sessionId);
      return row?.hash ?? null;
    },
    addTranscript({ sessionId, course, ts, text }) {
      q('INSERT INTO transcripts (session_id, course, ts, text) VALUES (?,?,?,?)')
        .run(sessionId, course ?? null, ts, text);
    },
    transcriptWindow(sessionId, limit = 40) {
      return q('SELECT ts, text FROM transcripts WHERE session_id = ? ORDER BY id DESC LIMIT ?')
        .all(sessionId, limit)
        .reverse();
    },
    transcriptForCourse(course, limit = 400) {
      return q('SELECT ts, text FROM transcripts WHERE course = ? ORDER BY id DESC LIMIT ?')
        .all(course, limit)
        .reverse();
    },

    // ── notes ─────────────────────────────────────────────────────────────────
    addNote({ course, sessionId, topic, facts }) {
      q('INSERT INTO notes (course, session_id, ts, topic, facts) VALUES (?,?,?,?,?)')
        .run(course, sessionId ?? null, Date.now() / 1000, topic ?? null, JSON.stringify(facts));
    },
    notesForCourse(course, limit = 40) {
      return q('SELECT ts, topic, facts FROM notes WHERE course = ? ORDER BY id DESC LIMIT ?')
        .all(course, limit)
        .map((r) => ({ ...r, facts: safeParse(r.facts, []) }));
    },

    // ── decisions ─────────────────────────────────────────────────────────────
    addDecision(d) {
      q('INSERT INTO decisions (id, session_id, observation_id, ts, kind, screen_type, payload, confidence, needs_human) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(d.id, d.sessionId, d.observationId ?? null, d.ts, d.kind, d.screenType ?? null,
          JSON.stringify(d.payload), d.confidence ?? null, d.needsHuman ? 1 : 0);
      return d.id;
    },
    getDecision(id) {
      const row = q('SELECT * FROM decisions WHERE id = ?').get(id);
      return row ? { ...row, payload: safeParse(row.payload, {}) } : null;
    },
    decisionsForSession(sessionId, limit = 60) {
      return q('SELECT * FROM decisions WHERE session_id = ? ORDER BY ts DESC LIMIT ?')
        .all(sessionId, limit)
        .map((r) => ({ ...r, payload: safeParse(r.payload, {}) }));
    },
    recentDecisions(limit = 40, course) {
      const rows = course
        ? q(`SELECT d.* FROM decisions d JOIN sessions s ON s.id = d.session_id
             WHERE s.course = ? ORDER BY d.ts DESC LIMIT ?`).all(course, limit)
        : q('SELECT * FROM decisions ORDER BY ts DESC LIMIT ?').all(limit);
      return rows.map((r) => ({ ...r, payload: safeParse(r.payload, {}) }));
    },

    // ── corrections & stats ───────────────────────────────────────────────────
    addCorrection({ decisionId, correct, truth, note }) {
      q('INSERT INTO corrections (decision_id, ts, correct, truth, note) VALUES (?,?,?,?,?)')
        .run(decisionId, Date.now() / 1000, correct ? 1 : 0, truth ?? null, note ?? null);
    },
    accuracyByScreenType() {
      return q(`
        SELECT d.screen_type AS screen_type,
               COUNT(c.id) AS graded,
               SUM(c.correct) AS agreed,
               ROUND(CAST(SUM(c.correct) AS REAL) / COUNT(c.id), 3) AS accuracy
        FROM corrections c
        JOIN decisions d ON d.id = c.decision_id
        GROUP BY d.screen_type
        ORDER BY graded DESC
      `).all();
    },
    totals() {
      const one = (sql) => q(sql).get()?.n ?? 0;
      return {
        sessions: one('SELECT COUNT(*) AS n FROM sessions'),
        observations: one('SELECT COUNT(*) AS n FROM observations'),
        decisions: one('SELECT COUNT(*) AS n FROM decisions'),
        corrections: one('SELECT COUNT(*) AS n FROM corrections'),
        lessons: one('SELECT COUNT(*) AS n FROM lessons'),
        transcriptChars: one('SELECT COALESCE(SUM(LENGTH(text)),0) AS n FROM transcripts'),
      };
    },

    // ── lessons (the evolving part) ───────────────────────────────────────────
    upsertLesson({ scope, course, text, delta = 0.15 }) {
      const existing = q('SELECT * FROM lessons WHERE scope = ? AND COALESCE(course,\'\') = COALESCE(?,\'\') AND text = ?')
        .get(scope, course ?? null, text);
      if (existing) {
        // Reinforcement strengthens a lesson; repeated use decays it toward a
        // baseline so a one-off does not dominate forever.
        const weight = Math.min(1, Math.max(0, existing.weight * (1 - 0.05) + delta * 0.5));
        q('UPDATE lessons SET weight = ?, updated_at = ? WHERE id = ?').run(weight, nowIso(), existing.id);
        return existing.id;
      }
      const info = q('INSERT INTO lessons (scope, course, text, weight, uses, created_at, updated_at) VALUES (?,?,?,?,0,?,?)')
        .run(scope, course ?? null, text, Math.min(1, Math.max(0.05, 0.4 + delta)), nowIso(), nowIso());
      return Number(info.lastInsertRowid);
    },
    lessons({ course, scopes = ['global', 'course', 'quiz', 'essay', 'notes'], limit = 12 }) {
      const placeholders = scopes.map(() => '?').join(',');
      return q(`SELECT * FROM lessons
                WHERE scope IN (${placeholders})
                  AND (course IS NULL OR course = ? OR scope = 'global')
                ORDER BY weight DESC, updated_at DESC LIMIT ?`)
        .all(...scopes, course ?? '', limit);
    },
    bumpLessonUses(ids) {
      for (const id of ids) q('UPDATE lessons SET uses = uses + 1 WHERE id = ?').run(id);
    },

    // ── persona drift ─────────────────────────────────────────────────────────
    getPersonaState(course) {
      const row = q('SELECT json FROM persona_state WHERE course = ?').get(course);
      return row ? safeParse(row.json, null) : null;
    },
    setPersonaState(course, state) {
      q(`INSERT INTO persona_state (course, json, updated_at) VALUES (?,?,?)
         ON CONFLICT(course) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
        .run(course, JSON.stringify(state), nowIso());
    },
  };
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
