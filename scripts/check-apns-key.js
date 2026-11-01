#!/usr/bin/env node
// Print whether the installed APNs key can actually sign a push.
//
// /api/health answers "a key was found, and where it came from". It cannot
// answer "Apple accepts it", because only Apple knows which service a key may
// sign for — an App Store Connect key loads and parses exactly like a provider
// key and is refused at delivery. So this asks Apple with a token nobody owns:
// BadDeviceToken means the key is good and the token was the problem,
// InvalidProviderToken means the key is the wrong one.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { probeKey } from '../src/apns-probe.js';

const { push } = loadConfig();

if (!push.keyPem && !push.keyPath) {
  console.error(`no key to check: ${push.missing.join(', ') || 'push is not configured'}`);
  process.exit(1);
}

let material = push.keyPem;
if (!material) {
  try {
    material = readFileSync(push.keyPath, 'utf8');
  } catch (e) {
    console.error(`cannot read ${push.keyPath}: ${e.message}`);
    process.exit(1);
  }
}

const result = await probeKey({
  keyPem: material,
  keyId: push.keyId,
  teamId: push.teamId,
  topic: push.topic,
  environment: push.environment,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.authenticates ? 0 : 1);
