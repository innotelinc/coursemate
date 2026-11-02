import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

/** Minimal .env reader — no dependency, no mutation of process.env. */
function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/**
 * The APNs provider key, in whichever form this machine actually has it.
 *
 * Three sources, in order, because the same project runs from a laptop holding
 * a downloaded file and from a host that only has environment secrets:
 *   APNS_KEY       the .p8 contents (PEM, base64 of it, or \n-escaped one-line)
 *   APNS_KEY_PATH  a path to the .p8
 *   neither        AuthKey_<APNS_KEY_ID>.p8 next to this file
 *
 * A path stored in a secret is useless on a deployed host, so the contents are
 * first-class rather than a convenience.
 */
function readApnsKey(env) {
  const raw = (env.APNS_KEY || '').trim();
  if (raw) {
    let pem = raw.replace(/\\n/g, '\n');
    if (!pem.includes('-----BEGIN')) {
      // A secret is often the file base64-encoded, because PEM's newlines do
      // not survive every secret store intact. Buffer.from ignores invalid
      // characters rather than throwing, so a non-base64 value simply stays
      // as-is and createPrivateKey reports the real problem.
      const decoded = Buffer.from(pem, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) pem = decoded;
    }
    return { keyPath: '', keyPem: pem, keySource: 'APNS_KEY' };
  }

  if (env.APNS_KEY_PATH) {
    return { keyPath: resolve(ROOT, env.APNS_KEY_PATH), keyPem: '', keySource: 'APNS_KEY_PATH' };
  }

  if (env.APNS_KEY_ID) {
    const conventional = join(ROOT, `AuthKey_${env.APNS_KEY_ID}.p8`);
    if (existsSync(conventional)) {
      return { keyPath: conventional, keyPem: '', keySource: 'AuthKey_<KEY_ID>.p8' };
    }
  }

  return { keyPath: '', keyPem: '', keySource: '' };
}

/**
 * Push is on only when a provider token can actually be signed. Everything that
 * is absent is named, because "configured: false" alone sends you looking in
 * four places.
 */
function pushConfig(env) {
  const key = readApnsKey(env);
  const missing = [];
  if (!bool(env.COURSEMATE_PUSH, false)) missing.push('COURSEMATE_PUSH is not 1');
  if (!key.keyPath && !key.keyPem) {
    missing.push('no key: set APNS_KEY (the .p8 contents) or APNS_KEY_PATH');
  }
  if (!env.APNS_KEY_ID) missing.push('APNS_KEY_ID');
  if (!env.APNS_TEAM_ID) missing.push('APNS_TEAM_ID');

  const warnings = [];
  if (key.keyPath && !existsSync(key.keyPath)) {
    // Reported, not enforced: a key mounted after start-up is legitimate, and
    // delivery already fails closed with "provider key unusable".
    warnings.push(`APNS_KEY_PATH does not exist yet: ${key.keyPath}`);
  }

  return {
    enabled: missing.length === 0,
    keyPath: key.keyPath,
    // Never surfaced over the wire; server.js reports key_source instead.
    keyPem: key.keyPem,
    keySource: key.keySource,
    keyId: env.APNS_KEY_ID || '',
    teamId: env.APNS_TEAM_ID || '',
    topic: env.APNS_TOPIC || 'us.innotel.coursemate',
    environment: env.APNS_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    minConfidence: num(env.COURSEMATE_PUSH_MIN_CONFIDENCE, 0.6),
    missing,
    warnings,
  };
}

export function loadConfig(overrides = {}) {
  // `.env` is the conventional name, but some environments strip dotfiles, so
  // `env.local` is read too and wins over it. Real environment variables win
  // over both.
  const fileEnv = {
    ...readDotEnv(join(ROOT, '.env')),
    ...readDotEnv(join(ROOT, 'env.local')),
  };
  const env = { ...fileEnv, ...process.env, ...overrides };

  const dataDir = resolve(ROOT, env.COURSEMATE_DATA_DIR || './data');

  return {
    host: env.COURSEMATE_HOST || '127.0.0.1',
    port: num(env.COURSEMATE_PORT, 8790),
    token: env.COURSEMATE_TOKEN || '',

    // The one name the product is published under. It is written in three
    // places that must not disagree — the redirect from the old host, the links
    // the site renders, and the share card — so it is read once here.
    publicUrl: (env.COURSEMATE_PUBLIC_URL || 'https://cm.innotel.us').replace(/\/$/, ''),
    // Hosts that used to serve this app. Empty by default, and that default is
    // the point: redirecting a live name to one that does not resolve yet takes
    // the whole product offline — a 301 is answered before anything is served,
    // so "the new name is not up" reads as "CourseMate is down". Turn this on
    // with COURSEMATE_LEGACY_HOSTS=cm.innotel.tech once `scripts/edge-host.sh`
    // reports the new name answering 200.
    legacyHosts: (env.COURSEMATE_LEGACY_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),

    // Purchased keys. CourseMate is sold the way Sage is: one gateway key per
    // session, minted on the OmniRoute gateway and deleted when the window ends.
    // With this on, a bearer that the gateway accepts is as good as the shared
    // token — which is what makes a bought key work without an account here.
    // Off by default: it moves authorisation from one secret to "whatever the
    // gateway will take", which is the hosted deployment's choice to make.
    gatewayKeys: bool(env.COURSEMATE_GATEWAY_KEYS, false),
    dataDir,
    dbPath: join(dataDir, 'coursemate.db'),
    framesDir: join(dataDir, 'frames'),
    keepFrames: bool(env.COURSEMATE_KEEP_FRAMES, false),

    // The personality is a file the user owns and can edit by hand.
    personaPath: env.COURSEMATE_PERSONA_FILE
      ? resolve(ROOT, env.COURSEMATE_PERSONA_FILE)
      : join(ROOT, 'persona.json'),

    gatewayUrl: (env.COURSEMATE_GATEWAY_URL || 'https://gateway.innotel.us/v1').replace(/\/$/, ''),
    apiKey: env.COURSEMATE_API_KEY || '',
    keyFile: env.COURSEMATE_KEY_FILE ? resolve(ROOT, env.COURSEMATE_KEY_FILE) : '',
    model: env.COURSEMATE_MODEL || 'auto',
    visionModel: env.COURSEMATE_VISION_MODEL || 'auto',
    sttModel: env.COURSEMATE_STT_MODEL || 'whisper-1',
    timeoutMs: num(env.COURSEMATE_TIMEOUT_MS, 90_000),

    // Where keys are sold. Magnate mints the key and the gateway enforces it;
    // the site only sends the buyer there, so the shop is one link and never a
    // second price list to keep in step.
    shopUrl: (env.COURSEMATE_SHOP_URL || 'https://magnate.innotel.us/coursemate').replace(/\/$/, ''),

    mode: env.COURSEMATE_MODE === 'auto' ? 'auto' : 'assist',
    actionWebhook: env.COURSEMATE_ACTION_WEBHOOK || '',
    confidenceFloor: num(env.COURSEMATE_CONFIDENCE_FLOOR, 0.55),
    transcriptWindow: num(env.COURSEMATE_TRANSCRIPT_WINDOW, 40),

    // APNs is off unless a provider key is actually available: there is no
    // point advertising a push path that cannot sign a token.
    push: pushConfig(env),
  };
}

export function ensureDirs(cfg) {
  for (const dir of [cfg.dataDir, cfg.framesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
