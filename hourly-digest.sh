#!/bin/bash
# Hourly digest: counts only, no PII (no emails, IPs, names) in payload.
# Cron: 5 * * * *  (5 min after the hour)

set -uo pipefail

LOG_OUT="/root/.pm2/logs/volunteer-golf-out.log"
LOG_ERR="/root/.pm2/logs/volunteer-golf-error.log"
TOPIC="golf-alerts-1c97adfdf03ef59f"
WINDOW_MIN=60

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

n_posts=$(echo "$out_recent"   | grep -c 'POST /api/data' || true)
n_patches=$(echo "$out_recent" | grep -c 'PATCH /api/volunteer' || true)
n_logins=$(echo "$out_recent"  | grep -c 'LOGIN OK' || true)
n_rejected=$(echo "$err_recent"  | grep -c 'REJECTED /api/data' || true)
n_forbidden=$(echo "$err_recent" | grep -c 'AUTH FORBIDDEN' || true)
n_loginfail=$(echo "$err_recent" | grep -c 'LOGIN FAILED' || true)
n_stale=$(echo "$err_recent"     | grep -c 'stale dataReadAt\|legacy-mode POST' || true)
n_unauthfb=$(echo "$err_recent"  | grep -c 'UNAUTH FALLBACK' || true)

# Aggregate save counts per user — but emit only the *number* (not the name)
heaviest=$(echo "$out_recent" \
  | grep -oE 'user=[^ ]+(.[^ ]+)?' \
  | sort | uniq -c | sort -rn | head -1 | awk '{print $1}')
heaviest=${heaviest:-0}

unique_savers=$(echo "$out_recent" \
  | grep -oE 'user=[^ ]+(.[^ ]+)?' \
  | sort -u | wc -l)

# Aggregate failed-login concentration — number of distinct emails, max attempts
loginfail_top=$(echo "$err_recent" \
  | grep 'LOGIN FAILED' \
  | grep -oE 'email=[^ ]+' \
  | sort | uniq -c | sort -rn | head -1 | awk '{print $1}')
loginfail_top=${loginfail_top:-0}

priority="low"
title="Golf hourly digest"
[ "$n_rejected" -gt 0 ] || [ "$n_forbidden" -gt 0 ] && { priority="default"; title="Golf hourly (errors present)"; }
[ "$heaviest" -gt 50 ] && { priority="high"; title="Golf hourly (heavy save volume from 1 user)"; }
[ "$loginfail_top" -gt 10 ] && { priority="high"; title="Golf hourly (login lockout pattern)"; }

body="Last 60m:
Saves(POST):    $n_posts
Edits(PATCH):   $n_patches
Logins:         $n_logins
Active savers:  $unique_savers
Heaviest user:  $heaviest saves

Errors:
REJECTED-saves: $n_rejected
AUTH-FORBIDDEN: $n_forbidden
STALE-client:   $n_stale
LOGIN-FAILED:   $n_loginfail (max from one source: $loginfail_top)
UNAUTH-FB:      $n_unauthfb"

curl -s \
  -H "Title: $title" \
  -H "Priority: $priority" \
  -H "Tags: chart_with_upwards_trend" \
  -d "$body" \
  "https://ntfy.sh/$TOPIC" > /dev/null
