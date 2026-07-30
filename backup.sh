#!/bin/bash
cd /root/volunteer-golf

# Stage data files (signups.json added 2026-06-15 — waiting-list submissions for
# next year; tracked here so they ride the same off-box git backups as data.json).
# Stage first, then test the *staged* diff so a brand-new (untracked) signups.json
# is also caught on its very first write.
git add data.json demo-data.json archives.json signups.json 2>/dev/null

if git diff --cached --quiet; then
  exit 0
fi

git commit -m "Auto-backup data $(date '+%Y-%m-%d %H:%M')"
git push origin main
