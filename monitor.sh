#!/bin/bash
# Scans last 5 min of PM2 logs; pushes counts-only summary to ntfy
# whenever ANY activity occurred (verbose mode for tournament prep).
# No PII (no emails, IPs, names) in the push payload.
# Cron: */5 * * * *
#
# To dial back to exceptions-only: set VERBOSE=0 below.

set -uo pipefail

VERBOSE=1                 # 1 = push on any activity; 0 = exceptions only

LOG_OUT="/root/.pm2/logs/volunteer-golf-out.log"
LOG_ERR="/root/.pm2/logs/volunteer-golf-error.log"
TOPIC="golf-alerts-1c97adfdf03ef59f"
WINDOW_MIN=5

CUTOFF=$(date -u -d "$WINDOW_MIN minutes ago" '+%Y-%m-%dT%H:%M:%S')

filter_recent() {
  awk -v cutoff="$CUTOFF" '
    match($0, /\[([0-9TZ:.\-]+)\]/) {
      ts = substr($0, RSTART+1, RLENGTH-2)
      sub(/\.[0-9]+Z?$/, "", ts)
      if (ts >= cutoff) print
    }
  ' "$1"
}

out_recent=$(filter_recent "$LOG_OUT")
err_recent=$(filter_recent "$LOG_ERR")

# Normal activity counts (out log)
n_logins=$(echo "$out_recent"   | grep -c 'LOGIN OK' || true)
n_logouts=$(echo "$out_recent"  | grep -c 'LOGOUT' || true)
n_posts=$(echo "$out_recent"    | grep -c 'POST /api/data' || true)
n_patches=$(echo "$out_recent"  | grep -c 'PATCH /api/volunteer' || true)
n_demoreset=$(echo "$out_recent" | grep -c 'Demo data reset' || true)

# Exception counts (error log)
n_rejected=$(echo "$err_recent"   | grep -c 'REJECTED /api/data' || true)
n_forbidden=$(echo "$err_recent"  | grep -c 'AUTH FORBIDDEN' || true)
n_authrej=$(echo "$err_recent"    | grep -c 'AUTH REJECTED' || true)
n_loginfail=$(echo "$err_recent"  | grep -c 'LOGIN FAILED' || true)
n_stale=$(echo "$err_recent"      | grep -c 'stale dataReadAt\|legacy-mode POST' || true)
n_unauthfb=$(echo "$err_recent"   | grep -c 'UNAUTH FALLBACK' || true)

# Per-user / per-source bursts
max_user_saves=$(echo "$out_recent" \
  | grep -E 'POST /api/data|PATCH /api/volunteer' \
  | grep -oE 'user=[^ ]+( [^ ]+)?' \
  | sort | uniq -c | sort -rn | head -1 | awk '{print $1+0}')
max_user_saves=${max_user_saves:-0}

max_loginfail_src=$(echo "$err_recent" \
  | grep 'LOGIN FAILED' \
  | grep -oE 'email=[^ ]+' \
  | sort | uniq -c | sort -rn | head -1 | awk '{print $1+0}')
max_loginfail_src=${max_loginfail_src:-0}

# Total activity in window
total_activity=$((n_logins + n_logouts + n_posts + n_patches \
               + n_rejected + n_forbidden + n_authrej + n_loginfail \
               + n_stale + n_unauthfb))

# Trigger logic
trigger=0
exception_trigger=0
[ "$n_rejected"        -gt 0  ] && exception_trigger=1
[ "$n_forbidden"       -gt 0  ] && exception_trigger=1
[ "$n_authrej"         -gt 0  ] && exception_trigger=1
[ "$n_stale"           -gt 0  ] && exception_trigger=1
[ "$max_user_saves"    -gt 15 ] && exception_trigger=1
[ "$max_loginfail_src" -gt 5  ] && exception_trigger=1

if [ "$exception_trigger" -eq 1 ]; then
  trigger=1
elif [ "$VERBOSE" -eq 1 ] && [ "$total_activity" -gt 0 ]; then
  trigger=1
fi

[ "$trigger" -eq 0 ] && exit 0

priority="low"
[ "$VERBOSE" -eq 1 ] && [ "$exception_trigger" -eq 0 ] && priority="min"
[ "$exception_trigger" -eq 1 ] && priority="high"

title="Golf activity (${WINDOW_MIN}m)"
[ "$exception_trigger" -eq 1 ] && title="Golf ALERT (${WINDOW_MIN}m)"

body="Last ${WINDOW_MIN}m:
Logins:         $n_logins
Logouts:        $n_logouts
Bulk saves:     $n_posts
Edits (PATCH):  $n_patches
Demo resets:    $n_demoreset

Exceptions:
REJECTED-saves: $n_rejected
AUTH-FORBIDDEN: $n_forbidden
AUTH-REJECTED:  $n_authrej
STALE-client:   $n_stale
LOGIN-FAILED:   $n_loginfail (max from one source: $max_loginfail_src)
UNAUTH-FB:      $n_unauthfb

Bursts:
Max saves from 1 user: $max_user_saves"

curl -s \
  -H "Title: $title" \
  -H "Priority: $priority" \
  -H "Tags: bell" \
  -d "$body" \
  "https://ntfy.sh/$TOPIC" > /dev/null
