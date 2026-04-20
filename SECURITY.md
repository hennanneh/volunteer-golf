# Security & Operations Runbook

This document covers what happened during the 2026-04-10 incident, what defenses
are in place now, how to recover from disasters, and the plan to harden the app
before the next tournament. Read this before making changes to authentication,
backups, or write endpoints.

---

## Quick reference (start here in an emergency)

| You need to... | Run this |
|---|---|
| Restart the app | `npx pm2 restart volunteer-golf` (or use full path below) |
| View live server logs | `npx pm2 logs volunteer-golf` |
| Check server health | `curl -s http://127.0.0.1:3001/api/health` |
| See who's been writing to the API today | `grep 'POST /api/data' /var/log/nginx/access.log \| grep "$(date +%d/%b/%Y)"` |
| Restore data.json from the last hourly backup | `git show $(git log --oneline -- data.json \| awk 'NR==2 {print $1}'):data.json > data.json && npx pm2 restart volunteer-golf` |
| Restore the entire site from the off-disk tarball | See "Restoring from tarball backup" below |
| Block an attacker IP | Edit `/etc/nginx/sites-enabled/volunteer-golf`, add `deny <ip>;` inside `location /`, then `nginx -t && systemctl reload nginx` |

**PM2 binary path** (it's not in `$PATH` because PM2 was installed via `npx`):
```
/root/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2
```
You can symlink it for convenience:
```
ln -s /root/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2 /usr/local/bin/pm2
```

---

## Important file locations

| File | Purpose |
|---|---|
| `/root/volunteer-golf/server.js` | Express server, API routes |
| `/root/volunteer-golf/public/index.html` | Entire frontend SPA (~7000 lines) |
| `/root/volunteer-golf/public/sw.js` | Service worker (PWA cache) |
| `/root/volunteer-golf/data.json` | Live tournament data (volunteers, check-ins, settings, activity log) |
| `/root/volunteer-golf/archives.json` | Archived past tournaments |
| `/root/volunteer-golf/demo-data.json` | Demo mode data, reset hourly |
| `/root/volunteer-golf/.env` | Resend API key + other secrets (chmod 600 — NEVER commit) |
| `/root/volunteer-golf/backup.sh` | Hourly cron-driven git auto-backup |
| `/etc/nginx/sites-enabled/volunteer-golf` | nginx vhost (TLS, proxy to :3001, IP blocks) |
| `/etc/systemd/system/volunteer-golf.service` | Systemd unit (DISABLED — PM2 manages the process; do not re-enable, it conflicts) |
| `/root/.pm2/logs/volunteer-golf-out.log` | PM2 stdout log |
| `/root/.pm2/logs/volunteer-golf-error.log` | PM2 stderr log |
| `/var/log/nginx/access.log` | Per-request access log (rotated daily) |
| `/root/volunteer-golf-backups/` | Off-project tarball backups (created manually before risky changes) |

---

## The 2026-04-10 incident

### What happened
- **2026-04-10 14:00 UTC** — last good auto-backup; `data.json` was 200 KB, 335 volunteers
- **2026-04-10 14:55 UTC** — IP `104.253.134.30` (a vulnerability scanner) sent 800 POST requests to `/api/data` in ~90 seconds
- The server, having no authentication on write endpoints and no input validation, accepted every one and saved them
- At least one of the requests had an empty body (`{}`), and the server wrote `{}` to `data.json`, wiping all 335 volunteers, all check-ins, and the activity log
- **2026-04-10 15:00 UTC** — the hourly auto-backup ran and committed the wiped state to git
- **2026-04-10 ~15:25 UTC** — incident discovered; data restored from the 14:00 git commit (`10d95de`)

### Root cause
The fundamental issue was **no server-side authentication on any write endpoint**. The login UI checked passwords in JavaScript in the browser (`index.html` `attachEventListeners`), and the server trusted any HTTP POST. Anyone on the internet could call `POST /api/data` and overwrite the entire dataset.

### Attacker IP (now blocked at nginx)
- `104.253.134.30` — datacenter IP, NOT one of the legitimate residential/mobile ISP IPs your real users come from
- User-agent strings included SQL injection probes like `(select 198766*667891 from DUAL)` and `@@ALg2Q`
- Referrer was a fake `https://www.google.com/search?hl=en&q=testing`

---

## Defenses in place after the incident

These mitigations were applied on 2026-04-10. They are **bandaids that block the specific attack pattern**, not a substitute for real authentication. Real auth is in Phase 1.1 of the security plan below.

### Server-side
1. **Atomic file writes** in `saveData()` and `saveArchives()` (write to `.tmp`, then `rename` — POSIX atomic). Crash mid-write can no longer leave `data.json` half-written.
2. **Mutex on `POST /api/data`** via the existing `withDataLock` helper. Two concurrent admin saves can no longer clobber each other.
3. **Check-ins now use the atomic `/api/checkin` endpoint** instead of POSTing the entire dataset through `/api/data`. The server already had this lighter, locked endpoint — the client was just bypassing it. Includes idempotent inserts and hole-aware removal.
4. **Input validation on `POST /api/data`**: rejects payloads that aren't objects, are missing the `volunteers` array, or are missing the `settings` object.
5. **Catastrophic-shrink guard on `POST /api/data`**: refuses saves that would drop the volunteer count by more than half from the on-disk state. Override with `?force=true` for intentional resets.
6. **Same protections on `POST /api/archives`**.
7. **Server-side write logging**: every `POST /api/data` and `POST /api/archives` writes a timestamped, IP-tagged line to PM2 logs. Every rejection logs the reason. Search with `npx pm2 logs volunteer-golf | grep REJECTED`.

### Client-side
8. **Login form no longer wipes mid-keystroke**. The `dataUpdated` socket handler now skips `render()` when (a) the user is on a login/landing screen, or (b) any text input has focus. Background broadcasts no longer destroy in-progress form input.
9. **Activity log capped at 200 entries** (was 1000) to keep broadcast payload size reasonable.
10. **Service worker cache version bumped to `v2`** so the new HTML reaches users on first load instead of being cached.

### Edge / network
11. **`104.253.134.30` blocked at nginx** (`/etc/nginx/sites-enabled/volunteer-golf`, `deny` directive inside `location /`).

---

## Recovery procedures

### Recovery 1: data.json got wiped or corrupted
This is the scenario from 2026-04-10. The hourly backup script commits `data.json` to git every hour, so there's almost always a recent snapshot.

```bash
cd /root/volunteer-golf

# 1. See the recent backup commits
git log --oneline -10 -- data.json

# 2. Pick a commit that has the data you want and check its size to confirm
for c in $(git log --oneline -10 -- data.json | awk '{print $1}'); do
  echo -n "$c "; git show $c:data.json | wc -c
done

# 3. Stop PM2 so no in-flight save can clobber the restore
PM2=/root/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2
$PM2 stop volunteer-golf

# 4. Snapshot the current (broken) file just in case
cp data.json data.json.before-restore-$(date +%s)

# 5. Restore the chosen commit
git show <commit-hash>:data.json > data.json

# 6. Verify it parses and looks right
node -e "const d=require('./data.json'); console.log('volunteers:',d.volunteers?.length,'checkIns:',d.checkIns?.length);"

# 7. Restart
$PM2 start volunteer-golf
curl -s http://127.0.0.1:3001/api/health
```

**Tell active users to hard-refresh** (Ctrl+Shift+R / Cmd+Shift+R) afterward, or their stale in-memory state could overwrite the restore on their next save.

### Recovery 2: Restoring the entire site from a tarball backup
Off-project tarball backups live in `/root/volunteer-golf-backups/`. These are created manually before risky changes (like before each phase of the security plan).

```bash
PM2=/root/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2

# 1. Stop PM2
$PM2 stop volunteer-golf

# 2. Extract to a staging dir
mkdir -p /tmp/restore && tar -xzf /root/volunteer-golf-backups/<backup-file>.tar.gz -C /tmp/restore

# 3. Read the included RESTORE.md inside the tarball for context, then:
rsync -a --delete /tmp/restore/project/ /root/volunteer-golf/

# Optional: also restore system config
cp /tmp/restore/system/nginx-volunteer-golf.conf /etc/nginx/sites-enabled/volunteer-golf
cp /tmp/restore/system/volunteer-golf.service /etc/systemd/system/volunteer-golf.service
nginx -t && systemctl reload nginx

# 4. Reinstall deps (node_modules is excluded from backups)
cd /root/volunteer-golf && npm install

# 5. Start
$PM2 start volunteer-golf
curl -s http://127.0.0.1:3001/api/health
```

### Recovery 3: PM2 process won't start
1. Check the error: `npx pm2 logs volunteer-golf --lines 50`
2. If port 3001 is in use, find what owns it: `ss -ltnp | grep :3001`. Common cause: a leftover manual `node server.js` invocation, or the disabled `volunteer-golf.service` systemd unit accidentally re-enabled. Kill the squatter, then `npx pm2 restart volunteer-golf`.
3. If `data.json` is corrupt or unparseable, follow Recovery 1 to restore from git.
4. If the issue is unclear, restore from the latest off-disk tarball (Recovery 2).

### Recovery 4: nginx config broken
1. `nginx -t` will tell you the syntax error
2. Restore from the tarball backup: `cp /tmp/restore/system/nginx-volunteer-golf.conf /etc/nginx/sites-enabled/volunteer-golf`
3. `nginx -t && systemctl reload nginx`

---

## Backup inventory

### Automated
- **Hourly git auto-backup** via `backup.sh` (cron). Commits `data.json`, `demo-data.json`, `archives.json` to the `main` branch and pushes to GitHub. Only commits when files change.
  - Look at: `git log --oneline -- data.json`
  - Recovery window: ~24 commits per day, kept indefinitely in git history

### Manual / pre-change
- **Off-project tarballs** in `/root/volunteer-golf-backups/`
  - Created by hand before risky changes (e.g. each security plan phase)
  - Contain: project source (no `node_modules`), `data.json`, `archives.json`, `.env`, nginx vhost config, systemd unit, PM2 dump, `RESTORE.md`
  - Naming: `pre-<reason>-YYYYMMDD-HHMMSS.tar.gz`

### What is NOT backed up automatically (be aware)
- nginx config (`/etc/nginx/sites-enabled/volunteer-golf`) — only in tarball backups
- The `.env` file with the Resend API key — only in tarball backups (and never in git)
- PM2 process state — only in tarball backups (`/root/.pm2/dump.pm2`)
- Server logs (`/root/.pm2/logs/*`) — not backed up; rotated by PM2
- nginx access logs — rotated daily by logrotate, kept ~14 days

---

## Security plan (phased, 6-week timeline)

### Phase 1 — Foundations (Week 1, in progress)

#### 1.1 Server-side authentication
**The fix for the actual root cause.** A `POST /api/login` endpoint validates the password server-side, issues a session token in an httpOnly secure cookie, and stores the session in memory. A `requireAuth(roles)` middleware protects every write endpoint and checks role.

- Sessions stored in memory (not on disk). Acceptable trade-off because PM2 restarts are infrequent post-deploy. If desired, can be persisted to a JSON file later.
- 12-hour idle session timeout, auto-cleanup
- Roles: `admin`, `viewAdmin`, `chair`, `asstChair`, `captain`, `volunteer`
- Login fallback during initial rollout: if cookie check fails, the server logs a warning but still allows the write (one-day grace period). Removed once everyone has logged in successfully.

#### 1.2 Stop returning passwords from `/api/data`
Strip `adminPassword`, `volunteerPassword`, `adminPasswordSetAt`, `customPin` from the JSON sent to clients. The server checks them locally; the browser doesn't need them.

**Note:** Right now, anyone hitting `/api/data` can read every admin password in plaintext. This is the second-biggest security issue after the missing auth.

#### 1.3 Bcrypt password hashing
Replace plaintext password storage with bcrypt hashes. Transparent migration: each user's first login after the rollout re-hashes their existing plaintext password.

#### 1.4 Rate limiting on write endpoints
Add `express-rate-limit`. Per-IP limits:
- `/api/data`: 60/min
- `/api/email`: 5/min
- `/api/checkin`: 200/min (check-in rush)
- `/api/login`: 10/min (block password-guessing)

#### 1.5 nginx edge filters
Reject requests at the nginx layer for:
- Empty bodies POSTing to write endpoints
- User-agents containing obvious attack strings (`select`, `union`, `<script`)

### Phase 2 — Hardening (Week 2)

- **2.1** Audit log moved out of `data.json` into its own append-only file (so it survives wipes)
- **2.2** CSRF tokens for state-changing requests
- **2.3** Security headers via `helmet` middleware
- **2.4** Verify `.env` file permissions (`chmod 600`), `.gitignore` audit, confirm `.env` is not in git history (rotate Resend API key if it ever was)
- **2.5** 15-minute incremental backups stored outside the project directory
- **2.6** One-command restore script (`./restore-data.sh <commit-or-snapshot>`)

### Phase 3 — Operational maturity (Weeks 3-4)

- **3.1** Custom security audit script (`./scripts/security-audit.sh`): runs `npm audit`, greps for hardcoded secrets, lists unauthenticated routes, checks file permissions, outputs markdown report
- **3.2** PreToolUse Claude Code hook protecting `.env*`, auth section of `server.js`, nginx config from accidental edits
- **3.3** `fail2ban` on nginx logs to auto-ban repeat scanners
- **3.4** Document `/api/*` endpoints, their auth requirements, and request/response shapes

### Phase 4 — Ongoing posture (Weeks 5-6 + permanent)

- **4.1** XSS sweep through the SPA — find every `innerHTML` of user-controlled content, sanitize
- **4.2** Enable `unattended-upgrades` for Ubuntu security patches
- **4.3** Verify SSH is key-only, `ufw` firewall is on (only 22, 80, 443)
- **4.4** Quarterly recovery drill checklist
- **4.5** Monthly `npm audit` check
- **4.6** Light monitoring: daily cron emails counts of write attempts, rejections, login failures

### Things deliberately NOT in the plan
- **Cloudflare WAF** for security alone (free, fine to add later as defense in depth, but not a substitute for fixing the app)
- **2FA on admin accounts** — overkill for 3 admins on a tournament app
- **Switching to a real database** — not a security improvement, just a refactor
- **Encrypting `data.json` at rest** — theater, doesn't help when the key lives on the same box
- **Custom security tooling** — every line of bespoke security code is a chance for a new bug; prefer well-known libraries (`bcrypt`, `helmet`, `csurf`, `express-rate-limit`, `fail2ban`)

---

## Operational notes for future Claude sessions

If you are a Claude Code session working on this project, please read this whole file before making changes. Key things to know:

1. **PM2 manages the process**, not systemd. The `volunteer-golf.service` systemd unit exists but is disabled — do not re-enable it; it will conflict with PM2 and cause `EADDRINUSE` restart loops. Use `npx pm2 restart volunteer-golf`.
2. **The PM2 binary is not in `$PATH`** — full path is `/root/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2`.
3. **`server.js` must not be edited** without understanding the auth model in `requireAuth()` and the data validation in `POST /api/data`. Both exist for incident-response reasons (see this file).
4. **`backup.sh` runs hourly via cron** and pushes data files to GitHub. Don't disable it.
5. **The `.env` file has the Resend API key**. Never commit it. Never `cat` it into a tool result that ends up in chat history.
6. **Don't introduce new write endpoints without `requireAuth`** (once Phase 1.1 ships). Existing endpoints follow the pattern in `server.js` — copy that pattern.
7. **Don't ship secrets to the client**. If you find yourself adding a field to a `/api/data` response, ask yourself whether it needs to go to the browser.
8. **Tarball backups go in `/root/volunteer-golf-backups/`**, not in the project directory. Don't commit them.

---

## Change log

| Date | Change | Commit |
|---|---|---|
| 2026-04-10 | Incident response: data restored, server-side mitigations applied (atomic writes, mutex, /api/checkin route, validation, shrink guard, IP block) | `a804488` |
| 2026-04-10 | This SECURITY.md added | `8ab586a` |
| 2026-04-10 | Phase 1.1: server-side session auth, /api/login, /api/logout, /api/whoami, requireAuth middleware on every write endpoint. STRICT_AUTH=false during rollout | `0f5f07b` |
| 2026-04-10 | Phase 1.2: strip password fields from GET /api/data and socket broadcasts | `369f87f` |
| 2026-04-10 | Phase 1.4: per-IP rate limiting via express-rate-limit (login 10/min, data 60/min, checkin 200/min, email 5/min) | `3dfdb09` |
| 2026-04-10 | Phase 1.3: bcryptjs password hashing with transparent migration on first login | `8f88ed0` |
| 2026-04-10 | Phase 1.2/1.3 followup: POST /api/data merges passwords from disk (server-owned), new POST /api/set-password endpoint | `c8f2e58` |
| 2026-04-10 | Phase 1 SPA: 3 login forms → /api/login, 3 password-change modals → /api/set-password, /api/whoami on page load, /api/logout on logout, hasAdminPassword/hasVolunteerPassword flags, sw.js bumped to v3 | `dbc3072` |
| 2026-04-10 | Phase 1.5: nginx UA-attack-string filter (select, union, &lt;script, @@ALg, drop table, information_schema). Backup at /root/volunteer-golf-backups/nginx-volunteer-golf.before-1.5.1775841897.conf | (nginx config, not in git) |
| 2026-04-10 | "Software updated, tap to refresh" banner via service worker; sw.js bumped to v4 | `c0d7179` |
| 2026-04-15 | Phone-default login loosened to accept formatted phone numbers. Forgot-password flow: POST /api/request-password-reset + POST /api/reset-password, emailed link via Resend, 30-min single-use in-memory tokens, rate-limited (5/min request, 10/min submit). "Forgot password?" link on all 3 login forms; sw.js bumped to v8. | (pending) |
