# Volunteer Golf - Tournament Volunteer Management System

## Overview
A web-based volunteer check-in and management system for golf tournaments. Built as a single-page application with Express.js backend.

## Tech Stack
- **Frontend**: Vanilla JavaScript SPA (single HTML file)
- **Backend**: Node.js/Express (server.js)
- **Data Storage**: JSON files (data.json, archives.json)
- **Email**: Resend API (from: hello@colonialvolunteers.golf)
- **Runtime**: Plain `node server.js` on port 3001 (no process manager — see DEVELOPMENT.md)

## Key Files (production paths on droplet)
- `/root/volunteer-golf/server.js` - Express server, API endpoints, email sending
- `/root/volunteer-golf/public/index.html` - Entire frontend SPA (~3700 lines)
- `/root/volunteer-golf/data.json` - Live tournament data
- `/root/volunteer-golf/archives.json` - Archived tournament data
- `/root/volunteer-golf/demo-data.json` - Demo dataset (used when `?demo=true`)
- `/root/volunteer-golf/backup.sh` - Hourly cron auto-commits data files to main

## Data Structure
```javascript
{
  volunteers: [{ id, name, type, hole, phone, email, yearsWorked, scheduled, assignedHoles?, customPin?, pairingPreferences?, noOutingPreference? }],
  checkIns: [{ volunteerId, volunteerName, hole, day, shift, checkedInBy, timestamp }],
  submissions: [{ hole, day, shift, timestamp, captainName, notes, checkedInIds }],
  settings: {
    adminPassword, viewAdminPassword?, tournamentName,
    tournamentStartDate, tournamentEndDate,
    helpName, helpPhone, helpEmail,
    amShiftCutoff, pmShiftCutoff, numberOfHoles
  }
}
```

## User Types & Access

### Admin Portal (full)
- Full access to all features
- Tabs: Overview, Check-ins, Edit Volunteers, Reports, Import, Settings

### Admin Portal (view-only)
- Uses `viewAdminPassword` setting
- Tabs: Overview, Check-ins, Volunteers (read-only), Reports
- Cannot edit volunteers, import data, or change settings

### Captain Portal
- Regular captains: Access their assigned hole only
- Chairman/Asst. Chairman: Access multiple holes via `assignedHoles` array
- Can check in volunteers, edit schedules, submit shift reports

### Volunteer Portal
- Any volunteer can log in with last 4 of phone
- View their schedule and check-in status
- Update their email address
- Submit pairing preferences for volunteer outing (3 choices)

## Volunteer Types
- **Volunteer** - Regular volunteer assigned to a hole
- **Captain** - Hole captain, can log into captain portal
- **Asst. Chairman** - Oversees multiple holes (uses assignedHoles field)
- **Chairman** - Oversees multiple holes (uses assignedHoles field)
- **Admin** - Full captain portal access to all holes
- **View Admin** - Read-only admin access to all data

## Key Features
- Shift-based check-ins (AM/PM shifts across tournament days)
- Captain PIN login (last 4 of phone or custom PIN)
- Schedule email notifications (HTML formatted)
- Reports: Volunteer Totals, Hole Roster, Custom Report Builder
- Tournament archives (save/restore year data)
- Shift cutoff times (prevent late check-in modifications)
- Print-friendly roster reports (landscape, 1 hole per page)

## Tournament Configuration
- Days: Monday-Sunday (configurable via tournament dates)
- Shifts: AM, PM
- Holes: Configurable (default 18)

## Common Commands (on droplet)
```bash
# Deploy code changes (preferred — does backup + restart + health-check + rollback):
ssh golf "cd /root/volunteer-golf && ./deploy.sh"

# View server logs:
ssh golf "tail -f /var/log/volunteer-golf.log"

# Manually check the running node process:
ssh golf "ps aux | grep 'node /root/volunteer-golf' | grep -v grep"

# Backup log (hourly data commits):
ssh golf "tail /var/log/volunteer-golf-backup.log"
```

See `DEVELOPMENT.md` for the safe edit workflow.

## API Endpoints
- `GET /api/data` - Load all data
- `POST /api/data` - Save all data
- `GET /api/archives` - Load archives
- `POST /api/archives` - Save archives
- `POST /api/email` - Send email (to, subject, message)
- `POST /api/hat-delivered` - Mark volunteer hat as delivered
- `GET /api/health` - Health check

## Recent Changes (Jan 2025)
- **PWA Support** - Installable on home screen (manifest.json, service worker, icons)
- **Hat Pickup Tracking** - QR code-scannable page for hat distribution (/hat-pickup.html)
- **Pull-to-Refresh** - Mobile swipe-down to refresh data
- **Session Persistence** - Auth state saved to localStorage (survives page refreshes)
- **Password Change Prompts** - Users prompted to set secure custom PINs
- **View Admin Type** - Read-only admin access for volunteers
- **QR Code Generation** - Admin can generate QR codes for hat pickup

## Changes (Dec 2024)
- Added multi-hole assignment for Chairman/Asst. Chairman types
- Added view-only admin access level
- Removed email alerts feature (unused)
- Reports: Volunteer Totals, Hole Roster, Custom Report Builder
- Captain roster prints 1 hole per landscape page
- Schedule emails with HTML grid layout
- Added Volunteer Portal (view schedule, update email, pairing preferences)
- Update Existing Volunteers CSV now supports any field (Email, Phone, Type, Hole, Years, PIN)
- Fixed PDF roster to single page
- Updated captain help modal with current features
