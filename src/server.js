import { createServer as createHttpServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT, ensureDirs } from './config.js';
import { openStore } from './store.js';
import { makeGateway } from './gateway.js';
import { makeBrain } from './brain.js';
import { makePersonaSource, applyDrift } from './persona.js';
import { makeStudy } from './study.js';
import { log, warn, nowIso } from './util.js';

const PUBLIC_DIR = join(ROOT, 'public');
// The landing page keeps its own tree. It is served from this origin now, so a
// visitor who is not the owner sees the product instead of the control desk.
const LANDING_DIR = join(ROOT, 'web', 'landing');
const MAX_BODY = 16 * 1024 * 1024; // a 1600x900 JPEG is well under this

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * The row shape the desk and the phone both read. One place, so a decision
 * fetched by id cannot disagree with the same decision inside a session list.
 */
function wireDecision(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    observation_id: row.observation_id,
    ts: row.ts,
    kind: row.kind,
    screen_type: row.screen_type,
    payload: row.payload,
    confidence: row.confidence,
    needs_human: row.needs_human ? 1 : 0,
  };
}

/**
 * Everything is wired here but nothing listens — `start()` does that, so tests
 * can drive the app over a real socket without touching config.
 */
export function createApp(cfg, { fetchImpl } = {}) {
  ensureDirs(cfg);
  const store = openStore(cfg.dbPath);
  const gateway = makeGateway(cfg, fetchImpl);
  const personaSource = makePersonaSource(cfg.personaPath, (path) =>
    log('persona', `reloaded ${path}`),
  );
  const brain = makeBrain({ cfg, store, gateway, personaSource });
  const study = makeStudy({ cfg, store, gateway, personaSource });

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('request body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  // A key sold for the hosted server is an OmniRoute key: minted by Magnate when
  // Stripe says the money arrived, revoked when the session ends. The server has
  // no account list, so it asks the gateway the key was minted on — one cheap
  // call to /models with the key as the bearer.
  // Only REFUSALS are remembered, and only briefly. A cached "yes" outlives the
  // thing it describes: with a five-minute positive verdict a key whose term had
  // ended — or that the sweep had just deleted — kept answering here for up to
  // five more minutes, which is the one window a paid key must not have. So a
  // live key is confirmed against the gateway on every request, and the cache
  // exists only so a wrong key is not asked about on every frame.
  const keyVerdicts = new Map();
  const KEY_REFUSAL_TTL_MS = 45_000;
  const KEY_VERDICT_MAX = 256;

  async function gatewayAccepts(key) {
    const cached = keyVerdicts.get(key);
    if (cached && !cached.ok && Date.now() - cached.at < KEY_REFUSAL_TTL_MS) {
      return false;
    }
    if (cached?.ok) keyVerdicts.delete(key);

    let ok = false;
    try {
      const res = await fetch(`${cfg.gatewayUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      ok = res.ok;
    } catch {
      // A gateway that cannot be reached is not a verdict on the key: refuse this
      // request, but do not cache the failure for five minutes.
      return false;
    }

    // A pass is never stored: the next request asks again, so revocation is
    // immediate. A refusal is stored for the TTL above.
    if (!ok) {
      if (keyVerdicts.size >= KEY_VERDICT_MAX) keyVerdicts.clear();
      keyVerdicts.set(key, { ok: false, at: Date.now() });
    }
    return ok;
  }

  async function authorised(req) {
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (cfg.token) {
      if (given && given === cfg.token) return true;
      return cfg.gatewayKeys && given ? gatewayAccepts(given) : false;
    }

    // No shared token: either this is an open development server, as before, or
    // it is the hosted one where a purchased key is the only way in.
    if (cfg.gatewayKeys) return given ? gatewayAccepts(given) : false;
    return true;
  }

  /**
   * Two trees on one origin: `/` is the landing page, `/desk` is the control
   * desk the app opens, and assets fall through public/ then web/landing/ so
   * neither page has to know which tree it lives in.
   */
  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    // The root is the landing page, so its tree is asked first and the desk's
    // files are the fallback for anything the landing page does not carry.
    let roots = [LANDING_DIR, PUBLIC_DIR];

    if (rel === '/desk' || rel.startsWith('/desk/')) {
      rel = rel.slice('/desk'.length) || '/index.html';
      if (rel === '/') rel = '/index.html';
      // The desk keeps its assets beside it, never in the landing tree.
      roots = [PUBLIC_DIR];
    }

    for (const root of roots) {
      const target = normalize(join(root, rel));
      if (!target.startsWith(root + '/')) return json(res, 403, { error: 'forbidden' });
      if (!existsSync(target)) continue;
      try {
        const buf = await readFile(target);
        res.writeHead(200, {
          'Content-Type': MIME[extname(target)] || 'application/octet-stream',
          'Content-Length': buf.length,
        });
        res.end(buf);
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    return json(res, 404, { error: 'not found' });
  }

  const sessionFor = (id) => {
    const s = store.getSession(id);
    if (!s) throw Object.assign(new Error(`unknown session ${id}`), { status: 404 });
    store.touchSession(id);
    return s;
  };

  // Push is fire-and-forget and lazily imported: an unconfigured APNs must cost
  // nothing, and a slow one must never delay the frame the extension is waiting on.
  const pushOnce = (() => {
    let module = null;
    return async (options) => {
      if (!module) module = await import('./push.js');
      return module.pushDecision(options);
    };
  })();

  // What is worth interrupting for lives in push.js (shouldPush), so the rule
  // has one home and can be tested without a provider key. This only decides
  // whether loading that module is worth it at all.
  const maybePush = (decision, course) => {
    if (!cfg.push.enabled || !decision) return;
    pushOnce({ cfg, store, decision, course }).catch((e) => log('push', 'delivery failed', e.message));
  };

  // A push that never happens is the hardest failure to notice here: a
  // registered device and a misconfigured key both look like silence. Health
  // reports whether the path is configured, how many devices are known, and
  // what the last attempt actually did.
  const pushStatus = async () => {
    const base = {
      configured: cfg.push.enabled,
      environment: cfg.push.environment,
      devices: store.countDevices(),
      // Where the key came from, never the key itself. This is the difference
      // between "the .p8 is on this host" and "the id and team are set but the
      // key never arrived" — which otherwise look identical from a phone.
      key_source: cfg.push.keySource || null,
      missing: cfg.push.missing ?? [],
      warnings: cfg.push.warnings ?? [],
      last_attempt: null,
    };

    // A device count is still worth reporting with push off: "one device
    // registered, push disabled" is exactly the state that delivers nothing.
    if (!cfg.push.enabled) return base;

    try {
      const { lastPushAttempt, totalPruned } = await import('./push.js');
      // pruned_total is cumulative for this process: a device list that quietly
      // keeps rejecting tokens shows up here before it shows up as silence.
      return { ...base, last_attempt: lastPushAttempt(), pruned_total: totalPruned() };
    } catch (e) {
      return { ...base, configured: false, error: e.message };
    }
  };

  const routes = {
    // What the site's "check this key" box asks. Reaching this handler already
    // means `authorised` accepted the bearer; `checked` says whether that was a
    // real verdict from the gateway or a development server saying yes to
    // everything, which the site shows differently rather than claiming a key
    // is good when nothing looked at it.
    'GET /api/key': async () => ({
      ok: true,
      checked: Boolean(cfg.gatewayKeys || cfg.token),
      gateway: cfg.gatewayUrl,
      shop: cfg.shopUrl,
      server: cfg.publicUrl,
      checked_at: nowIso(),
    }),

    'GET /api/health': async () => ({
      ok: true,
      now: nowIso(),
      mode: cfg.mode,
      gateway: { url: cfg.gatewayUrl, key_configured: gateway.apiKeyConfigured(), model: cfg.model, vision_model: cfg.visionModel },
      push: await pushStatus(),
      counters: store.totals(),
    }),

    'POST /api/session': async ({ body }) => {
      const course = String(body.course || '').trim();
      if (!course) throw Object.assign(new Error('course is required'), { status: 400 });
      const persona = personaSource();
      const session = store.createSession({ course, persona });
      log('session', `start ${session.id}`, course);
      return { session_id: session.id, course, persona };
    },

    'POST /api/ingest/frame': async ({ body }) => {
      const session = sessionFor(body.session_id);
      if (!body.image_b64) throw Object.assign(new Error('image_b64 is required'), { status: 400 });
      const result = await brain.processFrame({
        session,
        image: { b64: body.image_b64, mime: body.mime || 'image/jpeg' },
        hash: body.hash || null,
        ts: body.ts || Date.now() / 1000,
      });
      maybePush(result.decision, session.course);
      return result;
    },

    'POST /api/ingest/audio': async ({ body }) => {
      const session = sessionFor(body.session_id);
      if (!body.audio_b64) throw Object.assign(new Error('audio_b64 is required'), { status: 400 });
      return brain.processAudio({
        session,
        audio: { b64: body.audio_b64, mime: body.mime || 'audio/webm' },
        ts: body.ts || Date.now() / 1000,
      });
    },

    'GET /api/desk': async ({ query }) => {
      const sessionId = query.get('session_id');
      if (!sessionId) throw Object.assign(new Error('session_id is required'), { status: 400 });
      const limit = Number(query.get('limit')) || 30;
      return { decisions: store.decisionsForSession(sessionId, limit), totals: store.totals() };
    },

    // One decision by id. A tap on the Live Activity names an answer that may
    // predate the session this phone currently has open, so it cannot be found
    // by scanning the desk.
    'GET /api/decision': async ({ query }) => {
      const id = query.get('id');
      if (!id) throw Object.assign(new Error('id is required'), { status: 400 });
      const row = store.getDecision(id);
      if (!row) throw Object.assign(new Error(`unknown decision ${id}`), { status: 404 });
      return { decision: wireDecision(row) };
    },

    'GET /api/me': async ({ query }) => {
      const course = query.get('course') || '';
      const state = course ? store.getPersonaState(course) : null;
      const persona = applyDrift(personaSource(), state?.drift || {});
      return {
        course,
        persona,
        drift: state?.drift || {},
        lessons: store.lessons({ course, limit: 30 }),
        stats: store.accuracyByScreenType(),
        totals: store.totals(),
        sessions: store.recentSessions(10),
      };
    },

    'POST /api/correct': async ({ body }) => {
      if (!body.decision_id) throw Object.assign(new Error('decision_id is required'), { status: 400 });
      return brain.recordCorrection({
        decisionId: body.decision_id,
        correct: Boolean(body.correct),
        truth: body.truth || '',
        note: body.note || '',
      });
    },

    'POST /api/reflect': async ({ body }) => {
      const course = String(body.course || '').trim();
      if (!course) throw Object.assign(new Error('course is required'), { status: 400 });
      return brain.reflect({ course, sessionId: body.session_id });
    },

    'POST /api/ask': async ({ body }) => {
      const course = String(body.course || '').trim();
      const question = String(body.question || '').trim();
      if (!course || !question) throw Object.assign(new Error('course and question are required'), { status: 400 });
      return brain.ask({ course, question, sessionId: body.session_id });
    },

    'POST /api/study': async ({ body }) => {
      const course = String(body.course || '').trim();
      if (!course) throw Object.assign(new Error('course is required'), { status: 400 });
      return study.build({ course, sessionId: body.session_id });
    },

    'POST /api/devices': async ({ body }) => {
      const token = String(body.device_token || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(token)) {
        throw Object.assign(new Error('device_token must be a 64-hex APNs token'), { status: 400 });
      }
      store.addDevice({
        token,
        platform: String(body.platform || 'ios'),
        bundleId: String(body.bundle_id || ''),
      });
      log('push', `device registered (${store.countDevices()} known)`, token.slice(0, 10));
      return { ok: true, devices: store.countDevices(), push_configured: cfg.push.enabled };
    },

    'GET /api/persona': async () => ({
      path: cfg.personaPath,
      exists: existsSync(cfg.personaPath),
      persona: personaSource(),
    }),
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    // One canonical host. The name this app used to answer on redirects to it,
    // so an install that still carries the old endpoint reaches the same desk
    // instead of failing on a certificate that no longer exists. GET and HEAD
    // only: a 301 on a POST is replayed as a GET by every client, which would
    // drop the body and report success for a request that never happened.
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (
      cfg.publicUrl &&
      cfg.legacyHosts.includes(host) &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      res.writeHead(301, {
        Location: cfg.publicUrl + url.pathname + url.search,
        'Cache-Control': 'public, max-age=3600',
      });
      return res.end();
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    if (!(await authorised(req))) return json(res, 401, { error: 'unauthorized' });

    const handler = routes[key];
    if (!handler) return json(res, 404, { error: `no route ${key}` });

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler({ body, query: url.searchParams, req });
      json(res, 200, result);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) warn('http', `${key} failed`, e.message);
      json(res, status, { error: String(e.message || e) });
    }
  });

  return { server, store, gateway, brain, study, personaSource, cfg };
}

export async function start(cfg) {
  const { server } = createApp(cfg);
  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  log('server', `listening on http://${shown}:${cfg.port}`);
  log('server', `mode=${cfg.mode} gateway=${cfg.gatewayUrl} model=${cfg.model}`);
  if (cfg.host === '0.0.0.0' && !cfg.token) {
    warn('server', 'bound to 0.0.0.0 with no COURSEMATE_TOKEN — anyone on your network can drive this agent');
  }
  return server;
}

// CLI entry: `npm start`
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const { loadConfig } = await import('./config.js');
  await start(loadConfig());
}
