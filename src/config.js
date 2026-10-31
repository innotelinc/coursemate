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

    mode: env.COURSEMATE_MODE === 'auto' ? 'auto' : 'assist',
    actionWebhook: env.COURSEMATE_ACTION_WEBHOOK || '',
    confidenceFloor: num(env.COURSEMATE_CONFIDENCE_FLOOR, 0.55),
    transcriptWindow: num(env.COURSEMATE_TRANSCRIPT_WINDOW, 40),

    // APNs is off unless a provider key is actually available: there is no
    // point advertising a push path that cannot sign a token.
    push: {
      enabled:
        bool(env.COURSEMATE_PUSH, false) &&
        Boolean(env.APNS_KEY_PATH) &&
        Boolean(env.APNS_KEY_ID) &&
        Boolean(env.APNS_TEAM_ID),
      keyPath: env.APNS_KEY_PATH ? resolve(ROOT, env.APNS_KEY_PATH) : '',
      keyId: env.APNS_KEY_ID || '',
      teamId: env.APNS_TEAM_ID || '',
      topic: env.APNS_TOPIC || 'us.innotel.coursemate',
      environment: env.APNS_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      minConfidence: num(env.COURSEMATE_PUSH_MIN_CONFIDENCE, 0.6),
    },
  };
}

export function ensureDirs(cfg) {
  for (const dir of [cfg.dataDir, cfg.framesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
