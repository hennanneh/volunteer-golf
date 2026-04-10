require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { Resend } = require('resend');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
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

  res.json({ success: true, data: data, demoMode: req.demoMode });
});

app.post('/api/data', (req, res) => {
  const data = req.body;
  const socketId = req.headers['x-socket-id'];
  const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || 'unknown';

  // --- Input validation (added 2026-04-10 after a vulnerability scanner
  // wiped data.json by POSTing empty bodies to this unauthenticated endpoint).
  // These checks reject obviously-malformed payloads. They are NOT a
  // substitute for real authentication, which still needs to be added.
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
    // Catastrophic-shrink guard: reject if the incoming save would wipe out
    // most volunteers compared to what's currently on disk. Override with
    // ?force=true for intentional resets (e.g. starting a new tournament).
    const existing = loadData(req.demoMode);
    const existingCount = (existing.volunteers || []).length;
    const incomingCount = data.volunteers.length;
    if (req.query.force !== 'true' && existingCount >= 10 && incomingCount < existingCount / 2) {
      console.warn('[' + new Date().toISOString() + '] REJECTED /api/data: volunteer count would drop ' + existingCount + ' -> ' + incomingCount + '  ip=' + clientIp);
      return res.status(409).json({
        success: false,
        error: 'Refusing to save: volunteer count would drop from ' + existingCount + ' to ' + incomingCount + '. If this is intentional, add ?force=true to the request.'
      });
    }

    console.log('[' + new Date().toISOString() + '] POST /api/data  ip=' + clientIp + '  volunteers=' + incomingCount + '  checkIns=' + (data.checkIns ? data.checkIns.length : 0));

    if (saveData(data, req.demoMode)) {
      // Broadcast to OTHER clients only
      broadcastUpdate(req.demoMode, 'fullUpdate', data, socketId);
      res.json({ success: true, demoMode: req.demoMode });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save data' });
    }
  });
});

app.post('/api/checkin', (req, res) => {
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

app.post('/api/archives', (req, res) => {
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

app.post('/api/email', async (req, res) => {
  if (req.demoMode) {
    return res.json({ success: true, demoMode: true, message: 'Emails disabled in demo mode' });
  }
  
  const { to, subject, message } = req.body;
  if (!to || !subject || !message) {
    return res.status(400).json({ success: false, error: 'To, subject, and message required' });
  }

  try {
    const recipients = Array.isArray(to) ? to : [to];
    const isHtml = message.trim().startsWith('<!DOCTYPE') || message.trim().startsWith('<html');
    const htmlContent = isHtml ? message : message.replace(/\n/g, '<br>');
    const textContent = isHtml ? message.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : message;

    const { data, error } = await resend.emails.send({
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

app.post('/api/hat-delivered', (req, res) => {
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
      broadcastUpdate(req.demoMode, 'hatDelivered', { volunteerId, volunteer: data.volunteers[volIdx] });
      res.json({ success: true, volunteer: data.volunteers[volIdx] });
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
