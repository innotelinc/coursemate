import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import {
  pushConfigured,
  shouldPush,
  pushDecision,
  sendApns,
  notificationFor,
  lastPushAttempt,
  totalPruned,
} from '../src/push.js';

// A developer's real .env may carry APNs settings; every config here states its
// own so the tests describe the rule rather than the machine.
const NO_APNS = {
  COURSEMATE_PUSH: '',
  APNS_KEY_PATH: '',
  APNS_KEY_ID: '',
  APNS_TEAM_ID: '',
};

const tempDirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `coursemate-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A decision shaped like the wire object `brain.js` emits. */
const decision = (over = {}) => ({
  id: 'dec_1',
  session_id: 'ses_1',
  kind: 'quiz_answer',
  screen_type: 'quiz',
  confidence: 0.9,
  needsHuman: false,
  payload: {},
  ...over,
});

const minimalCfg = (over = {}) => ({ push: { enabled: true, minConfidence: 0.6 }, ...over });

test('push is off by default, and a switch without a key is not enough', () => {
  const plain = loadConfig({ ...NO_APNS, COURSEMATE_DATA_DIR: tempDir('push-off') });
  assert.equal(plain.push.enabled, false);
  assert.equal(pushConfigured(plain), false);

  // The switch alone cannot sign a provider token, so it must not report
  // "enabled" and then fail silently at delivery time.
  const switchOnly = loadConfig({
    ...NO_APNS,
    COURSEMATE_PUSH: '1',
    COURSEMATE_DATA_DIR: tempDir('push-switch'),
  });
  assert.equal(switchOnly.push.enabled, false);
});

test('push needs the switch, the key, the key id and the team id', () => {
  const base = {
    COURSEMATE_PUSH: '1',
    APNS_KEY_PATH: 'AuthKey_PUSH.p8',
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    COURSEMATE_DATA_DIR: tempDir('push-on'),
  };
  const full = loadConfig(base);
  assert.equal(full.push.enabled, true);
  assert.equal(full.push.topic, 'us.innotel.coursemate');
  assert.equal(full.push.environment, 'sandbox', 'sandbox unless production is named');

  const noTeam = loadConfig({ ...base, APNS_TEAM_ID: '' });
  assert.equal(noTeam.push.enabled, false);
});

test('the key may arrive as contents, because a path cannot be a secret', () => {
  const PEM =
    '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----';
  const base = {
    COURSEMATE_PUSH: '1',
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    COURSEMATE_DATA_DIR: tempDir('push-pem'),
  };

  const inline = loadConfig({ ...NO_APNS, ...base, APNS_KEY: PEM });
  assert.equal(inline.push.enabled, true);
  assert.equal(inline.push.keySource, 'APNS_KEY');
  assert.equal(inline.push.keyPath, '', 'no file is needed');
  assert.equal(inline.push.keyPem.trim(), PEM);

  const b64 = loadConfig({ ...NO_APNS, ...base, APNS_KEY: Buffer.from(PEM).toString('base64') });
  assert.match(b64.push.keyPem, /BEGIN PRIVATE KEY/, 'a base64 secret is decoded');

  const escaped = loadConfig({ ...NO_APNS, ...base, APNS_KEY: PEM.replace(/\n/g, '\\n') });
  assert.match(escaped.push.keyPem, /\n/, 'a literal backslash-n becomes a newline again');

  // Contents win over a path, so a host that carries the key as a secret is not
  // silently reading a stale file instead.
  const both = loadConfig({ ...NO_APNS, ...base, APNS_KEY: PEM, APNS_KEY_PATH: 'ignored.p8' });
  assert.equal(both.push.keySource, 'APNS_KEY');
  assert.ok(both.push.keyPem);
});

test('what keeps push off is named, not just reported as off', () => {
  const bare = loadConfig({ ...NO_APNS, COURSEMATE_DATA_DIR: tempDir('push-missing') });
  const reasons = bare.push.missing.join('; ');
  assert.equal(bare.push.enabled, false);
  assert.match(reasons, /COURSEMATE_PUSH/);
  assert.match(reasons, /no key/);
  assert.match(reasons, /APNS_KEY_ID/);
  assert.match(reasons, /APNS_TEAM_ID/);

  // The state that looks configured from the outside: switch, ids and topic all
  // set, key missing. This is the one health has to describe out loud.
  const noKey = loadConfig({
    ...NO_APNS,
    COURSEMATE_PUSH: '1',
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_TOPIC: 'us.innotel.coursemate',
    COURSEMATE_DATA_DIR: tempDir('push-no-key'),
  });
  assert.equal(noKey.push.enabled, false);
  assert.deepEqual(noKey.push.missing, [
    'no key: set APNS_KEY (the .p8 contents) or APNS_KEY_PATH',
  ]);

  const complete = loadConfig({
    ...NO_APNS,
    COURSEMATE_PUSH: '1',
    APNS_KEY: 'x',
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    COURSEMATE_DATA_DIR: tempDir('push-complete'),
  });
  assert.equal(complete.push.enabled, true);
  assert.deepEqual(complete.push.missing, []);
});

test('a key path that is not there yet is reported, not enforced', () => {
  const cfg = loadConfig({
    ...NO_APNS,
    COURSEMATE_PUSH: '1',
    APNS_KEY_PATH: join(tempDir('push-warn'), 'mounted-later.p8'),
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    COURSEMATE_DATA_DIR: tempDir('push-warn-data'),
  });
  // Still enabled: a key mounted after start-up is legitimate, and delivery
  // fails closed with "provider key unusable" if it never appears.
  assert.equal(cfg.push.enabled, true);
  assert.match(cfg.push.warnings.join('; '), /does not exist yet/);
});

test('only a confident, unflagged answer is worth interrupting for', () => {
  const cfg = minimalCfg();

  assert.equal(shouldPush(cfg, decision()), true);
  assert.equal(shouldPush(cfg, decision({ kind: 'observation' })), false);
  assert.equal(shouldPush(cfg, decision({ needsHuman: true })), false);
  // The wire shape carries needs_human as 0/1, so falsy-zero must still push.
  assert.equal(shouldPush(cfg, decision({ needsHuman: 1 })), false);
  assert.equal(shouldPush(cfg, decision({ needsHuman: 0 })), true);

  assert.equal(shouldPush(cfg, decision({ confidence: 0.59 })), false);
  assert.equal(shouldPush(cfg, decision({ confidence: 0.6 })), true, 'the floor is inclusive');
  assert.equal(shouldPush(cfg, decision({ confidence: undefined })), false);

  assert.equal(shouldPush({ push: { enabled: false } }, decision()), false);
  assert.equal(shouldPush(cfg, null), false);
});

test('an unconfigured push never touches the device table', async () => {
  let touched = 0;
  const store = {
    devices() {
      touched += 1;
      return [];
    },
    removeDevice() {
      touched += 1;
    },
  };

  const out = await pushDecision({
    cfg: { push: { enabled: false } },
    store,
    decision: decision(),
    course: 'BIOL 201',
  });

  assert.equal(out.sent, 0);
  assert.equal(out.skipped, 'push not configured');
  assert.equal(touched, 0);
});

test('a gated decision is skipped before any device is looked up', async () => {
  const store = {
    devices() {
      throw new Error('the store must not be read for a decision that is not pushed');
    },
    removeDevice() {
      throw new Error('nothing should be removed');
    },
  };

  const out = await pushDecision({
    cfg: minimalCfg(),
    store,
    decision: decision({ needsHuman: true }),
    course: 'BIOL 201',
  });

  assert.equal(out.sent, 0);
  assert.equal(out.skipped, 'not worth interrupting for');
});

test('an unusable provider key fails closed instead of throwing', async () => {
  const cfg = loadConfig({
    COURSEMATE_PUSH: '1',
    APNS_KEY_PATH: join(tempDir('push-key'), 'does-not-exist.p8'),
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    COURSEMATE_DATA_DIR: tempDir('push-key-data'),
  });
  assert.equal(cfg.push.enabled, true, 'the path is trusted until it is read');

  // No network is attempted: signing fails first, and the caller gets a reason.
  const out = await sendApns({ cfg, deviceTokens: ['a'.repeat(64)], payload: {} });
  assert.equal(out.sent, 0);
  assert.match(out.skipped, /provider key unusable/);
});

test('the payload carries the answer, the course and the confidence', () => {
  const payload = notificationFor(
    decision({
      id: 'dec_9',
      session_id: 'ses_7',
      confidence: 0.92,
      payload: {
        question: { stem: 'Which organelle makes ATP?', options: ['Ribosome', 'Mitochondrion'] },
        chosen_text: 'B) Mitochondrion',
      },
    }),
    'BIOL 201',
  );

  assert.equal(payload.aps.alert.title, 'BIOL 201 · 92%');
  assert.equal(payload.aps.alert.body, 'B) Mitochondrion');
  assert.equal(payload.aps['thread-id'], 'coursemate-answers');
  assert.equal(payload.aps.sound, 'default');
  assert.equal(payload.decision_id, 'dec_9');
  assert.equal(payload.session_id, 'ses_7');
  assert.equal(payload.course, 'BIOL 201');
});

test('the payload stays readable when there is no answer or no course', () => {
  const bare = notificationFor(
    decision({ confidence: 0.6, payload: { question: { stem: 'Explain entropy.' } } }),
    '',
  );
  assert.equal(bare.aps.alert.title, 'CourseMate · 60%');
  assert.equal(bare.aps.alert.body, 'Explain entropy.', 'the question stands in for a missing answer');

  const long = notificationFor(decision({ payload: { prose: 'x'.repeat(300) } }), 'PHYS 101');
  assert.equal(long.aps.alert.body.length, 220, 'a notification is not the place for an essay');
});

test('a device is registered once, not once per launch', () => {
  const app = createApp(loadConfig({ ...NO_APNS, COURSEMATE_DATA_DIR: tempDir('push-store') }));

  try {
    const token = 'b'.repeat(64);
    app.store.addDevice({ token, platform: 'ios', bundleId: 'us.innotel.coursemate' });
    app.store.addDevice({ token, platform: 'ios', bundleId: 'us.innotel.coursemate' });
    assert.equal(app.store.countDevices(), 1, 'the same token does not accumulate rows');

    assert.equal(app.store.devices()[0].token, token);
    app.store.removeDevice(token);
    assert.equal(app.store.countDevices(), 0, 'a token Apple reports gone is dropped');
  } finally {
    app.store.close();
  }
});

test('the last attempt is recorded even when nothing is sent', async () => {
  const store = { devices: () => [], removeDevice() {} };

  await pushDecision({
    cfg: { push: { enabled: false } },
    store,
    decision: decision({ id: 'dec_off' }),
    course: 'BIOL 201',
  });

  let attempt = lastPushAttempt();
  assert.equal(attempt.decision_id, 'dec_off', 'a skipped push still names the decision');
  assert.equal(attempt.sent, 0);
  assert.equal(attempt.skipped, 'push not configured');
  assert.deepEqual(attempt.results, []);

  await pushDecision({
    cfg: minimalCfg(),
    store,
    decision: decision({ id: 'dec_gated', needsHuman: true }),
    course: 'BIOL 201',
  });

  attempt = lastPushAttempt();
  assert.equal(attempt.decision_id, 'dec_gated');
  assert.equal(attempt.skipped, 'not worth interrupting for');
});

test('a delivery that cannot start records the reason it could not', async () => {
  const cfg = loadConfig({
    COURSEMATE_PUSH: '1',
    APNS_KEY_PATH: join(tempDir('push-attempt'), 'missing.p8'),
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'TEAM123456',
    COURSEMATE_DATA_DIR: tempDir('push-attempt-data'),
  });

  const out = await pushDecision({
    cfg,
    store: {
      devices: () => [{ token: 'c'.repeat(64) }],
      removeDevice() {
        throw new Error('a failed sign must not prune a live token');
      },
    },
    decision: decision({ id: 'dec_key' }),
    course: 'BIOL 201',
  });

  assert.equal(out.sent, 0);

  const attempt = lastPushAttempt();
  assert.equal(attempt.decision_id, 'dec_key');
  assert.equal(attempt.sent, 0);
  assert.match(attempt.skipped, /provider key unusable/);
  assert.equal(attempt.pruned, 0);
  assert.equal(attempt.omitted, 0);
});

test('health reports the push path without claiming it delivered anything', async () => {
  const app = createApp(loadConfig({ ...NO_APNS, COURSEMATE_DATA_DIR: tempDir('push-health') }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();

  try {
    // One device is registered while push is off: the state that produces
    // silence rather than an error, which is why it is reported explicitly.
    app.store.addDevice({ token: 'd'.repeat(64), platform: 'ios', bundleId: 'us.innotel.coursemate' });

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.push.configured, false);
    assert.equal(body.push.devices, 1, 'a registered device is visible even with push off');
    assert.equal(body.push.last_attempt, null, 'nothing has been attempted');
    assert.ok(body.counters, 'health still carries its existing shape');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
  }
});

test('one decision can be fetched by id, in the same shape the desk sends', async () => {
  const app = createApp(loadConfig({ ...NO_APNS, COURSEMATE_DATA_DIR: tempDir('push-decision') }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();

  try {
    app.store.addDecision({
      id: 'dec_solo',
      sessionId: 'ses_9',
      observationId: 'obs_9',
      ts: 1700000000,
      kind: 'quiz_answer',
      screenType: 'quiz',
      payload: { question: { stem: 'Which organelle makes ATP?' }, chosen_text: 'B) Mitochondrion' },
      confidence: 0.91,
      needsHuman: false,
    });

    const found = await (await fetch(`http://127.0.0.1:${port}/api/decision?id=dec_solo`)).json();
    assert.equal(found.decision.id, 'dec_solo');
    assert.equal(found.decision.session_id, 'ses_9');
    assert.equal(found.decision.screen_type, 'quiz');
    assert.equal(found.decision.needs_human, 0, 'the wire shape carries 0/1, as the desk does');
    assert.equal(found.decision.payload.chosen_text, 'B) Mitochondrion', 'payload is decoded, not a JSON string');

    const missing = await fetch(`http://127.0.0.1:${port}/api/decision?id=dec_nope`);
    assert.equal(missing.status, 404);

    const unnamed = await fetch(`http://127.0.0.1:${port}/api/decision`);
    assert.equal(unnamed.status, 400);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
  }
});

