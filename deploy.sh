#!/bin/bash
# deploy.sh — safe deploy for volunteer-golf
# Run on the droplet: ssh golf "cd /root/volunteer-golf && ./deploy.sh"
#
# What it does:
#   1. Snapshot live data files (data.json, demo-data.json, archives.json)
#   2. Pull latest code (rebases over hourly cron data commits)
#   3. Restore live data on top of new code
#   4. npm install if package.json/package-lock.json changed
#   5. pm2 restart volunteer-golf
#   6. Health-check via /api/health
#   7. If health-check fails: roll back to previous commit, restart, exit 1
#
# Process management is PM2 (the daemon at /root/.pm2/, app id "volunteer-golf").

set -u
set -o pipefail

cd /root/volunteer-golf

REPO_DIR="/root/volunteer-golf"
HEALTH_URL="http://127.0.0.1:3001/api/health"
LOG_URL="http://127.0.0.1:3001/api/log-deployment"
PM2_APP="volunteer-golf"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_DIR="/root/volunteer-golf-backups/pre-deploy-${TIMESTAMP}"

# Optional: pass deployment notes as first argument
DEPLOY_NOTES="${1:-}"

log() { echo "[deploy $(date '+%H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

# 0. Sanity
[ -f server.js ]    || fail "server.js not found in $REPO_DIR"
[ -f package.json ] || fail "package.json not found in $REPO_DIR"
command -v pm2 >/dev/null 2>&1 || fail "pm2 not on PATH; symlink /usr/local/bin/pm2 → /root/.npm/_npx/.../pm2/bin/pm2"
pm2 describe "$PM2_APP" >/dev/null 2>&1 || fail "pm2 has no app named '$PM2_APP'"

# 1. Snapshot live data
log "Snapshotting live data to ${SNAPSHOT_DIR}"
mkdir -p "$SNAPSHOT_DIR" || fail "could not create snapshot dir"
for f in data.json demo-data.json archives.json; do
  [ -f "$f" ] && cp -p "$f" "$SNAPSHOT_DIR/$f"
done

SAVE_SHA=$(git rev-parse HEAD)
log "Current commit: ${SAVE_SHA:0:8}"

# 2. Pull latest code
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

# 3. Restore live data on top of new code
log "Restoring live data from snapshot"
cp -p "$SNAPSHOT_DIR"/data.json data.json         2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/demo-data.json demo-data.json 2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/archives.json archives.json 2>/dev/null || true

# 4. npm install if deps changed
if ! git diff --quiet "$SAVE_SHA" "$NEW_SHA" -- package.json package-lock.json; then
  log "package.json/lock changed, running npm install"
  npm install 2>&1 | tail -20 || fail "npm install failed"
else
  log "no dependency changes"
fi

# 5. Restart via pm2
log "pm2 restart $PM2_APP"
pm2 restart "$PM2_APP" --update-env >/dev/null || fail "pm2 restart failed"
sleep 3

# 6. Health check
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
  pm2 save >/dev/null 2>&1 || true

  # Log the deployment to activity log
  if [ -n "$DEPLOY_NOTES" ]; then
    COMMIT_MSG="$DEPLOY_NOTES"
  else
    # Use git commit message if no notes provided
    COMMIT_MSG=$(git log -1 --pretty=%B | head -1)
  fi
  log "Logging deployment: $COMMIT_MSG"
  curl -fsS -X POST "$LOG_URL" \
    -H "Content-Type: application/json" \
    -d "{\"message\": \"$COMMIT_MSG\", \"version\": \"${NEW_SHA:0:8}\"}" \
    >/dev/null 2>&1 || log "Warning: could not log deployment to activity log"

  exit 0
fi

# 7. Roll back
log "FAIL — health check did not pass. Rolling back."

git checkout -- data.json demo-data.json archives.json 2>/dev/null || true
log "git reset --hard ${SAVE_SHA:0:8}"
git reset --hard "$SAVE_SHA"

# Re-restore data
cp -p "$SNAPSHOT_DIR"/data.json data.json         2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/demo-data.json demo-data.json 2>/dev/null || true
cp -p "$SNAPSHOT_DIR"/archives.json archives.json 2>/dev/null || true

log "pm2 restart $PM2_APP (rollback)"
pm2 restart "$PM2_APP" --update-env >/dev/null || true
sleep 3

if check_health; then
  log "Rolled back to ${SAVE_SHA:0:8}; site is up on the previous version."
  fail "deploy failed — rollback succeeded. Site is on ${SAVE_SHA:0:8}. Snapshot: $SNAPSHOT_DIR"
else
  fail "DEPLOY FAILED AND ROLLBACK FAILED — site may be down. Snapshot: $SNAPSHOT_DIR. Investigate immediately."
fi
