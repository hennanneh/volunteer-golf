require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Resend } = require('resend');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['https://colonialvolunteers.golf', 'http://localhost:3001'];
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS }
});

const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Demo mode middleware
app.use((req, res, next) => {
  if (req.query.demo === 'true') {
    res.cookie('demoMode', 'true', { maxAge: 24 * 60 * 60 * 1000, httpOnly: false });
    req.demoMode = true;
  } else if (req.query.demo === 'false') {
    res.clearCookie('demoMode');
    req.demoMode = false;
  } else {
    req.demoMode = req.cookies.demoMode === 'true';
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');
const DEMO_DATA_FILE = path.join(__dirname, 'demo-data.json');
const DEMO_TEMPLATE_FILE = path.join(__dirname, 'demo-data-template.json');
const ARCHIVES_FILE = path.join(__dirname, 'archives.json');

const defaultData = {
  volunteers: [],
  checkIns: [],
  submissions: [],
  settings: {
    tournamentName: 'Golf Tournament 2025'
  }
};

function getDataFile(isDemo) {
  return isDemo ? DEMO_DATA_FILE : DATA_FILE;
}

function loadData(isDemo = false) {
  const dataFile = getDataFile(isDemo);
  try {
    if (fs.existsSync(dataFile)) {
      const raw = fs.readFileSync(dataFile, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error loading data:', err.message);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

function saveData(data, isDemo = false) {
  const dataFile = getDataFile(isDemo);
  try {
    // Atomic write: write to temp file then rename. POSIX rename is atomic,
    // so a crash mid-write can never leave data.json half-written.
    const tmpFile = dataFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, dataFile);
    return true;
  } catch (err) {
    console.error('Error saving data:', err.message);
    return false;
  }
}

// Mutex for read-modify-write operations to prevent race conditions
const dataLocks = { live: Promise.resolve(), demo: Promise.resolve() };
function withDataLock(isDemo, fn) {
  const key = isDemo ? 'demo' : 'live';
  const prev = dataLocks[key];
  let resolve;
  dataLocks[key] = new Promise(r => { resolve = r; });
  return prev.then(() => fn()).finally(resolve);
}

// ============================================================================
// Concurrent-save merge (added 2026-05-11 after captains reported schedule
// edits silently overwriting each other and a deleted volunteer reappearing).
//
// The SPA POSTs the entire appData on every save. With multiple captains
// editing at once, a stale client's blob silently overwrote fresh writes
// from other clients (last-write-wins). Same mechanism resurrected deleted
// volunteers when a stale client's blob still contained them.
//
// New behavior when the client sends `dataReadAt` (epoch ms of last GET or
// broadcastUpdate): we merge per-volunteer-id instead of replacing the array.
// - Each volunteer carries server-managed `lastModified` (epoch ms).
// - If existing.lastModified > dataReadAt, the client's view of that record
//   is stale; we keep existing.
// - Otherwise we accept the client's version and stamp lastModified=now.
// - Explicit deletes ride in `deletedIds`; we record tombstones in
//   data.deletedVolunteerIds so stale clients can't resurrect deleted ids.
// - checkIns and submissions are owned by their dedicated endpoints and are
//   preserved from disk to prevent bulk-save clobber.
// - activityLog is merged by entry id (dedupe), sorted desc, trimmed to 200.
//
// Legacy clients (no dataReadAt) still fall through to a full-replace path,
// but tombstone-aware: any incoming volunteer matching a recent tombstone
// is dropped. This protects deletes during the rollout window before all
// browsers have refreshed the SPA (sw.js CACHE_NAME bump).
// ============================================================================
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function pruneTombstones(tombstones, now) {
  const cutoff = now - TOMBSTONE_TTL_MS;
  return (tombstones || []).filter(t => t && t.deletedAt > cutoff);
}

function mergeVolunteerSave(existing, incoming, deletedIds, dataReadAt) {
  const now = Date.now();
  const tombList = pruneTombstones(existing.deletedVolunteerIds, now);
  const tombMap = new Map(tombList.map(t => [String(t.id), t.deletedAt]));

  for (const rawId of (deletedIds || [])) {
    tombMap.set(String(rawId), now);
  }

  const existingById = new Map((existing.volunteers || []).map(v => [String(v.id), v]));
  const incomingById = new Map((incoming.volunteers || []).map(v => [String(v.id), v]));

  const merged = [];
  const handled = new Set();

  for (const [id, existV] of existingById) {
    if (tombMap.has(id)) continue;  // explicitly deleted
    handled.add(id);
    const incV = incomingById.get(id);
    if (!incV) {
      // Client didn't send this id (stale view or filtered) — keep existing.
      merged.push(existV);
      continue;
    }
    const exMod = Number(existV.lastModified) || 0;
    if (exMod > dataReadAt) {
      // Someone else edited this record after the client's last read.
      // Reject the client's stale version of this record.
      merged.push(existV);
    } else {
      merged.push(Object.assign({}, incV, { lastModified: now }));
    }
  }

  for (const [id, incV] of incomingById) {
    if (handled.has(id)) continue;
    if (tombMap.has(id)) {
      const tombAt = tombMap.get(id);
      if (tombAt > dataReadAt) continue;  // deleted after client's read — don't resurrect
      tombMap.delete(id);  // older tombstone; client may be intentionally re-adding
    }
    merged.push(Object.assign({}, incV, { lastModified: now }));
  }

  const finalTombstones = Array.from(tombMap.entries()).map(([id, deletedAt]) => ({ id, deletedAt }));

  // ActivityLog: merge by id, sort desc by timestamp, trim to 200.
  const logById = new Map();
  for (const e of (existing.activityLog || [])) if (e && e.id) logById.set(String(e.id), e);
  for (const e of (incoming.activityLog || [])) if (e && e.id && !logById.has(String(e.id))) logById.set(String(e.id), e);
  const mergedLog = Array.from(logById.values())
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, 200);

  return Object.assign({}, existing, incoming, {
    volunteers: merged,
    deletedVolunteerIds: finalTombstones,
    activityLog: mergedLog,
    // Owned by per-action endpoints — preserve from disk to prevent bulk-save clobber.
    checkIns: existing.checkIns || [],
    submissions: existing.submissions || [],
  });
}

// Legacy full-replace path: also drop volunteers that match a recent tombstone,
// so a stale browser that hasn't picked up the new SPA can't resurrect deletes.
function applyTombstonesToLegacyData(existing, incoming) {
  const now = Date.now();
  const tombList = pruneTombstones(existing.deletedVolunteerIds, now);
  if (!tombList.length) return Object.assign({}, incoming, { deletedVolunteerIds: tombList });
  const tombIds = new Set(tombList.map(t => String(t.id)));
  const filtered = (incoming.volunteers || []).filter(v => !tombIds.has(String(v.id)));
  return Object.assign({}, incoming, {
    volunteers: filtered,
    deletedVolunteerIds: tombList,
  });
}

function loadArchives() {
  try {
    if (fs.existsSync(ARCHIVES_FILE)) {
      const raw = fs.readFileSync(ARCHIVES_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error loading archives:', err.message);
  }
  return [];
}

function saveArchives(archives) {
  try {
    const tmpFile = ARCHIVES_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(archives, null, 2));
    fs.renameSync(tmpFile, ARCHIVES_FILE);
    return true;
  } catch (err) {
    console.error('Error saving archives:', err.message);
    return false;
  }
}

function resetDemoData() {
  try {
    if (fs.existsSync(DEMO_TEMPLATE_FILE)) {
      const template = fs.readFileSync(DEMO_TEMPLATE_FILE, 'utf8');
      fs.writeFileSync(DEMO_DATA_FILE, template);
      console.log('Demo data reset at', new Date().toISOString());
      io.to('demo').emit('demoReset');
      return true;
    }
  } catch (err) {
    console.error('Error resetting demo data:', err.message);
  }
  return false;
}

setInterval(resetDemoData, 60 * 60 * 1000);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('joinRoom', (room) => {
    socket.join(room);
    console.log(socket.id, 'joined room:', room);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Broadcast data update to OTHER clients (exclude sender)
function broadcastUpdate(isDemo, changeType, changeData, excludeSocketId) {
  const room = isDemo ? 'demo' : 'live';
  const payload = { 
    type: changeType,
    data: changeData,
    timestamp: new Date().toISOString()
  };
  
  if (excludeSocketId) {
    // Broadcast to room except the sender
    io.to(room).except(excludeSocketId).emit('dataUpdated', payload);
  } else {
    io.to(room).emit('dataUpdated', payload);
  }
}

app.get('/api/demo-status', (req, res) => {
  res.json({ 
    demoMode: req.demoMode,
    message: req.demoMode ? 'You are in demo mode. Data resets hourly.' : null
  });
});

app.post('/api/demo-exit', (req, res) => {
  res.clearCookie('demoMode');
  res.json({ success: true });
});

// Superadmin account - always guaranteed access even if not in volunteer list
const SUPERADMIN = {
  email: 'annehowrey@yahoo.com',
  name: 'Howrey, Anne',
  type: 'Admin',
  phone: '',
  hole: '',
  yearsWorked: '',
  scheduled: {}
};

// ============================================================================
// Secret stripping (Phase 1.2, added 2026-04-10 — see SECURITY.md)
//
// Volunteer records on disk carry password fields. The browser must never
// see them — the server checks passwords locally in checkPassword(). Apply
// stripVolunteerSecrets at every boundary where a volunteer record leaves
// the server: GET /api/data, the fullUpdate socket broadcast, and the
// hatDelivered broadcast.
// ============================================================================

const VOLUNTEER_SECRET_FIELDS = [
  'adminPassword',
  'volunteerPassword',
  'adminPasswordSetAt',
  'customPin'
];

function stripVolunteerSecrets(volunteer) {
  if (!volunteer || typeof volunteer !== 'object') return volunteer;
  const cleaned = { ...volunteer };
  // Surface metadata BEFORE deleting the source fields. The flags let the
  // SPA render "custom password set" vs "using default" without ever seeing
  // the password itself. Knowing whether a custom password exists is low-
  // value info compared to leaking the password.
  cleaned.hasAdminPassword = !!volunteer.adminPassword;
  cleaned.hasVolunteerPassword = !!volunteer.volunteerPassword;
  for (const field of VOLUNTEER_SECRET_FIELDS) delete cleaned[field];
  return cleaned;
}

// Returns a shallow clone of `data` with each volunteer's secret fields
// removed. Does NOT mutate the input. Cheap because we only clone the
// volunteers array — checkIns/settings/activity log are passed by reference.
function stripDataSecrets(data) {
  if (!data || typeof data !== 'object') return data;
  if (!Array.isArray(data.volunteers)) return data;
  return {
    ...data,
    volunteers: data.volunteers.map(stripVolunteerSecrets)
  };
}

// ============================================================================
// Rate limiting (Phase 1.4, added 2026-04-10 — see SECURITY.md)
//
// Per-IP write-endpoint limits, applied BEFORE requireAuth so unauthenticated
// flooders eat 429s without going through password/session work. The keys are
// nginx-supplied X-Real-IP / X-Forwarded-For headers because the Express
// `req.ip` would otherwise resolve to 127.0.0.1 (the upstream proxy).
// ============================================================================

function clientIpFromReq(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';
}

function makeLimiter(max, label) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => clientIpFromReq(req),
    handler: (req, res) => {
      const ip = clientIpFromReq(req);
      console.warn('[' + new Date().toISOString() + '] RATE LIMITED ' + label + ' ' + req.method + ' ' + req.path + '  ip=' + ip);
      res.status(429).json({ success: false, error: 'Too many requests, please slow down and try again in a minute' });
    }
  });
}

const dataLimiter    = makeLimiter(60,  'data');     // POST /api/data        60/min
const checkinLimiter = makeLimiter(200, 'checkin');  // POST /api/checkin    200/min (rush)
const emailLimiter   = makeLimiter(5,   'email');    // POST /api/email        5/min
const loginLimiter   = makeLimiter(10,  'login');    // POST /api/login       10/min (block guessing)
const resetReqLimiter    = makeLimiter(5,  'reset-request'); // POST /api/request-password-reset
const resetSubmitLimiter = makeLimiter(10, 'reset-submit');  // POST /api/reset-password

// ============================================================================
// Authentication (Phase 1.1, added 2026-04-10 — see SECURITY.md)
//
// Server-side session-based auth. Sessions are stored in memory (Map),
// keyed by random tokens, set as httpOnly cookies. Each write endpoint is
// protected by requireAuth(allowedRoles).
//
// STRICT_AUTH controls rollout: while false, requests with no valid
// session log a warning but are still allowed through. Switch to true once
// all real users have logged in via the new flow at least once.
// ============================================================================

let STRICT_AUTH = false;  // Set to true after all users have logged in once

const sessions = new Map();  // token -> { userId, email, name, role, portal, createdAt, lastUsed }
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;       // 12 hours
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, sess] of sessions) {
    if (now - sess.lastUsed > SESSION_IDLE_MS) {
      sessions.delete(token);
      cleaned++;
    }
  }
  if (cleaned) console.log('[' + new Date().toISOString() + '] Cleaned ' + cleaned + ' expired sessions');
}, SESSION_CLEANUP_INTERVAL_MS);

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Map a volunteer record's `type` field to a normalized role string
function roleForVolunteer(v) {
  if (!v) return null;
  if (v.type === 'Admin') return 'admin';
  if (v.type === 'View Admin') return 'viewAdmin';
  if (v.type === 'Chairman') return 'chair';
  if (v.type === 'Asst. Chairman') return 'asstChair';
  if (v.type === 'Captain') return 'captain';
  return 'volunteer';
}

// Phase 1.3: bcrypt support with transparent migration.
//
// Stored passwords on disk are gradually upgraded from plaintext to bcrypt
// hashes the first time each user logs in successfully. Until that happens,
// the legacy plaintext path is still accepted. Hashes are recognizable by
// their $2a$/$2b$/$2y$ prefix.
const BCRYPT_ROUNDS = 10;

function looksLikeBcryptHash(s) {
  return typeof s === 'string' && /^\$2[aby]\$/.test(s);
}

// Compare a typed password against a stored value (plaintext OR bcrypt hash).
function comparePassword(typed, stored) {
  if (typeof typed !== 'string' || typeof stored !== 'string' || !stored) return false;
  if (looksLikeBcryptHash(stored)) {
    try { return bcrypt.compareSync(typed, stored); } catch (e) { return false; }
  }
  return typed === stored;
}

// Re-load the volunteer from disk under the lock, double-check the field
// is still plaintext and still matches the typed value (defends against a
// concurrent password change), then write back the bcrypt hash.
// Best-effort: failures only log. Skips the synthetic superadmin record.
function upgradePasswordToHash(volunteerId, fieldName, typed, isDemo) {
  if (!volunteerId || volunteerId === 'superadmin') return;
  withDataLock(isDemo, () => {
    try {
      const data = loadData(isDemo);
      if (!data.volunteers) return;
      const v = data.volunteers.find(x => x.id === volunteerId);
      if (!v) return;
      const current = v[fieldName];
      if (!current || looksLikeBcryptHash(current)) return; // already upgraded
      if (current !== typed) return; // changed under us — leave alone
      v[fieldName] = bcrypt.hashSync(typed, BCRYPT_ROUNDS);
      if (saveData(data, isDemo)) {
        console.log('[' + new Date().toISOString() + '] BCRYPT UPGRADE  user=' + (v.name || volunteerId) + '  field=' + fieldName);
      }
    } catch (e) {
      console.warn('[' + new Date().toISOString() + '] BCRYPT UPGRADE FAILED  user=' + volunteerId + '  err=' + e.message);
    }
  }).catch(() => { /* lock chain already logged */ });
}

// Validate the password for a volunteer in a given portal context.
// Returns { ok, upgradeField, usingDefault } where:
//   upgradeField — set when authentication used a still-plaintext stored
//                  value; the caller should fire-and-forget the bcrypt upgrade
//   usingDefault — true when there was no stored password and the user
//                  authenticated against the legacy fallback ('admin2025'
//                  or phone digits). The SPA uses this to prompt the user
//                  to set a real password on first login.
// Users frequently paste their phone with formatting like "(817) 733-3743".
// For the phone-default fallback only, strip non-digits from the typed value
// before comparing. (Custom passwords are still compared byte-for-byte.)
function typedMatchesPhoneDefault(typed, phoneDigits) {
  if (!phoneDigits || phoneDigits.length < 10) return false;
  const typedDigits = String(typed || '').replace(/\D/g, '').slice(-10);
  return typedDigits.length === 10 && typedDigits === phoneDigits;
}

function checkPassword(volunteer, portal, password) {
  const fail = { ok: false, upgradeField: null, usingDefault: false };
  if (!volunteer || !password) return fail;
  const phoneDigits = (volunteer.phone || '').replace(/\D/g, '').slice(-10);

  if (portal === 'admin') {
    if (!['Admin', 'View Admin', 'Chairman', 'Asst. Chairman'].includes(volunteer.type)) return fail;
    const stored = volunteer.adminPassword;
    if (stored) {
      const ok = comparePassword(password, stored);
      return { ok, upgradeField: ok && !looksLikeBcryptHash(stored) ? 'adminPassword' : null, usingDefault: false };
    }
    // Fallback default — never gets bcrypt-upgraded because there's nothing on disk to upgrade.
    return { ok: password === 'admin2025', upgradeField: null, usingDefault: password === 'admin2025' };
  }
  if (portal === 'captain') {
    if (!['Captain', 'Chairman', 'Asst. Chairman', 'Admin'].includes(volunteer.type)) return fail;
    const stored = volunteer.volunteerPassword;
    if (stored) {
      const ok = comparePassword(password, stored);
      return { ok, upgradeField: ok && !looksLikeBcryptHash(stored) ? 'volunteerPassword' : null, usingDefault: false };
    }
    const okPhone = typedMatchesPhoneDefault(password, phoneDigits);
    return { ok: okPhone, upgradeField: null, usingDefault: okPhone };
  }
  if (portal === 'volunteer') {
    const stored = volunteer.volunteerPassword;
    if (stored) {
      const ok = comparePassword(password, stored);
      return { ok, upgradeField: ok && !looksLikeBcryptHash(stored) ? 'volunteerPassword' : null, usingDefault: false };
    }
    const okPhone = typedMatchesPhoneDefault(password, phoneDigits);
    return { ok: okPhone, upgradeField: null, usingDefault: okPhone };
  }
  return fail;
}

// Express middleware factory. allowedRoles is an array of role strings.
// Pass null to allow any authenticated user.
function requireAuth(allowedRoles) {
  return (req, res, next) => {
    const token = req.cookies && req.cookies.session;
    let session = null;
    if (token) {
      session = sessions.get(token);
      if (session) {
        if (Date.now() - session.lastUsed > SESSION_IDLE_MS) {
          sessions.delete(token);
          session = null;
        } else {
          session.lastUsed = Date.now();
        }
      }
    }

    if (session) {
      req.user = session;
      if (allowedRoles && !allowedRoles.includes(session.role)) {
        const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';
        console.warn('[' + new Date().toISOString() + '] AUTH FORBIDDEN ' + req.method + ' ' + req.path + '  user=' + session.name + '  role=' + session.role + '  needed=' + allowedRoles.join('|') + '  ip=' + ip);
        return res.status(403).json({ success: false, error: 'Forbidden: this action requires role ' + allowedRoles.join(' or ') });
      }
      return next();
    }

    // No valid session
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';
    if (STRICT_AUTH) {
      console.warn('[' + new Date().toISOString() + '] AUTH REJECTED ' + req.method + ' ' + req.path + '  ip=' + ip);
      return res.status(401).json({ success: false, error: 'Authentication required - please log in' });
    } else {
      // Fallback mode: log warning but allow through
      console.warn('[' + new Date().toISOString() + '] UNAUTH FALLBACK ALLOWED ' + req.method + ' ' + req.path + '  ip=' + ip + '  (would be rejected once STRICT_AUTH is enabled)');
      req.user = { role: 'unauthenticated', _fallback: true, name: 'unauth-' + ip, userId: null };
      return next();
    }
  };
}

// POST /api/login — verify password, issue session
app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password, portal } = req.body || {};
  const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';

  if (!email || !password || !portal) {
    return res.status(400).json({ success: false, error: 'email, password, and portal required' });
  }
  if (!['admin', 'captain', 'volunteer'].includes(portal)) {
    return res.status(400).json({ success: false, error: 'portal must be admin, captain, or volunteer' });
  }

  const data = loadData(req.demoMode);
  if (!data.volunteers) data.volunteers = [];

  // Ensure superadmin is always considered (even if not on disk)
  if (!data.volunteers.some(v => v.email && v.email.toLowerCase() === SUPERADMIN.email)) {
    data.volunteers.push({ id: 'superadmin', ...SUPERADMIN });
  }

  const emailLc = String(email).trim().toLowerCase();
  const volunteer = data.volunteers.find(v => v.email && v.email.toLowerCase() === emailLc);

  const authResult = volunteer ? checkPassword(volunteer, portal, password) : { ok: false, upgradeField: null };
  if (!authResult.ok) {
    console.warn('[' + new Date().toISOString() + '] LOGIN FAILED  email=' + emailLc + '  portal=' + portal + '  ip=' + ip);
    // Generic error to avoid leaking which emails exist
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }

  const role = roleForVolunteer(volunteer);
  const token = generateToken();
  sessions.set(token, {
    userId: volunteer.id,
    email: volunteer.email,
    name: volunteer.name,
    role: role,
    portal: portal,
    createdAt: Date.now(),
    lastUsed: Date.now()
  });

  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_IDLE_MS,
    path: '/'
  });

  console.log('[' + new Date().toISOString() + '] LOGIN OK  user=' + volunteer.name + '  role=' + role + '  portal=' + portal + '  ip=' + ip);
  res.json({
    success: true,
    user: {
      id: volunteer.id,
      name: volunteer.name,
      email: volunteer.email,
      role: role
    },
    // SPA prompts the user to set a real password when this is true.
    usingDefaultPassword: !!authResult.usingDefault
  });

  // Phase 1.3: fire-and-forget bcrypt upgrade for users still on plaintext.
  // Runs after the response is sent so the user never waits on hashing.
  if (authResult.upgradeField) {
    upgradePasswordToHash(volunteer.id, authResult.upgradeField, password, req.demoMode);
  }
});

