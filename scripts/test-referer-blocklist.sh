#!/usr/bin/env bash
# Local-dev smoke test for the /click referer blocklist.
#
# Start the backend first (from tracking-backend/):  npm run dev
# Then run:                                          bash scripts/test-referer-blocklist.sh
#
# Overridable:  BASE_URL=http://localhost:3000  OFFER_ID=<a-real-offer-slug>
#
# Expected results:
#   BLOCKED cases  -> HTTP 403  (referer check fires before the offer fetch,
#                                so the offer slug does not need to exist)
#   ALLOWED cases  -> HTTP 302  if OFFER_ID is a real active offer
#                  -> HTTP 404  if it is not — still proves the referer PASSED
#                                the blocklist (anything other than 403 = allowed)

BASE="${BASE_URL:-http://localhost:3000}"
OFFER="${OFFER_ID:-test-offer}"

echo "Target: $BASE/click/$OFFER"
echo

check() {
  local label="$1" referer="$2"
  local code
  if [ -n "$referer" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Referer: $referer" "$BASE/click/$OFFER")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/click/$OFFER")
  fi
  printf '%-26s Referer: %-32s -> HTTP %s\n' "$label" "${referer:-<none>}" "$code"
}

echo "--- should be BLOCKED (expect 403) ---"
check "blocked m.facebook.com"  "https://m.facebook.com/"
check "blocked facebook.com"    "https://facebook.com/"
check "blocked www.google.com"  "https://www.google.com/search?q=x"
check "blocked fb.com"          "https://fb.com/"
echo
echo "--- should be ALLOWED (expect 302 or 404, NOT 403) ---"
check "allowed empty referer"   ""
check "allowed example.com"     "https://example.com/"
check "allowed myfacebook.com"  "https://myfacebook.com/"
echo
echo "Tip: see the blocked error page itself with:"
echo "  curl -s -H 'Referer: https://m.facebook.com/' \"$BASE/click/$OFFER\""
