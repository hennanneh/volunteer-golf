# Development workflow

The safe loop for editing volunteer-golf without breaking production.

## Where things live

| What | Where |
|---|---|
| Local clone | `~/Desktop/Personal/volunteer-golf` |
| Production | `golf:/root/volunteer-golf` (DO droplet `137.184.231.234`) |
| GitHub | `github.com/hennanneh/volunteer-golf` (HTTPS via gh CLI) |
| Domains | colonialvolunteers.golf, volunteers.golf, volunteer.golf |
| Process | plain `node server.js` on port 3001 — **no process supervisor** |
| Hourly data backup | cron runs `backup.sh` :00, commits data files to `main` |

## The golden rule

Never edit on the droplet. Edit locally → push → run `deploy.sh`.

## Daily loop

### 1. Sync local to latest
```bash
cd ~/Desktop/Personal/volunteer-golf
git pull origin main
```
The hourly cron pushes data file commits to `main`, so always pull before starting work.

### 2. Edit and run locally
```bash
node server.js
# → http://localhost:3001
```
- The local server reads `data.json` from your local clone — it's a snapshot, not the live data. Safe to mess with.
- For email-sending features to work locally, copy `.env` from the droplet: `scp golf:/root/volunteer-golf/.env .env` (then add `.env` to `.gitignore` if it isn't already).
- For demo content, append `?demo=true` (uses `demo-data.json`).

### 3. Commit and push
```bash
git add <files>
git commit -m "..."
git pull --rebase origin main   # in case cron committed data while you were working
git push origin main
```

### 4. Deploy
```bash
ssh golf "cd /root/volunteer-golf && ./deploy.sh"
```

`deploy.sh` does:
1. Snapshot live `data.json`, `demo-data.json`, `archives.json` to `/root/volunteer-golf-backups/pre-deploy-<timestamp>/`
2. Stop the running node process
3. `git pull --ff-only origin main`
4. Restore live data on top of the new code
5. `npm install` if `package.json` or `package-lock.json` changed
6. Start node, redirected to `/var/log/volunteer-golf.log`
7. Health-check `http://127.0.0.1:3001/api/health`
8. **Roll back** to the previous commit and restart if the health-check fails

If you see `OK — health check passed`, you're done. If you see `Rolled back to ...`, the site is back on the previous version and you have a snapshot dir noted in the output.

### 5. Smoke-test against demo data
After deploy, hit a domain with `?demo=true` to validate UX changes without touching real tournament data:
- https://colonialvolunteers.golf/?demo=true

## Common operations

```bash
# Tail live logs
ssh golf "tail -f /var/log/volunteer-golf.log"

# Tail backup cron log
ssh golf "tail /var/log/volunteer-golf-backup.log"

# Check the running process
ssh golf "ps aux | grep 'node /root/volunteer-golf' | grep -v grep"

# Manually restart node (if you need to and don't want a full deploy)
ssh golf "pkill -f 'node /root/volunteer-golf/server.js'; cd /root/volunteer-golf && nohup node server.js >> /var/log/volunteer-golf.log 2>&1 & disown"
```

## Known gotchas

- **`data.json` is in git.** The hourly cron auto-commits and pushes it. If you edit `data.json` locally and commit, you'll fight with the cron. Don't commit local `data.json` changes — they're for testing only.
- **No process supervisor.** If node crashes, the site is down until someone restarts it. (Future work: fix the disabled `volunteer-golf.service` systemd unit.)
- **`claude.md` history mentions pm2 and `/var/www/...`** — those are stale. The current setup is plain `node` at `/root/volunteer-golf`.

## Rollback by hand

If you ever need to roll back outside of `deploy.sh`:

```bash
ssh golf
cd /root/volunteer-golf
ls /root/volunteer-golf-backups/        # find a snapshot
pkill -f 'node /root/volunteer-golf/server.js'
git log --oneline -10                   # pick a known-good commit
git reset --hard <sha>
cp /root/volunteer-golf-backups/<snapshot>/* .
nohup node server.js >> /var/log/volunteer-golf.log 2>&1 & disown
sleep 3 && curl -fsS http://127.0.0.1:3001/api/health
```
