#!/usr/bin/env bash
# GlobProxy v1 API — run-through of every endpoint, old and new.
# Usage: GLOBPROXY_API_KEY=gp_live_... bash globproxy-api-test.sh
#   (optional) GLOBPROXY_BASE_URL=https://globproxy.com
#
# The API key is read from the environment — NEVER hard-code one in this
# file. A live key was previously committed here in a public repo; that key
# must be revoked from /dashboard/api-keys and the file's git history
# rewritten (see the audit notes), not just edited.
#
# Prints "PASS"/"FAIL" per check based on HTTP status, plus the raw body
# so you can eyeball anything that looks wrong even on a "PASS" status.
# Doesn't need jq — everything's parsed with grep/sed to avoid a missing
# dependency stopping the run.

BASE="https://globproxy.com"
# Never commit a real key here. Create a throwaway key in the dashboard, then:
#   GLOBPROXY_API_KEY=gp_live_... bash globproxy-api-test.sh
KEY="${GLOBPROXY_API_KEY:-}"
if [ -z "$KEY" ]; then
  echo "Set GLOBPROXY_API_KEY to an API key from your dashboard first." >&2
  exit 1
fi
AUTH="Authorization: Bearer $KEY"
CT="Content-Type: application/json"

PASS=0
FAIL=0

# $1 = description, $2 = expected status, $3 = curl command (as a string, eval'd)
check() {
  local desc="$1" expected="$2" cmd="$3"
  local resp status body
  resp=$(eval "$cmd" -s -w '\nSTATUS:%{http_code}')
  status=$(echo "$resp" | grep -o 'STATUS:[0-9]*' | cut -d: -f2)
  body=$(echo "$resp" | sed '$d')
  if [ "$status" = "$expected" ]; then
    echo "✅ PASS  [$status]  $desc"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL  [expected $expected, got $status]  $desc"
    FAIL=$((FAIL+1))
  fi
  echo "   $body"
  echo
}

echo "=================================================="
echo " 1. Account bandwidth"
echo "=================================================="
check "GET account/bandwidth" 200 \
  "curl -s '$BASE/api/v1/account/bandwidth' -H '$AUTH'"

echo "=================================================="
echo " 2. List existing sub-users"
echo "=================================================="
check "GET sub-users (list)" 200 \
  "curl -s '$BASE/api/v1/sub-users' -H '$AUTH'"

echo "=================================================="
echo " 3. Create a sub-user (this becomes the test target for the rest)"
echo "=================================================="
CREATE_RESP=$(curl -s -X POST "$BASE/api/v1/sub-users" \
  -H "$AUTH" -H "$CT" \
  -d '{"label":"qa-script-test","gb_allocated":0.5,"country":"us"}')
