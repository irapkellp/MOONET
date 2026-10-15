 'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const APP_NAME = 'MOONET';
const MOON_VALUE_RWF = 10;
const MIN_WITHDRAWAL_MOON = 1000;
const STREAM_REWARD_MOON = 0.1;
const STREAM_DURATION_MS = 30000;

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const SESSION_SECRET = String(process.env.SESSION_SECRET || '');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (SESSION_SECRET.length < 32) {
  console.error('ERROR: Set SESSION_SECRET to a random string of at least 32 characters.');
  process.exit(1);
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ERROR: Set ADMIN_EMAIL and ADMIN_PASSWORD in Render environment variables.');
  process.exit(1);
}

if (ADMIN_PASSWORD.length < 12) {
  console.error('ERROR: ADMIN_PASSWORD must contain at least 12 characters.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'moonet.db'));

db.exec(`
 PRAGMA foreign_keys=ON;
 PRAGMA busy_timeout=5000;

 CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  moon INTEGER NOT NULL DEFAULT 0 CHECK(moon>=0),
  referral_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  suspended INTEGER NOT NULL DEFAULT 0
 );

 CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  moon INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  moon INTEGER NOT NULL CHECK(moon>0),
  amount_rwf INTEGER NOT NULL CHECK(amount_rwf>0),
  payment_method TEXT NOT NULL,
  payment_account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS revenue(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_rwf INTEGER NOT NULL CHECK(amount_rwf>=0),
  source TEXT NOT NULL,
  reference TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_rwf INTEGER NOT NULL CHECK(amount_rwf>=0),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS video_streams(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stream_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id,user_id,stream_date)
 );

 CREATE TABLE IF NOT EXISTS video_likes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id,user_id)
 );

 CREATE TABLE IF NOT EXISTS video_comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS follows(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(follower_id,following_id),
  CHECK(follower_id<>following_id)
 );

 CREATE TABLE IF NOT EXISTS gifts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  gift_name TEXT NOT NULL,
  moon INTEGER NOT NULL CHECK(moon>0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
`);

try {
  db.exec("ALTER TABLE videos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'");
} catch (e) {
  if (!String(e.message).includes('duplicate column name')) {
    throw e;
  }
}

// Add new balance columns without deleting existing user data.
for (const [column, definition] of [
  ['like_moon', 'REAL NOT NULL DEFAULT 0'],
  ['watch_moon', 'REAL NOT NULL DEFAULT 0'],
  ['listen_moon', 'REAL NOT NULL DEFAULT 0']
]) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!String(e.message).includes('duplicate column name')) {
      throw e;
    }
  }
}

db.exec(`
 CREATE TABLE IF NOT EXISTS watch_sessions(
  id TEXT PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS listen_sessions(
  id TEXT PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS like_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id,user_id)
 );

 CREATE TABLE IF NOT EXISTS like_rewards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  liker_id INTEGER NOT NULL REFERENCES users(id),
  creator_id INTEGER NOT NULL REFERENCES users(id),
  moon REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id,liker_id)
 );
`);

const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function transaction(work) {
  return function () {
    db.exec('BEGIN IMMEDIATE');

    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}

      throw error;
    }
  };
}

function esc(v = '') {
  return String(v).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US');
}

function ref() {
  return crypto.randomUUID();
}

