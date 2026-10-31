#!/usr/bin/env bash
# frames-bridge.sh — feed any ffmpeg video source into CourseMate.
#
#   ./frames-bridge.sh --course "BIOL 201" --input "-f x11grab -framerate 2 -i :0.0"
#
# Options:
#   --course NAME     course label (creates a session on first run)
#   --input SPEC      ffmpeg input arguments (quoted string)
#   --url URL         server base, default http://127.0.0.1:8790
#   --session ID      reuse an existing session instead of creating one
#   --rate SECONDS    sampling interval, default 2.5
#   --token TOKEN     bearer token if COURSEMATE_TOKEN is set
#   --width PX        downscale width, default 1280
#
# Requires: ffmpeg, curl, base64.
set -euo pipefail

URL="http://127.0.0.1:8790"
COURSE=""
INPUT=""
SESSION=""
RATE="2.5"
TOKEN="${COURSEMATE_TOKEN:-}"
WIDTH="1280"

while [ $# -gt 0 ]; do
  case "$1" in
    --course)  COURSE="$2";  shift 2 ;;
    --input)   INPUT="$2";   shift 2 ;;
    --url)     URL="$2";     shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --rate)    RATE="$2";    shift 2 ;;
    --token)   TOKEN="$2";   shift 2 ;;
    --width)   WIDTH="$2";   shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for bin in ffmpeg curl base64; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done
[ -n "$INPUT" ] || { echo "--input is required" >&2; exit 2; }

auth=()
[ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")

post_json() {
  curl -sS "${auth[@]}" -H 'Content-Type: application/json' -X POST "$1" -d "$2"
}

if [ -z "$SESSION" ]; then
  [ -n "$COURSE" ] || { echo "need --course or --session" >&2; exit 2; }
  resp=$(post_json "$URL/api/session" "{\"course\":$(printf '%s' "$COURSE" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')}")
  SESSION=$(printf '%s' "$resp" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$SESSION" ] || { echo "could not create session: $resp" >&2; exit 1; }
  echo "session: $SESSION"
fi

TMP=$(mktemp -d)
cleanup() { kill "${FF_PID:-0}" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# shellcheck disable=SC2086
ffmpeg -hide_banner -loglevel error $INPUT \
  -vf "fps=1/${RATE},scale=${WIDTH}:-2" -q:v 5 \
  -f image2 "$TMP/f_%08d.jpg" &
FF_PID=$!

echo "sampling every ${RATE}s -> $URL (session $SESSION)"
LAST_SEEN_FILE="$TMP/.last"
LAST_HASH=""

while :; do
  newest=$(ls -1 "$TMP"/f_*.jpg 2>/dev/null | tail -1 || true)
  if [ -n "$newest" ]; then
    if [ "$newest" != "$(cat "$LAST_SEEN_FILE" 2>/dev/null || true)" ]; then
      printf '%s' "$newest" > "$LAST_SEEN_FILE"
      # Cheap duplicate guard: identical encoder output hashes identically.
      h=$(md5sum "$newest" | cut -d' ' -f1)
      if [ "$h" != "$LAST_HASH" ]; then
        LAST_HASH="$h"
        b64=$(base64 < "$newest" | tr -d '\n')
        body="{\"session_id\":\"$SESSION\",\"image_b64\":\"$b64\",\"mime\":\"image/jpeg\",\"hash\":\"$h\"}"
        reply=$(post_json "$URL/api/ingest/frame" "$body" || echo '{"error":"post failed"}')
        kind=$(printf '%s' "$reply" | sed -n 's/.*"kind"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
        echo "$(date +%H:%M:%S)  ${kind:-?}"
        # Keep only the newest frame on disk.
        find "$TMP" -name 'f_*.jpg' ! -name "$(basename "$newest")" -delete 2>/dev/null || true
      fi
    fi
  fi
  sleep "$RATE"
done
