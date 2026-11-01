// APNs delivery over HTTP/2, with no dependency: the provider JWT is signed
// with node:crypto (ES256 over the .p8 key) and the request speaks the same
// protocol every push library speaks.
//
// Unconfigured is the normal state. Without APNS_KEY_PATH / APNS_KEY_ID /
// APNS_TEAM_ID this module reports "not configured" and the app keeps using its
// local notifications — nothing here pretends a push was sent.
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

const PRODUCTION = 'https://api.push.apple.com';
const SANDBOX = 'https://api.sandbox.push.apple.com';

/** Apple rejects provider tokens older than an hour; refresh well inside that. */
const TOKEN_TTL_SECONDS = 3000;

let cache = { keyPath: '', jwt: '', mintedAt: 0 };

/**
 * The last delivery attempt, kept in memory so /api/health can answer the one
 * question a silent failure makes impossible to ask: did the push path run at
 * all, and if not, why? A registered device plus a misconfigured key produces
 * no notification and no error, which is indistinguishable from working.
 *
 * In memory on purpose: this describes the running process, and a record that
 * survived a restart would describe a different one.
 */
let lastAttempt = null;
const MAX_RECORDED_RESULTS = 10;

/** Device tokens dropped because Apple said they were gone, since start-up. */
let prunedTotal = 0;

export function lastPushAttempt() {
  return lastAttempt;
}

export function totalPruned() {
  return prunedTotal;
}

/** Enough of a token to tell two devices apart, not enough to be one. */
const shortToken = (token) => (typeof token === 'string' ? token.slice(0, 10) : '');

function recordAttempt({ cfg, decision, outcome, pruned = 0, pruneFailed = 0 }) {
  const results = outcome?.results ?? [];
  lastAttempt = {
    ts: new Date().toISOString(),
    decision_id: decision?.id ?? null,
    kind: decision?.kind ?? null,
    environment: cfg?.push?.environment ?? '',
    sent: outcome?.sent ?? 0,
    failed: results.filter((result) => result.status !== 200).length,
    skipped: outcome?.skipped ?? '',
    attempts: outcome?.attempts ?? 0,
    pruned,
    prune_failed: pruneFailed,
    results: results.slice(0, MAX_RECORDED_RESULTS).map((result) => ({
      token: shortToken(result.token),
      status: result.status,
      reason: result.reason,
    })),
    omitted: Math.max(0, results.length - MAX_RECORDED_RESULTS),
  };
  return lastAttempt;
}

const b64url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function pushConfigured(cfg) {
  return Boolean(cfg?.push?.enabled);
}

/**
 * Whether a decision deserves a push at all, independent of whether APNs can
 * actually deliver one. Kept here rather than in the route so the rule is
 * testable without a provider key: an observation, a card the model flagged for
 * review, and anything under the confidence floor are all silent.
 */
export function shouldPush(cfg, decision) {
  if (!pushConfigured(cfg) || !decision) return false;
  if (decision.kind === 'observation') return false;
  if (decision.needsHuman) return false;
  return (decision.confidence ?? 0) >= (cfg.push.minConfidence ?? 0.6);
}

function providerToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  // Identify the key by where it came from, since a key held in a secret has no
  // path and would otherwise share the empty-string cache slot.
  const keyRef = cfg.push.keyPath || cfg.push.keySource || 'APNS_KEY';
  if (cache.keyPath === keyRef && now - cache.mintedAt < TOKEN_TTL_SECONDS) {
    return cache.jwt;
  }

  // Contents win over a path: a host that carries the key as a secret has no
  // file to read.
  const material = cfg.push.keyPem || readFileSync(cfg.push.keyPath);
  const key = createPrivateKey(material);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.push.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.push.teamId, iat: now }));

  // ieee-p1363 gives the raw R||S form JOSE expects, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });

  const jwt = `${header}.${claims}.${b64url(signature)}`;
  cache = { keyPath: keyRef, jwt, mintedAt: now };
  return jwt;
}

export function notificationFor(decision, course) {
  const headline = decision.payload?.question?.stem || decision.payload?.topic || '';
  const answer =
    decision.payload?.chosen_text ||
    decision.payload?.answer_text ||
    decision.payload?.prose ||
    '';

  return {
    aps: {
      alert: {
        title: `${course || 'CourseMate'} · ${Math.round((decision.confidence ?? 0) * 100)}%`,
        body: String(answer || headline || 'A new screen was read.').slice(0, 220),
      },
      sound: 'default',
      'thread-id': 'coursemate-answers',
      'interruption-level': 'active',
    },
    session_id: decision.session_id,
    decision_id: decision.id,
    course,
  };
}

function sendOne({ cfg, client, token, payload }) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'apns-topic': cfg.push.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': body.length,
    });

    let status = 0;
    let reason = '';
    request.on('response', (headers) => {
      status = headers[':status'] || 0;
      const id = headers['apns-id'];
      if (id) reason = `apns-id ${id}`;
    });
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      try {
        const parsed = JSON.parse(chunk);
        if (parsed.reason) reason = parsed.reason;
      } catch {
        /* body is only informative */
      }
    });
    request.on('end', () => resolve({ token, status, reason }));
    request.on('error', (error) => resolve({ token, status: 0, reason: error.message }));

    request.setTimeout(10_000, () => {
      request.close();
      resolve({ token, status: 0, reason: 'timeout' });
    });

    request.end(body);
  });
}

