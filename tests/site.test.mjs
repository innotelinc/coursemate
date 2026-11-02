import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { startMockGateway } from './mock-gateway.mjs';

// The site is one origin with two trees: `/` is what a buyer sees, `/desk` is
// what the owner opens. Both are in this file because the split is the thing
// that can break silently — a wrong root serves the desk to the public, or the
// landing page at the desk's address.

let app;
let port;
let mock;
let tmp;

/** A request with a chosen Host, which fetch will not let us set. */
function ask(pathname, { host, method = 'GET', authorization } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          ...(host ? { Host: host } : {}),
          ...(authorization ? { Authorization: authorization } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  mock = await startMockGateway();
  tmp = mkdtempSync(join(tmpdir(), 'coursemate-site-'));

  const cfg = loadConfig({
    COURSEMATE_GATEWAY_URL: mock.url,
    COURSEMATE_API_KEY: 'test-key',
    COURSEMATE_DATA_DIR: tmp,
    COURSEMATE_TOKEN: 'the-shared-token',
    // Opted in explicitly, because the default is off: a redirect to a name
    // that is not live takes the site down, so it is never on by accident.
    COURSEMATE_LEGACY_HOSTS: 'cm.innotel.tech',
  });

  app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  app.store.close();
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('the root is the public page, and it sells and checks keys', async () => {
  const res = await ask('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /CourseMate/);
  // The two things a buyer does without installing anything.
  assert.match(res.body, /check/i);
  assert.match(res.body, /magnate\.innotel\.us/);
  // The desk shows decisions from the owner's sessions; it must not be here.
  assert.doesNotMatch(res.body, /session_id/);
});

test('the desk is served at /desk, from its own tree', async () => {
  const desk = await ask('/desk');
  assert.equal(desk.status, 200);
  assert.match(desk.headers['content-type'], /text\/html/);

  const root = await ask('/');
  assert.notEqual(desk.body, root.body, '/desk is not the landing page');
});

test('the old host redirects to the canonical one, path and query intact', async () => {
  const res = await ask('/desk?session=abc', { host: 'cm.innotel.tech' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://cm.innotel.us/desk?session=abc');
});

test('a POST to the old host is answered, not redirected', async () => {
  // A 301 would be replayed as a GET by every client, silently dropping the
  // body — so the redirect is GET and HEAD only.
  const res = await ask('/api/health', { host: 'cm.innotel.tech', method: 'POST' });
  assert.notEqual(res.status, 301);
});

test('the canonical host is not redirected at all', async () => {
  const res = await ask('/', { host: 'cm.innotel.us' });
  assert.equal(res.status, 200);
});

test('the receipt page is served, and its lookup validates the reference', async () => {
  const page = await ask('/receipt');
  assert.equal(page.status, 200);
  assert.match(page.body, /session_id/);

  // Public — a buyer has no key yet, and the only thing they hold is the Stripe
  // session id. A missing one is the buyer's mistake, not an auth failure.
  const missing = await ask('/api/receipt');
  assert.equal(missing.status, 400);
});

test('/buy is the price card under its own name', async () => {
  const res = await ask('/buy');
  assert.equal(res.status, 200);
  assert.match(res.body, /id="price"/);
  assert.match(res.body, /Continue to payment/);
});

// The purchase path is three strings in the page that have to agree with three
// routes on the server. Renaming one of them breaks buying for everybody while
// every page still renders, so the pairing is pinned here.
test('the page and the server agree on the purchase path', async () => {
  const page = (await ask('/')).body;
  for (const path of ['/api/key', '/api/plans', '/api/checkout']) {
    assert.ok(page.includes(`fetch('${path}'`), `the page calls ${path}`);
  }
  assert.match(page, /Continue to payment/);
});

test('buying is reachable without a key, and still validates', async () => {
  // A buyer has no key — that is what they are buying — so this route sits
  // outside the auth gate. A 400 proves it got past that gate and stopped at
  // the body, which is the whole distinction; a 401 here would mean the page's
  // only purchase button could never work.
  const res = await ask('/api/checkout', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(res.body, /email/);
});

test('a key is checked against the bearer this server actually accepts', async () => {
  const anonymous = await ask('/api/key');
  assert.equal(anonymous.status, 401);

  const wrong = await ask('/api/key', { authorization: 'Bearer not-the-token' });
  assert.equal(wrong.status, 401);

  const right = await ask('/api/key', { authorization: 'Bearer the-shared-token' });
  assert.equal(right.status, 200);
  const body = JSON.parse(right.body);
  assert.equal(body.ok, true);
  // `checked` is what lets the site tell a real verdict from an open server.
  assert.equal(body.checked, true);
  assert.equal(body.shop, 'https://magnate.innotel.us/coursemate');
});