// POST /api/logout — clear session
app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.session;
  if (token) {
    const sess = sessions.get(token);
    if (sess) {
      console.log('[' + new Date().toISOString() + '] LOGOUT  user=' + sess.name);
    }
    sessions.delete(token);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

// GET /api/whoami — return current session info or null
app.get('/api/whoami', (req, res) => {
  const token = req.cookies && req.cookies.session;
  if (!token) return res.json({ user: null });
  const session = sessions.get(token);
  if (!session || Date.now() - session.lastUsed > SESSION_IDLE_MS) {
    if (session) sessions.delete(token);
    return res.json({ user: null });
  }
  session.lastUsed = Date.now();
  res.json({
    user: {
      id: session.userId,
      name: session.name,
      email: session.email,
      role: session.role
    }
  });
});

// POST /api/set-password — set, change, or clear a stored password.
//
// Body: { volunteerId, field, currentPassword?, newPassword }
//   field         — 'admin' or 'volunteer' (maps to adminPassword/volunteerPassword)
//   newPassword   — non-empty string to set (will be bcrypt-hashed); empty
//                   string or null to CLEAR (so login falls back to default)
//   currentPassword — required when changing your OWN password; ignored when
//                   an admin is changing/clearing someone else's
//
// Authorization:
//   - Self change: any logged-in user can change their own password,
//     provided currentPassword validates against the stored value.
//   - Other-user change: only role=admin (full Admin) can do this. Used for
//     the SPA's "reset to default" and the new-admin auto-init flows.
app.post('/api/set-password', requireAuth(null), (req, res) => {
  const { volunteerId, field, currentPassword, newPassword } = req.body || {};
  const ip = clientIpFromReq(req);

  if (!volunteerId || !field) {
    return res.status(400).json({ success: false, error: 'volunteerId and field are required' });
  }
  if (field !== 'admin' && field !== 'volunteer') {
    return res.status(400).json({ success: false, error: "field must be 'admin' or 'volunteer'" });
  }
  const fieldName = field === 'admin' ? 'adminPassword' : 'volunteerPassword';

  // Optional length floor for non-empty passwords (clears are always OK)
  if (newPassword && typeof newPassword === 'string' && newPassword.length > 0 && newPassword.length < 4) {
    return res.status(400).json({ success: false, error: 'New password must be at least 4 characters' });
  }

  const session = req.user;
  // STRICT_AUTH=false fallback users have no real session — refuse password
  // changes for safety even in fallback mode.
  if (session._fallback) {
    return res.status(401).json({ success: false, error: 'Authentication required to change passwords' });
  }
  const isSelf = session.userId && String(session.userId) === String(volunteerId);
  if (!isSelf && session.role !== 'admin') {
    console.warn('[' + new Date().toISOString() + '] SET-PASSWORD FORBIDDEN  actor=' + session.name + '  target=' + volunteerId + '  ip=' + ip);
    return res.status(403).json({ success: false, error: 'Only admins can change another user\'s password' });
  }

  withDataLock(req.demoMode, () => {
    try {
      const data = loadData(req.demoMode);
      if (!data.volunteers) data.volunteers = [];
      const v = data.volunteers.find(x => String(x.id) === String(volunteerId));
      if (!v) {
        return res.status(404).json({ success: false, error: 'Volunteer not found' });
      }

      // Self-change requires the current password to validate against what's
      // on disk. If no stored value, validate against the legacy default.
      if (isSelf) {
        const stored = v[fieldName];
        let okCurrent;
        if (stored) {
          okCurrent = comparePassword(currentPassword || '', stored);
        } else {
          // No stored value → fall back to the same defaults checkPassword uses.
          if (fieldName === 'adminPassword') {
            okCurrent = currentPassword === 'admin2025';
          } else {
            const phoneDigits = (v.phone || '').replace(/\D/g, '').slice(-10);
            okCurrent = typedMatchesPhoneDefault(currentPassword, phoneDigits);
          }
        }
        if (!okCurrent) {
          console.warn('[' + new Date().toISOString() + '] SET-PASSWORD FAILED  user=' + session.name + '  reason=current-mismatch  ip=' + ip);
          return res.status(401).json({ success: false, error: 'Current password is incorrect' });
        }
      }

      // Apply the change.
      if (!newPassword) {
        // Clear → login falls back to default ('admin2025' or phone digits)
        delete v[fieldName];
        if (fieldName === 'adminPassword') delete v.adminPasswordSetAt;
        console.log('[' + new Date().toISOString() + '] SET-PASSWORD CLEARED  actor=' + session.name + '  target=' + (v.name || volunteerId) + '  field=' + fieldName);
      } else {
        v[fieldName] = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
        if (fieldName === 'adminPassword') v.adminPasswordSetAt = new Date().toISOString();
        console.log('[' + new Date().toISOString() + '] SET-PASSWORD SET  actor=' + session.name + '  target=' + (v.name || volunteerId) + '  field=' + fieldName);
      }

      if (saveData(data, req.demoMode)) {
        return res.json({ success: true });
      }
      return res.status(500).json({ success: false, error: 'Failed to save data' });
    } catch (e) {
      console.warn('[' + new Date().toISOString() + '] SET-PASSWORD ERROR  ' + e.message);
      return res.status(500).json({ success: false, error: 'Internal error' });
    }
  });
});

// ============================================================================
// Password reset via email (forgot-password flow)
//
// In-memory, single-use tokens with a 30-minute TTL. Sessions are already
// in-memory (see Phase 1.1); doing the same here keeps the model consistent.
// A PM2 restart invalidates any outstanding reset emails — acceptable given
// the short TTL.
// ============================================================================

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const passwordResetTokens = new Map(); // token -> { volunteerId, fieldName, expiresAt, used }

setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of passwordResetTokens) {
    if (rec.used || now > rec.expiresAt) passwordResetTokens.delete(token);
  }
}, 5 * 60 * 1000);