function referralCode() {
  return 'MOON' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function csrfField(req) {
  return `<input type="hidden" name="_csrf" value="${esc(req.session.csrfToken || '')}">`;
}

function msg(s, cls = '') {
  return `<div class="message ${cls}">${esc(s)}</div>`;
}
// ==============================
// MOONET — IGICE CYA 2
// HTML, MIDDLEWARE, SECURITY
// ==============================

function page(title, body, user = null, req = null) {
  const nav = user
    ? `
      <nav class="nav">
        <a href="/app">Home</a>
        <a href="/feed">Feed</a>
        <a href="/wallet">Wallet</a>
        <a href="/transactions">History</a>
        <a href="/profile">Profile</a>
        <form method="POST" action="/logout" class="inline">
          ${csrfField(req)}
          <button type="submit">Logout</button>
        </form>
      </nav>
    `
    : `
      <nav class="nav">
        <a href="/">Home</a>
        <a href="/login">Login</a>
        <a href="/signup">Sign Up</a>
      </nav>
    `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${APP_NAME}</title>
<style>
:root {
  --bg: #0b1020;
  --panel: #151d32;
  --panel2: #202b45;
  --text: #f5f7ff;
  --muted: #aab5ce;
  --accent: #8b5cf6;
  --accent2: #06b6d4;
  --danger: #ef4444;
  --success: #22c55e;
  --border: #33415f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Arial, sans-serif;
  line-height: 1.55;
}
header {
  padding: 18px;
  background: linear-gradient(120deg, #4c1d95, #1d4ed8);
}
header h1 { margin: 0; font-size: 27px; }
header p { margin: 5px 0 0; color: #e0e7ff; }
main { max-width: 950px; margin: auto; padding: 18px; }
.nav {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  padding: 12px 18px;
  background: #11182b;
  border-bottom: 1px solid var(--border);
}
a { color: #93c5fd; text-decoration: none; }
a:hover { text-decoration: underline; }
.nav a, .nav button {
  display: inline-block;
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--panel2);
  color: white;
  border: 0;
  cursor: pointer;
  font-size: 14px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px;
  margin: 15px 0;
  overflow-wrap: anywhere;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.stat {
  background: var(--panel2);
  padding: 16px;
  border-radius: 12px;
}
.stat strong { display: block; font-size: 25px; }
label { display: block; margin: 12px 0 5px; }
input, textarea, select {
  display: block;
  width: 100%;
  padding: 12px;
  background: #0b1327;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: white;
}
textarea { min-height: 100px; resize: vertical; }
button, .button {
  display: inline-block;
  padding: 11px 16px;
  background: var(--accent);
  color: white;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
  margin-top: 10px;
}
button:hover, .button:hover { opacity: .88; }
.inline { display: inline; }
.inline button { margin: 0; }
.muted { color: var(--muted); }
.message {
  padding: 12px;
  border-radius: 8px;
  margin: 12px 0;
  background: var(--panel2);
}
.error { border-left: 4px solid var(--danger); }
.success { border-left: 4px solid var(--success); }
video, audio, .feed-photo {
  width: 100%;
  max-height: 600px;
  border-radius: 10px;
  margin-top: 10px;
  background: #000;
}
.feed-photo { object-fit: contain; }
.text-post {
  padding: 18px;
  background: #101a31;
  border-radius: 10px;
  white-space: pre-wrap;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}
th, td {
  padding: 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
footer {
  text-align: center;
  padding: 24px;
  color: var(--muted);
}
hr { border: 0; border-top: 1px solid var(--border); }
@media (max-width: 550px) {
  main { padding: 12px; }
  .card { padding: 13px; }
  header h1 { font-size: 23px; }
}
</style>
</head>
<body>
<header>
  <h1>🌙 MOONET</h1>
  <p>Create. Share. Watch. Listen. Earn MOONS.</p>
</header>
${nav}
<main>
${user ? `<p class="muted">Welcome, ${esc(user.name || user.email)}!</p>` : ''}
${req?.query?.msg ? msg(String(req.query.msg)) : ''}
${body}
</main>
<footer>MOONET &copy; ${new Date().getFullYear()} — Earn and share responsibly.</footer>
</body>
</html>`;
}

function render(res, title, body, user = null, req = null, status = 200) {
  return res.status(status).send(page(title, body, user, req));
}

function resSend(req, res, title, body, user = null, status = 200) {
  return render(res, title, body, user, req, status);
}

// ==============================
// AUTHENTICATION MIDDLEWARE
// ==============================

function requireUser(req, res, next) {
  const userId = req.session?.userId;

  if (!userId) {
    return res.redirect('/login?msg=' + encodeURIComponent(
      'Please login to continue.'
    ));
  }

  const user = get(
    `SELECT id, name, email, moon, like_moon, watch_moon,
            listen_moon, referral_code, suspended
     FROM users
     WHERE id = ?`,
    userId
  );

  if (!user) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }

  if (Number(user.suspended) === 1) {
    req.session.destroy(() => {});
    return res.status(403).send('Your account is suspended.');
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    return res.redirect('/admin/login');
  }

  next();
}

function validateCsrf(req, res, next) {
  const supplied = String(
    req.body?._csrf || req.headers['x-csrf-token'] || ''
  );
  const expected = String(req.session?.csrfToken || '');

  if (!supplied || !expected) {
    return res.status(403).send('Security check failed. Refresh the page.');
  }

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).send('Security check failed. Refresh the page.');
  }

  next();
}

// ==============================
// FILE UPLOAD SETUP
// ==============================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
    cb(null, crypto.randomUUID() + safeExt);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  },
  fileFilter: function (req, file, cb) {
    const allowed = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'audio/mpeg',
      'audio/mp4',
      'audio/wav',
      'audio/ogg',
      'audio/webm'
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(
        'Unsupported file type. Upload a supported video, photo, or audio file.'
      ));
    }

    cb(null, true);
  }
});

// ==============================
// EXPRESS MIDDLEWARE
// ==============================

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.urlencoded({
  extended: false,
  limit: '2mb'
}));

app.use(express.json({
  limit: '2mb'
}));

app.use(session({
  name: 'moonet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  next();
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  dotfiles: 'deny',
  index: false,
  maxAge: '1h'
}));

// ==============================
// HOME AND HEALTH CHECK
// ==============================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: APP_NAME,
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  const body = `
    <section class="card">
      <h2>Welcome to MOONET 🌙</h2>
      <p>
        Share videos, photos, music, and stories.
        Watch and listen to qualifying content to earn MOONS.
      </p>
      <p>
        <strong>1 MOON ≈ ${MOON_VALUE_RWF} RWF</strong>
      </p>
      <div class="actions">
        <a class="button" href="/signup">Create Account</a>
        <a class="button" href="/login">Login</a>
        <a class="button" href="/feed">Explore Feed</a>
      </div>
    </section>

    <section class="grid">
      <div class="stat">
        <strong>🌙 MOONS</strong>
        <span class="muted">Your reward balance</span>
      </div>
      <div class="stat">
        <strong>🎬 Watch</strong>
        <span class="muted">Discover video content</span>
      </div>
      <div class="stat">
        <strong>🎵 Listen</strong>
        <span class="muted">Discover music and audio</span>
      </div>
      <div class="stat">
        <strong>❤️ Create</strong>
        <span class="muted">Share content with others</span>
      </div>
    </section>
  `;

  render(res, 'Home', body, null, req);
});

// ==============================
// SIGNUP PAGE
// ==============================

app.get('/signup', (req, res) => {
  const body = `
    <section class="card">
      <h2>Create your MOONET account</h2>

      <form method="POST" action="/signup">
        ${csrfField(req)}

        <label for="name">Full name</label>
        <input id="name" name="name"
          maxlength="80" required autocomplete="name">

        <label for="email">Email address</label>
        <input id="email" name="email"
          type="email" maxlength="190"
          required autocomplete="email">

        <label for="password">Password</label>
        <input id="password" name="password"
          type="password" minlength="12"
          required autocomplete="new-password">

        <label for="referral_code">Referral code (optional)</label>
        <input id="referral_code" name="referral_code"
          maxlength="40"
          value="${esc(String(req.query.ref || ''))}">

        <button type="submit">Create Account</button>
      </form>

      <p class="muted">
        Already registered? <a href="/login">Login here</a>.
      </p>
    </section>
  `;

  render(res, 'Sign Up', body, null, req);
});
// ==============================
// MOONET — IGICE CYA 3
// SIGNUP, LOGIN, LOGOUT, DASHBOARD
// ==============================

// SIGNUP
app.post('/signup', validateCsrf, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const suppliedReferral = String(req.body.referral_code || '')
      .trim()
      .toUpperCase();

    if (name.length < 2 || name.length > 80) {
      return resSend(req, res, 'Sign Up',
        msg('Your name must contain 2–80 characters.', 'error'),
        null, 400);
    }

    if (
      email.length > 190 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return resSend(req, res, 'Sign Up',
        msg('Enter a valid email address.', 'error'),
        null, 400);
    }

    if (password.length < 12 || password.length > 200) {
      return resSend(req, res, 'Sign Up',
        msg('Your password must contain at least 12 characters.', 'error'),
        null, 400);
    }

    const existing = get(
      'SELECT id FROM users WHERE email = ?',
      email
    );

    if (existing) {
      return resSend(req, res, 'Sign Up',
        msg('Email already registered. Please login.', 'error'),
        null, 409);
    }

    let referredBy = null;

    if (suppliedReferral) {
      const referrer = get(
        'SELECT id FROM users WHERE referral_code = ?',
        suppliedReferral
      );

      if (referrer) referredBy = referrer.id;
    }

    const passwordHash = bcrypt.hashSync(password, 12);
    const code = referralCode();

    const result = run(
      `INSERT INTO users
       (name, email, password, moon, referral_code, referred_by)
       VALUES (?, ?, ?, 0, ?, ?)`,
      name,
      email,
      passwordHash,
      code,
      referredBy
    );

    const newUserId = Number(result.lastInsertRowid);

    run(
      `INSERT INTO transactions
       (user_id, type, amount, description, created_at)
       VALUES (?, 'signup', 0, ?, datetime('now'))`,
      newUserId,
      'MOONET account created'
    );

    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.status(500).send('Unable to start your session.');
      }

      req.session.userId = newUserId;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.status(500).send('Unable to save your session.');
        }

        res.redirect('/app?msg=' +
          encodeURIComponent('Welcome to MOONET!'));
      });
    });
  } catch (err) {
    console.error('Signup error:', err);

    if (String(err.message).includes('UNIQUE')) {
      return resSend(req, res, 'Sign Up',
        msg('Email already registered. Please login.', 'error'),
        null, 409);
    }

    res.status(500).send('Account creation failed. Please try again.');
  }
});

// LOGIN PAGE
app.get('/login', (req, res) => {
  const body = `
    <section class="card">
      <h2>Login to MOONET</h2>

      <form method="POST" action="/login">
        ${csrfField(req)}

        <label for="email">Email address</label>
        <input id="email" name="email"
          type="email" maxlength="190"
          required autocomplete="email">

        <label for="password">Password</label>
        <input id="password" name="password"
          type="password" required
          autocomplete="current-password">

        <button type="submit">Login</button>
      </form>

      <p class="muted">
        New to MOONET? <a href="/signup">Create an account</a>.
      </p>
    </section>
  `;

  render(res, 'Login', body, null, req);
});

// LOGIN
app.post('/login', validateCsrf, (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');

    if (!email || !password) {
      return resSend(req, res, 'Login',
        msg('Enter your email and password.', 'error'),
        null, 400);
    }

    const user = get(
      `SELECT id, email, password, suspended
       FROM users
       WHERE email = ?`,
      email
    );

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return resSend(req, res, 'Login',
        msg('Invalid email or password.', 'error'),
        null, 401);
    }

    if (Number(user.suspended) === 1) {
      return resSend(req, res, 'Login',
        msg('Your account has been suspended.', 'error'),
        null, 403);
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('Login session error:', err);
        return res.status(500).send('Login failed. Please try again.');
      }

      req.session.userId = Number(user.id);
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Login save error:', saveErr);
          return res.status(500).send('Login failed. Please try again.');
        }

        res.redirect('/app');
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Login failed. Please try again.');
  }
});

// LOGOUT
app.post('/logout', validateCsrf, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).send('Unable to logout right now.');
    }

    res.clearCookie('moonet.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });

    res.redirect('/?msg=' + encodeURIComponent('You have logged out.'));
  });
});

// ==============================
// USER DASHBOARD
// ==============================

app.get('/app', requireUser, (req, res) => {
  const user = req.user;

  const totalLikes = get(
    `SELECT COUNT(*) AS total
     FROM video_likes
     WHERE video_id IN (
       SELECT id FROM videos WHERE user_id = ?
     )`,
    user.id
  );

  const myVideos = get(
    'SELECT COUNT(*) AS total FROM videos WHERE user_id = ?',
    user.id
  );

  const recentTransactions = all(
    `SELECT type, amount, description, created_at
     FROM transactions
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    user.id
  );

  const recentHtml = recentTransactions.length
    ? recentTransactions.map((t) => `
        <tr>
          <td>${esc(t.type || 'activity')}</td>
          <td>${fmt(Number(t.amount || 0))} MOONS</td>
          <td>${esc(t.description || '')}</td>
          <td>${esc(t.created_at || '')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4">No transactions yet.</td></tr>';

  const body = `
    <section class="card">
      <h2>Your MOONET Dashboard 🌙</h2>
      <p>Welcome back, ${esc(user.name)}.</p>

      <div class="grid">
        <div class="stat">
          <span class="muted">Wallet Balance</span>
          <strong>${fmt(Number(user.moon || 0))}</strong>
          <span>MOONS</span>
        </div>

        <div class="stat">
          <span class="muted">Like Rewards</span>
          <strong>${fmt(Number(user.like_moon || 0))}</strong>
          <span>MOONS</span>
        </div>

        <div class="stat">
          <span class="muted">Watch Rewards</span>
          <strong>${fmt(Number(user.watch_moon || 0))}</strong>
          <span>MOONS</span>
        </div>

        <div class="stat">
          <span class="muted">Listen Rewards</span>
          <strong>${fmt(Number(user.listen_moon || 0))}</strong>
          <span>MOONS</span>
        </div>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <h3>🎬 Your Content</h3>
        <p>You have published <strong>${Number(myVideos.total || 0)}</strong> posts.</p>
        <a class="button" href="/feed">Open Feed</a>
      </div>

      <div class="card">
        <h3>❤️ Likes</h3>
        <p>Your posts have received <strong>${Number(totalLikes.total || 0)}</strong> likes.</p>
        <p class="muted">
          Like rewards begin only after a post reaches 1,000 likes.
        </p>
      </div>

      <div class="card">
        <h3>💰 Wallet</h3>
        <p>Check your MOONS and withdrawal options.</p>
        <a class="button" href="/wallet">Open Wallet</a>
      </div>
    </section>

    <section class="card">
      <h3>Recent Activity</h3>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Description</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${recentHtml}</tbody>
        </table>
      </div>

      <p><a href="/transactions">View transaction history →</a></p>
    </section>

    <section class="card">
      <h3>Invite Friends</h3>
      <p>Your referral code:</p>
      <p><strong>${esc(user.referral_code || '')}</strong></p>
      <p class="muted">
        Share this code with friends when they create their MOONET accounts.
      </p>
    </section>
  `;

  render(res, 'Dashboard', body, user, req);
});
// ==============================
// MOONET — IGICE CYA 4
// PROFILE, WALLET, HISTORY
// ==============================

// ==============================
// PROFILE PAGE
// ==============================

app.get('/profile', requireUser, (req, res) => {
  const user = req.user;

  const postCount = get(
    'SELECT COUNT(*) AS total FROM videos WHERE user_id = ?',
    user.id
  );

  const followerCount = get(
    'SELECT COUNT(*) AS total FROM follows WHERE following_id = ?',
    user.id
  );

  const followingCount = get(
    'SELECT COUNT(*) AS total FROM follows WHERE follower_id = ?',
    user.id
  );

  const body = `
    <section class="card">
      <h2>👤 My Profile</h2>

      <p><strong>Name:</strong> ${esc(user.name || '')}</p>
      <p><strong>Email:</strong> ${esc(user.email || '')}</p>
      <p><strong>Referral Code:</strong>
        ${esc(user.referral_code || '')}
      </p>

      <div class="grid">
        <div class="stat">
          <span class="muted">Published Posts</span>
          <strong>${Number(postCount?.total || 0)}</strong>
        </div>

        <div class="stat">
          <span class="muted">Followers</span>
          <strong>${Number(followerCount?.total || 0)}</strong>
        </div>

        <div class="stat">
          <span class="muted">Following</span>
          <strong>${Number(followingCount?.total || 0)}</strong>
        </div>
      </div>
    </section>

    <section class="card">
      <h3>Update Profile</h3>

      <form method="POST" action="/profile">
        ${csrfField(req)}

        <label for="name">Display Name</label>
        <input
          id="name"
          name="name"
          value="${esc(user.name || '')}"
          minlength="2"
          maxlength="80"
          required
        >

        <button type="submit">Save Profile</button>
      </form>
    </section>

    <section class="card">
      <h3>Reward Balances</h3>

      <p>Wallet: <strong>${fmt(Number(user.moon || 0))} MOONS</strong></p>
      <p>Like rewards: ${fmt(Number(user.like_moon || 0))} MOONS</p>
      <p>Watch rewards: ${fmt(Number(user.watch_moon || 0))} MOONS</p>
      <p>Listen rewards: ${fmt(Number(user.listen_moon || 0))} MOONS</p>

      <a class="button" href="/wallet">Open Wallet</a>
    </section>
  `;

  render(res, 'My Profile', body, user, req);
});

// ==============================
// UPDATE PROFILE
// ==============================

app.post('/profile', requireUser, validateCsrf, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();

    if (name.length < 2 || name.length > 80) {
      return resSend(
        req,
        res,
        'My Profile',
        msg('Your name must contain 2–80 characters.', 'error'),
        req.user,
        400
      );
    }

    run(
      'UPDATE users SET name = ? WHERE id = ?',
      name,
      req.user.id
    );

    res.redirect('/profile?msg=' +
      encodeURIComponent('Profile updated successfully.'));
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).send('Unable to update your profile.');
  }
});

// ==============================
// WALLET PAGE
// ==============================

app.get('/wallet', requireUser, (req, res) => {
  const user = req.user;

  const pending = get(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM withdrawals
     WHERE user_id = ? AND status = 'pending'`,
    user.id
  );

  const completed = get(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM withdrawals
     WHERE user_id = ? AND status = 'paid'`,
    user.id
  );

  const minimumRwf = MIN_WITHDRAWAL_MOON * MOON_VALUE_RWF;

  const body = `
    <section class="card">
      <h2>🌙 My Wallet</h2>

      <div class="grid">
        <div class="stat">
          <span class="muted">Available MOONS</span>
          <strong>${fmt(Number(user.moon || 0))}</strong>
          <span>MOONS</span>
        </div>

        <div class="stat">
          <span class="muted">Estimated Value</span>
          <strong>${fmt(Number(user.moon || 0) * MOON_VALUE_RWF)}</strong>
          <span>RWF</span>
        </div>

        <div class="stat">
          <span class="muted">Pending Withdrawals</span>
          <strong>${fmt(Number(pending?.total || 0))}</strong>
          <span>MOONS</span>
        </div>

        <div class="stat">
          <span class="muted">Paid Withdrawals</span>
          <strong>${fmt(Number(completed?.total || 0))}</strong>
          <span>MOONS</span>
        </div>
      </div>

      <p class="muted">
        Estimated conversion: 1 MOON = ${MOON_VALUE_RWF} RWF.
        The actual payout depends on withdrawal approval and payment availability.
      </p>
    </section>

    <section class="card">
      <h3>Request Withdrawal</h3>

      <p>
        Minimum withdrawal:
        <strong>${fmt(MIN_WITHDRAWAL_MOON)} MOONS</strong>
        (${fmt(minimumRwf)} RWF estimated).
      </p>

      <form method="POST" action="/withdraw">
        ${csrfField(req)}

        <label for="amount">Amount (MOONS)</label>
        <input
          id="amount"
          name="amount"
          type="number"
          min="${MIN_WITHDRAWAL_MOON}"
          max="${Math.floor(Number(user.moon || 0))}"
          step="1"
          required
        >

        <label for="method">Payment Method</label>
        <select id="method" name="method" required>
          <option value="">Choose a method</option>
          <option value="MTN MoMo">MTN Mobile Money</option>
          <option value="Airtel Money">Airtel Money</option>
          <option value="Bank Transfer">Bank Transfer</option>
          <option value="Other">Other</option>
        </select>

        <label for="account">Payment Account / Number</label>
        <input
          id="account"
          name="account"
          maxlength="150"
          required
          autocomplete="off"
        >

        <button type="submit">Request Withdrawal</button>
      </form>

      <p class="muted">
        A withdrawal request is not proof of payment.
        Wait for the administrator to process it.
      </p>
    </section>

    <section class="card">
      <h3>Reward Breakdown</h3>
      <p>❤️ Like rewards: ${fmt(Number(user.like_moon || 0))} MOONS</p>
      <p>🎬 Watch rewards: ${fmt(Number(user.watch_moon || 0))} MOONS</p>
      <p>🎵 Listen rewards: ${fmt(Number(user.listen_moon || 0))} MOONS</p>

      <a class="button" href="/transactions">View History</a>
    </section>
  `;

  render(res, 'Wallet', body, user, req);
});

// ==============================
// WITHDRAWAL REQUEST
// ==============================

app.post('/withdraw', requireUser, validateCsrf, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const method = String(req.body.method || '').trim();
    const account = String(req.body.account || '').trim();

    const allowedMethods = [
      'MTN MoMo',
      'Airtel Money',
      'Bank Transfer',
      'Other'
    ];

    if (
      !Number.isSafeInteger(amount) ||
      amount < MIN_WITHDRAWAL_MOON
    ) {
      return resSend(
        req,
        res,
        'Wallet',
        msg(
          `The minimum withdrawal is ${MIN_WITHDRAWAL_MOON} MOONS.`,
          'error'
        ),
        req.user,
        400
      );
    }

    if (!allowedMethods.includes(method)) {
      return resSend(
        req,
        res,
        'Wallet',
        msg('Choose a valid payment method.', 'error'),
        req.user,
        400
      );
    }

    if (account.length < 3 || account.length > 150) {
      return resSend(
        req,
        res,
        'Wallet',
        msg('Enter valid payment account details.', 'error'),
        req.user,
        400
      );
    }

    transaction(() => {
      const currentUser = get(
        'SELECT moon FROM users WHERE id = ?',
        req.user.id
      );

      if (!currentUser || Number(currentUser.moon) < amount) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // Reserve the amount immediately so it cannot be withdrawn twice.
      const update = run(
        `UPDATE users
         SET moon = moon - ?
         WHERE id = ? AND moon >= ?`,
        amount,
        req.user.id,
        amount
      );

      if (Number(update.changes || 0) !== 1) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      run(
        `INSERT INTO withdrawals
         (user_id, amount, method, account, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
        req.user.id,
        amount,
        method,
        account
      );

      run(
        `INSERT INTO transactions
         (user_id, type, amount, description, created_at)
         VALUES (?, 'withdrawal', ?, ?, datetime('now'))`,
        req.user.id,
        -amount,
        `Withdrawal requested via ${method}`
      );
    });

    res.redirect('/wallet?msg=' +
      encodeURIComponent('Withdrawal request submitted successfully.'));
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return resSend(
        req,
        res,
        'Wallet',
        msg('You do not have enough available MOONS.', 'error'),
        req.user,
        400
      );
    }

    console.error('Withdrawal request error:', err);
    res.status(500).send(
      'Unable to submit withdrawal. Please check the server logs.'
    );
  }
});

