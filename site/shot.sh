#!/usr/bin/env bash
# Screenshot a dev-server route with Windows Edge (headless) from WSL.
# Usage: ./shot.sh <url> <out.png> [width] [height]
set -euo pipefail
url="$1" out="$2" w="${3:-1440}" h="${4:-900}"
edge="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
wintmp="$(wslpath -u "$(cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")"
name="gond-agent-shot-$$-$RANDOM.png"
# Edge won't make a window narrower than ~484px, so phone widths are laid out inside an iframe of the
# requested size (the dev server's /__frame page; its viewport is then exactly w x h).
if [ "$w" -lt 500 ]; then
  origin="$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')"
  path="${url#"$origin"}"
  url="$origin/__frame?w=$w&h=$h&src=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "${path:-/}")"
fi
# Its own profile, so an open Edge window (or a stuck headless one) can't lock the default profile.
# REDUCED=1 renders with reduced motion on (animations show their final state).
extra=""; [ -n "${REDUCED:-}" ] && extra="--force-prefers-reduced-motion"
"$edge" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 $extra \
  --user-data-dir="$(wslpath -w "$wintmp/gond-agent-shot-profile")" --no-first-run \
  --window-size="$w,$h" --virtual-time-budget=${VTB:-4000} --run-all-compositor-stages-before-draw \
  --screenshot="$(wslpath -w "$wintmp/$name")" "$url" >/dev/null 2>&1 || true
mv "$wintmp/$name" "$out"
echo "$out"
