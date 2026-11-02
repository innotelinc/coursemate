#!/usr/bin/env bash
# Dispatch the iOS release for a tag GitHub's scheduler has not noticed.
#
#   scripts/tag-release.sh
#
# The tag IS the trigger, but the only credential-free way to read it from the
# repository that holds the App Store Connect key is a `schedule:` in
# ios-release.yml — and a scheduled workflow is entirely at GitHub's discretion.
# It ran zero times in the two hours after the trigger was added, while every
# `workflow_dispatch` succeeded, so a tag sat there with nothing happening and no
# error anywhere to say why.
#
# This is the missing nudge, not a second implementation: it reads the same tags,
# respects the same ios-release/<tag> markers, and dispatches the same workflow
# on the same ref, so the build still happens — and is still signed — on GitHub.
# A dispatch GitHub's own schedule wins the race is harmless: the workflow's
# concurrency group serialises them and the marker makes the second one a no-op.
set -euo pipefail

APP_REPO="${CM_APP_REPO:-innotelinc/coursemate-ios}"
REPO="${CM_REPO:-innotelinc/coursemate}"
WORKFLOW="${CM_WORKFLOW:-ios-release.yml}"
REF="${CM_REF:-master}"

tags() {
  git ls-remote --tags --refs "$1" "${2:-}" 2>/dev/null | awk '{print $2}'
}

latest=$(tags "https://github.com/$APP_REPO" \
  | sed 's#refs/tags/##' \
  | grep -E '^v[0-9]+(\.[0-9]+)*$' | sort -V | tail -n 1 || true)

if [ -z "$latest" ]; then
  echo "no version tags in $APP_REPO — nothing to release"
  exit 0
fi

# The marker a finished release writes, read from the repository that builds it.
if tags "https://github.com/$REPO" 'refs/tags/ios-release/*' \
  | sed 's#refs/tags/ios-release/##' | grep -qx "${latest#v}"; then
  echo "$latest is already released"
  exit 0
fi

# One dispatch is enough. A second would only queue behind the first and then
# find its own marker.
active=$(gh run list -R "$REPO" --workflow "$WORKFLOW" -L 10 --json status \
  --jq '[.[] | select(.status == "in_progress" or .status == "queued")] | length' 2>/dev/null || echo 0)
if [ "${active:-0}" != "0" ]; then
  echo "$latest is not released yet, but a release run is already active"
  exit 0
fi

echo "dispatching $latest (${latest#v}) to $WORKFLOW on $REF"
gh workflow run "$WORKFLOW" -R "$REPO" --ref "$REF" -f version="${latest#v}"
