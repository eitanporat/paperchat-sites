#!/bin/bash
# find-image.sh — search Wikimedia Commons + DOWNLOAD top matches so
# the writer can Read each candidate before deciding to embed.
#
# Usage: ./_lib/find-image.sh "QUERY" [LIMIT] [WIDTH]
#   QUERY  search terms (e.g. "solar panel")
#   LIMIT  how many results to download (default 5)
#   WIDTH  preferred thumbnail width in px (default 800)
#
# Downloads each match to ./figures/web/ and prints one line per match:
#   <local-path>\t<remote-url>\t<commons-page-url>
#
# The writer's workflow:
#   1) Call this with a query.
#   2) Read each <local-path> to actually see the image.
#   3) Decide which to use; embed by referencing the local path:
#      <img src="figures/web/<file>.jpg">
#   4) Always credit the <commons-page-url> in the figcaption.
set -euo pipefail
QUERY="${1:?usage: find-image.sh \"QUERY\" [LIMIT] [WIDTH]}"
LIMIT="${2:-5}"
WIDTH="${3:-800}"
OUTDIR="figures/web"
mkdir -p "$OUTDIR"
ENC=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote_plus(sys.argv[1]))' "$QUERY")
URL="https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=${LIMIT}&gsrsearch=${ENC}&prop=imageinfo&iiprop=url&iiurlwidth=${WIDTH}&format=json"
RESP=$(curl -sS -A "paperchat/0.1 (find-image)" "$URL")
echo "$RESP" | python3 -c '
import json, sys, re
d = json.load(sys.stdin)
pages = (d.get("query") or {}).get("pages") or {}
for p in pages.values():
    info = (p.get("imageinfo") or [{}])[0]
    if not info: continue
    title = p.get("title", "").replace("File:", "")
    url = info.get("thumburl") or info.get("url") or ""
    desc = info.get("descriptionurl") or ""
    if not url: continue
    # Sanitize filename: keep alnum, dash, underscore, dot
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", title)[:80]
    print(f"{safe}\t{url}\t{desc}")
' | while IFS=$'\t' read -r SAFE URL DESC; do
  LOCAL="$OUTDIR/$SAFE"
  curl -sSL -A "paperchat/0.1 (find-image)" -o "$LOCAL" "$URL" || continue
  printf "%s\t%s\t%s\n" "$LOCAL" "$URL" "$DESC"
done