export async function sendApns({ cfg, deviceTokens, payload }) {
  if (!cfg.push.enabled) return { sent: 0, skipped: 'push not configured', results: [] };
  if (!deviceTokens.length) return { sent: 0, skipped: 'no registered devices', results: [] };

  let token;
  try {
    token = providerToken(cfg);
  } catch (error) {
    return { sent: 0, skipped: `provider key unusable: ${error.message}`, results: [] };
  }

  const origin = cfg.push.environment === 'production' ? PRODUCTION : SANDBOX;
  const client = http2.connect(origin);

  // An unreachable host errors the *session*, and an unhandled 'error' event on
  // an http2 session takes the process down with it. Each request reports its
  // own failure, so this listener exists only to keep the server running.
  client.on('error', () => {
    try {
      client.close();
    } catch {
      /* already gone */
    }
  });

  const closed = new Promise((resolve) => client.on('close', resolve));
  const results = await Promise.all(
    deviceTokens.map((device) =>
      sendOne({
        cfg,
        client,
        token: device,
        payload,
      }),
    ),
  );

  client.close();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);

  return {
    sent: results.filter((r) => r.status === 200).length,
    skipped: '',
    results,
  };
}

/** APNs answers that mean "later", not "never". */
const TRANSIENT_STATUS = new Set([0, 429, 500, 503]);
const MAX_DELIVERY_ATTEMPTS = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTransient(result) {
  return TRANSIENT_STATUS.has(result?.status);
}

/**
 * Deliver one payload to every token, retrying only what could have been a
 * blip. A retry that re-sent to devices which already succeeded would buzz the
 * phone twice for one answer, so only unanswered or transient tokens go back
 * on the wire.
 */
export async function deliver({ cfg, tokens, payload, send = sendApns, sleep = wait }) {
  let pending = [...tokens];
  const settled = [];
  let attempts = 0;

  while (pending.length > 0 && attempts < MAX_DELIVERY_ATTEMPTS) {
    attempts += 1;
    const outcome = await send({ cfg, deviceTokens: pending, payload });

    // A send that never reached the wire (unusable key, no devices) is a
    // configuration error, not a flaky one: retrying it spends attempts on
    // something that cannot change on its own.
    if (outcome.skipped) {
      return { ...outcome, results: [...settled, ...(outcome.results ?? [])], attempts };
    }

    const results = outcome.results ?? [];
    const answered = new Set(results.map((result) => result.token));
    const retry = [];

    for (const result of results) {
      if (isTransient(result) && attempts < MAX_DELIVERY_ATTEMPTS) retry.push(result.token);
      else settled.push(result);
    }

    // Silence about a token is not success. Counting it as one would let the
    // attempt total overstate how many phones actually got the answer.
    for (const token of pending) {
      if (!answered.has(token)) settled.push({ token, status: 0, reason: 'no result from apns' });
    }

    pending = retry;
    if (pending.length > 0) await sleep(250 * attempts);
  }

  for (const token of pending) settled.push({ token, status: 0, reason: 'retries exhausted' });

  return {
    sent: settled.filter((result) => result.status === 200).length,
    skipped: '',
    results: settled,
    attempts,
  };
}

/**
 * Drop a token Apple says is gone, confirming the row actually went. The delete
 * is tried twice because a busy writer is worth one more attempt, and a token
 * that survives is reported rather than counted: a dead token left in the
 * table costs an attempt on every future push and is invisible otherwise.
 */
function pruneDevice(store, token) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      store.removeDevice(token);
    } catch {
      continue;
    }

    try {
      const remaining = store.devices?.() ?? [];
      if (!remaining.some((device) => device.token === token)) return true;
    } catch {
      // The delete threw nothing; it is the read-back that is unavailable.
      return true;
    }
  }

  return false;
}

/**
 * Deliver one decision to every registered device. Tokens Apple reports as
 * gone (410 / Unregistered) are dropped so the list does not rot.
 */
export async function pushDecision({ cfg, store, decision, course, send = sendApns, sleep = wait }) {
  if (!pushConfigured(cfg)) {
    const outcome = { sent: 0, skipped: 'push not configured' };
    recordAttempt({ cfg, decision, outcome });
    return outcome;
  }

  if (!shouldPush(cfg, decision)) {
    const outcome = { sent: 0, skipped: 'not worth interrupting for' };
    recordAttempt({ cfg, decision, outcome });
    return outcome;
  }

  const devices = store.devices();

  let outcome;
  try {
    outcome = await deliver({
      cfg,
      tokens: devices.map((device) => device.token),
      payload: notificationFor(decision, course),
      send,
      sleep,
    });
  } catch (error) {
    // Sending can still throw (a malformed payload). Swallowing it here keeps
    // the fire-and-forget caller intact, but the reason is recorded so health
    // does not keep showing the last attempt that worked.
    const failed = { sent: 0, skipped: `delivery error: ${error.message}`, results: [] };
    recordAttempt({ cfg, decision, outcome: failed });
    return failed;
  }

  let pruned = 0;
  let pruneFailed = 0;
  for (const result of outcome.results ?? []) {
    if (result.status !== 410 && result.reason !== 'Unregistered') continue;
    if (pruneDevice(store, result.token)) pruned += 1;
    else pruneFailed += 1;
  }
  prunedTotal += pruned;

  recordAttempt({ cfg, decision, outcome, pruned, pruneFailed });
  return outcome;
}