test('a transient apns failure is retried, and only for the device that failed', async () => {
  const rounds = [];
  let call = 0;

  const out = await pushDecision({
    cfg: minimalCfg(),
    store: { devices: () => [{ token: 'flaky' }, { token: 'steady' }], removeDevice() {} },
    decision: decision({ id: 'dec_retry' }),
    send: async ({ deviceTokens }) => {
      call += 1;
      rounds.push(deviceTokens);
      return {
        sent: 0,
        results: deviceTokens.map((token) =>
          token === 'flaky' && call === 1
            ? { token, status: 503, reason: 'ServiceUnavailable' }
            : { token, status: 200, reason: 'apns-id 1' },
        ),
      };
    },
    sleep: async () => {},
  });

  assert.equal(out.attempts, 2);
  assert.equal(out.sent, 2, 'the retried device still ends up delivered');
  assert.deepEqual(rounds[0], ['flaky', 'steady']);
  assert.deepEqual(rounds[1], ['flaky'], 'a phone that already got the answer is not buzzed again');

  const attempt = lastPushAttempt();
  assert.equal(attempt.attempts, 2);
  assert.equal(attempt.failed, 0, 'the failure was resolved by the retry');
});

test('a definitive apns rejection is not retried', async () => {
  let calls = 0;

  await pushDecision({
    cfg: minimalCfg(),
    store: { devices: () => [{ token: 'bad' }], removeDevice() {} },
    decision: decision(),
    send: async ({ deviceTokens }) => {
      calls += 1;
      return {
        sent: 0,
        results: deviceTokens.map((token) => ({ token, status: 400, reason: 'BadDeviceToken' })),
      };
    },
    sleep: async () => {},
  });

  assert.equal(calls, 1, 'a bad token stays bad; retrying it only spends attempts');
  assert.equal(lastPushAttempt().failed, 1);
});

