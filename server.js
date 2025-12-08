const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Data file path
const DATA_FILE = path.join(__dirname, 'data.json');
const ARCHIVES_FILE = path.join(__dirname, 'archives.json');

// Default data structure
const defaultData = {
  volunteers: [],
  checkIns: [],
  submissions: [],
  settings: {
    adminPassword: 'admin2025',
    tournamentName: 'Golf Tournament 2025',
    alertTimes: [],
    alertEmails: [],
    gmailUser: '',
    gmailAppPassword: ''
  }
};

// Load data from file
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error loading data:', err.message);
  }
  return defaultData;
}

// Save data to file
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving data:', err.message);
    return false;
  }
}

// Load archives from file
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

// Save archives to file
function saveArchives(archives) {
  try {
    fs.writeFileSync(ARCHIVES_FILE, JSON.stringify(archives, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving archives:', err.message);
    return false;
  }
}

// GET data
app.get('/api/data', (req, res) => {
  const data = loadData();
  res.json({ success: true, data: data });
});

// POST save data
app.post('/api/data', (req, res) => {
  const data = req.body;
  if (saveData(data)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save data' });
  }
});

// GET archives
app.get('/api/archives', (req, res) => {
  const archives = loadArchives();
  res.json({ success: true, archives: archives });
});

// POST save archives
app.post('/api/archives', (req, res) => {
  const archives = req.body.archives || [];
  if (saveArchives(archives)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save archives' });
  }
});

// Email endpoint
app.post('/api/email', async (req, res) => {
  const { to, subject, message, gmailUser, gmailAppPassword } = req.body;

  if (!to || !subject || !message) {
    return res.status(400).json({ success: false, error: 'To, subject, and message required' });
  }

  if (!gmailUser || !gmailAppPassword) {
    return res.status(400).json({ success: false, error: 'Gmail credentials not configured' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailAppPassword
      }
    });

    const recipients = Array.isArray(to) ? to.join(', ') : to;

    await transporter.sendMail({
      from: gmailUser,
      to: recipients,
      subject: subject,
      text: message,
      html: message.replace(/\n/g, '<br>')
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = 3001;
app.listen(PORT, () => console.log('Volunteer Golf running on port ' + PORT));