function portalToResetField(portal) {
  if (portal === 'admin') return 'adminPassword';
  if (portal === 'captain' || portal === 'volunteer') return 'volunteerPassword';
  return null;
}

app.post('/api/request-password-reset', resetReqLimiter, async (req, res) => {
  const { email, portal } = req.body || {};
  const ip = clientIpFromReq(req);

  // Always respond success to avoid leaking which emails/portals exist.
  const ack = () => res.json({ success: true });

  if (!email || !portal) return ack();
  const fieldName = portalToResetField(portal);
  if (!fieldName) return ack();

  const data = loadData(req.demoMode);
  const emailLc = String(email).trim().toLowerCase();
  const volunteer = (data.volunteers || []).find(v => v.email && v.email.toLowerCase() === emailLc);
  if (!volunteer || !volunteer.email) return ack();

  // Admin portal is only available to admin-typed records
  if (portal === 'admin' && !['Admin', 'View Admin', 'Chairman', 'Asst. Chairman'].includes(volunteer.type)) {
    return ack();
  }

  const token = generateToken();
  passwordResetTokens.set(token, {
    volunteerId: volunteer.id,
    fieldName: fieldName,
    expiresAt: Date.now() + RESET_TOKEN_TTL_MS,
    used: false
  });

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const resetUrl = proto + '://' + host + '/?reset=' + token;

  console.log('[' + new Date().toISOString() + '] RESET REQUESTED  user=' + volunteer.name + '  portal=' + portal + '  ip=' + ip);

  if (req.demoMode) return ack(); // don't send real email in demo

  try {
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Volunteer Golf <hello@colonialvolunteers.golf>',
      to: [volunteer.email],
      subject: 'Reset your Volunteer Golf password',
      text: 'Hi ' + (volunteer.name || '') + ',\n\nClick the link below to reset your password. This link expires in 30 minutes and can only be used once.\n\n' + resetUrl + '\n\nIf you didn\'t request this, you can safely ignore this email.',
      html: '<p>Hi ' + (volunteer.name || '') + ',</p><p>Click the link below to reset your password. This link expires in 30 minutes and can only be used once.</p><p><a href="' + resetUrl + '">' + resetUrl + '</a></p><p style="color:#666;font-size:12px">If you didn\'t request this, you can safely ignore this email.</p>'
    });
    if (error) {
      console.warn('[' + new Date().toISOString() + '] RESET EMAIL FAILED  user=' + volunteer.name + '  err=' + error.message);
    }
  } catch (e) {
    console.warn('[' + new Date().toISOString() + '] RESET EMAIL ERROR  ' + e.message);
  }
  return ack();
});

