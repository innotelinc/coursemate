#!/usr/bin/env bash
# Publish CourseMate on its canonical host — DNS, edge vhost, certificate.
#
#   scripts/edge-host.sh            # print the plan; change nothing
#   scripts/edge-host.sh --apply    # do it
#
# Run this where the estate's DNS and edge actually live, not on the box that
# runs the server: Cerulean's Technitium is not published to the LAN and the NPM
# edge is a different machine, so `cm.innotel.us` cannot be created from the
# application host at all.
#
# Idempotent by construction. Every step reads first and reports "already there"
# rather than creating a second record or a second vhost, because a duplicated
# proxy host on NPM takes over a name silently and is very hard to see.
set -euo pipefail

DOMAIN="${COURSEMATE_DOMAIN:-cm.innotel.us}"
ZONE="${COURSEMATE_ZONE:-innotel.us}"
TARGET_IP="${COURSEMATE_EDGE_IP:-73.68.203.71}"
# The existing host is the template: same upstream, same websocket and buffer
# settings, so nothing about how the app is proxied has to be re-derived.
REFERENCE="${COURSEMATE_REFERENCE_HOST:-cm.innotel.tech}"
UPSTREAM_PORT="${COURSEMATE_UPSTREAM_PORT:-8790}"
UPSTREAM_HOST="${COURSEMATE_UPSTREAM_HOST:-192.168.1.94}"

NPM_API="${NPM_API:-http://127.0.0.1:81}"
NPM_EMAIL="${NPM_ADMIN_EMAIL:-}"
NPM_PASSWORD="${NPM_ADMIN_PASSWORD:-}"
DNS_API="${DNS_API:-}"
DNS_USER="${DNS_ADMIN_USER:-admin}"
DNS_PASSWORD="${DNS_ADMIN_PASSWORD:-}"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

need() {
  [ -n "$2" ] || { say "FAIL: $1 is not set"; exit 1; }
}

step "plan"
say "  name        $DOMAIN (zone $ZONE)"
say "  address     $TARGET_IP"
say "  upstream    http://$UPSTREAM_HOST:$UPSTREAM_PORT"
say "  edge api    $NPM_API"
say "  mode        $([ "$APPLY" = 1 ] && echo apply || echo 'dry run — pass --apply')"

# ── DNS ──────────────────────────────────────────────────────────────────────
step "dns"
if [ -z "$DNS_API" ] || [ -z "$DNS_PASSWORD" ]; then
  say "  skipped: DNS_API / DNS_ADMIN_PASSWORD are not set"
  say "  a CNAME to $ZONE, or an A record to $TARGET_IP, is what this step writes"
