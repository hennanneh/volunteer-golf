#!/bin/bash
# Daily local tarball snapshot of the volunteer-golf repo for fast in-place
# restore if a code/config push wedges the app. Excludes node_modules (can be
# `npm ci`'d) and .git (already mirrored to GitHub via backup.sh). data.json
# and archives.json are included so this snapshot is also a same-day data
# fallback if the git history is somehow corrupted.
#
# Lives at /var/backups/volunteer-golf/, perms 700, keeps last 14 days.

set -euo pipefail

REPO=/root/volunteer-golf
DEST=/var/backups/volunteer-golf
KEEP_DAYS=14

STAMP=$(date -u +%Y-%m-%d_%H%M%S)
OUT="${DEST}/volunteer-golf-${STAMP}.tar.gz"

tar -czf "${OUT}" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.activity-watcher.state' \
  -C /root volunteer-golf

chmod 600 "${OUT}"

# Prune old snapshots
find "${DEST}" -name 'volunteer-golf-*.tar.gz' -mtime "+${KEEP_DAYS}" -delete

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] snapshot ok: $(du -h "${OUT}" | cut -f1) ${OUT}"
