#!/usr/bin/env bash
# Deploy this checkout to the service that runs it — only when the remote moved.
#
#   scripts/deploy.sh [repo-dir] [service]
#
# Run by coursemate-deploy.timer on the host every couple of minutes, and safe to
# run by hand. A pull-based deploy needs no inbound credential and opens no
# endpoint on the public server: the box that runs the code decides when to take
# a new commit, and a commit it cannot fast-forward is reported rather than
# forced over local work.
set -euo pipefail

REPO="${1:-/root/coursemate}"
SERVICE="${2:-coursemate}"

cd "$REPO"

branch=$(git rev-parse --abbrev-ref HEAD)
before=$(git rev-parse HEAD)

git fetch --quiet origin "$branch"
after=$(git rev-parse "origin/$branch")

if [ "$before" = "$after" ]; then
  echo "up to date at ${before:0:8}"
  exit 0
fi

# Never force: a checkout with local commits or edits is somebody's work.
if ! git merge --ff-only --quiet "$after"; then
  echo "cannot fast-forward $branch from ${before:0:8} to ${after:0:8} — local changes?" >&2
  exit 1
fi

echo "deployed ${branch} ${before:0:8} -> ${after:0:8}"

# A dependency-free server, but a checkout that grows one should not restart into
# a crash loop: install only when there is something to install.
if [ -f package-lock.json ] && [ -d node_modules ] || [ -f package-lock.json ]; then
  npm ci --omit=dev --silent >/dev/null 2>&1 || npm install --omit=dev --silent >/dev/null 2>&1 || true
fi

systemctl restart "$SERVICE"

# Report the state the operator actually cares about, not just that a restart ran.
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "$SERVICE did not come back after deploying ${after:0:8}" >&2
  exit 1
fi

echo "$SERVICE active on ${after:0:8}"
