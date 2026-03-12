#!/bin/bash
cd /root/volunteer-golf

# Only commit if data files have changed
if git diff --quiet data.json demo-data.json archives.json 2>/dev/null; then
  exit 0
fi

git add data.json demo-data.json archives.json
git commit -m "Auto-backup data $(date '+%Y-%m-%d %H:%M')"
git push origin main
