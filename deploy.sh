#!/bin/bash
# deploy.sh — safe deploy for volunteer-golf
# Run on the droplet: ssh golf "cd /root/volunteer-golf && ./deploy.sh"
#
# What it does:
#   1. Snapshot live data files (data.json, demo-data.json, archives.json)
#   2. Stop the running node process
#   3. git pull --ff-only (after temporarily discarding live data dirtiness)
#   4. Restore live data on top of the new code
#   5. npm install if package.json/package-lock.json changed
#   6. Start node again, redirected to /var/log/volunteer-golf.log
#   7. Health-check via /api/health
#   8. If health-check fails: roll back to the previous commit, restart, exit 1

set -u
set -o pipefail

cd /root/volunteer-golf

REPO_DIR="/root/volunteer-golf"
LOG_FILE="/var/log/volunteer-golf.log"
HEALTH_URL="http://127.0.0.1:3001/api/health"
PROCESS_PATTERN="node /root/volunteer-golf/server.js"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_DIR="/root/volunteer-golf-backups/pre-deploy-${TIMESTAMP}"

log() { echo "[deploy $(date '+%H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

# 0. Sanity
[ -f server.js ]   || fail "server.js not found in $REPO_DIR"
[ -f package.json ] || fail "package.json not found in $REPO_DIR"

# 1. Snapshot live data
log "Snapshotting live data to ${SNAPSHOT_DIR}"
mkdir -p "$SNAPSHOT_DIR" || fail "could not create snapshot dir"
for f in data.json demo-data.json archives.json; do
  [ -f "$f" ] && cp -p "$f" "$SNAPSHOT_DIR/$f"
done

SAVE_SHA=$(git rev-parse HEAD)
log "Current commit: ${SAVE_SHA:0:8}"

# 2. Stop running node (graceful, then forceful)
PIDS=$(pgrep -f "$PROCESS_PATTERN" || true)
if [ -n "$PIDS" ]; then
  log "Stopping node (pids: $PIDS)"
  kill -TERM $PIDS 2>/dev/null || true
  for i in 1 2 3 4 5; do
    sleep 1
    pgrep -f "$PROCESS_PATTERN" >/dev/null || break
  done
  if pgrep -f "$PROCESS_PATTERN" >/dev/null; then
    log "graceful stop didn't work, forcing"
    kill -KILL $(pgrep -f "$PROCESS_PATTERN") 2>/dev/null || true
    sleep 1
  fi
else
  log "no running node process found (nothing to stop)"
fi

# 3. Pull latest code
# Live data files are usually dirty (running app writes them between hourly commits),
# so reset them to the snapshot we took, then restore after pulling.
log "Cleaning working tree of data file dirtiness"
git checkout -- data.json demo-data.json archives.json 2>/dev/null || true

log "git pull --rebase origin main"
# --rebase (not --ff-only) so this tolerates the cron's local data commits
# accumulating on top of origin/main between deploys.
if ! git pull --rebase origin main; then
  git rebase --abort 2>/dev/null || true
  log "git pull failed — restoring live data from snapshot and aborting"
  cp -p "$SNAPSHOT_DIR"/* . 2>/dev/null || true
  fail "could not pull; resolve manually and re-run"
fi

NEW_SHA=$(git rev-parse HEAD)
log "Pulled to ${NEW_SHA:0:8} (was ${SAVE_SHA:0:8})"

# 4. Restore live data on top of new code
log "Restoring live data from snapshot"
cp -p "$SNAPSHOT_DIR"/data.json data.json         2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/demo-data.json demo-data.json 2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/archives.json archives.json 2>/dev/null || true

# 5. npm install if deps changed
if ! git diff --quiet "$SAVE_SHA" "$NEW_SHA" -- package.json package-lock.json; then
  log "package.json/lock changed, running npm install"
  npm install --omit=dev=false 2>&1 | tail -20 || fail "npm install failed"
else
  log "no dependency changes"
fi

# 6. Start node
start_node() {
  log "Starting node (logs → $LOG_FILE)"
  nohup node /root/volunteer-golf/server.js >> "$LOG_FILE" 2>&1 &
  disown
  sleep 3
}
start_node

# 7. Health check
check_health() {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if check_health; then
  log "OK — health check passed at ${NEW_SHA:0:8}"
  exit 0
fi

# 8. Roll back
log "FAIL — health check did not pass. Rolling back."

# Stop the broken new node
PIDS=$(pgrep -f "$PROCESS_PATTERN" || true)
[ -n "$PIDS" ] && kill -TERM $PIDS 2>/dev/null
sleep 2
PIDS=$(pgrep -f "$PROCESS_PATTERN" || true)
[ -n "$PIDS" ] && kill -KILL $PIDS 2>/dev/null

git checkout -- data.json demo-data.json archives.json 2>/dev/null || true
log "git reset --hard ${SAVE_SHA:0:8}"
git reset --hard "$SAVE_SHA"

# Re-restore data
cp -p "$SNAPSHOT_DIR"/data.json data.json         2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/demo-data.json demo-data.json 2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/archives.json archives.json 2>/dev/null || true

start_node

if check_health; then
  log "Rolled back to ${SAVE_SHA:0:8}; site is up on the previous version."
  fail "deploy failed — rollback succeeded. Site is on ${SAVE_SHA:0:8}. Snapshot: $SNAPSHOT_DIR"
else
  fail "DEPLOY FAILED AND ROLLBACK FAILED — site may be down. Snapshot: $SNAPSHOT_DIR. Investigate immediately."
fi