test('retries stop at the cap and the answer is never reported as delivered', async () => {
  let calls = 0;

  const out = await pushDecision({
    cfg: minimalCfg(),
    store: { devices: () => [{ token: 'down' }], removeDevice() {} },
    decision: decision(),
    send: async ({ deviceTokens }) => {
      calls += 1;
      return {
        sent: 0,
        results: deviceTokens.map((token) => ({ token, status: 503, reason: 'ServiceUnavailable' })),
      };
    },
    sleep: async () => {},
  });

  assert.equal(calls, 3, 'bounded, so an apns outage cannot spin');
  assert.equal(out.sent, 0);
  assert.equal(out.results.length, 1, 'one row per device, not one per attempt');
  assert.equal(out.results[0].status, 503);
});

test('a token apple calls unregistered is pruned, and the delete is retried', async () => {
  const removed = [];
  let deletes = 0;
  const store = {
    devices: () => (removed.includes('gone') ? [] : [{ token: 'gone' }]),
    removeDevice(token) {
      deletes += 1;
      if (deletes === 1) throw new Error('database is locked');
      removed.push(token);
    },
  };

  const before = totalPruned();
  await pushDecision({
    cfg: minimalCfg(),
    store,
    decision: decision(),
    send: async () => ({
      sent: 0,
      results: [{ token: 'gone', status: 410, reason: 'Unregistered' }],
    }),
    sleep: async () => {},
  });

  assert.equal(deletes, 2, 'a locked writer is worth one more try');
  assert.equal(totalPruned() - before, 1);

  const attempt = lastPushAttempt();
  assert.equal(attempt.pruned, 1);
  assert.equal(attempt.prune_failed, 0);
});

