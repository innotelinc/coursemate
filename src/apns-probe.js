// Ask Apple whether a key can actually sign for APNs.
//
// An App Store Connect key and an APNs provider key are both ES256 P-256 keys
// with a ten-character key id and a team id, so on disk they are
// indistinguishable — same shape, same header, both parse. Only Apple knows
// which service a key is allowed to sign for, and the difference is invisible
// until a notification silently fails to arrive: the App Store Connect key
// answers InvalidProviderToken to every push attempt.
//
// So the key is proved instead of trusted. A delivery is attempted to a device
// token that cannot exist. A usable key gets as far as the token lookup and is
// told BadDeviceToken; an unusable key never gets that far and is told
// InvalidProviderToken. Either way nothing is delivered and no device is
// touched.
import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Reasons that mean "the key signed and Apple accepted it, the token is the problem". */
const TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'MissingDeviceToken',
  'Unregistered',
]);

const b64url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * Sign a provider JWT with the key under test. Throws when the material is not
 * an EC P-256 key, which is a different failure from "Apple rejects it" and is
 * worth reporting as such.
 */
export function providerToken({ keyPem, keyId, teamId }) {
  const key = createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`the key is ${key.asymmetricKeyType}, APNs needs EC P-256`);
  }
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`curve ${key.asymmetricKeyDetails?.namedCurve}, APNs needs prime256v1`);
  }

  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  // ieee-p1363 is the raw R||S form JOSE expects, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${b64url(signature)}`;
}

function classify(status, reason) {
  // The key authenticated and the token was rejected: exactly what a real
  // provider key produces when aimed at a token nobody owns.
  if (TOKEN_REASONS.has(reason)) return { authenticates: true, verdict: 'key-valid' };
  if (status === 403) return { authenticates: false, verdict: 'key-rejected' };
  if (status === 400) return { authenticates: false, verdict: 'request-rejected' };
  return { authenticates: false, verdict: status ? 'unexpected-answer' : 'no-answer' };
}

/**
 * @returns {Promise<{status:number, reason:string, authenticates:boolean, verdict:string, detail?:string}>}
 */
export async function probeKey({
  keyPem,
  keyId,
  teamId,
  topic,
  environment = 'production',
  timeoutMs = 20_000,
}) {
  const jwt = providerToken({ keyPem, keyId, teamId });
  const origin = HOSTS[environment] || HOSTS.production;

  return new Promise((resolve) => {
    let settled = false;
    let timer;

    const client = http2.connect(origin);
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* already gone */
      }
      resolve(out);
    };

    timer = setTimeout(
      () => finish({ status: 0, reason: 'timeout', authenticates: false, verdict: 'no-answer', detail: `no answer in ${timeoutMs}ms` }),
      timeoutMs,
    );

    client.on('error', (e) =>
      finish({ status: 0, reason: 'connect', authenticates: false, verdict: 'unreachable', detail: e.message }),
    );

    const req = client.request({
      ':method': 'POST',
      // No device owns this token, so the worst case is a rejected request.
      ':path': `/3/device/${'0'.repeat(64)}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    });

    let status = 0;
    let raw = '';
    req.on('response', (headers) => {
      status = Number(headers[':status']) || 0;
    });
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('error', (e) =>
      finish({ status, reason: 'request', authenticates: false, verdict: 'request-failed', detail: e.message }),
    );
    req.on('end', () => {
      let reason = '';
      try {
        reason = JSON.parse(raw).reason || '';
      } catch {
        // Apple answers JSON, but a proxy or a captive portal may not.
        reason = raw.slice(0, 120);
      }
      finish({ status, reason, ...classify(status, reason) });
    });
    req.end('{}');
  });
}