// ==============================
// TRANSACTION HISTORY
// ==============================

app.get('/transactions', requireUser, (req, res) => {
  const records = all(
    `SELECT id, type, amount, description, created_at
     FROM transactions
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 200`,
    req.user.id
  );

  const rows = records.length
    ? records.map((item) => {
        const amount = Number(item.amount || 0);
        const sign = amount > 0 ? '+' : '';

        return `
          <tr>
            <td>${esc(item.type || 'activity')}</td>
            <td>${esc(sign + fmt(amount))} MOONS</td>
            <td>${esc(item.description || '')}</td>
            <td>${esc(item.created_at || '')}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="4">No transactions found.</td></tr>';

  const body = `
    <section class="card">
      <h2>📜 Transaction History</h2>

      <p class="muted">
        Your latest 200 wallet transactions.
      </p>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Description</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <p><a href="/wallet">← Back to Wallet</a></p>
    </section>
  `;

  render(res, 'Transaction History', body, req.user, req);
});
// ==============================
// MOONET — IGICE CYA 5
// FEED, POSTS, VIDEO, PHOTO, AUDIO
// ==============================

// Create additional safe tables for listening sessions.
// Existing tables and user data are preserved.
db.exec(`
  CREATE TABLE IF NOT EXISTS listen_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stream_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, user_id, stream_date)
  );

  CREATE INDEX IF NOT EXISTS idx_videos_user
  ON videos(user_id);

  CREATE INDEX IF NOT EXISTS idx_video_likes_video
  ON video_likes(video_id);

  CREATE INDEX IF NOT EXISTS idx_video_comments_video
  ON video_comments(video_id);

  CREATE INDEX IF NOT EXISTS idx_follows_following
  ON follows(following_id);
`);

// ==============================
// FEED PAGE
// ==============================

app.get('/feed', requireUser, (req, res) => {
  try {
    const posts = all(`
      SELECT
        v.*,
        u.name AS creator_name,
        u.referral_code AS creator_referral,
        (SELECT COUNT(*)
         FROM video_likes l
         WHERE l.video_id = v.id) AS like_count,
        (SELECT COUNT(*)
         FROM video_comments c
         WHERE c.video_id = v.id) AS comment_count,
        (SELECT COUNT(*)
         FROM video_streams s
         WHERE s.video_id = v.id) AS stream_count,
        EXISTS(
          SELECT 1
          FROM video_likes mine
          WHERE mine.video_id = v.id
            AND mine.user_id = ?
        ) AS liked_by_me,
        EXISTS(
          SELECT 1
          FROM follows f
          WHERE f.follower_id = ?
            AND f.following_id = v.user_id
        ) AS following_creator
      FROM videos v
      JOIN users u ON u.id = v.user_id
      ORDER BY v.id DESC
      LIMIT 100
    `, req.user.id, req.user.id);

    const postHtml = posts.map((post) => {
      const mediaType = String(post.media_type || 'text').toLowerCase();
      const mediaUrl = String(post.media_url || post.file_path || '');
      let mediaHtml = '';

      if (mediaType === 'video' && mediaUrl) {
        mediaHtml = `
          <video
            controls
            preload="metadata"
            playsinline
            data-moonet-video="${Number(post.id)}"
            src="${esc(mediaUrl)}"
          ></video>
          <p class="muted">
            Watch rewards are available only after qualifying playback.
          </p>
        `;
      } else if (mediaType === 'photo' && mediaUrl) {
        mediaHtml = `
          <img class="feed-photo"
               src="${esc(mediaUrl)}"
               alt="Post image"
               loading="lazy">
        `;
      } else if (mediaType === 'audio' && mediaUrl) {
        mediaHtml = `
          <audio
            controls
            preload="metadata"
            data-moonet-audio="${Number(post.id)}"
            src="${esc(mediaUrl)}"
          ></audio>
          <p class="muted">
            Listen rewards are available only after qualifying playback.
          </p>
        `;
      } else {
        mediaHtml = `
          <div class="text-post">
            ${esc(post.content || 'Shared on MOONET')}
          </div>
        `;
      }

      const likeButton = `
        <form class="inline"
              method="POST"
              action="/videos/${Number(post.id)}/like">
          ${csrfField(req)}
          <button type="submit">
            ${Number(post.liked_by_me) ? 'Unlike' : '❤️ Like'}
            (${Number(post.like_count || 0)})
          </button>
        </form>
      `;

      const followButton = Number(post.user_id) !== Number(req.user.id)
        ? `
          <form class="inline"
                method="POST"
                action="/users/${Number(post.user_id)}/follow">
            ${csrfField(req)}
            <button type="submit">
              ${Number(post.following_creator) ? 'Unfollow' : 'Follow'}
            </button>
          </form>
        `
        : '';

      const comments = all(`
        SELECT c.id, c.comment, c.created_at, u.name
        FROM video_comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.video_id = ?
        ORDER BY c.id DESC
        LIMIT 10
      `, post.id);

      const commentsHtml = comments.map((comment) => `
        <div class="message">
          <strong>${esc(comment.name || 'User')}</strong>
          <p>${esc(comment.comment || '')}</p>
          <small class="muted">${esc(comment.created_at || '')}</small>
        </div>
      `).join('');

      return `
        <article class="card">
          <h3>${esc(post.creator_name || 'MOONET Creator')}</h3>
          <p class="muted">
            ${esc(post.created_at || '')}
            · ${Number(post.stream_count || 0)} recorded qualifying views
          </p>

          ${mediaHtml}

          ${post.content && mediaType !== 'text'
            ? `<p>${esc(post.content)}</p>`
            : ''}

          <div class="actions">
            ${likeButton}
            ${followButton}
            <span class="muted">
              ${Number(post.comment_count || 0)} comments
            </span>
          </div>

          <hr>

          <h4>Comments</h4>
          ${commentsHtml || '<p class="muted">No comments yet.</p>'}

          <form method="POST"
                action="/videos/${Number(post.id)}/comments">
            ${csrfField(req)}
            <label for="comment-${Number(post.id)}">Add a comment</label>
            <textarea
              id="comment-${Number(post.id)}"
              name="comment"
              maxlength="1000"
              required
            ></textarea>
            <button type="submit">Post Comment</button>
          </form>
        </article>
      `;
    }).join('');

    const body = `
      <section class="card">
        <h2>🌍 MOONET Feed</h2>
        <p>Discover videos, photos, music, and stories.</p>
        <a class="button" href="/videos/new">Create a Post</a>
      </section>

      ${postHtml || `
        <section class="card">
          <h3>No posts yet</h3>
          <p>Be the first to share something with MOONET.</p>
          <a class="button" href="/videos/new">Create a Post</a>
        </section>
      `}
    `;

    render(res, 'Feed', body, req.user, req);
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).send('Unable to load the feed.');
  }
});

// ==============================
// CREATE POST PAGE
// ==============================

app.get('/videos/new', requireUser, (req, res) => {
  const body = `
    <section class="card">
      <h2>➕ Create a Post</h2>

      <form method="POST"
            action="/videos"
            enctype="multipart/form-data">

        ${csrfField(req)}

        <label for="media_type">Post Type</label>
        <select id="media_type" name="media_type" required>
          <option value="text">Text</option>
          <option value="photo">Photo</option>
          <option value="video">Video</option>
          <option value="audio">Audio / Music</option>
        </select>

        <label for="content">Caption or Text</label>
        <textarea
          id="content"
          name="content"
          maxlength="5000"
          placeholder="What would you like to share?"
        ></textarea>

        <label for="media">Upload Media (optional for text posts)</label>
        <input
          id="media"
          name="media"
          type="file"
          accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp,image/gif,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm"
        >

        <button type="submit">Publish Post</button>
      </form>

      <p class="muted">
        Maximum upload size: 100 MB.
        Only upload content you own or have permission to share.
      </p>
    </section>
  `;

  render(res, 'Create Post', body, req.user, req);
});

// ==============================
// CREATE POST
// ==============================

app.post(
  '/videos',
  requireUser,
  upload.single('media'),
  validateCsrf,
  (req, res) => {
    try {
      const mediaType = String(req.body.media_type || 'text').toLowerCase();
      const content = String(req.body.content || '').trim();

      const allowedTypes = ['text', 'photo', 'video', 'audio'];

      if (!allowedTypes.includes(mediaType)) {
        if (req.file) {
          fs.unlink(req.file.path, () => {});
        }

        return resSend(
          req,
          res,
          'Create Post',
          msg('Choose a valid post type.', 'error'),
          req.user,
          400
        );
      }

      if (content.length > 5000) {
        if (req.file) {
          fs.unlink(req.file.path, () => {});
        }

        return resSend(
          req,
          res,
          'Create Post',
          msg('Your caption is too long.', 'error'),
          req.user,
          400
        );
      }

      if (mediaType !== 'text' && !req.file) {
        return resSend(
          req,
          res,
          'Create Post',
          msg('Please upload a file for this post type.', 'error'),
          req.user,
          400
        );
      }

      if (mediaType === 'text' && !content) {
        return resSend(
          req,
          res,
          'Create Post',
          msg('Write some text before publishing.', 'error'),
          req.user,
          400
        );
      }

      if (req.file) {
        const mime = req.file.mimetype || '';

        const validForType =
          (mediaType === 'video' && mime.startsWith('video/')) ||
          (mediaType === 'photo' && mime.startsWith('image/')) ||
          (mediaType === 'audio' && mime.startsWith('audio/'));

        if (!validForType) {
          fs.unlink(req.file.path, () => {});

          return resSend(
            req,
            res,
            'Create Post',
            msg('The uploaded file does not match the selected type.', 'error'),
            req.user,
            400
          );
        }
      }

      const mediaUrl = req.file
        ? '/uploads/' + path.basename(req.file.filename)
        : null;

      run(
        `INSERT INTO videos
         (user_id, content, media_url, media_type, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        req.user.id,
        content,
        mediaUrl,
        mediaType
      );

      res.redirect('/feed?msg=' +
        encodeURIComponent('Your post was published.'));
    } catch (err) {
      console.error('Create post error:', err);

      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }

      res.status(500).send('Unable to publish your post.');
    }
  }
);
// =============================================
// MOONET — IGICE CYA 6
// LIKE SYSTEM & LIKE REWARDS
// =============================================