echo "$CREATE_RESP"
SUB_ID=$(echo "$CREATE_RESP" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
if [ -z "$SUB_ID" ]; then
  echo "❌ FAIL  Could not extract sub-user id from create response — aborting remaining tests."
  echo "PASS=$PASS FAIL=$((FAIL+1))"
  exit 1
fi
echo "✅ Created sub-user id: $SUB_ID"
echo

echo "=================================================="
echo " 4. Get usage for that sub-user"
echo "=================================================="
check "GET sub-users/:id/usage" 200 \
  "curl -s '$BASE/api/v1/sub-users/$SUB_ID/usage' -H '$AUTH'"

echo "=================================================="
echo " 5. Top up that sub-user by 0.5GB"
echo "=================================================="
check "POST sub-users/:id/topup" 200 \
  "curl -s -X POST '$BASE/api/v1/sub-users/$SUB_ID/topup' -H '$AUTH' -H '$CT' -d '{\"gb_amount\":0.2}'"

echo "=================================================="
echo " 6. Configure auto-topup (enable)"
echo "=================================================="
check "PATCH sub-users/:id/auto-topup (enable)" 200 \
  "curl -s -X PATCH '$BASE/api/v1/sub-users/$SUB_ID/auto-topup' -H '$AUTH' -H '$CT' -d '{\"enabled\":true,\"threshold_gb\":1,\"amount_gb\":5}'"

echo "=================================================="
echo " 7. Configure auto-topup (disable)"
echo "=================================================="
check "PATCH sub-users/:id/auto-topup (disable)" 200 \
  "curl -s -X PATCH '$BASE/api/v1/sub-users/$SUB_ID/auto-topup' -H '$AUTH' -H '$CT' -d '{\"enabled\":false}'"

echo "=================================================="
echo " 8. Whitelist — add one IP"
echo "=================================================="
check "POST sub-users/:id/whitelist" 201 \
  "curl -s -X POST '$BASE/api/v1/sub-users/$SUB_ID/whitelist' -H '$AUTH' -H '$CT' -d '{\"ip\":\"203.0.113.4\",\"description\":\"QA script\"}'"

echo "=================================================="
echo " 9. Whitelist — list IPs (should include the one just added)"
echo "=================================================="
check "GET sub-users/:id/whitelist" 200 \
  "curl -s '$BASE/api/v1/sub-users/$SUB_ID/whitelist' -H '$AUTH'"

echo "=================================================="
echo " 10. Whitelist — remove that IP"
echo "=================================================="
check "DELETE sub-users/:id/whitelist?ip=..." 200 \
  "curl -s -X DELETE '$BASE/api/v1/sub-users/$SUB_ID/whitelist?ip=203.0.113.4' -H '$AUTH'"

echo "=================================================="
echo " 11. Whitelist bulk — add two IPs at once"
echo "=================================================="
check "POST sub-users/:id/whitelist/bulk" 201 \
  "curl -s -X POST '$BASE/api/v1/sub-users/$SUB_ID/whitelist/bulk' -H '$AUTH' -H '$CT' -d '{\"items\":[{\"ip\":\"203.0.113.4\",\"description\":\"QA A\"},{\"ip\":\"198.51.100.9\",\"description\":\"QA B\"}]}'"

echo "=================================================="
echo " 12. Whitelist bulk — remove both"
echo "=================================================="
check "DELETE sub-users/:id/whitelist/bulk" 200 \
  "curl -s -X DELETE '$BASE/api/v1/sub-users/$SUB_ID/whitelist/bulk' -H '$AUTH' -H '$CT' -d '{\"ips\":[\"203.0.113.4\",\"198.51.100.9\"]}'"

echo "=================================================="
echo " 13. Error case — invalid IP rejected with 400"
echo "=================================================="
check "POST whitelist with garbage IP" 400 \
  "curl -s -X POST '$BASE/api/v1/sub-users/$SUB_ID/whitelist' -H '$AUTH' -H '$CT' -d '{\"ip\":\"not-an-ip\",\"description\":\"bad\"}'"

echo "=================================================="
echo " 14. Error case — topup with 0 amount rejected with 400"
echo "=================================================="
check "POST topup with gb_amount=0" 400 \
  "curl -s -X POST '$BASE/api/v1/sub-users/$SUB_ID/topup' -H '$AUTH' -H '$CT' -d '{\"gb_amount\":0}'"

echo "=================================================="
echo " 15. Error case — acting on a sub-user id that doesn't exist"
echo "=================================================="
check "GET usage for bogus id" 404 \
  "curl -s '$BASE/api/v1/sub-users/00000000-0000-0000-0000-000000000000/usage' -H '$AUTH'"

echo "=================================================="
echo " 16. Delete the test sub-user (cleanup + delete test)"
echo "=================================================="
check "DELETE sub-users/:id" 200 \
  "curl -s -X DELETE '$BASE/api/v1/sub-users/$SUB_ID' -H '$AUTH'"

echo "=================================================="
echo " 17. Confirm it's actually gone (usage on deleted id -> 404)"
echo "=================================================="
check "GET usage after delete" 404 \
  "curl -s '$BASE/api/v1/sub-users/$SUB_ID/usage' -H '$AUTH'"

echo "=================================================="
echo " 18. Auth error case — garbage key -> 401 with a real JSON body"
echo "     (this is the specific bug that was just fixed — empty body"
echo "      after a revoked/invalid key. Body below should NOT be blank.)"
echo "=================================================="
check "GET sub-users with garbage key" 401 \
  "curl -s '$BASE/api/v1/sub-users' -H 'Authorization: Bearer gp_live_totally_made_up_and_invalid'"

echo "=================================================="
echo " 19. Repeat the same bad-key call 3 more times back to back"
echo "     (the empty-body bug only showed up on a REPEATED failure in"
echo "      the same Worker isolate — one bad call alone wasn't enough"
echo "      to catch it originally)"
echo "=================================================="
for i in 1 2 3; do
  check "GET sub-users with garbage key (repeat $i)" 401 \
    "curl -s '$BASE/api/v1/sub-users' -H 'Authorization: Bearer gp_live_totally_made_up_and_invalid'"
done

echo "=================================================="
echo " RESULTS: $PASS passed, $FAIL failed"
echo "=================================================="