app.post('/api/reset-password', resetSubmitLimiter, (req, res) => {
  const { token, newPassword } = req.body || {};
  const ip = clientIpFromReq(req);

  if (!token || !newPassword) {
    return res.status(400).json({ success: false, error: 'token and newPassword required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    return res.status(400).json({ success: false, error: 'New password must be at least 4 characters' });
  }

  const rec = passwordResetTokens.get(token);
  if (!rec || rec.used || Date.now() > rec.expiresAt) {
    return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  withDataLock(false, () => {
    try {
      const data = loadData(false);
      const v = (data.volunteers || []).find(x => String(x.id) === String(rec.volunteerId));
      if (!v) {
        passwordResetTokens.delete(token);
        return res.status(404).json({ success: false, error: 'Account not found' });
      }
      v[rec.fieldName] = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
      if (rec.fieldName === 'adminPassword') v.adminPasswordSetAt = new Date().toISOString();

      if (!saveData(data, false)) {
        return res.status(500).json({ success: false, error: 'Failed to save data' });
      }
      rec.used = true;
      passwordResetTokens.delete(token);
      console.log('[' + new Date().toISOString() + '] RESET COMPLETED  user=' + (v.name || v.id) + '  field=' + rec.fieldName + '  ip=' + ip);
      return res.json({ success: true, name: v.name });
    } catch (e) {
      console.warn('[' + new Date().toISOString() + '] RESET ERROR  ' + e.message);
      return res.status(500).json({ success: false, error: 'Internal error' });
    }
  });
});

app.get('/api/data', (req, res) => {
  const data = loadData(req.demoMode);

  // Ensure superadmin is always present in volunteers
  const hasSuperadmin = data.volunteers && data.volunteers.some(v =>
    v.email && v.email.toLowerCase() === SUPERADMIN.email
  );
  if (!hasSuperadmin) {
    if (!data.volunteers) data.volunteers = [];
    data.volunteers.push({
      id: 'superadmin',
      ...SUPERADMIN
    });
  }

  // Phase 1.2: strip password fields before sending to the browser.
  // serverNow lets the client stamp dataReadAt for the merge logic in POST /api/data.
  res.json({ success: true, data: stripDataSecrets(data), demoMode: req.demoMode, serverNow: Date.now() });
});

app.post('/api/data', dataLimiter, requireAuth(['admin', 'chair', 'asstChair', 'captain']), (req, res) => {
  // Chair/Asst. Chairman are read-only in captain portal
  if ((req.user.role === 'chair' || req.user.role === 'asstChair') && req.user.portal === 'captain') {
    return res.status(403).json({ success: false, error: 'View-only access in captain portal' });
  }

  const body = req.body;
  const socketId = req.headers['x-socket-id'];
  const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';

  // New-mode envelope: { data, deletedIds, dataReadAt }. Legacy clients still
  // POST the bare appData object — detect and unwrap.
  const isNewMode = body && typeof body === 'object' && !Array.isArray(body)
    && typeof body.dataReadAt === 'number' && body.data && typeof body.data === 'object';
  const data = isNewMode ? body.data : body;
  const deletedIds = isNewMode && Array.isArray(body.deletedIds) ? body.deletedIds : [];
  const dataReadAt = isNewMode ? body.dataReadAt : 0;

  // --- Input validation (added 2026-04-10 after a vulnerability scanner
  // wiped data.json by POSTing empty bodies to this unauthenticated endpoint).
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn('[' + new Date().toISOString() + '] REJECTED /api/data: not an object  ip=' + clientIp);
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }
  if (!Array.isArray(data.volunteers)) {
    console.warn('[' + new Date().toISOString() + '] REJECTED /api/data: missing volunteers array  ip=' + clientIp);
    return res.status(400).json({ success: false, error: 'Missing volunteers array' });
  }
  if (!data.settings || typeof data.settings !== 'object') {
    console.warn('[' + new Date().toISOString() + '] REJECTED /api/data: missing settings object  ip=' + clientIp);
    return res.status(400).json({ success: false, error: 'Missing settings object' });
  }

  // Ensure superadmin is never removed from volunteer list
  const hasSuperadmin = data.volunteers.some(v =>
    v.email && v.email.toLowerCase() === SUPERADMIN.email
  );
  if (!hasSuperadmin) {
    data.volunteers.push({
      id: 'superadmin',
      ...SUPERADMIN
    });
  }

  // Serialize concurrent saves so two admins editing at once can't clobber
  // each other mid-write. Same lock used by /api/checkin and /api/hat-delivered.
  withDataLock(req.demoMode, () => {
    const existing = loadData(req.demoMode);
    const existingCount = (existing.volunteers || []).length;
    const incomingCount = data.volunteers.length;

    // Catastrophic-shrink guard: only meaningful for legacy mode (new mode
    // can't drop volunteers except via explicit deletedIds). Override with
    // ?force=true for intentional resets (e.g. starting a new tournament).
    if (!isNewMode && req.query.force !== 'true' && existingCount >= 10 && incomingCount < existingCount / 2) {
      console.warn('[' + new Date().toISOString() + '] REJECTED /api/data: volunteer count would drop ' + existingCount + ' -> ' + incomingCount + '  ip=' + clientIp);
      return res.status(409).json({
        success: false,
        error: 'Refusing to save: volunteer count would drop from ' + existingCount + ' to ' + incomingCount + '. If this is intentional, add ?force=true to the request.'
      });
    }

    // Strip any password fields the client sent (defense in depth — passwords
    // are server-owned since Phase 1.2). The merge step below re-applies disk
    // passwords by id.
    for (const v of data.volunteers) {
      for (const f of VOLUNTEER_SECRET_FIELDS) delete v[f];
    }

    let finalData;
    if (isNewMode) {
      finalData = mergeVolunteerSave(existing, data, deletedIds, dataReadAt);
    } else {
      finalData = applyTombstonesToLegacyData(existing, data);
    }

    // Re-apply passwords from disk (post-merge). The /api/set-password endpoint
    // is the only authorized writer for these fields.
    const existingById = new Map((existing.volunteers || []).map(v => [String(v.id), v]));
    for (const v of finalData.volunteers) {
      const onDisk = existingById.get(String(v.id));
      if (onDisk) {
        for (const f of VOLUNTEER_SECRET_FIELDS) {
          if (onDisk[f] !== undefined) v[f] = onDisk[f];
        }
      }
    }

    const mode = isNewMode ? 'merge' : 'legacy';
    console.log('[' + new Date().toISOString() + '] POST /api/data  ip=' + clientIp + '  mode=' + mode + '  vols=' + finalData.volunteers.length + '  deletes=' + deletedIds.length);

    if (saveData(finalData, req.demoMode)) {
      // Broadcast to OTHER clients — strip passwords before they reach browsers.
      // Include serverNow so receivers can advance their dataReadAt.
      const broadcastPayload = stripDataSecrets(finalData);
      broadcastPayload.serverNow = Date.now();
      broadcastUpdate(req.demoMode, 'fullUpdate', broadcastPayload, socketId);
      res.json({ success: true, demoMode: req.demoMode, serverNow: Date.now() });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save data' });
    }
  });
});

app.post('/api/checkin', checkinLimiter, requireAuth(['admin', 'chair', 'asstChair', 'captain']), (req, res) => {
  // Chair/Asst. Chairman are read-only in captain portal
  if ((req.user.role === 'chair' || req.user.role === 'asstChair') && req.user.portal === 'captain') {
    return res.status(403).json({ success: false, error: 'View-only access in captain portal' });
  }

  const { volunteerId, volunteerName, hole, day, shift, checkedInBy, action, isAlternate } = req.body;
  const socketId = req.headers['x-socket-id'];

  if (action !== 'add' && action !== 'remove') {
    return res.status(400).json({ success: false, error: 'Invalid action' });
  }

  withDataLock(req.demoMode, () => {
    const data = loadData(req.demoMode);
    if (!data.checkIns) data.checkIns = [];

    if (action === 'add') {
      const checkIn = {
        volunteerId,
        volunteerName,
        hole,
        day,
        shift,
        checkedInBy,
        timestamp: new Date().toISOString(),
        isAlternate: !!isAlternate
      };
      // Idempotent: don't add duplicate (volunteerId, day, shift, hole) entries
      const exists = data.checkIns.some(c =>
        c.volunteerId === volunteerId && c.day === day && c.shift === shift && c.hole === hole
      );
      if (!exists) data.checkIns.push(checkIn);
      if (saveData(data, req.demoMode)) {
        broadcastUpdate(req.demoMode, 'checkIn', checkIn, socketId);
        res.json({ success: true, checkIn });
      } else {
        res.status(500).json({ success: false, error: 'Failed to save' });
      }
    } else {
      // Match on hole as well so a volunteer with check-ins on multiple holes
      // for the same shift only loses the intended one.
      data.checkIns = data.checkIns.filter(c =>
        !(c.volunteerId === volunteerId && c.day === day && c.shift === shift && c.hole === hole)
      );
      if (saveData(data, req.demoMode)) {
        broadcastUpdate(req.demoMode, 'checkOut', { volunteerId, day, shift, hole }, socketId);
        res.json({ success: true });
      } else {
        res.status(500).json({ success: false, error: 'Failed to save' });
      }
    }
  });
});

app.get('/api/archives', (req, res) => {
  if (req.demoMode) {
    return res.json({ success: true, archives: [], demoMode: true });
  }
  const archives = loadArchives();
  res.json({ success: true, archives: archives });
});

app.post('/api/archives', requireAuth(['admin']), (req, res) => {
  if (req.demoMode) {
    return res.json({ success: true, demoMode: true, message: 'Archives disabled in demo mode' });
  }
  const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';

  // Validation: must explicitly send an archives array
  if (!req.body || !Array.isArray(req.body.archives)) {
    console.warn('[' + new Date().toISOString() + '] REJECTED /api/archives: missing archives array  ip=' + clientIp);
    return res.status(400).json({ success: false, error: 'Missing archives array' });
  }

  const archives = req.body.archives;

  // Don't let an empty payload wipe existing archives
  const existing = loadArchives();
  if (req.query.force !== 'true' && existing.length > 0 && archives.length < existing.length) {
    console.warn('[' + new Date().toISOString() + '] REJECTED /api/archives: archive count would drop ' + existing.length + ' -> ' + archives.length + '  ip=' + clientIp);
    return res.status(409).json({
      success: false,
      error: 'Refusing to save: archive count would drop from ' + existing.length + ' to ' + archives.length + '. If this is intentional, add ?force=true to the request.'
    });
  }

  console.log('[' + new Date().toISOString() + '] POST /api/archives  ip=' + clientIp + '  archives=' + archives.length);

  if (saveArchives(archives)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save archives' });
  }
});

app.post('/api/email', emailLimiter, requireAuth(['admin', 'chair', 'asstChair', 'captain']), async (req, res) => {
  if (req.demoMode) {
    return res.json({ success: true, demoMode: true, message: 'Emails disabled in demo mode' });
  }

  const { to, subject, message } = req.body;
  if (!to || !subject || !message) {
    return res.status(400).json({ success: false, error: 'To, subject, and message required' });
  }

  try {
    const recipients = Array.isArray(to) ? to : [to];

    // Captains may only send to addresses belonging to people on their hole
    // (volunteers and any co-captains). This mirrors /api/email/hole-roster.
    if (req.user && req.user.role === 'captain') {
      const data = loadData(req.demoMode);
      const me = (data.volunteers || []).find(v => v.id === req.user.userId);
      if (!me || !Number.isInteger(me.hole)) {
        return res.status(403).json({ success: false, error: 'Captain has no assigned hole' });
      }
      const allowed = new Set(
        (data.volunteers || [])
          .filter(v => v.hole === me.hole && v.email)
          .map(v => String(v.email).trim().toLowerCase())
      );
      const allOnHole = recipients.every(r => allowed.has(String(r).trim().toLowerCase()));
      if (!allOnHole) {
        return res.status(403).json({ success: false, error: 'Captains can only email people on their assigned hole' });
      }
    }

    const trimmed = String(message).trim();
    const isHtml = trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div');
    const htmlContent = isHtml ? message : message.replace(/\n/g, '<br>');
    const textContent = isHtml ? message.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : message;

    const { data: emailData, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Volunteer Golf <hello@colonialvolunteers.golf>',
      to: recipients,
      subject: subject,
      text: textContent,
      html: htmlContent
    });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/email/hole-roster — send the roster for a specific hole to every
// volunteer on that hole who has an email address. Captains may only email
// their own hole; admin/chair/asstChair may email any hole.
//
// Body: { hole, subject, message }  (recipients are resolved server-side —
// the client cannot specify arbitrary addresses)
app.post('/api/email/hole-roster', emailLimiter, requireAuth(['admin', 'chair', 'asstChair', 'captain']), async (req, res) => {
  if (req.demoMode) {
    return res.json({ success: true, demoMode: true, message: 'Emails disabled in demo mode' });
  }

  const { hole, subject, message } = req.body || {};
  const holeNum = parseInt(hole, 10);
  if (!Number.isInteger(holeNum) || holeNum < 1 || holeNum > 18) {
    return res.status(400).json({ success: false, error: 'hole must be an integer 1-18' });
  }
  if (!subject || !message) {
    return res.status(400).json({ success: false, error: 'subject and message required' });
  }

  const data = loadData(req.demoMode);
  const allVols = data.volunteers || [];

  if (req.user && req.user.role === 'captain') {
    const me = allVols.find(v => v.id === req.user.userId);
    if (!me || me.hole !== holeNum) {
      return res.status(403).json({ success: false, error: 'Captains can only email their assigned hole' });
    }
  }

  const recipients = allVols
    .filter(v => v.hole === holeNum)
    .map(v => String(v.email || '').trim())
    .filter(e => e.length > 0);

  if (recipients.length === 0) {
    return res.status(400).json({ success: false, error: 'No volunteers with email on hole ' + holeNum });
  }

  try {
    const trimmed = String(message).trim();
    const isHtml = trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div');
    const htmlContent = isHtml ? message : message.replace(/\n/g, '<br>');
    const textContent = isHtml ? message.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : message;

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Volunteer Golf <hello@colonialvolunteers.golf>',
      to: recipients,
      subject: String(subject),
      text: textContent,
      html: htmlContent
    });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    console.log('[' + new Date().toISOString() + '] HOLE ROSTER EMAIL  user=' + (req.user && req.user.name) + '  hole=' + holeNum + '  recipients=' + recipients.length);
    res.json({ success: true, count: recipients.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/hat-delivered', requireAuth(['admin', 'chair', 'asstChair', 'captain']), (req, res) => {
  const { volunteerId } = req.body;

  if (!volunteerId) {
    return res.status(400).json({ success: false, error: 'volunteerId required' });
  }

  withDataLock(req.demoMode, () => {
    const data = loadData(req.demoMode);
    const volIdx = data.volunteers.findIndex(v => v.id === volunteerId);

    if (volIdx === -1) {
      return res.status(404).json({ success: false, error: 'Volunteer not found' });
    }

    data.volunteers[volIdx].hatReceived = true;

    if (saveData(data, req.demoMode)) {
      // Phase 1.2: strip password fields from the volunteer record before
      // broadcasting it and returning it to the caller.
      const safeVolunteer = stripVolunteerSecrets(data.volunteers[volIdx]);
      broadcastUpdate(req.demoMode, 'hatDelivered', { volunteerId, volunteer: safeVolunteer });
      res.json({ success: true, volunteer: safeVolunteer });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save' });
    }
  });
});

// POST /api/log-deployment - Log a system update/deployment
// Called by deploy.sh to record what was deployed
app.post('/api/log-deployment', (req, res) => {
  const { message, version } = req.body || {};
  const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';

  if (!message) {
    return res.status(400).json({ success: false, error: 'message required' });
  }

  withDataLock(false, () => {  // Always log to live data, not demo
    const data = loadData(false);
    if (!data.activityLog) data.activityLog = [];

    const entry = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      user: 'System',
      userType: 'Deployment',
      action: 'system-update',
      target: version || '',
      details: message
    };

    data.activityLog.unshift(entry);

    // Keep last 500 entries (increased from 200 for better history)
    if (data.activityLog.length > 500) {
      data.activityLog = data.activityLog.slice(0, 500);
    }

    if (saveData(data, false)) {
      console.log('[' + new Date().toISOString() + '] DEPLOYMENT LOGGED: ' + message + '  ip=' + clientIp);
      broadcastUpdate(false, 'fullUpdate', data);
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save' });
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), clients: io.engine.clientsCount });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Volunteer Golf running on port ' + PORT + ' with WebSocket support'));