// Preserve existing data. Do not delete existing tables.
db.exec(`
  CREATE TABLE IF NOT EXISTS like_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS like_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    liker_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    moon REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, liker_id)
  );

  CREATE INDEX IF NOT EXISTS idx_like_rewards_creator
  ON like_rewards(creator_id);

  CREATE INDEX IF NOT EXISTS idx_like_history_video
  ON like_history(video_id);
`);

// Existing likes must be recorded so removing and restoring
// a like cannot create another reward.
db.exec(`
  INSERT OR IGNORE INTO like_history (video_id, user_id)
  SELECT video_id, user_id
  FROM video_likes;
`);

// =============================================
// LIKE / UNLIKE A POST
// =============================================

app.post(
  '/videos/:id/like',
  requireUser,
  validateCsrf,
  (req, res) => {
    const videoId = Number(req.params.id);
    const userId = Number(req.user.id);

    if (!Number.isSafeInteger(videoId) || videoId <= 0) {
      return res.status(400).send('Invalid post ID.');
    }

    try {
      const result = transaction(() => {
        const post = get(
          `SELECT id, user_id
           FROM videos
           WHERE id = ?`,
          videoId
        );

        if (!post) {
          throw new Error('POST_NOT_FOUND');
        }

        const creatorId = Number(post.user_id);

        // Users cannot like their own posts.
        if (creatorId === userId) {
          throw new Error('CANNOT_LIKE_OWN_POST');
        }

        const existingLike = get(
          `SELECT id
           FROM video_likes
           WHERE video_id = ? AND user_id = ?`,
          videoId,
          userId
        );

        // Unlike removes the current visible like.
        // It does not erase permanent like history or reverse
        // any reward that was legitimately earned earlier.
        if (existingLike) {
          run(
            `DELETE FROM video_likes
             WHERE video_id = ? AND user_id = ?`,
            videoId,
            userId
          );

          return {
            action: 'unliked',
            rewarded: false
          };
        }

        // A user can only create one valid like event per post.
        const previousLike = get(
          `SELECT id
           FROM like_history
           WHERE video_id = ? AND user_id = ?`,
          videoId,
          userId
        );

        if (previousLike) {
          throw new Error('LIKE_ALREADY_USED');
        }

        const likeCount = get(
          `SELECT COUNT(*) AS total
           FROM video_likes
           WHERE video_id = ?`,
          videoId
        );

        const likesBefore = Number(likeCount?.total || 0);

        run(
          `INSERT INTO video_likes
           (video_id, user_id)
           VALUES (?, ?)`,
          videoId,
          userId
        );

        run(
          `INSERT INTO like_history
           (video_id, user_id)
           VALUES (?, ?)`,
          videoId,
          userId
        );

        let rewarded = false;

        // First 1,000 likes are not paid.
        // The next valid, unique like can earn 1 MOON.
        if (likesBefore >= 1000) {
          const rewardExists = get(
            `SELECT id
             FROM like_rewards
             WHERE video_id = ? AND liker_id = ?`,
            videoId,
            userId
          );

          if (!rewardExists) {
            run(
              `INSERT INTO like_rewards
               (video_id, liker_id, creator_id, moon)
               VALUES (?, ?, ?, 1)`,
              videoId,
              userId,
              creatorId
            );

            run(
              `UPDATE users
               SET like_moon = COALESCE(like_moon, 0) + 1,
                   moon = COALESCE(moon, 0) + 1
               WHERE id = ?`,
              creatorId
            );

            run(
              `INSERT INTO transactions
               (user_id, type, amount, description, created_at)
               VALUES (?, 'like_reward', 1, ?, datetime('now'))`,
              creatorId,
              `Like reward for post #${videoId}`
            );

            rewarded = true;
          }
        }

        return {
          action: 'liked',
          rewarded
        };
      });

      let message;

      if (result.action === 'unliked') {
        message = 'You removed your like.';
      } else if (result.rewarded) {
        message = 'Like added. The creator earned 1 MOON!';
      } else {
        message = 'Like added successfully.';
      }

      return res.redirect(
        '/feed?msg=' + encodeURIComponent(message)
      );
    } catch (err) {
      if (err.message === 'POST_NOT_FOUND') {
        return res.status(404).send('Post not found.');
      }

      if (err.message === 'CANNOT_LIKE_OWN_POST') {
        return res.redirect(
          '/feed?msg=' +
          encodeURIComponent('You cannot like your own post.')
        );
      }

      if (err.message === 'LIKE_ALREADY_USED') {
        return res.redirect(
          '/feed?msg=' +
          encodeURIComponent(
            'You already used your like on this post. No duplicate reward is allowed.'
          )
        );
      }

      console.error('Like processing error:', err);

      return res.status(500).send(
        'Unable to process your like. Please try again.'
      );
    }
  }
);
// =============================================
// MOONET — IGICE CYA 8
// MUSIC LISTENING REWARDS
// =============================================

const LISTEN_REWARD_MOON = 0.1;
const LISTEN_REQUIRED_SECONDS = 30;

// Preserve existing data.
db.exec(`
  CREATE TABLE IF NOT EXISTS listen_sessions (
    id TEXT PRIMARY KEY,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listen_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stream_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, user_id, stream_date)
  );

  CREATE INDEX IF NOT EXISTS idx_listen_sessions_user
  ON listen_sessions(user_id, video_id);

  CREATE INDEX IF NOT EXISTS idx_listen_streams_user
  ON listen_streams(user_id, video_id);
`);

// =============================================
// START LISTENING SESSION
// =============================================

app.post(
  '/videos/:id/listen/start',
  requireUser,
  validateCsrf,
  (req, res) => {
    try {
      const videoId = Number(req.params.id);
      const userId = Number(req.user.id);

      if (!Number.isSafeInteger(videoId) || videoId <= 0) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid audio post.'
        });
      }

      const audio = get(
        `SELECT id, user_id, media_type
         FROM videos
         WHERE id = ?`,
        videoId
      );

      if (
        !audio ||
        String(audio.media_type || '').toLowerCase() !== 'audio'
      ) {
        return res.status(404).json({
          ok: false,
          message: 'Audio post not found.'
        });
      }

      if (Number(audio.user_id) === userId) {
        return res.json({
          ok: true,
          eligible: false,
          message: 'You cannot earn listening rewards from your own audio.'
        });
      }

      const alreadyListened = get(
        `SELECT id
         FROM listen_streams
         WHERE video_id = ?
           AND user_id = ?
           AND stream_date = date('now')`,
        videoId,
        userId
      );

      if (alreadyListened) {
        return res.json({
          ok: true,
          eligible: false,
          message: 'You have already received today’s reward for this audio.'
        });
      }

      const sessionId = crypto.randomUUID();
      const startedAt = Date.now();

      run(
        `INSERT INTO listen_sessions
         (id, video_id, user_id, started_at, completed)
         VALUES (?, ?, ?, ?, 0)`,
        sessionId,
        videoId,
        userId,
        startedAt
      );

      return res.json({
        ok: true,
        eligible: true,
        sessionId,
        requiredSeconds: LISTEN_REQUIRED_SECONDS,
        message: 'Listening session started.'
      });
    } catch (err) {
      console.error('Listen start error:', err);

      return res.status(500).json({
        ok: false,
        message: 'Unable to start listening session.'
      });
    }
  }
);

// =============================================
// COMPLETE LISTENING SESSION
// =============================================

app.post(
  '/videos/:id/listen/complete',
  requireUser,
  validateCsrf,
  (req, res) => {
    try {
      const videoId = Number(req.params.id);
      const userId = Number(req.user.id);
      const sessionId = String(req.body.sessionId || '');

      if (
        !Number.isSafeInteger(videoId) ||
        videoId <= 0 ||
        !sessionId
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid listening session.'
        });
      }

      const result = transaction(() => {
        const session = get(
          `SELECT *
           FROM listen_sessions
           WHERE id = ?
             AND video_id = ?
             AND user_id = ?`,
          sessionId,
          videoId,
          userId
        );

        if (!session) {
          throw new Error('LISTEN_SESSION_NOT_FOUND');
        }

        if (Number(session.completed) === 1) {
          throw new Error('LISTEN_SESSION_COMPLETED');
        }

        const elapsedSeconds =
          (Date.now() - Number(session.started_at)) / 1000;

        if (elapsedSeconds < LISTEN_REQUIRED_SECONDS) {
          throw new Error('LISTEN_TOO_SHORT');
        }

        const audio = get(
          `SELECT id, user_id, media_type
           FROM videos
           WHERE id = ?`,
          videoId
        );

        if (
          !audio ||
          String(audio.media_type || '').toLowerCase() !== 'audio'
        ) {
          throw new Error('AUDIO_NOT_FOUND');
        }

        const creatorId = Number(audio.user_id);

        if (creatorId === userId) {
          throw new Error('OWN_AUDIO');
        }

        const existing = get(
          `SELECT id
           FROM listen_streams
           WHERE video_id = ?
             AND user_id = ?
             AND stream_date = date('now')`,
          videoId,
          userId
        );

        if (existing) {
          throw new Error('LISTEN_REWARD_ALREADY_PAID');
        }

        // Record today's qualifying listening.
        run(
          `INSERT INTO listen_streams
           (video_id, user_id, stream_date)
           VALUES (?, ?, date('now'))`,
          videoId,
          userId
        );

        // Mark the session completed before awarding.
        run(
          `UPDATE listen_sessions
           SET completed = 1
           WHERE id = ? AND completed = 0`,
          sessionId
        );

        // Add the reward to the creator-independent listener balance.
        run(
          `UPDATE users
           SET listen_moon = COALESCE(listen_moon, 0) + ?,
               moon = COALESCE(moon, 0) + ?
           WHERE id = ?`,
          LISTEN_REWARD_MOON,
          LISTEN_REWARD_MOON,
          userId
        );

        run(
          `INSERT INTO transactions
           (user_id, type, amount, description, created_at)
           VALUES (?, 'listen_reward', ?, ?, datetime('now'))`,
          userId,
          LISTEN_REWARD_MOON,
          `Listening reward for audio post #${videoId}`
        );

        return {
          rewarded: true,
          amount: LISTEN_REWARD_MOON
        };
      });

      return res.json({
        ok: true,
        rewarded: result.rewarded,
        amount: result.amount,
        currency: 'MOON',
        message: 'Congratulations! You earned 0.1 MOON.'
      });
    } catch (err) {
      if (err.message === 'LISTEN_SESSION_NOT_FOUND') {
        return res.status(404).json({
          ok: false,
          message: 'Listening session not found.'
        });
      }

      if (err.message === 'LISTEN_SESSION_COMPLETED') {
        return res.status(409).json({
          ok: false,
          message: 'This listening session has already been completed.'
        });
      }

      if (err.message === 'LISTEN_TOO_SHORT') {
        return res.status(400).json({
          ok: false,
          message: 'Listen for at least 30 seconds before claiming a reward.'
        });
      }

      if (err.message === 'AUDIO_NOT_FOUND') {
        return res.status(404).json({
          ok: false,
          message: 'Audio post not found.'
        });
      }

      if (err.message === 'OWN_AUDIO') {
        return res.status(403).json({
          ok: false,
          message: 'You cannot earn rewards by listening to your own audio.'
        });
      }

      if (err.message === 'LISTEN_REWARD_ALREADY_PAID') {
        return res.status(409).json({
          ok: false,
          message: 'You have already received today’s reward for this audio.'
        });
      }

      console.error('Listen completion error:', err);

      return res.status(500).json({
        ok: false,
        message: 'Unable to process the listening reward.'
      });
    }
  }
);