test('a prune that cannot be confirmed is reported, not counted', async () => {
  const store = {
    devices: () => [{ token: 'stuck' }],
    removeDevice() {
      throw new Error('database is locked');
    },
  };

  const before = totalPruned();
  await pushDecision({
    cfg: minimalCfg(),
    store,
    decision: decision(),
    send: async () => ({
      sent: 0,
      results: [{ token: 'stuck', status: 410, reason: 'Unregistered' }],
    }),
    sleep: async () => {},
  });

  assert.equal(totalPruned() - before, 0, 'a token still in the table is not pruned');

  const attempt = lastPushAttempt();
  assert.equal(attempt.pruned, 0);
  assert.equal(attempt.prune_failed, 1, 'and the failure is visible instead of silent');
});

test('health reports the pruned total once push is configured', async () => {
  const app = createApp(
    loadConfig({
      COURSEMATE_PUSH: '1',
      APNS_KEY_PATH: join(tempDir('push-total'), 'unused.p8'),
      APNS_KEY_ID: 'ABC123DEFG',
      APNS_TEAM_ID: 'TEAM123456',
      COURSEMATE_DATA_DIR: tempDir('push-total-data'),
    }),
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();

  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(body.push.configured, true);
    assert.equal(body.push.pruned_total, totalPruned());
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
  }
});
