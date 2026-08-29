#!/usr/bin/env bash
# Fetch VRoid-Modelle aus Adrians Nextcloud-Share in public/models/
# Usage: ./scripts/fetch-vroid-share.sh [SHARE_ID]
# Nextcloud public share via WebDAV (Basic Auth mit Share-Token)
set -euo pipefail

SHARE_ID="${1:-DSaCJTHodbY72XB}"
BASE="https://nextcloud.at-veranstaltungen.de/public.php/webdav"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/models/incoming-vroid"

mkdir -p "$DEST"
echo "→ Liste Share $SHARE_ID ..."
curl -sf -u "$SHARE_ID:" -X PROPFIND "$BASE/" -H "Depth: 1" \
  | grep -oE '<d:href>[^<]*</d:href>' \
  | sed 's|</\?d:href>||g; s|/public.php/webdav/||' \
  | grep -v '^$' \
  | while read -r f; do
      [ "$f" = "" ] && continue
      echo "  ↓ $f"
      curl -sf -u "$SHARE_ID:" "$BASE/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$f")" -o "$DEST/$f"
    done
echo "✅ Fertig: $DEST"
ls -la "$DEST"