// =============================================
// LISTENING REWARD BALANCE
// =============================================

app.get('/listen-rewards', requireUser, (req, res) => {
  const user = get(
    `SELECT listen_moon, moon
     FROM users
     WHERE id = ?`,
    req.user.id
  );

  const body = `
    <section class="card">
      <h2>🎵 Listening Rewards</h2>

      <div class="grid">
        <div class="stat">
          <span class="muted">Listening Rewards</span>
          <strong>${fmt(Number(user?.listen_moon || 0))}</strong>
          <span>MOONS</span>
        </div>

        <div class="stat">
          <span class="muted">Total Wallet Balance</span>
          <strong>${fmt(Number(user?.moon || 0))}</strong>
          <span>MOONS</span>
        </div>
      </div>

      <p>
        Reward rate: ${LISTEN_REWARD_MOON} MOON per qualifying listen.
      </p>

      <p>
        Minimum listening duration:
        ${LISTEN_REQUIRED_SECONDS} seconds.
      </p>

      <p class="muted">
        Rewards are limited to one qualifying listen per audio post
        per user per day.
      </p>

      <a class="button" href="/feed">Return to Feed</a>
    </section>
  `;

  render(res, 'Listening Rewards', body, req.user, req);
});
// =============================================
// MOONET — IGICE CYA 9
// COMMENTS, FOLLOWS & GIFTS
// =============================================

// =============================================
// ADD COMMENT
// =============================================

app.post(
  '/videos/:id/comments',
  requireUser,
  validateCsrf,
  (req, res) => {
    try {
      const videoId = Number(req.params.id);
      const userId = Number(req.user.id);
      const comment = String(req.body.comment || '').trim();

      if (!Number.isSafeInteger(videoId) || videoId <= 0) {
        return res.status(400).send('Invalid post ID.');
      }

      if (!comment || comment.length > 1000) {
        return res.redirect(
          '/feed?msg=' +
          encodeURIComponent('Comment must contain 1–1000 characters.')
        );
      }

      const post = get(
        'SELECT id FROM videos WHERE id = ?',
        videoId
      );

      if (!post) {
        return res.status(404).send('Post not found.');
      }

      run(
        `INSERT INTO video_comments
         (video_id, user_id, comment, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
        videoId,
        userId,
        comment
      );

      res.redirect('/feed?msg=' +
        encodeURIComponent('Comment posted successfully.'));
    } catch (err) {
      console.error('Comment error:', err);
      res.status(500).send('Unable to post your comment.');
    }
  }
);

// =============================================
// FOLLOW / UNFOLLOW USER
// =============================================

app.post(
  '/users/:id/follow',
  requireUser,
  validateCsrf,
  (req, res) => {
    try {
      const followerId = Number(req.user.id);
      const followingId = Number(req.params.id);

      if (
        !Number.isSafeInteger(followingId) ||
        followingId <= 0
      ) {
        return res.status(400).send('Invalid user ID.');
      }

      if (followerId === followingId) {
        return res.redirect(
          '/feed?msg=' +
          encodeURIComponent('You cannot follow yourself.')
        );
      }

      const target = get(
        'SELECT id FROM users WHERE id = ? AND suspended = 0',
        followingId
      );

      if (!target) {
        return res.status(404).send('User not found.');
      }

      const existing = get(
        `SELECT id
         FROM follows
         WHERE follower_id = ? AND following_id = ?`,
        followerId,
        followingId
      );

      if (existing) {
        run(
          `DELETE FROM follows
           WHERE follower_id = ? AND following_id = ?`,
          followerId,
          followingId
        );

        return res.redirect(
          '/feed?msg=' + encodeURIComponent('You unfollowed this creator.')
        );
      }

      run(
        `INSERT INTO follows
         (follower_id, following_id, created_at)
         VALUES (?, ?, datetime('now'))`,
        followerId,
        followingId
      );

      res.redirect(
        '/feed?msg=' + encodeURIComponent('You are now following this creator.')
      );
    } catch (err) {
      console.error('Follow error:', err);

      if (String(err.message).includes('UNIQUE')) {
        return res.redirect('/feed');
      }

      res.status(500).send('Unable to update follow status.');
    }
  }
);

// =============================================
// SEND MOON GIFT PAGE
// =============================================

app.get('/gifts', requireUser, (req, res) => {
  const users = all(
    `SELECT id, name, email
     FROM users
     WHERE id != ? AND suspended = 0
     ORDER BY name
     LIMIT 200`,
    req.user.id
  );

  const options = users.map((u) => `
    <option value="${Number(u.id)}">
      ${esc(u.name || u.email)}
    </option>
  `).join('');

  const body = `
    <section class="card">
      <h2>🎁 Send MOONS</h2>

      <p>
        Available wallet balance:
        <strong>${fmt(Number(req.user.moon || 0))} MOONS</strong>
      </p>

      <form method="POST" action="/gifts">
        ${csrfField(req)}

        <label for="recipient_id">Choose recipient</label>
        <select id="recipient_id" name="recipient_id" required>
          <option value="">Select a user</option>
          ${options}
        </select>

        <label for="amount">Amount in MOONS</label>
        <input
          id="amount"
          name="amount"
          type="number"
          min="1"
          step="1"
          max="${Math.floor(Number(req.user.moon || 0))}"
          required
        >

        <label for="message">Message (optional)</label>
        <textarea
          id="message"
          name="message"
          maxlength="300"
        ></textarea>

        <button type="submit">Send Gift</button>
      </form>
    </section>
  `;

  render(res, 'Send Gifts', body, req.user, req);
});

// =============================================
// SEND MOON GIFT
// =============================================

app.post(
  '/gifts',
  requireUser,
  validateCsrf,
  (req, res) => {
    try {
      const senderId = Number(req.user.id);
      const recipientId = Number(req.body.recipient_id);
      const amount = Number(req.body.amount);
      const message = String(req.body.message || '').trim();

      if (
        !Number.isSafeInteger(recipientId) ||
        recipientId <= 0 ||
        recipientId === senderId
      ) {
        return res.redirect(
          '/gifts?msg=' +
          encodeURIComponent('Choose a valid recipient.')
        );
      }

      if (
        !Number.isSafeInteger(amount) ||
        amount < 1
      ) {
        return res.redirect(
          '/gifts?msg=' +
          encodeURIComponent('Gift amount must be at least 1 MOON.')
        );
      }

      if (message.length > 300) {
        return res.redirect(
          '/gifts?msg=' +
          encodeURIComponent('Your message is too long.')
        );
      }

      transaction(() => {
        const recipient = get(
          `SELECT id
           FROM users
           WHERE id = ? AND suspended = 0`,
          recipientId
        );

        if (!recipient) {
          throw new Error('RECIPIENT_NOT_FOUND');
        }

        const sender = get(
          'SELECT moon FROM users WHERE id = ?',
          senderId
        );

        if (!sender || Number(sender.moon || 0) < amount) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        const debit = run(
          `UPDATE users
           SET moon = moon - ?
           WHERE id = ? AND moon >= ?`,
          amount,
          senderId,
          amount
        );

        if (Number(debit.changes || 0) !== 1) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        run(
          `UPDATE users
           SET moon = moon + ?
           WHERE id = ?`,
          amount,
          recipientId
        );

        run(
          `INSERT INTO gifts
           (sender_id, recipient_id, amount, message, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
          senderId,
          recipientId,
          amount,
          message
        );

        run(
          `INSERT INTO transactions
           (user_id, type, amount, description, created_at)
           VALUES (?, 'gift_sent', ?, ?, datetime('now'))`,
          senderId,
          -amount,
          `Gift sent to user #${recipientId}`
        );

        run(
          `INSERT INTO transactions
           (user_id, type, amount, description, created_at)
           VALUES (?, 'gift_received', ?, ?, datetime('now'))`,
          recipientId,
          amount,
          `Gift received from user #${senderId}`
        );
      });

      res.redirect(
        '/gifts?msg=' + encodeURIComponent('Your MOON gift was sent successfully.')
      );
    } catch (err) {
      if (err.message === 'RECIPIENT_NOT_FOUND') {
        return res.redirect(
          '/gifts?msg=' + encodeURIComponent('Recipient not found.')
        );
      }

      if (err.message === 'INSUFFICIENT_BALANCE') {
        return res.redirect(
          '/gifts?msg=' + encodeURIComponent('You do not have enough MOONS.')
        );
      }

      console.error('Gift error:', err);
      res.status(500).send('Unable to send the gift.');
    }
  }
);

// =============================================
// GIFT HISTORY
// =============================================

app.get('/gifts/history', requireUser, (req, res) => {
  const records = all(
    `SELECT
       g.id,
       g.amount,
       g.message,
       g.created_at,
       s.name AS sender_name,
       r.name AS recipient_name
     FROM gifts g
     JOIN users s ON s.id = g.sender_id
     JOIN users r ON r.id = g.recipient_id
     WHERE g.sender_id = ? OR g.recipient_id = ?
     ORDER BY g.id DESC
     LIMIT 100`,
    req.user.id,
    req.user.id
  );

  const rows = records.map((g) => {
    const sent = Number(g.sender_id) === Number(req.user.id);

    return `
      <tr>
        <td>${esc(g.sender_name || 'User')}</td>
        <td>${esc(g.recipient_name || 'User')}</td>
        <td>${fmt(Number(g.amount || 0))} MOONS</td>
        <td>${esc(g.message || '')}</td>
        <td>${esc(g.created_at || '')}</td>
      </tr>
    `;
  }).join('');

  const body = `
    <section class="card">
      <h2>🎁 Gift History</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Sender</th>
              <th>Recipient</th>
              <th>Amount</th>
              <th>Message</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5">No gifts yet.</td></tr>'}
          </tbody>
        </table>
      </div>

      <a class="button" href="/gifts">Send a Gift</a>
    </section>
  `;

  render(res, 'Gift History', body, req.user, req);
});
// ==========================================
// MOONET — PART 10: ADMIN DASHBOARD
// ==========================================

