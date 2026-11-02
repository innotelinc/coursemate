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
  node tools/asc.mjs builds --key <p8> --kid <id> --issuer <uuid> [--bundle <bundleId>] [--watch <build>] [--timeout <seconds>]
  node tools/asc.mjs certs  --key <p8> --kid <id> --issuer <uuid>
  node tools/asc.mjs revoke --key <p8> --kid <id> --issuer <uuid> --id <certId>[,<certId>] [--confirm] [--allow-distribution]
  node tools/asc.mjs mint   --key <p8> --kid <id> --issuer <uuid> --csr <base64 der> [--type DISTRIBUTION]
  node tools/asc.mjs cert   --key <p8> --kid <id> --issuer <uuid> --id <certId>`);
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

/**
 * Signing assets, read-only. "Revoke an unused certificate" is only actionable
 * if you can see which ones exist, when they were made and whether they are
 * already dead — an expired certificate costs a slot in nobody's accounting and
 * is pure noise to the person being asked to delete something.
 */
async function certs(args) {
  const jwt = sign(args);

  // No `sort` here: certificates do not accept one (Apple answers
  // PARAMETER_ERROR.INVALID for `sort=expirationDate`), so ordering is done
  // below where it also accounts for expired entries.
  const list = await request('/v1/certificates?limit=200', jwt);
  if (list.status !== 200) {
    console.error(explain(list.status, list.body));
    return 1;
  }

  const now = Date.now();
  const rows = (list.body.data ?? []).map((cert) => {
    const a = cert.attributes ?? {};
    const expires = a.expirationDate ? new Date(a.expirationDate) : null;
    return {
      id: cert.id,
      type: a.certificateType ?? '?',
      serial: a.serialNumber ?? '',
      expiry: a.expirationDate ?? '',
      name: a.displayName ?? a.name ?? '',
      expired: Boolean(expires && expires.getTime() < now),
    };
  });

  rows.sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));

  console.log(`${rows.length} certificate(s) on this account`);
  for (const r of rows) {
    const state = r.expired ? 'EXPIRED' : 'valid  ';
    // Labelled rather than columnar: these ids get copied into a revoke call, and
    // a misread column would revoke the wrong certificate.
    console.log(`  ${state}  ${r.type.padEnd(20)} expires ${String(r.expiry).slice(0, 10)}  id=${r.id}  ${r.name}`);
  }

  const byType = new Map();
  for (const r of rows) {
    const live = r.expired ? 0 : 1;
    byType.set(r.type, (byType.get(r.type) ?? 0) + live);
  }
  console.log('\nlive counts by type:');
  for (const [type, count] of byType) console.log(`  ${type.padEnd(20)} ${count}`);

  const profiles = await request('/v1/profiles?limit=200', jwt);
  if (profiles.status !== 200) {
    console.log(`\nprofiles unavailable: ${profiles.status}`);
    return 0;
  }

  const byKind = new Map();
  for (const p of profiles.body.data ?? []) {
    const kind = p.attributes?.profileType ?? '?';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  console.log(`\n${(profiles.body.data ?? []).length} provisioning profile(s)`);
  for (const [kind, count] of byKind) console.log(`  ${kind.padEnd(20)} ${count}`);
  return 0;
}

/**
 * Revoke named certificates, and never by inference.
 *
 * There is no "revoke the stale ones" here on purpose: a certificate is signing
 * material, and a wrong guess breaks a build that currently works. Callers name
 * ids they got from `certs`, see the plan, and pass --confirm to act. A dry run
 * happens by default so the first invocation cannot destroy anything.
 *
 * Distribution certificates are refused without --allow-distribution: they are
 * what already-shipped builds were signed with, unlike the development ones an
 * ephemeral runner leaves behind.
 */
async function revoke(args) {
  const jwt = sign(args);

  const list = await request('/v1/certificates?limit=200', jwt);
  if (list.status !== 200) {
    console.error(explain(list.status, list.body));
    return 1;
  }

  const all = (list.body.data ?? []).map((cert) => ({
    id: cert.id,
    type: cert.attributes?.certificateType ?? '?',
    expiry: cert.attributes?.expirationDate ?? '',
    name: cert.attributes?.displayName ?? cert.attributes?.name ?? '',
  }));

  const wanted = args.id && args.id !== 'true'
    ? String(args.id).split(',').map((value) => value.trim()).filter(Boolean)
    : [];

  if (wanted.length === 0) {
    console.error('refusing to guess: pass --id <certificateId>[,<certificateId>]');
    console.error('ids come from: node tools/asc.mjs certs …');
    return 1;
  }

  const missing = wanted.filter((id) => !all.some((cert) => cert.id === id));
  if (missing.length > 0) {
    console.error(`not on this account: ${missing.join(', ')}`);
    return 1;
  }

  const targets = all.filter((cert) => wanted.includes(cert.id));
  const distribution = targets.filter((cert) => /DISTRIBUTION/i.test(cert.type));
  if (distribution.length > 0 && args['allow-distribution'] !== 'true') {
    for (const cert of distribution) console.error(`refused ${cert.type} ${cert.id} — pass --allow-distribution to include it`);
    return 1;
  }

  for (const cert of targets) {
    console.log(`  ${cert.type.padEnd(20)} expires ${String(cert.expiry).slice(0, 10)}  ${cert.id}  ${cert.name}`);
  }

  if (args.confirm !== 'true') {
    console.log(`\ndry run: ${targets.length} certificate(s) would be revoked. Re-run with --confirm.`);
    return 0;
  }

  let failures = 0;
  for (const cert of targets) {
    const res = await fetch(`${API}/v1/certificates/${cert.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const ok = res.status === 204 || res.status === 200;
    console.log(`${ok ? 'revoked' : 'failed '} ${cert.id} (HTTP ${res.status})`);
    if (!ok) failures += 1;
  }
  return failures > 0 ? 1 : 0;
}

