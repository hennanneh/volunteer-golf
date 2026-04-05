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
  return defaultData;
}

function saveData(data, isDemo = false) {
  const dataFile = getDataFile(isDemo);
  try {
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving data:', err.message);
    return false;
  }
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
    fs.writeFileSync(ARCHIVES_FILE, JSON.stringify(archives, null, 2));
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

  // Ensure superadmin is never removed from volunteer list
  if (data.volunteers) {
    const hasSuperadmin = data.volunteers.some(v =>
      v.email && v.email.toLowerCase() === SUPERADMIN.email
    );
    if (!hasSuperadmin) {
      data.volunteers.push({
        id: 'superadmin',
        ...SUPERADMIN
      });
    }
  }

  if (saveData(data, req.demoMode)) {
    // Broadcast to OTHER clients only
    broadcastUpdate(req.demoMode, 'fullUpdate', data, socketId);
    res.json({ success: true, demoMode: req.demoMode });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save data' });
  }
});

app.post('/api/checkin', (req, res) => {
  const { volunteerId, volunteerName, hole, day, shift, checkedInBy, action } = req.body;
  const socketId = req.headers['x-socket-id'];
  const data = loadData(req.demoMode);
  
  if (action === 'add') {
    const checkIn = {
      volunteerId,
      volunteerName,
      hole,
      day,
      shift,
      checkedInBy,
      timestamp: new Date().toISOString()
    };
    data.checkIns.push(checkIn);
    if (saveData(data, req.demoMode)) {
      broadcastUpdate(req.demoMode, 'checkIn', checkIn, socketId);
      res.json({ success: true, checkIn });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save' });
    }
  } else if (action === 'remove') {
    data.checkIns = data.checkIns.filter(c => 
      !(c.volunteerId === volunteerId && c.day === day && c.shift === shift)
    );
    if (saveData(data, req.demoMode)) {
      broadcastUpdate(req.demoMode, 'checkOut', { volunteerId, day, shift }, socketId);
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save' });
    }
  } else {
    res.status(400).json({ success: false, error: 'Invalid action' });
  }
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
  const archives = req.body.archives || [];
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), clients: io.engine.clientsCount });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Volunteer Golf running on port ' + PORT + ' with WebSocket support'));
