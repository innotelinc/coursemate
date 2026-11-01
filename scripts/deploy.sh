#!/usr/bin/env bash
# Deploy this checkout to the service that runs it — when the running code is
# not the code at HEAD.
#
#   scripts/deploy.sh [repo-dir] [service]
#
# Run by coursemate-deploy.timer on the host every couple of minutes, and safe to
# run by hand. A pull-based deploy needs no inbound credential and opens no
# endpoint on the public server: the box that runs the code decides when to take
# a new commit, and a commit it cannot fast-forward is reported rather than
# forced over local work.
#
# The comparison is against the commit the service was last restarted onto, not
# against the remote. A commit made on this box is already HEAD when the remote
# is fetched, so "did the remote move?" answers no and the service kept running
# the previous code — a deploy that reported success and changed nothing.
set -euo pipefail

REPO="${1:-/root/coursemate}"
SERVICE="${2:-coursemate}"
STATE="${COURSEMATE_DEPLOY_STATE:-/var/lib/coursemate/deployed.sha}"

cd "$REPO"

branch=$(git rev-parse --abbrev-ref HEAD)

# Take a new commit first; a fetch that fails (offline, no remote) must not stop
# the restart check below, so it is allowed to fail on its own.
git fetch --quiet origin "$branch" || true

remote=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")
head=$(git rev-parse HEAD)

if [ -n "$remote" ] && [ "$head" != "$remote" ]; then
  before=$head
  if git merge-base --is-ancestor "$before" "$remote"; then
    # Behind the remote: take it. Never force, so a checkout with edits is
    # somebody's work and is reported instead of overwritten.
    if ! git merge --ff-only --quiet "$remote"; then
      echo "cannot fast-forward $branch from ${before:0:8} to ${remote:0:8} — local changes?" >&2
      exit 1
    fi
    echo "fast-forwarded ${branch} ${before:0:8} -> ${remote:0:8}"
  else
    # Ahead of (or diverged from) the remote. Merging would be a no-op, so the
    # code to run is what is checked out — this is the case that used to keep
    # the old process alive while calling itself up to date.
    echo "local commits ahead of origin/$branch; running HEAD ${before:0:8}"
  fi
  # Read back, rather than assuming the merge moved anything.
  head=$(git rev-parse HEAD)
fi

deployed=$(cat "$STATE" 2>/dev/null || echo "")
if [ "$head" = "$deployed" ] && systemctl is-active --quiet "$SERVICE"; then
  echo "up to date at ${head:0:8}"
  exit 0
fi

# A dependency-free server, but a checkout that grows one should not restart into
# a crash loop: install only when there is something to install.
if [ -f package-lock.json ]; then
  npm ci --omit=dev --silent >/dev/null 2>&1 || npm install --omit=dev --silent >/dev/null 2>&1 || true
fi

echo "restarting $SERVICE onto ${head:0:8} (was ${deployed:0:8})"
systemctl restart "$SERVICE"

# Report the state the operator actually cares about, not just that a restart ran.
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "$SERVICE did not come back after deploying ${head:0:8}" >&2
  exit 1
fi

mkdir -p "$(dirname "$STATE")"
printf '%s\n' "$head" > "$STATE"
echo "$SERVICE active on ${head:0:8}"
