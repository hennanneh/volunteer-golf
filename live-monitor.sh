#!/bin/bash
# Live failure/security watcher: tails PM2 stderr, pushes per-event to ntfy
# in plain English (no technical jargon). Covers events that never reach the
# in-app activity log — i.e. things that FAILED or were BLOCKED, plus security
# signals. Normal successful activity is handled by activity-log-watcher.sh.
#
# Includes user initials or email-prefix hints (e.g. "JAS") so brute-force
# patterns are spottable without exposing full PII.
#
# Click-link opens colonialvolunteers.golf.
# Run under PM2 as `golf-live-monitor`.

set -uo pipefail

TOPIC="golf-alerts-1c97adfdf03ef59f"
CLICK_URL="https://colonialvolunteers.golf"
LOG_ERR="/root/.pm2/logs/volunteer-golf-error.log"

push() {
  local title="$1" priority="$2" tag="$3" body="${4:-}"
  curl -s -m 5 \
    -H "Title: $title" \
    -H "Priority: $priority" \
    -H "Tags: $tag" \
    -H "Click: $CLICK_URL" \
    -d "$body" \
    "https://ntfy.sh/$TOPIC" > /dev/null &
}

initials_from_user() {
  local s
  s=$(echo "$1" | grep -oE 'user=[A-Za-z]+, [A-Za-z]+' | head -1)
  [ -z "$s" ] && return
  s=${s#user=}
  local last=${s%%,*}
  local rest=${s#*, }
  local first=${rest%% *}
  echo "${last:0:1}${first:0:1}" | tr '[:lower:]' '[:upper:]'
}

hint_from_email() {
  local s
  s=$(echo "$1" | grep -oE 'email=[^ ]+' | head -1)
  [ -z "$s" ] && return
  s=${s#email=}
  s=${s%@*}
  echo "${s:0:3}" | tr '[:lower:]' '[:upper:]'
}

exec tail -n 0 -F "$LOG_ERR" 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    "")  continue ;;

    # Save was blocked because user's browser tab was older than 10 min
    *"stale dataReadAt"*)
      push "Save blocked — outdated browser tab" \
           "high" "stop_sign" \
           "A user's tab was older than 10 min. Their changes did NOT save. Ask them to reload the page." ;;

    # Save was blocked because browser is on cached pre-fix code
    *"legacy-mode POST"*)
      push "Save blocked — old cached browser" \
           "high" "stop_sign" \
           "A user's browser is running cached code from before the 5/14 fix. Ask them to hard-refresh (Ctrl+Shift+R)." ;;

    # Mass-deletion protection: a bulk save would have removed many volunteer
    # records at once. This is the 2026-04-10 data-wipe protection signal.
    *"volunteer count would drop"*)
      push "🚨 Data-wipe protection triggered" \
           "high" "rotating_light" \
           "A bulk save would have deleted volunteers. Server blocked it. Check the error log immediately — this is the same shape as the 4/10 data-wipe incident." ;;

    # Catch-all for other REJECTED save reasons (missing fields, malformed body)
    *"REJECTED /api/data"*)
      push "Save blocked" "high" "stop_sign" \
           "A bulk save was rejected (malformed/missing fields). Check the error log for the specific reason." ;;

    # A logged-in user tried to do something they don't have permission for.
    # Most common cause: volunteer-role user with a stale cached SPA sending a
    # bulk-save. Server correctly blocks it; user should hard-refresh.
    *"AUTH FORBIDDEN"*)
      i=$(initials_from_user "$line")
      push "Unauthorized save attempt${i:+ — $i}" \
           "default" "no_entry" \
           "A volunteer-role user's browser tried a bulk save (POST /api/data). Server blocked it. Usually a stale SPA cache — ask them to hard-refresh." ;;

    # Unauthenticated request hit a protected endpoint (rare; usually scanners)
    *"AUTH REJECTED"*)
      push "Unauthenticated request blocked" \
           "default" "no_entry" \
           "Someone hit a protected endpoint without being logged in. Mostly internet scanning noise." ;;

    # Wrong password / wrong account attempted
    *"LOGIN FAILED"*)
      h=$(hint_from_email "$line")
      push "Login failed${h:+ — $h}" \
           "default" "warning" \
           "Could be a typo, could be a locked-out captain, could be brute-force if it repeats." ;;

    # Old browser still using pre-strict-auth path (informational)
    *"UNAUTH FALLBACK"*)
      push "Old browser detected (legacy auth path)" \
           "low" "grey_question" \
           "Allowed for now, but this user hasn't refreshed since the auth update." ;;
  esac
done