// Admin Dashboard
app.get('/admin', requireAdmin, (req, res) => {
  try {
    const users = get(`
      SELECT COUNT(*) AS total
      FROM users
    `)?.total || 0;

    const totalMoons = get(`
      SELECT COALESCE(SUM(moon), 0) AS total
      FROM users
    `)?.total || 0;

    const totalRevenue = get(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM revenue
    `)?.total || 0;

    const totalExpenses = get(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM expenses
    `)?.total || 0;

    const pendingWithdrawals = get(`
      SELECT COUNT(*) AS total
      FROM withdrawals
      WHERE LOWER(status) = 'pending'
    `)?.total || 0;

    const withdrawals = all(`
      SELECT
        w.*,
        u.name AS user_name,
        u.email AS user_email
      FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC
      LIMIT 100
    `);

    const recentUsers = all(`
      SELECT id, name, email, moon, created_at, suspended
      FROM users
      ORDER BY created_at DESC
      LIMIT 50
    `);

    const profit = Number(totalRevenue) - Number(totalExpenses);

    const withdrawalRows = withdrawals.map(w => `
      <tr>
        <td>${esc(w.user_name || 'Unknown')}</td>
        <td>${esc(w.user_email || '')}</td>
        <td>${fmt(w.amount)}</td>
        <td>${esc(w.status || 'pending')}</td>
        <td>
          ${
            String(w.status).toLowerCase() === 'pending'
              ? `
                <form method="POST"
                      action="/admin/withdrawals/${encodeURIComponent(w.id)}/paid"
                      style="display:inline">
                  ${csrfField(req)}
                  <button type="submit">Mark Paid</button>
                </form>

                <form method="POST"
                      action="/admin/withdrawals/${encodeURIComponent(w.id)}/reject"
                      style="display:inline">
                  ${csrfField(req)}
                  <button type="submit">Reject & Refund</button>
                </form>
              `
              : '-'
          }
        </td>
      </tr>
    `).join('');

    const userRows = recentUsers.map(u => `
      <tr>
        <td>${esc(u.name || '')}</td>
        <td>${esc(u.email || '')}</td>
        <td>${fmt(u.moon)}</td>
        <td>${u.suspended ? 'Suspended' : 'Active'}</td>
      </tr>
    `).join('');

    const content = `
      <h1>MOONET Admin Dashboard</h1>

      <div class="grid">
        <div class="card">
          <h3>Total Users</h3>
          <h2>${fmt(users)}</h2>
        </div>

        <div class="card">
          <h3>Total User MOONS</h3>
          <h2>${fmt(totalMoons)}</h2>
        </div>

        <div class="card">
          <h3>Total Revenue</h3>
          <h2>${fmt(totalRevenue)} RWF</h2>
        </div>

        <div class="card">
          <h3>Total Expenses</h3>
          <h2>${fmt(totalExpenses)} RWF</h2>
        </div>

        <div class="card">
          <h3>Profit / Loss</h3>
          <h2>${fmt(profit)} RWF</h2>
        </div>

        <div class="card">
          <h3>Pending Withdrawals</h3>
          <h2>${fmt(pendingWithdrawals)}</h2>
        </div>
      </div>

      <h2>Withdrawal Requests</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Amount (MOONS)</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${withdrawalRows || '<tr><td colspan="5">No withdrawals found.</td></tr>'}
          </tbody>
        </table>
      </div>

      <h2>Recent Users</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>MOONS</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${userRows || '<tr><td colspan="4">No users found.</td></tr>'}
          </tbody>
        </table>
      </div>

      <p>
        <a href="/admin/revenue">Manage Revenue</a> |
        <a href="/admin/expenses">Manage Expenses</a>
      </p>
    `;

    resSend(res, render('Admin Dashboard', content, req));

  } catch (err) {
    console.error('MOONET admin dashboard error:', err);
    res.status(500).send('Admin dashboard error. Check the server logs.');
  }
});


// Mark a withdrawal as paid
app.post('/admin/withdrawals/:id/paid', requireAdmin, (req, res) => {
  try {
    if (!validateCsrf(req, res)) return;

    transaction(() => {
      const withdrawal = get(`
        SELECT *
        FROM withdrawals
        WHERE id = ?
      `, req.params.id);

      if (!withdrawal) {
        throw new Error('Withdrawal not found.');
      }

      if (String(withdrawal.status).toLowerCase() !== 'pending') {
        throw new Error('This withdrawal has already been processed.');
      }

      run(`
        UPDATE withdrawals
        SET status = 'paid'
        WHERE id = ?
          AND LOWER(status) = 'pending'
      `, withdrawal.id);
    });

    return res.redirect('/admin');

  } catch (err) {
    console.error('Mark withdrawal paid error:', err);
    return res.status(400).send(esc(err.message || 'Unable to update withdrawal.'));
  }
});


// Reject a withdrawal and refund the user
app.post('/admin/withdrawals/:id/reject', requireAdmin, (req, res) => {
  try {
    if (!validateCsrf(req, res)) return;

    transaction(() => {
      const withdrawal = get(`
        SELECT *
        FROM withdrawals
        WHERE id = ?
      `, req.params.id);

      if (!withdrawal) {
        throw new Error('Withdrawal not found.');
      }

      if (String(withdrawal.status).toLowerCase() !== 'pending') {
        throw new Error('This withdrawal has already been processed.');
      }

      const amount = Number(withdrawal.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Invalid withdrawal amount.');
      }

      run(`
        UPDATE withdrawals
        SET status = 'rejected'
        WHERE id = ?
          AND LOWER(status) = 'pending'
      `, withdrawal.id);

      run(`
        UPDATE users
        SET moon = COALESCE(moon, 0) + ?
        WHERE id = ?
      `, amount, withdrawal.user_id);

      run(`
        INSERT INTO transactions
          (user_id, type, amount, description, created_at)
        VALUES (?, 'refund', ?, ?, ?)
      `,
        withdrawal.user_id,
        amount,
        'Refund for rejected withdrawal',
        Date.now()
      );
    });

    return res.redirect('/admin');

  } catch (err) {
    console.error('Reject withdrawal error:', err);
    return res.status(400).send(esc(err.message || 'Unable to reject withdrawal.'));
  }
});


// Revenue management page
app.get('/admin/revenue', requireAdmin, (req, res) => {
  try {
    const rows = all(`
      SELECT *
      FROM revenue
      ORDER BY created_at DESC
      LIMIT 200
    `);

    const total = get(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM revenue
    `)?.total || 0;

    const tableRows = rows.map(r => `
      <tr>
        <td>${esc(r.description || '')}</td>
        <td>${fmt(r.amount)} RWF</td>
        <td>${esc(r.created_at || '')}</td>
      </tr>
    `).join('');

    const content = `
      <h1>MOONET Revenue</h1>
      <div class="card">
        <h3>Total Revenue</h3>
        <h2>${fmt(total)} RWF</h2>
      </div>

      <form method="POST" action="/admin/revenue">
        ${csrfField(req)}
        <label>Description</label>
        <input name="description" required maxlength="200">

        <label>Amount (RWF)</label>
        <input name="amount" type="number" min="0.01" step="0.01" required>

        <button type="submit">Add Revenue</button>
      </form>

      <h2>Revenue History</h2>
      <table>
        <thead>
          <tr><th>Description</th><th>Amount</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="3">No revenue recorded.</td></tr>'}
        </tbody>
      </table>

      <p><a href="/admin">Back to Admin</a></p>
    `;

    resSend(res, render('MOONET Revenue', content, req));

  } catch (err) {
    console.error('Revenue page error:', err);
    res.status(500).send('Revenue page error. Check the server logs.');
  }
});


// Add revenue
app.post('/admin/revenue', requireAdmin, (req, res) => {
  try {
    if (!validateCsrf(req, res)) return;

    const description = String(req.body.description || '').trim();
    const amount = Number(req.body.amount);

    if (!description || description.length > 200 ||
        !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).send('Please provide a valid description and amount.');
    }

    run(`
      INSERT INTO revenue (description, amount, created_at)
      VALUES (?, ?, ?)
    `, description, amount, Date.now());

    return res.redirect('/admin/revenue');

  } catch (err) {
    console.error('Add revenue error:', err);
    return res.status(500).send('Unable to add revenue.');
  }
});


// Expense management page
app.get('/admin/expenses', requireAdmin, (req, res) => {
  try {
    const rows = all(`
      SELECT *
      FROM expenses
      ORDER BY created_at DESC
      LIMIT 200
    `);

    const total = get(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM expenses
    `)?.total || 0;

    const tableRows = rows.map(e => `
      <tr>
        <td>${esc(e.description || '')}</td>
        <td>${fmt(e.amount)} RWF</td>
        <td>${esc(e.created_at || '')}</td>
      </tr>
    `).join('');

    const content = `
      <h1>MOONET Expenses</h1>
      <div class="card">
        <h3>Total Expenses</h3>
        <h2>${fmt(total)} RWF</h2>
      </div>

      <form method="POST" action="/admin/expenses">
        ${csrfField(req)}
        <label>Description</label>
        <input name="description" required maxlength="200">

        <label>Amount (RWF)</label>
        <input name="amount" type="number" min="0.01" step="0.01" required>

        <button type="submit">Add Expense</button>
      </form>

      <h2>Expense History</h2>
      <table>
        <thead>
          <tr><th>Description</th><th>Amount</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="3">No expenses recorded.</td></tr>'}
        </tbody>
      </table>

      <p><a href="/admin">Back to Admin</a></p>
    `;

    resSend(res, render('MOONET Expenses', content, req));

  } catch (err) {
    console.error('Expenses page error:', err);
    res.status(500).send('Expenses page error. Check the server logs.');
  }
});


// Add expense
app.post('/admin/expenses', requireAdmin, (req, res) => {
  try {
    if (!validateCsrf(req, res)) return;

    const description = String(req.body.description || '').trim();
    const amount = Number(req.body.amount);

    if (!description || description.length > 200 ||
        !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).send('Please provide a valid description and amount.');
    }

    run(`
      INSERT INTO expenses (description, amount, created_at)
      VALUES (?, ?, ?)
    `, description, amount, Date.now());

    return res.redirect('/admin/expenses');

  } catch (err) {
    console.error('Add expense error:', err);
    return res.status(500).send('Unable to add expense.');
  }
});
// ==========================================
// MOONET — PART 11: USER MANAGEMENT
// ==========================================

// Admin: List and search users
app.get('/admin/users', requireAdmin, (req, res) => {
  try {
    const search = String(req.query.search || '').trim();

    let users;

    if (search) {
      const term = `%${search}%`;

      users = all(`
        SELECT id, name, email, moon, suspended, created_at
        FROM users
        WHERE name LIKE ? OR email LIKE ?
        ORDER BY created_at DESC
        LIMIT 200
      `, term, term);
    } else {
      users = all(`
        SELECT id, name, email, moon, suspended, created_at
        FROM users
        ORDER BY created_at DESC
        LIMIT 200
      `);
    }

    const rows = users.map(user => `
      <tr>
        <td>${esc(user.name || '')}</td>
        <td>${esc(user.email || '')}</td>
        <td>${fmt(user.moon || 0)} MOONS</td>
        <td>${user.suspended ? 'Suspended' : 'Active'}</td>
        <td>${esc(user.created_at || '')}</td>
        <td>
          <form method="POST"
                action="/admin/users/${encodeURIComponent(user.id)}/toggle-suspension">
            ${csrfField(req)}

            <button type="submit">
              ${user.suspended ? 'Reactivate' : 'Suspend'}
            </button>
          </form>
        </td>
      </tr>
    `).join('');

    const content = `
      <h1>MOONET — User Management</h1>

      <form method="GET" action="/admin/users">
        <label>Search by name or email</label>
        <input
          type="search"
          name="search"
          value="${esc(search)}"
          placeholder="Enter name or email"
        >
        <button type="submit">Search</button>
        <a href="/admin/users">Show All</a>
      </form>

      <p>Showing up to 200 users.</p>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Balance</th>
              <th>Status</th>
              <th>Joined</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            ${rows || '<tr><td colspan="6">No users found.</td></tr>'}
          </tbody>
        </table>
      </div>

      <p><a href="/admin">Back to Admin Dashboard</a></p>
    `;

    return resSend(res, render('MOONET User Management', content, req));

  } catch (err) {
    console.error('MOONET user management error:', err);
    return res.status(500).send(
      'Unable to load users. Check the server logs.'
    );
  }
});


// Admin: Suspend or reactivate a user
app.post(
  '/admin/users/:id/toggle-suspension',
  requireAdmin,
  (req, res) => {
    try {
      if (!validateCsrf(req, res)) return;

      const userId = req.params.id;

      const user = get(`
        SELECT id, suspended
        FROM users
        WHERE id = ?
      `, userId);

      if (!user) {
        return res.status(404).send('User not found.');
      }

      const newStatus = user.suspended ? 0 : 1;

      run(`
        UPDATE users
        SET suspended = ?
        WHERE id = ?
      `, newStatus, userId);

      return res.redirect('/admin/users');

    } catch (err) {
      console.error('MOONET user suspension error:', err);
      return res.status(500).send(
        'Unable to update user status.'
      );
    }
  }
);
// ==========================================
// MOONET — PART 12: CONTENT STATISTICS
// ==========================================

