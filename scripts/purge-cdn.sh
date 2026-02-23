#!/usr/bin/env bash
# Purge Netlify CDN cache for scotuspdf
set -euo pipefail

TOKEN=$(python3 << 'PYEOF'
import json
d = json.load(open("/Users/yahelc/Library/Preferences/netlify/config.json"))
k = next(k for k in d["users"] if k != "default")
print(d["users"][k]["auth"]["token"])
PYEOF
)

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.netlify.com/api/v1/purge" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site_id":"751ab2cd-6265-41d6-8d7e-591b870e6d42"}')

if [ "$STATUS" = "202" ]; then
  echo "CDN cache purged successfully"
else
  echo "CDN cache purge failed (HTTP $STATUS)" >&2
  exit 1
fi
