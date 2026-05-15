#!/bin/bash
# Polls data.json for new activityLog entries and pushes each to ntfy with full
# content in a readable, jargon-free format. Click-link opens
# colonialvolunteers.golf for fast review.
#
# Title:  "{User} — {Action}"           e.g. "Howrey, Anne — Delete"
# Body:   "{Time}                         e.g. "8:31 PM
#          {Type} · target: {Target}            Admin · target: test 2 anne
#          {Details}"                            Deleted volunteer"
#
# WARNING: payloads include real names and edit details, sent to public ntfy.sh.
# Topic name is sensitive — treat like a password.
# User explicitly accepted this tradeoff 2026-05-15.
#
# Run under PM2 as `golf-activity-watcher`.

set -uo pipefail

DATA_FILE="/root/volunteer-golf/data.json"
STATE_FILE="/root/volunteer-golf/.activity-watcher.state"
TOPIC="golf-alerts-1c97adfdf03ef59f"
CLICK_URL="https://colonialvolunteers.golf"
POLL_SEC=10

if [ ! -f "$STATE_FILE" ]; then
  jq -r '.activityLog[0].timestamp // "1970-01-01T00:00:00.000Z"' "$DATA_FILE" > "$STATE_FILE"
fi

friendly_action() {
  case "$1" in
    login)               echo "Login" ;;
    logout)              echo "Logout" ;;
    edit-volunteer)      echo "Edit" ;;
    edit-schedule|schedule-change) echo "Schedule edit" ;;
    add-volunteer)       echo "Add volunteer" ;;
    delete-volunteer|delete) echo "Delete" ;;
    check-in)            echo "Check in" ;;
    check-out)           echo "Check out" ;;
    password-change)     echo "Password change" ;;
    import)              echo "Import" ;;
    submission)          echo "Submission" ;;
    settings-change)     echo "Settings change" ;;
    system-update)       echo "System update" ;;
    rejected-bulk-edit)  echo "Auto-rejected" ;;
    *)                   echo "$1" ;;
  esac
}

priority_for() {
  case "$1" in
    rejected-bulk-edit) echo "high" ;;
    delete-volunteer|delete|password-change|system-update|settings-change|import) echo "default" ;;
    *) echo "low" ;;
  esac
}

tag_for() {
  case "$1" in
    login)               echo "white_check_mark" ;;
    logout)              echo "wave" ;;
    edit-schedule|schedule-change) echo "calendar" ;;
    edit-volunteer)      echo "pencil2" ;;
    add-volunteer)       echo "heavy_plus_sign" ;;
    delete-volunteer|delete) echo "x" ;;
    password-change)     echo "key" ;;
    check-in)            echo "hand" ;;
    check-out)           echo "wave" ;;
    system-update)       echo "rocket" ;;
    submission)          echo "inbox_tray" ;;
    settings-change)     echo "gear" ;;
    import)              echo "arrow_down" ;;
    rejected-bulk-edit)  echo "stop_sign" ;;
    *)                   echo "bell" ;;
  esac
}

while true; do
  last_ts=$(cat "$STATE_FILE" 2>/dev/null || echo "1970-01-01T00:00:00.000Z")

  new_entries=$(jq -c --arg since "$last_ts" '
    [.activityLog[] | select(.timestamp > $since)] | sort_by(.timestamp) | .[]
  ' "$DATA_FILE" 2>/dev/null || true)

  if [ -n "$new_entries" ]; then
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue

      action=$(echo "$entry"      | jq -r '.action // "?"')
      user=$(echo "$entry"        | jq -r '.user // "?"')
      utype=$(echo "$entry"       | jq -r '.userType // "?"')
      target=$(echo "$entry"      | jq -r '.target // ""')
      details=$(echo "$entry"     | jq -r '.details // ""')
      ts=$(echo "$entry"          | jq -r '.timestamp // ""')
      actor_hole=$(echo "$entry"  | jq -r '.actorHole // ""')
      target_hole=$(echo "$entry" | jq -r '.targetHole // ""')
      time_str=$(TZ=America/Chicago date -d "$ts" '+%I:%M %p' 2>/dev/null || echo "$ts")

      friendly=$(friendly_action "$action")
      priority=$(priority_for "$action")
      tag=$(tag_for "$action")

      # Cross-hole detection — only meaningful for captains. Bulk-save entries
      # carry actorHole + targetHole. Mismatch = silent override into another
      # captain's records, very high signal.
      cross_hole=0
      if [ "$utype" = "Captain" ] && [ -n "$actor_hole" ] && [ -n "$target_hole" ] && [ "$actor_hole" != "$target_hole" ]; then
        cross_hole=1
      fi

      if [ "$action" = "rejected-bulk-edit" ]; then
        title="🛑 AUTO-REJECTED: $user → $target"
      elif [ "$cross_hole" -eq 1 ]; then
        priority="high"
        tag="rotating_light"
        title="🚨 CROSS-HOLE: $user → $target"
      else
        title="$user — $friendly"
      fi

      target_line=""
      if [ -n "$target" ] && [ "$target" != "-" ]; then
        if [ -n "$target_hole" ]; then
          target_line="$utype · target: $target (hole $target_hole)"
        else
          target_line="$utype · target: $target"
        fi
      else
        target_line="$utype"
      fi

      body="$time_str
$target_line"
      [ -n "$details" ] && [ "$details" != "-" ] && body="$body
$details"
      if [ "$cross_hole" -eq 1 ]; then
        body="$body

⚠️ $user is captain of hole $actor_hole but modified a hole $target_hole volunteer. Investigate immediately."
      fi

      curl -s -m 5 \
        -H "Title: $title" \
        -H "Priority: $priority" \
        -H "Tags: $tag" \
        -H "Click: $CLICK_URL" \
        -d "$body" \
        "https://ntfy.sh/$TOPIC" > /dev/null

      echo "$ts" > "$STATE_FILE"
    done <<< "$new_entries"
  fi

  sleep "$POLL_SEC"
done