// Admin: Content statistics dashboard
app.get('/admin/content-stats', requireAdmin, (req, res) => {
  try {
    const videoCount = get(`
      SELECT COUNT(*) AS total
      FROM videos
    `)?.total || 0;

    const likeCount = get(`
      SELECT COUNT(*) AS total
      FROM video_likes
    `)?.total || 0;

    const commentCount = get(`
      SELECT COUNT(*) AS total
      FROM video_comments
    `)?.total || 0;

    const streamCount = get(`
      SELECT COUNT(*) AS total
      FROM video_streams
    `)?.total || 0;

    const watchRewards = get(`
      SELECT COALESCE(SUM(watch_moon), 0) AS total
      FROM users
    `)?.total || 0;

    const listenRewards = get(`
      SELECT COALESCE(SUM(listen_moon), 0) AS total
      FROM users
    `)?.total || 0;

    const likeRewards = get(`
      SELECT COALESCE(SUM(like_moon), 0) AS total
      FROM users
    `)?.total || 0;

    const content = `
      <h1>MOONET Content Statistics</h1>

      <div class="grid">
        <div class="card">
          <h3>Total Videos</h3>
          <h2>${fmt(videoCount)}</h2>
        </div>

        <div class="card">
          <h3>Total Likes</h3>
          <h2>${fmt(likeCount)}</h2>
        </div>

        <div class="card">
          <h3>Total Comments</h3>
          <h2>${fmt(commentCount)}</h2>
        </div>

        <div class="card">
          <h3>Video Stream Records</h3>
          <h2>${fmt(streamCount)}</h2>
        </div>

        <div class="card">
          <h3>Watch Rewards</h3>
          <h2>${fmt(watchRewards)} MOONS</h2>
        </div>

        <div class="card">
          <h3>Listening Rewards</h3>
          <h2>${fmt(listenRewards)} MOONS</h2>
        </div>

        <div class="card">
          <h3>Like Rewards</h3>
          <h2>${fmt(likeRewards)} MOONS</h2>
        </div>
      </div>

      <p>
        <a href="/admin">Back to Admin Dashboard</a>
      </p>
    `;

    return resSend(
      res,
      render('MOONET Content Statistics', content, req)
    );

  } catch (err) {
    console.error('MOONET content statistics error:', err);

    return res.status(500).send(
      'Unable to load content statistics. Check the server logs.'
    );
  }
});
// ==========================================
// MOONET — PART 13: REWARD HISTORY
// ==========================================

app.get('/admin/reward-history', requireAdmin, (req, res) => {
  try {
    const rewards = all(`
      SELECT
        'LIKE' AS reward_type,
        lr.liker_id AS user_id,
        u.name AS user_name,
        lr.moon AS amount,
        lr.created_at AS created_at,
        lr.video_id AS content_id
      FROM like_rewards lr
      LEFT JOIN users u ON u.id = lr.liker_id

      UNION ALL

      SELECT
        'WATCH' AS reward_type,
        ws.user_id AS user_id,
        u.name AS user_name,
        0.1 AS amount,
        ws.created_at AS created_at,
        ws.video_id AS content_id
      FROM watch_sessions ws
      LEFT JOIN users u ON u.id = ws.user_id
      WHERE ws.completed = 1

      UNION ALL

      SELECT
        'LISTEN' AS reward_type,
        ls.user_id AS user_id,
        u.name AS user_name,
        0.1 AS amount,
        ls.created_at AS created_at,
        ls.video_id AS content_id
      FROM listen_sessions ls
      LEFT JOIN users u ON u.id = ls.user_id
      WHERE ls.completed = 1

      ORDER BY created_at DESC
      LIMIT 200
    `);

    const rows = rewards.map(r => `
      <tr>
        <td>${esc(r.reward_type)}</td>
        <td>${esc(r.user_name || 'Unknown')}</td>
        <td>${fmt(r.amount)} MOONS</td>
        <td>${esc(r.content_id || '')}</td>
        <td>${esc(r.created_at || '')}</td>
      </tr>
    `).join('');

    const content = `
      <h1>MOONET Reward History</h1>

      <p>
        Amateka y'ibihembo bya MOONS. Hagaragazwa inyandiko
        zitarenze 200 ziheruka.
      </p>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Reward Type</th>
              <th>User</th>
              <th>Amount</th>
              <th>Content ID</th>
              <th>Date</th>
            </tr>
          </thead>

          <tbody>
            ${rows || '<tr><td colspan="5">No rewards found.</td></tr>'}
          </tbody>
        </table>
      </div>

      <p>
        <a href="/admin">Back to Admin Dashboard</a>
      </p>
    `;

    return resSend(
      res,
      render('MOONET Reward History', content, req)
    );

  } catch (err) {
    console.error('Reward history error:', err);

    return res.status(500).send(
      'Unable to load reward history. Check server logs.'
    );
  }
});
// ==========================================
// MOONET — PART 14: NOTIFICATIONS
// ==========================================

// Create notifications table if it does not exist.
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, created_at);
`);


// Helper: create a notification.
function createNotification(userId, title, message) {
  if (!userId || !title || !message) {
    throw new Error('Notification requires a user, title, and message.');
  }

  run(`
    INSERT INTO notifications
      (user_id, title, message, is_read, created_at)
    VALUES (?, ?, ?, 0, ?)
  `, userId, String(title), String(message), Date.now());
}


// Show notifications for the logged-in user.
app.get('/notifications', requireUser, (req, res) => {
  try {
    const notifications = all(`
      SELECT id, title, message, is_read, created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `, req.user.id);

    const rows = notifications.map(n => `
      <div class="card" style="margin-bottom:12px">
        <h3>${esc(n.title)}</h3>
        <p>${esc(n.message)}</p>
        <small>
          ${esc(new Date(Number(n.created_at)).toLocaleString())}
        </small>

        ${
          n.is_read
            ? '<p>Read</p>'
            : `
              <form method="POST"
                    action="/notifications/${encodeURIComponent(n.id)}/read">
                ${csrfField(req)}
                <button type="submit">Mark as Read</button>
              </form>
            `
        }
      </div>
    `).join('');

    const content = `
      <h1>My Notifications</h1>
      ${rows || '<p>You have no notifications yet.</p>'}
      <p><a href="/app">Back to MOONET</a></p>
    `;

    return resSend(res, render('My Notifications', content, req));

  } catch (err) {
    console.error('Notifications page error:', err);
    return res.status(500).send('Unable to load notifications.');
  }
});


// Mark a notification as read.
app.post('/notifications/:id/read', requireUser, (req, res) => {
  try {
    if (!validateCsrf(req, res)) return;

    run(`
      UPDATE notifications
      SET is_read = 1
      WHERE id = ?
        AND user_id = ?
    `, req.params.id, req.user.id);

    return res.redirect('/notifications');

  } catch (err) {
    console.error('Mark notification read error:', err);
    return res.status(500).send('Unable to update notification.');
  }
});


// Count unread notifications for the logged-in user.
app.get('/notifications/unread-count', requireUser, (req, res) => {
  try {
    const result = get(`
      SELECT COUNT(*) AS total
      FROM notifications
      WHERE user_id = ?
        AND is_read = 0
    `, req.user.id);

    return res.json({
      success: true,
      unread: Number(result?.total || 0)
    });

  } catch (err) {
    console.error('Unread notification count error:', err);
    return res.status(500).json({
      success: false,
      error: 'Unable to get notification count.'
    });
  }
});
// ==========================================
// MOONET — PART 15: REFERRAL SYSTEM
// ==========================================

// Create referral records without deleting existing data.
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_user_id INTEGER NOT NULL UNIQUE,
    reward_moon REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    UNIQUE(referrer_id, referred_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals(referrer_id);
`);


// Referral dashboard
app.get('/referrals', requireUser, (req, res) => {
  try {
    const user = get(`
      SELECT id, name, email, referral_code, moon
      FROM users
      WHERE id = ?
    `, req.user.id);

    if (!user) {
      return res.status(404).send('User not found.');
    }

    const referrals = all(`
      SELECT
        r.created_at,
        r.status,
        r.reward_moon,
        u.name AS referred_name
      FROM referrals r
      LEFT JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `, user.id);

    const totalInvited = get(`
      SELECT COUNT(*) AS total
      FROM referrals
      WHERE referrer_id = ?
    `, user.id)?.total || 0;

    const totalRewards = get(`
      SELECT COALESCE(SUM(reward_moon), 0) AS total
      FROM referrals
      WHERE referrer_id = ?
        AND status = 'paid'
    `, user.id)?.total || 0;

    const referralLink =
      `${req.protocol}://${req.get('host')}/signup?ref=${
        encodeURIComponent(user.referral_code || '')
      }`;

    const rows = referrals.map(r => `
      <tr>
        <td>${esc(r.referred_name || 'Member')}</td>
        <td>${esc(r.status)}</td>
        <td>${Number(r.reward_moon || 0).toFixed(2)} MOONS</td>
        <td>${esc(new Date(Number(r.created_at)).toLocaleString())}</td>
      </tr>
    `).join('');

    const content = `
      <h1>Invite Friends to MOONET</h1>

      <div class="card">
        <h3>Your Referral Code</h3>
        <p>${esc(user.referral_code || 'No referral code assigned')}</p>

        <h3>Your Referral Link</h3>
        <input
          readonly
          value="${esc(referralLink)}"
          onclick="this.select()"
        >

        <p>Copy this link and share it with your friends.</p>
      </div>

      <div class="grid">
        <div class="card">
          <h3>People Invited</h3>
          <h2>${fmt(totalInvited)}</h2>
        </div>

        <div class="card">
          <h3>Referral Rewards Paid</h3>
          <h2>${fmt(totalRewards)} MOONS</h2>
        </div>
      </div>

      <h2>Your Referrals</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Status</th>
              <th>Reward</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4">No referrals yet.</td></tr>'}
          </tbody>
        </table>
      </div>

      <p><a href="/app">Back to MOONET</a></p>
    `;

    return resSend(res, render('MOONET Referrals', content, req));

  } catch (err) {
    console.error('Referral dashboard error:', err);
    return res.status(500).send('Unable to load referrals.');
  }
});
// ==========================================
// MOONET — PART 16: WALLET & REWARD HISTORY
// ==========================================

app.get('/wallet/rewards', requireUser, (req, res) => {
  try {
    const user = get(`
      SELECT
        id,
        moon,
        like_moon,
        watch_moon,
        listen_moon
      FROM users
      WHERE id = ?
    `, req.user.id);

    if (!user) {
      return res.status(404).send('User not found.');
    }

    const history = all(`
      SELECT type, amount, description, created_at
      FROM transactions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `, req.user.id);

    const rows = history.map(item => `
      <tr>
        <td>${esc(item.type || '')}</td>
        <td>${fmt(item.amount)} MOONS</td>
        <td>${esc(item.description || '')}</td>
        <td>${esc(
          item.created_at
            ? new Date(Number(item.created_at)).toLocaleString()
            : ''
        )}</td>
      </tr>
    `).join('');

    const content = `
      <h1>My MOONET Wallet</h1>

      <div class="grid">
        <div class="card">
          <h3>Total Wallet Balance</h3>
          <h2>${fmt(user.moon || 0)} MOONS</h2>
        </div>

        <div class="card">
          <h3>Like Rewards</h3>
          <h2>${fmt(user.like_moon || 0)} MOONS</h2>
        </div>

        <div class="card">
          <h3>Video Watch Rewards</h3>
          <h2>${fmt(user.watch_moon || 0)} MOONS</h2>
        </div>

        <div class="card">
          <h3>Music Listening Rewards</h3>
          <h2>${fmt(user.listen_moon || 0)} MOONS</h2>
        </div>
      </div>

      <p>
        MOONS zigaragara mu byiciro ni ibisobanuro by’aho ibihembo
        byaturutse; ntuzongere kuziteranya n’umubare wa Total Wallet.
      </p>

      <h2>Transaction History</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Description</th>
              <th>Date</th>
            </tr>
          </thead>

          <tbody>
            ${rows || '<tr><td colspan="4">No transactions yet.</td></tr>'}
          </tbody>
        </table>
      </div>

      <p>
        <a href="/wallet">Wallet</a> |
        <a href="/app">Back to Home</a>
      </p>
    `;

    return resSend(res, render('MOONET Wallet Rewards', content, req));

  } catch (err) {
    console.error('Wallet rewards error:', err);

    return res.status(500).send(
      'Unable to load wallet rewards. Check server logs.'
    );
  }
});
// ==========================================
// MOONET — PART 17: SECURITY
// ==========================================