else
  TOK=$(curl -s -X POST "$DNS_API/api/user/login?user=$DNS_USER&pass=$DNS_PASSWORD" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$TOK" ] || { say "FAIL: DNS login refused"; exit 1; }

  existing=$(curl -s -G "$DNS_API/api/zones/records/get" \
    --data-urlencode "token=$TOK" --data-urlencode "domain=$DOMAIN" \
    --data-urlencode "zone=$ZONE" --data-urlencode "type=A" \
    | sed -n 's/.*"value":"\([0-9][0-9.]*\)".*/\1/p' | head -1)

  if [ "$existing" = "$TARGET_IP" ]; then
    say "  $DOMAIN already points at $TARGET_IP"
  elif [ "$APPLY" = 1 ]; then
    curl -s -G "$DNS_API/api/zones/records/add" \
      --data-urlencode "token=$TOK" --data-urlencode "domain=$DOMAIN" \
      --data-urlencode "zone=$ZONE" --data-urlencode "type=A" \
      --data-urlencode "value=$TARGET_IP" --data-urlencode "ttl=300" >/dev/null
    say "  added A $DOMAIN -> $TARGET_IP"
  else
    say "  would add A $DOMAIN -> $TARGET_IP (currently ${existing:-none})"
  fi
fi

# ── edge ────────────────────────────────────────────────────────────────────
step "edge"
need NPM_ADMIN_EMAIL "$NPM_EMAIL"
need NPM_ADMIN_PASSWORD "$NPM_PASSWORD"

JWT=$(curl -s -X POST "$NPM_API/api/tokens" -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$NPM_EMAIL\",\"secret\":\"$NPM_PASSWORD\"}" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$JWT" ] || { say "FAIL: the edge refused the login"; exit 1; }
AUTH="Authorization: Bearer $JWT"

hosts=$(curl -s -H "$AUTH" "$NPM_API/api/nginx/proxy-hosts")

# Already published? Nothing to do — a second host with the same name wins
# silently, so this is the check that keeps the script safe to re-run.
if printf '%s' "$hosts" | grep -q "\"$DOMAIN\""; then
  say "  $DOMAIN is already a proxy host"
  id=$(printf '%s' "$hosts" | python3 -c '
import json, sys
want = sys.argv[1]
for h in json.load(sys.stdin):
    if want in (h.get("domain_names") or []):
        print(h["id"]); break
' "$DOMAIN")
  say "  id=$id"
else
  template=$(printf '%s' "$hosts" | python3 -c '
import json, sys
want = sys.argv[1]
for h in json.load(sys.stdin):
    if want in (h.get("domain_names") or []):
        print(json.dumps(h)); break
' "$REFERENCE")
  if [ -z "$template" ]; then
    say "  no $REFERENCE host to copy; creating a minimal one instead"
    body=$(python3 - "$DOMAIN" "$UPSTREAM_HOST" "$UPSTREAM_PORT" <<'PY'
import json, sys
domain, host, port = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "domain_names": [domain],
    "forward_scheme": "http",
    "forward_host": host,
    "forward_port": int(port),
    "caching_enabled": False,
    "block_exploits": True,
    "allow_websocket_upgrade": True,
    "access_list_id": 0,
    "certificate_id": 0,
    "ssl_forced": True,
    "http2_support": True,
    "meta": {"letsencrypt_agree": True, "dns_challenge": False},
    "advanced_config": "",
    "locations": [],
}))
PY
)
  else
    body=$(printf '%s' "$template" | python3 -c '
import json, sys
h = json.load(sys.stdin)
keep = ("forward_scheme", "forward_host", "forward_port", "caching_enabled",
        "block_exploits", "allow_websocket_upgrade", "access_list_id",
        "ssl_forced", "http2_support", "advanced_config", "locations",
        "hsts_enabled", "hsts_subdomains")
out = {k: h[k] for k in keep if k in h}
out["domain_names"] = [sys.argv[1]]
out["certificate_id"] = 0
out["meta"] = {"letsencrypt_agree": True, "dns_challenge": False}
print(json.dumps(out))
' "$DOMAIN")
  fi

  if [ "$APPLY" != 1 ]; then
    say "  would create a proxy host from $REFERENCE:"
    printf '%s\n' "$body" | python3 -m json.tool | sed 's/^/    /'
  else
    created=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
      -d "$body" "$NPM_API/api/nginx/proxy-hosts")
    id=$(printf '%s' "$created" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
    [ -n "$id" ] || { say "FAIL: the edge refused the host: $created"; exit 1; }
    say "  created host id=$id"
  fi
fi

# ── certificate ─────────────────────────────────────────────────────────────
# A certificate is only requested once DNS answers, because Let's Encrypt will
# fail an order for a name that does not resolve yet — and a failed order burns
# that name's weekly validation attempts.
step "certificate"
if [ "${id:-}" = "" ]; then
  say "  skipped: no host id"
elif ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
  say "  skipped: $DOMAIN does not resolve yet; re-run once it does"
elif [ "$APPLY" != 1 ]; then
  say "  would request a Let's Encrypt certificate for $DOMAIN"
else
  cert=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"letsencrypt\",\"domain_names\":[\"$DOMAIN\"],\"meta\":{\"letsencrypt_agree\":true}}" \
    "$NPM_API/api/nginx/certificates")
  cert_id=$(printf '%s' "$cert" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
  if [ -z "$cert_id" ]; then
    say "  certificate request refused: $cert"
  else
    curl -s -X POST -H "$AUTH" "$NPM_API/api/nginx/certificates/$cert_id/issue" >/dev/null
    curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
      -d "{\"certificate_id\":$cert_id}" "$NPM_API/api/nginx/proxy-hosts/$id" >/dev/null
    say "  requested certificate id=$cert_id"
  fi
fi

step "verify"
if [ "$APPLY" = 1 ]; then
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$DOMAIN/" || echo 000)
  say "  https://$DOMAIN/ -> $code"
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$DOMAIN/desk" || echo 000)
  say "  https://$DOMAIN/desk -> $code"
else
  say "  nothing was changed"
fi
