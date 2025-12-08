# Volunteer Golf Check-In System

## Project Overview
A web-based volunteer check-in system for golf tournaments. Hole Captains use their phones to check in volunteers at each hole, and administrators can monitor attendance in real-time.

**Live URL:** https://volunteer.golf (or configured domain)
**Server:** Digital Ocean droplet
**Process Manager:** PM2 (process name: `volunteer-golf`)

## Tech Stack
- **Frontend:** Vanilla JavaScript, single-page app in `public/index.html`
- **Backend:** Node.js with Express (`server.js`)
- **Database:** JSON file storage (`data.json`)
- **Email:** Nodemailer with Gmail SMTP

## File Structure
```
/var/www/volunteer-golf/
├── server.js           # Express server, API endpoints
├── public/
│   └── index.html      # Single-page app (all frontend code)
├── data.json           # Persistent data storage
├── package.json        # Dependencies
└── CLAUDE.md           # This file
```

## Key Features

### User Types (Volunteer Types)
1. **Volunteer** - Regular volunteers assigned to holes
2. **Captain** - Hole captains who check in volunteers
3. **Asst. Chairman** - Assistant chairmen (can also check in)
4. **Chairman** - Chairmen (can also check in)
5. **Admin** - Special type with access to ALL holes from captain login

### Captain Login Page
- Login with last 4 digits of phone number
- Captains see only their assigned hole
- **Admin type** sees a hole dropdown to switch between any hole (1-18)

### Captain Dashboard Features
- Day/shift selector (AM/PM for each tournament day)
- Volunteer list with:
  - Captains shown first (current user marked "You")
  - Scheduled volunteers
  - Unscheduled volunteers (separated by divider)
- **Auto-check-in:** Captain is automatically checked in on first load (before any submission)
- **"Checked in" tag:** Shows next to volunteers included in last submission
- **Dynamic submit button:**
  - First time: "Check In X Volunteers"
  - After submission, new check-ins: "Check In X Volunteers"
  - Removals only: "Update X Changes"
  - Both: "Check In X, Update Y"
  - No changes: "No Changes"
- **Last submitted time:** Shows after first submission (nothing shown before)
- Search bar to find volunteers by name

### Admin Dashboard Tabs
1. **Overview** - Real-time hole status grid showing:
   - Holes submitted count (removed confusing volunteer % stat)
   - Per-hole check-in status with volunteer counts
2. **Check-ins** - Detailed check-in records with filters (has its own filters, no duplicate "Viewing" selector)
3. **Edit Volunteers** - Manage volunteer data:
   - **"+ Add Volunteer" button** to add individuals
   - Edit existing volunteers (click row)
   - Filter by type (including Admin) and hole
   - Delete volunteers
4. **Settings** - Tournament configuration:
   - Tournament name and dates
   - Admin password (case-insensitive login)
   - **Contact information** with Name, Phone, and Email fields
   - Gmail SMTP settings for alerts
   - Data management (import/export, clear data)

## Important Code Locations

### State Variables (in index.html)
- `appData` - Main data object (volunteers, checkIns, submissions, settings)
- `captainAuth` - Current captain login info (`{ name, hole, phone4, isAdmin }`)
- `adminSelectedHole` - Selected hole for Admin users (1-18)
- `selectedDay`, `selectedShift` - Current day/shift selection
- `editingVolunteer` - Volunteer being edited (null or object with `isNew` flag)

### Key Functions
- `renderCaptainDashboard()` - Captain check-in page (~line 1675)
- `toggleCheckIn(volunteerId)` - Check/uncheck a volunteer (~line 2208)
- `confirmSubmission()` - Submit check-ins (~line 2406)
- `renderVolunteersEdit()` - Edit volunteers tab (~line 1350)
- `addNewVolunteer()` - Create new volunteer (~line 1493)
- `saveVolunteerEdit()` - Save new/edited volunteer (~line 1516)

### API Endpoints (server.js)
- `GET /api/data` - Fetch all data
- `POST /api/data` - Save all data
- `GET /api/archives` - Get tournament archives
- `POST /api/archives` - Save archives
- `POST /api/email` - Send email alerts

## Recent Changes (December 2024)

### Admin Features
- Added "Admin" volunteer type with access to all holes
- Admin users see hole dropdown selector in captain view
- Admin filter added to Edit Volunteers tab

### Captain Dashboard
- Captains now appear in volunteer list (auto-checked on first load)
- "You" tag shows next to current captain's name
- "Checked in" tag only shows for volunteers in last submission
- Dynamic button text based on action type
- Section dividers: Captains → Volunteers → Not Scheduled

### Admin Dashboard
- Removed confusing "X/Y volunteers (Z%)" from Overview header
- Only shows "X/18 holes submitted" now
- Removed duplicate "Viewing:" filter from Check-ins tab
- Admin password is now case-insensitive
- Added "Contact Name" field in Settings
- Added "+ Add Volunteer" button to Edit Volunteers tab

## Deployment Commands
```bash
# Restart the app after changes
pm2 restart volunteer-golf

# View logs
pm2 logs volunteer-golf

# Check status
pm2 list
```

## Data Structure

### appData.volunteers[]
```javascript
{
  id: "string",
  name: "Last, First",
  type: "Volunteer|Captain|Asst. Chairman|Chairman|Admin",
  hole: 1-18 (or 99 for Admin),
  phone: "5551234567",
  yearsWorked: 0,
  scheduled: { "Monday AM": true, "Monday PM": true, ... }
}
```

### appData.checkIns[]
```javascript
{
  volunteerId: "string",
  volunteerName: "Last, First",
  hole: 1-18,
  day: "Monday",
  shift: "AM|PM",
  timestamp: "ISO date string",
  checkedInBy: "Captain Name",
  isAlternate: boolean
}
```

### appData.submissions[]
```javascript
{
  hole: 1-18,
  day: "Monday",
  shift: "AM|PM",
  timestamp: "ISO date string",
  captainName: "Captain Name",
  notes: "optional notes",
  checkedInIds: ["volunteerId1", "volunteerId2", ...]
}
```

### appData.settings
```javascript
{
  tournamentName: "Tournament Name",
  tournamentDates: "Date range string",
  adminPassword: "password",
  helpName: "Contact Name",
  helpPhone: "5551234567",
  helpEmail: "email@example.com",
  gmailUser: "sender@gmail.com",
  gmailAppPassword: "app-password",
  alertEmails: ["recipient@example.com"],
  alertTimes: [{ day: "Monday", shift: "AM", time: "09:00" }]
}
```