/**
 * Create one certificate from a CSR whose private key stays with the caller.
 *
 * This is the difference between an identity and a leak: the key never leaves the
 * machine that generated it, and only the request and the public certificate
 * cross the network. It is also what lets CI stop minting a certificate per
 * runner — one certificate, one key, reused until it expires.
 */
async function mint(args) {
  const jwt = sign(args);
  const csr = args.csr && args.csr !== 'true' ? String(args.csr).trim() : '';
  if (!csr) {
    console.error('pass --csr <base64 DER of a certificate signing request>');
    return 1;
  }

  const res = await fetch(`${API}/v1/certificates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        type: 'certificates',
        attributes: {
          csrContent: csr,
          certificateType: args.type && args.type !== 'true' ? args.type : 'DISTRIBUTION',
        },
      },
    }),
  });

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (res.status >= 300) {
    console.error(explain(res.status, body));
    console.error(text.slice(0, 600));
    return 1;
  }

  const cert = body?.data?.attributes ?? {};
  console.log(`created ${cert.certificateType} id=${body?.data?.id}`);
  console.log(`expires ${cert.expirationDate}`);
  console.log('---CERT-BEGIN---');
  console.log(cert.certificateContent ?? '');
  console.log('---CERT-END---');
  return 0;
}

/** Print one certificate's public content, for assembling a .p12 with a key held elsewhere. */
async function cert(args) {
  const jwt = sign(args);
  const id = args.id && args.id !== 'true' ? String(args.id).trim() : '';
  if (!id) {
    console.error('pass --id <certificateId>');
    return 1;
  }

  const res = await request(`/v1/certificates/${id}`, jwt);
  if (res.status !== 200) {
    console.error(explain(res.status, res.body));
    return 1;
  }

  const a = res.body?.data?.attributes ?? {};
  console.log(`${a.certificateType} expires ${a.expirationDate} ${a.displayName ?? a.name ?? ''}`);
  console.log('---CERT-BEGIN---');
  console.log(a.certificateContent ?? '');
  console.log('---CERT-END---');
  return 0;
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
    id: args.id,
    confirm: args.confirm,
    'allow-distribution': args['allow-distribution'],
  };

  if (command === 'probe') return probe(credentials);
  if (command === 'builds') return builds(credentials);
  if (command === 'certs') return certs(credentials);
  if (command === 'revoke') return revoke(credentials);
  if (command === 'mint') return mint({ ...credentials, csr: args.csr, type: args.type });
  if (command === 'cert') return cert(credentials);
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
