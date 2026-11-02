#!/usr/bin/env node
//
//  App Store Connect credentials, checked before a build depends on them.
//
//  Apple answers a wrong credential set with the same opaque `401` for three
//  different mistakes: the key is the wrong kind, the key id names a different
//  key, or the issuer uuid belongs to another team. This turns that into a named
//  cause. It is worth the one API call: an APNs key is also a valid ES256 `.p8`,
//  so "the key parses" proves nothing about whether Apple will accept it — that
//  is exactly the mix-up that cost a release.
//
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com';
const DEFAULT_BUNDLE = 'us.innotel.coursemate';

function usage() {
  console.error(`usage:
  node tools/asc.mjs probe  --key <p8> --kid <id> --issuer <uuid> [--bundle <bundleId>]
  node tools/asc.mjs builds --key <p8> --kid <id> --issuer <uuid> [--bundle <bundleId>] [--watch <build>] [--timeout <seconds>]`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[token.slice(2)] = 'true';
    else args[token.slice(2)] = argv[++i];
  }
  return args;
}

const b64u = (value) => Buffer.from(value).toString('base64url');

/** A short-lived ES256 token; App Store Connect rejects anything over 20 minutes. */
function sign({ keyPath, keyId, issuerId }) {
  const key = readFileSync(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const data = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(data), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${data}.${b64u(signature)}`;
}

async function request(path, jwt) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function explain(status, body) {
  const detail = body?.errors?.[0];
  const reason = detail ? `${detail.code}: ${detail.title}` : '';
  if (status === 401) {
    return [
      `Apple rejected these credentials (401 ${reason}).`,
      'The .p8 parses, so this is not a broken file — it is the pairing.',
      'In the order these actually happen:',
      '  1. the .p8 is an APNs key rather than an App Store Connect key (both are ES256 .p8)',
      '  2. APP_STORE_CONNECT_KEY_ID does not name this key — it is the 10 characters in AuthKey_<ID>.p8',
      '  3. APP_STORE_CONNECT_ISSUER_ID is not this team\'s issuer UUID',
      'Re-download is not possible for a key whose contents were lost: revoke it and create a new one.',
    ].join('\n');
  }
  if (status === 403) {
    return [
      `Apple authenticated the key but refused the request (403 ${reason}).`,
      'The key works; its role does not. In App Store Connect → Users and Access →',
      'Integrations, the key needs App Manager or Admin to sign and upload.',
    ].join('\n');
  }
  return `Unexpected answer from Apple: ${status} ${reason}\n${body?.errors ? JSON.stringify(body.errors) : ''}`;
}

async function probe(args) {
  const jwt = sign(args);
  const apps = await request('/v1/apps?limit=200', jwt);
  if (apps.status !== 200) {
    console.error(explain(apps.status, apps.body));
    return 1;
  }

  const bundle = args.bundle || DEFAULT_BUNDLE;
  const found = (apps.body?.data ?? []).find(
    (app) => app.attributes?.bundleId === bundle,
  );

  console.log(`credentials authenticate: ${apps.body.data.length} app(s) visible to this key`);
  if (!found) {
    console.error(`but ${bundle} is not among them — the key can sign, but not for this app.`);
    console.error(`visible: ${(apps.body.data ?? []).map((a) => a.attributes?.bundleId).join(', ') || '(none)'}`);
    return 1;
  }
  console.log(`app ${bundle} is visible as ${found.id} (${found.attributes?.name ?? 'unnamed'})`);
  return 0;
}

function row(build) {
  const version = build.attributes?.version ?? '?';
  const state = build.attributes?.processingState ?? '?';
  const uploaded = build.attributes?.uploadedDate ?? '';
  const marketing = build.relationships?.preReleaseVersion?.data?.id ?? '';
  return { version, state, uploaded, marketing };
}

async function builds(args) {
  const jwt = sign(args);
  const bundle = args.bundle || DEFAULT_BUNDLE;

  const apps = await request(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}&limit=1`, jwt);
  if (apps.status !== 200) {
    console.error(explain(apps.status, apps.body));
    return 1;
  }
  const app = apps.body?.data?.[0];
  if (!app) {
    console.error(`no app with bundle id ${bundle} is visible to this key`);
    return 1;
  }

  const watch = args.watch && args.watch !== 'true' ? String(args.watch) : null;
  const timeout = Number(args.timeout || 900) * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const list = await request(
      `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=10&include=preReleaseVersion`,
      jwt,
    );
    if (list.status !== 200) {
      console.error(explain(list.status, list.body));
      return 1;
    }

    const versions = new Map(
      (list.body.included ?? [])
        .filter((item) => item.type === 'preReleaseVersions')
        .map((item) => [item.id, item.attributes?.version]),
    );

    const rows = (list.body.data ?? []).map((build) => {
      const info = row(build);
      const marketing = versions.get(info.marketing) ?? info.marketing;
      return { ...info, marketing };
    });

    console.log(`builds for ${bundle} (${app.id})`);
    for (const r of rows) {
      console.log(`  ${String(r.marketing).padEnd(8)} build ${String(r.version).padEnd(5)} ${String(r.state).padEnd(12)} ${r.uploaded}`);
    }
    if (rows.length === 0) console.log('  (none)');

    if (!watch) return 0;

    const target = rows.find((r) => String(r.version) === watch);
    if (!target) {
      console.log(`build ${watch} is not listed yet`);
    } else if (target.state !== 'PROCESSING') {
      console.log(`build ${watch} finished processing with state ${target.state}`);
      return target.state === 'VALID' ? 0 : 2;
    } else {
      console.log(`build ${watch} still PROCESSING`);
    }

    if (Date.now() + 30_000 > deadline) {
      console.log('stopped waiting; ask again later for the final state');
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || !args.key || !args.kid || !args.issuer) {
    usage();
    return 1;
  }

  // Named so the messages above can be specific about which secret is wrong.
  const credentials = {
    keyPath: args.key,
    keyId: args.kid,
    issuerId: args.issuer,
    bundle: args.bundle,
    watch: args.watch,
    timeout: args.timeout,
  };

  if (command === 'probe') return probe(credentials);
  if (command === 'builds') return builds(credentials);
  usage();
  return 1;
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(`asc: ${error.message}`);
    process.exit(1);
  },
);
