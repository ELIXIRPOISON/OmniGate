#!/usr/bin/env sh
# End-to-end check against the production image. Proves the container really serves the whole
# product: the proxy, auth, rate limiting, the cache, the admin API and the dashboard.
#
#   docker compose -f compose.prod.yml up -d
#   docker compose -f compose.prod.yml exec -T gateway node dist/prisma/seed.js
#   sh tools/smoke-prod.sh "$KEY"
set -e
BASE="${BASE:-http://localhost:8080}"
KEY="$1"
fails=0


check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ok    %-42s %s\n' "$1" "$3"
  else printf '  FAIL  %-42s expected %s, got %s\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# The last section deliberately exhausts the anonymous per-IP cap, and every request from this host
# shares one bucket because TRUST_PROXY is off locally. So wait for the window to drain rather than
# failing a rerun that happens inside it.
waited=0
while [ "$(code "$BASE/api/mock/items")" = "429" ] && [ "$waited" -lt 75 ]; do
  [ "$waited" = "0" ] && echo "waiting for the rate-limit window to drain..."
  sleep 5
  waited=$((waited + 5))
done

echo "gateway"
check "readyz"                    200 "$(code "$BASE/readyz")"
check "healthz"                   200 "$(code "$BASE/healthz")"
check "open route proxied"        200 "$(code "$BASE/api/mock/items")"
check "protected route, no creds" 401 "$(code "$BASE/api/orders/items")"
check "protected route, api key"  200 "$(code -H "X-API-Key: $KEY" "$BASE/api/orders/items")"
check "unknown service"           404 "$(code "$BASE/api/nope")"

echo "dashboard"
check "index"                     200 "$(code -H 'accept: text/html' "$BASE/")"
check "client-side route"         200 "$(code -H 'accept: text/html' "$BASE/routes")"
check "HEAD index"                200 "$(code -I "$BASE/")"
check "curl default accept"       200 "$(code "$BASE/")"
check "missing asset still 404s"  404 "$(code "$BASE/nope.png")"

ASSET=$(curl -s "$BASE/" | tr '"' '\n' | grep -m1 '^/assets/.*\.js$' || true)
if [ -n "$ASSET" ]; then
  check "hashed asset"            200 "$(code "$BASE$ASSET")"
  CC=$(curl -sI "$BASE$ASSET" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
  check "asset cached immutably"  "public, max-age=31536000, immutable" "$CC"
  IC=$(curl -sI -H 'accept: text/html' "$BASE/" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
  check "index revalidates"       "no-cache" "$IC"
else
  echo "  FAIL  could not find a hashed asset in index.html"; fails=$((fails + 1))
fi

echo "hardening"
hdr() { curl -sI -H 'accept: text/html' "$1" | tr -d '\r' | awk -F': ' -v k="$2" 'tolower($1)==k{print $2}'; }
check "nosniff on the dashboard"    "nosniff" "$(hdr "$BASE/" x-content-type-options)"
check "framing denied"              "DENY"    "$(hdr "$BASE/" x-frame-options)"
check "referrer suppressed"         "no-referrer" "$(hdr "$BASE/" referrer-policy)"
CSP=$(hdr "$BASE/" content-security-policy)
check "CSP present"                 "yes" "$([ -n "$CSP" ] && echo yes || echo no)"
check "CSP has no unsafe-inline js" "yes" "$(echo "$CSP" | grep -q "script-src[^;]*unsafe-inline" && echo no || echo yes)"
check "CSP hashes the theme script" "yes" "$(echo "$CSP" | grep -q "script-src[^;]*sha256-" && echo yes || echo no)"
# A gateway must not rewrite the upstream's own security headers.
UPSTREAM_CSP=$(curl -sI "$BASE/api/mock/items" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
check "proxied response untouched"  "" "$UPSTREAM_CSP"
check "admin is never cached"       "no-store" "$(curl -sI "$BASE/admin/v1/routes" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"

echo "control plane"
check "admin needs auth"          401 "$(code "$BASE/admin/v1/routes")"
TOKEN=$(curl -s -X POST -H 'content-type: application/json' \
  -d '{"email":"'"${ADMIN_EMAIL:-admin@example.com}"'","password":"'"${ADMIN_PASSWORD:-admin}"'"}' \
  "$BASE/admin/v1/auth/login" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
check "admin login"               200 "$([ -n "$TOKEN" ] && echo 200 || echo 000)"
check "routes listed"             200 "$(code -H "Authorization: Bearer $TOKEN" "$BASE/admin/v1/routes")"
check "metrics listed"            200 "$(code -H "Authorization: Bearer $TOKEN" "$BASE/admin/v1/metrics/overview")"

echo "rate limiting"
last=""
i=0
while [ $i -lt 45 ]; do last=$(code "$BASE/api/mock/items"); i=$((i + 1)); done
check "anon cap trips"            429 "$last"

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) failed"; exit 1; fi