// 1. Security response headers.
// Add before your application routes.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  next();
});


// 2. Rate limiting for sensitive endpoints.
// This in-memory limiter resets when the server restarts.
// For multiple instances, use a shared store.
const securityRateLimits = new Map();

function securityRateLimit(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const maxRequests = options.maxRequests || 100;

  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;

    let entry = securityRateLimits.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + windowMs
      };

      securityRateLimits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      res.setHeader(
        'Retry-After',
        String(Math.ceil((entry.resetAt - now) / 1000))
      );

      return res.status(429).send(
        'Too many requests. Please try again later.'
      );
    }

    next();
  };
}


// 3. Confirm that the current account is active.
// Use this in protected user routes where appropriate.
function requireActiveUser(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.redirect('/login');
  }

  try {
    const user = get(`
      SELECT id, suspended
      FROM users
      WHERE id = ?
    `, req.user.id);

    if (!user) {
      return res.redirect('/logout');
    }

    if (Number(user.suspended || 0) === 1) {
      return res.status(403).send(
        'Your account is suspended. Please contact MOONET support.'
      );
    }

    next();

  } catch (err) {
    console.error('Active user check error:', err);

    return res.status(500).send(
      'Unable to verify your account.'
    );
  }
}


// 4. Protect a sensitive endpoint against excessive requests.
// Example: apply this middleware to the existing login POST route
// rather than creating a duplicate login route.
//
// app.post('/login', securityRateLimit({
//   windowMs: 15 * 60 * 1000,
//   maxRequests: 10
// }), existingLoginHandler);


// 5. Security status endpoint for the administrator.
app.get('/admin/security-status', requireAdmin, (req, res) => {
  try {
    const totalUsers = get(`
      SELECT COUNT(*) AS total
      FROM users
    `)?.total || 0;

    const suspendedUsers = get(`
      SELECT COUNT(*) AS total
      FROM users
      WHERE suspended = 1
    `)?.total || 0;

    const content = `
      <h1>MOONET Security Status</h1>

      <div class="grid">
        <div class="card">
          <h3>Total Accounts</h3>
          <h2>${fmt(totalUsers)}</h2>
        </div>

        <div class="card">
          <h3>Suspended Accounts</h3>
          <h2>${fmt(suspendedUsers)}</h2>
        </div>
      </div>

      <p>
        Rate limiting is active only on endpoints where the
        middleware is explicitly attached.
      </p>

      <p>
        <a href="/admin">Back to Admin Dashboard</a>
      </p>
    `;

    return resSend(
      res,
      render('MOONET Security Status', content, req)
    );

  } catch (err) {
    console.error('Security status error:', err);

    return res.status(500).send(
      'Unable to load security status.'
    );
  }
});
// ==========================================
// MOONET — PART 18: ADMIN SETTINGS
// ==========================================

// Create settings table if it does not exist.
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);


// Default settings.
// Existing settings are preserved.
const moonetDefaultSettings = [
  ['MOON_VALUE_RWF', '10'],
  ['MIN_WITHDRAWAL_MOON', '1000'],
  ['REFERRAL_REWARD_MOON', '5']
];

for (const [key, value] of moonetDefaultSettings) {
  run(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
  `, key, value, Date.now());
}


// Read one setting.
function getMoonetSetting(key, fallback) {
  const row = get(`
    SELECT value
    FROM settings
    WHERE key = ?
  `, key);

  return row ? row.value : fallback;
}


// Admin settings page.
app.get('/admin/settings', requireAdmin, (req, res) => {
  try {
    const moonValue = getMoonetSetting('MOON_VALUE_RWF', '10');
    const minWithdrawal = getMoonetSetting(
      'MIN_WITHDRAWAL_MOON',
      '1000'
    );
    const referralReward = getMoonetSetting(
      'REFERRAL_REWARD_MOON',
      '5'
    );

    const content = `
      <h1>MOONET Admin Settings</h1>

      <form method="POST" action="/admin/settings">
        ${csrfField(req)}

        <label>Value of 1 MOON in RWF</label>
        <input
          type="number"
          name="moon_value_rwf"
          min="0.01"
          step="0.01"
          value="${esc(moonValue)}"
          required
        >

        <label>Minimum Withdrawal (MOONS)</label>
        <input
          type="number"
          name="min_withdrawal_moon"
          min="1"
          step="1"
          value="${esc(minWithdrawal)}"
          required
        >

        <label>Referral Reward (MOONS)</label>
        <input
          type="number"
          name="referral_reward_moon"
          min="0"
          step="0.1"
          value="${esc(referralReward)}"
          required
        >

        <button type="submit">Save Settings</button>
      </form>

      <p>
        <strong>Important:</strong> Changing settings here only stores
        the new values. Existing withdrawal and reward routes must read
        these settings for the changes to affect actual transactions.
      </p>

      <p><a href="/admin">Back to Admin Dashboard</a></p>
    `;

    return resSend(res, render('MOONET Settings', content, req));

  } catch (err) {
    console.error('Admin settings page error:', err);
    return res.status(500).send('Unable to load settings.');
  }
});


// Save settings.
app.post('/admin/settings', requireAdmin, (req, res) => {
  try {
    if (!validateCsrf(req, res)) return;

    const moonValue = Number(req.body.moon_value_rwf);
    const minWithdrawal = Number(req.body.min_withdrawal_moon);
    const referralReward = Number(req.body.referral_reward_moon);

    if (
      !Number.isFinite(moonValue) ||
      moonValue <= 0 ||
      !Number.isFinite(minWithdrawal) ||
      minWithdrawal < 1 ||
      !Number.isInteger(minWithdrawal) ||
      !Number.isFinite(referralReward) ||
      referralReward < 0
    ) {
      return res.status(400).send('Invalid settings values.');
    }

    const values = [
      ['MOON_VALUE_RWF', String(moonValue)],
      ['MIN_WITHDRAWAL_MOON', String(minWithdrawal)],
      ['REFERRAL_REWARD_MOON', String(referralReward)]
    ];

    transaction(() => {
      for (const [key, value] of values) {
        run(`
          INSERT INTO settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `, key, value, Date.now());
      }
    });

    return res.redirect('/admin/settings');

  } catch (err) {
    console.error('Save settings error:', err);
    return res.status(500).send('Unable to save settings.');
  }
});
// ==========================================
// MOONET — PART 19: REPORTS & ANALYTICS
// ==========================================

app.get('/admin/reports', requireAdmin, (req, res) => {
  try {
    // Member statistics
    const totalUsers = Number(
      get(`SELECT COUNT(*) AS total FROM users`)?.total || 0
    );

    const suspendedUsers = Number(
      get(`
        SELECT COUNT(*) AS total
        FROM users
        WHERE suspended = 1
      `)?.total || 0
    );

    const recentUsers = Number(
      get(`
        SELECT COUNT(*) AS total
        FROM users
        WHERE created_at >= ?
      `, Date.now() - 7 * 24 * 60 * 60 * 1000)?.total || 0
    );

    // Revenue and expenses
    const revenue = Number(
      get(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM revenue
      `)?.total || 0
    );

    const expenses = Number(
      get(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM expenses
      `)?.total || 0
    );

    const profit = revenue - expenses;

    // Withdrawal statistics
    const pendingWithdrawals = Number(
      get(`
        SELECT COUNT(*) AS total
        FROM withdrawals
        WHERE LOWER(status) = 'pending'
      `)?.total || 0
    );

    const paidWithdrawals = Number(
      get(`
        SELECT COUNT(*) AS total
        FROM withdrawals
        WHERE LOWER(status) = 'paid'
      `)?.total || 0
    );

    // Content statistics
    const videos = Number(
      get(`SELECT COUNT(*) AS total FROM videos`)?.total || 0
    );

    const likes = Number(
      get(`SELECT COUNT(*) AS total FROM video_likes`)?.total || 0
    );

    const comments = Number(
      get(`SELECT COUNT(*) AS total FROM video_comments`)?.total || 0
    );

    // Latest revenue records
    const latestRevenue = all(`
      SELECT description, amount, created_at
      FROM revenue
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const revenueRows = latestRevenue.map(item => `
      <tr>
        <td>${esc(item.description || '')}</td>
        <td>${fmt(item.amount)} RWF</td>
        <td>${esc(item.created_at || '')}</td>
      </tr>
    `).join('');

    // Latest expense records
    const latestExpenses = all(`
      SELECT description, amount, created_at
      FROM expenses
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const expenseRows = latestExpenses.map(item => `
      <tr>
        <td>${esc(item.description || '')}</td>
        <td>${fmt(item.amount)} RWF</td>
        <td>${esc(item.created_at || '')}</td>
      </tr>
    `).join('');

    const content = `
      <h1>MOONET Reports & Analytics</h1>

      <div class="grid">
        <div class="card">
          <h3>Total Users</h3>
          <h2>${fmt(totalUsers)}</h2>
        </div>

        <div class="card">
          <h3>New Users — 7 Days</h3>
          <h2>${fmt(recentUsers)}</h2>
        </div>

        <div class="card">
          <h3>Suspended Users</h3>
          <h2>${fmt(suspendedUsers)}</h2>
        </div>

        <div class="card">
          <h3>Total Revenue</h3>
          <h2>${fmt(revenue)} RWF</h2>
        </div>

        <div class="card">
          <h3>Total Expenses</h3>
          <h2>${fmt(expenses)} RWF</h2>
        </div>

        <div class="card">
          <h3>Profit / Loss</h3>
          <h2>${fmt(profit)} RWF</h2>
        </div>

        <div class="card">
          <h3>Pending Withdrawals</h3>
          <h2>${fmt(pendingWithdrawals)}</h2>
        </div>

        <div class="card">
          <h3>Paid Withdrawals</h3>
          <h2>${fmt(paidWithdrawals)}</h2>
        </div>

        <div class="card">
          <h3>Videos</h3>
          <h2>${fmt(videos)}</h2>
        </div>

        <div class="card">
          <h3>Likes</h3>
          <h2>${fmt(likes)}</h2>
        </div>

        <div class="card">
          <h3>Comments</h3>
          <h2>${fmt(comments)}</h2>
        </div>
      </div>

      <h2>Recent Revenue</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Amount</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${revenueRows || '<tr><td colspan="3">No revenue records.</td></tr>'}
          </tbody>
        </table>
      </div>

      <h2>Recent Expenses</h2>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Amount</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${expenseRows || '<tr><td colspan="3">No expense records.</td></tr>'}
          </tbody>
        </table>
      </div>

      <p><a href="/admin">Back to Admin Dashboard</a></p>
    `;

    return resSend(res, render('MOONET Reports', content, req));

  } catch (err) {
    console.error('MOONET reports error:', err);

    return res.status(500).send(
      'Unable to load reports. Check the server logs.'
    );
  }
});
// ==========================================
// MOONET — PART 20: HEALTH CHECK
// ==========================================

// Basic server health endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    app: 'MOONET',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});


// Database health endpoint
app.get('/health/database', (req, res) => {
  try {
    const result = get('SELECT 1 AS ok');

    if (!result || Number(result.ok) !== 1) {
      return res.status(503).json({
        success: false,
        app: 'MOONET',
        database: 'unavailable'
      });
    }

    return res.status(200).json({
      success: true,
      app: 'MOONET',
      database: 'connected',
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('MOONET database health check failed:', err);

    return res.status(503).json({
      success: false,
      app: 'MOONET',
      database: 'error'
    });
  }
});
// MOONET — Safe settings migration.
// This preserves existing settings and does not delete any records.
try {
  const settingsColumns = db
    .prepare('PRAGMA table_info(settings)')
    .all()
    .map(column => column.name);

  if (!settingsColumns.includes('updated_at')) {
    db.exec('ALTER TABLE settings ADD COLUMN updated_at TEXT');
  }

  console.log('MOONET settings schema checked successfully.');
} catch (error) {
  console.error('MOONET settings migration failed:', error.message);
  throw error;
}
