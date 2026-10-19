'use strict';
require('dotenv').config();
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

// ================================================
// MOONET CONFIGURATION
// ================================================

const MOON_VALUE_RWF = 10;
const MIN_WITHDRAWAL_MOON = 1000;

const STREAM_REWARD_MOON = 0.1;
const STREAM_DURATION_MS = 30000;

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || ''
).trim().toLowerCase();

const ADMIN_PASSWORD = String(
  process.env.ADMIN_PASSWORD || ''
);

const SESSION_SECRET = String(
  process.env.SESSION_SECRET || ''
);

// Offerwall.me secrets must be configured in Render.
// Do not put real secret values in source code.
const OFFERWALL_POSTBACK_SECRET = String(
  process.env.OFFERWALL_POSTBACK_SECRET || ''
).trim();

const OFFERWALL_PUBLIC_API_KEY = String(
  process.env.OFFERWALL_PUBLIC_API_KEY || ''
).trim();

const OFFERWALL_IDENTITY_SECRET = String(
  process.env.OFFERWALL_IDENTITY_SECRET || ''
).trim();

const OFFERWALL_WALL_ID = String(
  process.env.OFFERWALL_WALL_ID ||
  '5126c45ff0096181b7ad353b735ad976'
).trim();

// ================================================
// DATA DIRECTORY
// ================================================

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ================================================
// DATABASE CONNECTION
// ================================================

// IMPORTANT:
// Reuse the existing database. Do not delete the DB file.
const DB_PATH = path.join(DATA_DIR, 'moonet.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// ================================================
// SECURITY HELPERS
// ================================================

function safeEqualText(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  if (first.length !== second.length) {
    return false;
  }

  return crypto.timingSafeEqual(first, second);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(email || '').trim()
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ================================================
// REQUEST CONFIGURATION
// ================================================

app.disable('x-powered-by');

app.use(express.urlencoded({
  extended: true,
  limit: '2mb'
}));

app.use(express.json({
  limit: '2mb'
}));

app.use('/uploads', express.static(UPLOAD_DIR));

// ================================================
// SESSION CONFIGURATION
// ================================================

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

if (SESSION_SECRET.length < 32) {
  console.error(
    'ERROR: SESSION_SECRET must contain at least 32 characters.'
  );

  process.exit(1);
}

app.use(session({
  name: 'moonet.sid',

  secret: SESSION_SECRET,

  resave: false,

  saveUninitialized: false,

  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// ================================================
// END OF PART 1
// PART 2 WILL CONTINUE WITH DATABASE TABLES,
// SAFE MIGRATIONS AND EXISTING DATA PRESERVATION.
// ================================================
// ================================================
// PART 2: DATABASE TABLES AND MIGRATIONS
// Continue directly after Part 1.
// ================================================

// USERS
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    moon INTEGER NOT NULL DEFAULT 0 CHECK(moon >= 0),
    referral_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    suspended INTEGER NOT NULL DEFAULT 0
  );
`);

// TRANSACTIONS
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    moon INTEGER NOT NULL,
    description TEXT NOT NULL,
    reference TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// VIDEOS
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// WITHDRAWALS
db.exec(`
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    moon INTEGER NOT NULL,
    amount_rwf REAL NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT 'MTN MoMo',
    phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
  );
`);

// REVENUE
db.exec(`
  CREATE TABLE IF NOT EXISTS revenue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'RWF',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// EXPENSES
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'RWF',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// APP SETTINGS
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// COMMENTS
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// FOLLOWS
db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id INTEGER NOT NULL REFERENCES users(id),
    following_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, following_id)
  );
`);

// GIFTS
db.exec(`
  CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    receiver_id INTEGER NOT NULL REFERENCES users(id),
    moon INTEGER NOT NULL CHECK(moon > 0),
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// WATCH SESSIONS
db.exec(`
  CREATE TABLE IF NOT EXISTS watch_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    video_id INTEGER NOT NULL REFERENCES videos(id),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    rewarded INTEGER NOT NULL DEFAULT 0
  );
`);

// LISTEN SESSIONS
db.exec(`
  CREATE TABLE IF NOT EXISTS listen_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    video_id INTEGER NOT NULL REFERENCES videos(id),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    rewarded INTEGER NOT NULL DEFAULT 0
  );
`);

// LIKE HISTORY
db.exec(`
  CREATE TABLE IF NOT EXISTS like_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    video_id INTEGER NOT NULL REFERENCES videos(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, video_id)
  );
`);

// LIKE REWARDS
db.exec(`
  CREATE TABLE IF NOT EXISTS like_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    video_id INTEGER NOT NULL REFERENCES videos(id),
    moon INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, video_id)
  );
`);

// OFFERWALL EVENTS
db.exec(`
  CREATE TABLE IF NOT EXISTS offerwall_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reward REAL NOT NULL CHECK(reward > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// ================================================
// SAFE MIGRATION HELPERS
// ================================================

function getTableColumns(tableName) {
  // Table names used here must be internal constants,
  // never user-provided input.
  return db.prepare(
    `PRAGMA table_info("${tableName}")`
  ).all().map(column => column.name);
}

function addColumnIfMissing(tableName, columnName, definition) {
  const columns = getTableColumns(tableName);

  if (!columns.includes(columnName)) {
    db.exec(
      `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
    );
  }
}

// Preserve existing video data while adding media_type.
addColumnIfMissing(
  'videos',
  'media_type',
  "TEXT NOT NULL DEFAULT 'video'"
);

// Preserve existing user balances and add reward breakdown columns.
addColumnIfMissing(
  'users',
  'like_moon',
  'INTEGER NOT NULL DEFAULT 0'
);

addColumnIfMissing(
  'users',
  'watch_moon',
  'INTEGER NOT NULL DEFAULT 0'
);

addColumnIfMissing(
  'users',
  'listen_moon',
  'INTEGER NOT NULL DEFAULT 0'
);

// Helpful indexes for common queries.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_transactions_user
    ON transactions(user_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_videos_user
    ON videos(user_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_withdrawals_user
    ON withdrawals(user_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_comments_video
    ON comments(video_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_watch_sessions_user
    ON watch_sessions(user_id, started_at);

  CREATE INDEX IF NOT EXISTS idx_listen_sessions_user
    ON listen_sessions(user_id, started_at);
`);

// ================================================
// END OF PART 2
// PART 3 WILL CONTINUE WITH AUTHENTICATION,
// SIGNUP, LOGIN, LOGOUT AND USER HELPERS.
// ================================================
// ================================================
// PART 3: AUTHENTICATION AND USER HELPERS
// ================================================

// Generate a unique referral code.
function generateReferralCode() {
  return 'MOON' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

// Find user by ID.
function getUserById(userId) {
  return db.prepare(`
    SELECT *
    FROM users
    WHERE id = ?
  `).get(Number(userId));
}

// Find user by email.
function getUserByEmail(email) {
  return db.prepare(`
    SELECT *
    FROM users
    WHERE lower(email) = lower(?)
  `).get(String(email || '').trim());
}

// Get current logged-in user.
function currentUser(req) {
  if (!req.session || !req.session.userId) {
    return null;
  }

  return getUserById(req.session.userId) || null;
}

// Require login.
function requireLogin(req, res, next) {
  const user = currentUser(req);

  if (!user) {
    return res.redirect('/login');
  }

  if (Number(user.suspended) === 1) {
    req.session.destroy(() => {
      res.status(403).send(
        'Konti yawe yahagaritswe. Hamagara MOONET support.'
      );
    });

    return;
  }

  req.user = user;
  next();
}

// Require administrator.
function requireAdmin(req, res, next) {
  const user = currentUser(req);

  if (!user) {
    return res.redirect('/admin/login');
  }

  if (
    !ADMIN_EMAIL ||
    user.email.toLowerCase() !== ADMIN_EMAIL
  ) {
    return res.status(403).send(
      'Ntabwo wemerewe gufungura iyi page.'
    );
  }

  if (Number(user.suspended) === 1) {
    return res.status(403).send(
      'Konti yawe yahagaritswe.'
    );
  }

  req.user = user;
  next();
}

// Escape values before inserting them into HTML.
function pageLayout(title, body, user = null) {
  const nav = user
    <nav style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
  <a href="/">Home</a>
  <a href="/dashboard">Dashboard</a>
  <a href="/feed">Videos</a>
<a href="/offers">Offers 🌙</a>
<a href="/wallet">Wallet</a>
  <a href="/offers">Offers 🌙</a>
  <a href="/wallet">Wallet</a>
  <a href="/transactions">Transactions</a>
  <a href="/profile">Profile</a>
    ? `
      <nav style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        <a href="/">Home</a>
        <a href="/dashboard">Dashboard</a>
        <a href="/feed">Videos</a>
        <a href="/wallet">Wallet</a>
        <a href="/transactions">Transactions</a>
        <a href="/profile">Profile</a>
        <form action="/logout" method="POST" style="display:inline">
          <button type="submit">Logout</button>
        </form>
      </nav>
    `
    : `
      <nav style="display:flex;gap:12px;margin-bottom:20px">
        <a href="/">Home</a>
        <a href="/login">Login</a>
        <a href="/signup">Create account</a>
      </nav>
    `;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(title)} - MOONET</title>
      <style>
        *{box-sizing:border-box}
        body{
          margin:0;
          padding:20px;
          font-family:Arial,sans-serif;
          background:#f5fff7;
          color:#183126
        }
        main{
          max-width:900px;
          margin:25px auto;
          background:white;
          padding:24px;
          border-radius:16px;
          box-shadow:0 4px 18px rgba(0,0,0,.07)
        }
        a{color:#168447;text-decoration:none}
        input,button,select,textarea{
          width:100%;
          padding:12px;
          margin:7px 0 14px;
          border:1px solid #d4e5d9;
          border-radius:8px;
          font-size:16px
        }
        button{
          background:#168447;
          color:white;
          border:0;
          cursor:pointer
        }
        .card{
          padding:16px;
          margin:12px 0;
          border:1px solid #e0eee4;
          border-radius:12px
        }
        .muted{color:#617468}
      </style>
    </head>
    <body>
      <main>
        <h1>🌙 MOONET</h1>
        ${nav}
        ${body}
      </main>
    </body>
    </html>
  `;
}

// ================================================
// HOME PAGE
// ================================================

app.get('/', (req, res) => {
  const user = currentUser(req);

  if (user) {
    return res.redirect('/dashboard');
  }

  const body = `
    <h2>Watch. Create. Connect.</h2>
    <p>Join MOONET and discover videos, creators and rewards.</p>

    <div class="card">
      <h3>🌙 Earn MOONS</h3>
      <p>Explore videos and participate in available activities.</p>
    </div>

    <div class="card">
      <h3>🎬 Share your videos</h3>
      <p>Upload videos and connect with other users.</p>
    </div>

    <a href="/signup">
      <button>Create your free account</button>
    </a>

    <p>Already registered? <a href="/login">Login here</a>.</p>
  `;

  res.send(pageLayout('Home', body));
});

// ================================================
// SIGNUP PAGE
// ================================================

app.get('/signup', (req, res) => {
  if (currentUser(req)) {
    return res.redirect('/dashboard');
  }

  const body = `
    <h2>Create your MOONET account</h2>

    <form method="POST" action="/signup">
      <label>Full name</label>
      <input
        name="name"
        required
        minlength="2"
        maxlength="80"
        autocomplete="name"
      >

      <label>Email address</label>
      <input
        type="email"
        name="email"
        required
        maxlength="254"
        autocomplete="email"
      >

      <label>Password</label>
      <input
        type="password"
        name="password"
        required
        minlength="8"
        maxlength="128"
        autocomplete="new-password"
      >

      <label>Referral code (optional)</label>
      <input
        name="referral"
        maxlength="40"
        autocomplete="off"
      >

      <button type="submit">Create account</button>
    </form>
  `;

  res.send(pageLayout('Create account', body));
});

// ================================================
// SIGNUP HANDLER
// ================================================

app.post('/signup', (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');
    const referral = String(req.body.referral || '')
      .trim()
      .toUpperCase();

    if (name.length < 2 || name.length > 80) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<h2>Invalid name</h2><p>Please enter your name correctly.</p>'
        )
      );
    }

    if (!isValidEmail(email) || email.length > 254) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<h2>Invalid email</h2><p>Please enter a valid email address.</p>'
        )
      );
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<h2>Invalid password</h2><p>Password must contain 8–128 characters.</p>'
        )
      );
    }

    if (getUserByEmail(email)) {
      return res.status(409).send(
        pageLayout(
          'Signup error',
          '<h2>Email already registered</h2><p>Please login or use another email.</p>'
        )
      );
    }

    let referredBy = null;

    if (referral) {
      const referrer = db.prepare(`
        SELECT id
        FROM users
        WHERE referral_code = ?
      `).get(referral);

      if (referrer) {
        referredBy = referrer.id;
      }
    }

    const passwordHash = bcrypt.hashSync(password, 12);

    let referralCode = generateReferralCode();

    // Avoid collisions with existing referral codes.
    for (let attempt = 0; attempt < 10; attempt++) {
      const exists = db.prepare(`
        SELECT id FROM users WHERE referral_code = ?
      `).get(referralCode);

      if (!exists) break;

      referralCode = generateReferralCode();
    }

    const result = db.prepare(`
      INSERT INTO users (
        name,
        email,
        password_hash,
        moon,
        referral_code,
        referred_by
      )
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(
      name,
      email,
      passwordHash,
      referralCode,
      referredBy
    );

    const userId = Number(result.lastInsertRowid);

    // Regenerate the session after signup.
    req.session.regenerate((err) => {
      if (err) {
        console.error('Signup session error:', err);
        return res.status(500).send('Could not create session.');
      }

      req.session.userId = userId;

      req.session.save((saveError) => {
        if (saveError) {
          console.error('Signup save error:', saveError);
          return res.status(500).send('Could not save session.');
        }

        res.redirect('/dashboard');
      });
    });
  } catch (error) {
    console.error('Signup error:', error);

    if (
      String(error.message || '').includes('UNIQUE constraint failed')
    ) {
      return res.status(409).send(
        'Email cyangwa referral code isanzwe ikoreshwa.'
      );
    }

    res.status(500).send('Signup failed. Please try again.');
  }
});

// ================================================
// LOGIN PAGE
// ================================================

app.get('/login', (req, res) => {
  if (currentUser(req)) {
    return res.redirect('/dashboard');
  }

  const body = `
    <h2>Login to MOONET</h2>

    <form method="POST" action="/login">
      <label>Email address</label>
      <input
        type="email"
        name="email"
        required
        autocomplete="username"
      >

      <label>Password</label>
      <input
        type="password"
        name="password"
        required
        autocomplete="current-password"
      >

      <button type="submit">Login</button>
    </form>

    <p>New here? <a href="/signup">Create an account</a>.</p>
  `;

  res.send(pageLayout('Login', body));
});

// ================================================
// LOGIN HANDLER
// ================================================

app.post('/login', (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');

    const user = getUserByEmail(email);

    if (
      !user ||
      !bcrypt.compareSync(password, user.password_hash)
    ) {
      return res.status(401).send(
        pageLayout(
          'Login failed',
          '<h2>Login failed</h2><p>Email cyangwa password si byo.</p><a href="/login">Try again</a>'
        )
      );
    }

    if (Number(user.suspended) === 1) {
      return res.status(403).send(
        'Konti yawe yahagaritswe. Hamagara MOONET support.'
      );
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('Login session error:', err);
        return res.status(500).send('Login failed.');
      }

      req.session.userId = user.id;

      req.session.save((saveError) => {
        if (saveError) {
          console.error('Login save error:', saveError);
          return res.status(500).send('Login failed.');
        }

        res.redirect('/dashboard');
      });
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send('Login failed. Please try again.');
  }
});

// ================================================
// LOGOUT
// ================================================

app.post('/logout', (req, res) => {
  if (!req.session) {
    return res.redirect('/');
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).send('Could not logout.');
    }

    res.clearCookie('moonet.sid');
    res.redirect('/');
  });
});

// ================================================
// END OF PART 3
// PART 4: DASHBOARD, PROFILE AND WALLET
// ================================================
// ================================================
// PART 4: DASHBOARD, PROFILE, WALLET AND TRANSACTIONS
// ================================================

// DASHBOARD
app.get('/dashboard', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const videoCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM videos
    WHERE user_id = ?
  `).get(user.id).total;

  const recentTransactions = db.prepare(`
    SELECT type, moon, description, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(user.id);

  const transactionRows = recentTransactions.map((tx) => `
    <tr>
      <td>${escapeHtml(tx.type)}</td>
      <td>${escapeHtml(tx.description)}</td>
      <td>${Number(tx.moon).toLocaleString()} MOONS</td>
      <td>${escapeHtml(tx.created_at)}</td>
    </tr>
  `).join('');

  const body = `
    <h2>Murakaza neza, ${escapeHtml(user.name)}! 🌙</h2>

    <div class="card">
      <h3>Wallet balance</h3>
      <p style="font-size:28px;font-weight:bold">
        ${Number(user.moon).toLocaleString()} MOONS
      </p>
      <p class="muted">
        Indicative value: ${(Number(user.moon) * MOON_VALUE_RWF).toLocaleString()} RWF
      </p>
      <a href="/wallet">Open wallet</a>
    </div>

    <div class="card">
      <h3>Your videos</h3>
      <p>${Number(videoCount)} videos</p>
      <a href="/feed">View videos</a>
    </div>

    <div class="card">
      <h3>Quick links</h3>
      <p><a href="/profile">My profile</a></p>
      <p><a href="/transactions">Transaction history</a></p>
      <p><a href="/withdraw">Withdraw MOONS</a></p>
      <p><a href="/offers">Earn with offers</a></p>
    </div>

    <h3>Recent transactions</h3>

    <div style="overflow-x:auto">
      <table style="width:100%;text-align:left">
        <thead>
          <tr>
            <th>Type</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${transactionRows || '<tr><td colspan="4">No transactions yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  res.send(pageLayout('Dashboard', body, user));
});

// ================================================
// PROFILE
// ================================================

app.get('/profile', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const body = `
    <h2>My profile</h2>

    <div class="card">
      <p><strong>Name:</strong> ${escapeHtml(user.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(user.email)}</p>
      <p><strong>Referral code:</strong> ${escapeHtml(user.referral_code)}</p>
      <p><strong>Balance:</strong> ${Number(user.moon).toLocaleString()} MOONS</p>
      <p><strong>Joined:</strong> ${escapeHtml(user.created_at)}</p>
    </div>

    <h3>Update your name</h3>

    <form method="POST" action="/profile">
      <label>Name</label>
      <input
        name="name"
        value="${escapeHtml(user.name)}"
        required
        minlength="2"
        maxlength="80"
      >
      <button type="submit">Save profile</button>
    </form>
  `;

  res.send(pageLayout('Profile', body, user));
});

app.post('/profile', requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim();

  if (name.length < 2 || name.length > 80) {
    return res.status(400).send(
      'Izina rigomba kuba hagati y’inyuguti 2 na 80.'
    );
  }

  db.prepare(`
    UPDATE users
    SET name = ?
    WHERE id = ?
  `).run(name, req.user.id);

  res.redirect('/profile');
});

// ================================================
// WALLET
// ================================================

app.get('/wallet', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const balance = Number(user.moon);

  const estimatedRwf = balance * MOON_VALUE_RWF;

  const body = `
    <h2>🌙 My MOONET Wallet</h2>

    <div class="card">
      <p>Available balance</p>

      <h2>${balance.toLocaleString()} MOONS</h2>

      <p>
        Estimated value:
        <strong>${estimatedRwf.toLocaleString()} RWF</strong>
      </p>

      <p class="muted">
        The displayed value is an estimate, not a guarantee of payment.
      </p>
    </div>

    <div class="card">
      <h3>Manage your MOONS</h3>
      <p><a href="/transactions">View transaction history</a></p>
      <p><a href="/withdraw">Request withdrawal</a></p>
      <p><a href="/offers">Explore offers</a></p>
    </div>
  `;

  res.send(pageLayout('Wallet', body, user));
});

// ================================================
// TRANSACTION HISTORY
// ================================================

app.get('/transactions', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const transactions = db.prepare(`
    SELECT id, type, moon, description, reference, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 200
  `).all(user.id);

  const rows = transactions.map((tx) => `
    <tr>
      <td>${Number(tx.id)}</td>
      <td>${escapeHtml(tx.type)}</td>
      <td>${escapeHtml(tx.description)}</td>
      <td>${Number(tx.moon).toLocaleString()} MOONS</td>
      <td>${escapeHtml(tx.reference || '')}</td>
      <td>${escapeHtml(tx.created_at)}</td>
    </tr>
  `).join('');

  const body = `
    <h2>Transaction history</h2>

    <p>
      Current balance:
      <strong>${Number(user.moon).toLocaleString()} MOONS</strong>
    </p>

    <div style="overflow-x:auto">
      <table style="width:100%;text-align:left">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Description</th>
            <th>MOONS</th>
            <th>Reference</th>
            <th>Date</th>
          </tr>
        </thead>

        <tbody>
          ${rows || '<tr><td colspan="6">No transactions found.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  res.send(pageLayout('Transactions', body, user));
});

// ================================================
// END OF PART 4
// NEXT: PART 5 — VIDEOS, UPLOADS AND FEED
// ================================================
// ================================================
// PART 5: VIDEO UPLOADS AND FEED
// ================================================

// Configure video uploads.
const storage = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, UPLOAD_DIR);
  },

  filename: function (req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    const safeName =
      Date.now() + '-' +
      crypto.randomBytes(12).toString('hex') +
      extension;

    callback(null, safeName);
  }
});

// Accept common video formats only.
const videoUpload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  },

  fileFilter: function (req, file, callback) {
    const allowedExtensions = [
      '.mp4',
      '.webm',
      '.mov',
      '.m4v'
    ];

    const extension = path.extname(
      file.originalname
    ).toLowerCase();

    if (!allowedExtensions.includes(extension)) {
      return callback(
        new Error('Unsupported video file format.')
      );
    }

    callback(null, true);
  }
});

// ================================================
// VIDEO FEED
// ================================================

app.get('/feed', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const videos = db.prepare(`
    SELECT
      videos.id,
      videos.user_id,
      videos.title,
      videos.filename,
      videos.created_at,
      users.name AS creator_name
    FROM videos
    JOIN users ON users.id = videos.user_id
    ORDER BY videos.id DESC
    LIMIT 100
  `).all();

  const videoCards = videos.map((video) => {
    const filename = path.basename(video.filename);

    return `
      <div class="card">
        <h3>${escapeHtml(video.title)}</h3>

        <p>
          By ${escapeHtml(video.creator_name)}
        </p>

        <video
          controls
          preload="metadata"
          style="width:100%;max-height:500px;background:#111;border-radius:12px"
        >
          <source
            src="/uploads/${encodeURIComponent(filename)}"
            type="video/mp4"
          >
          Your browser does not support this video.
        </video>

        <p class="muted">
          Posted ${escapeHtml(video.created_at)}
        </p>

        <p>
          <a href="/videos/${Number(video.id)}">
            Open video
          </a>
        </p>
      </div>
    `;
  }).join('');

  const body = `
    <h2>🎬 MOONET Video Feed</h2>

    <p>Discover videos shared by the community.</p>

    <div class="card">
      <h3>Upload a video</h3>

      <form
        action="/upload"
        method="POST"
        enctype="multipart/form-data"
      >
        <label>Video title</label>

        <input
          type="text"
          name="title"
          required
          maxlength="120"
        >

        <label>Select video</label>

        <input
          type="file"
          name="video"
          accept="video/mp4,video/webm,video/quicktime"
          required
        >

        <button type="submit">
          Upload video
        </button>
      </form>

      <p class="muted">
        Maximum upload size: 100 MB.
      </p>
    </div>

    <h3>Latest videos</h3>

    ${videoCards || '<p>No videos available yet. Be the first to upload!</p>'}
  `;

  res.send(pageLayout('Video Feed', body, user));
});

// ================================================
// UPLOAD VIDEO
// ================================================

app.post(
  '/upload',
  requireLogin,
  (req, res, next) => {
    videoUpload.single('video')(req, res, function (error) {
      if (error) {
        console.error('Video upload error:', error.message);

        return res.status(400).send(
          pageLayout(
            'Upload error',
            `<h2>Upload failed</h2><p>${escapeHtml(error.message)}</p><a href="/feed">Return to feed</a>`,
            req.user
          )
        );
      }

      next();
    });
  },
  (req, res) => {
    try {
      const title = String(
        req.body.title || ''
      ).trim();

      if (!title || title.length > 120) {
        if (req.file) {
          fs.unlink(req.file.path, () => {});
        }

        return res.status(400).send(
          'Video title must contain 1–120 characters.'
        );
      }

      if (!req.file) {
        return res.status(400).send(
          'Please select a video file.'
        );
      }

      const result = db.prepare(`
        INSERT INTO videos (
          user_id,
          title,
          filename
        )
        VALUES (?, ?, ?)
      `).run(
        req.user.id,
        title,
        req.file.filename
      );

      console.log(
        'Video uploaded:',
        Number(result.lastInsertRowid)
      );

      res.redirect('/feed');
    } catch (error) {
      console.error('Saving video failed:', error);

      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }

      res.status(500).send(
        'Could not save video. Please try again.'
      );
    }
  }
);

// ================================================
// VIDEO DETAILS
// ================================================

app.get('/videos/:id', requireLogin, (req, res) => {
  const videoId = Number(req.params.id);

  if (!Number.isSafeInteger(videoId) || videoId <= 0) {
    return res.status(400).send('Invalid video ID.');
  }

  const video = db.prepare(`
    SELECT
      videos.*,
      users.name AS creator_name
    FROM videos
    JOIN users ON users.id = videos.user_id
    WHERE videos.id = ?
  `).get(videoId);

  if (!video) {
    return res.status(404).send('Video not found.');
  }

  const filename = path.basename(video.filename);

  const body = `
    <h2>${escapeHtml(video.title)}</h2>

    <p>
      Created by ${escapeHtml(video.creator_name)}
    </p>

    <video
      controls
      preload="metadata"
      style="width:100%;max-height:600px;background:#111;border-radius:12px"
    >
      <source
        src="/uploads/${encodeURIComponent(filename)}"
        type="video/mp4"
      >
      Your browser does not support this video.
    </video>

    <p>
      <a href="/feed">← Back to feed</a>
    </p>
  `;

  res.send(pageLayout('Video', body, req.user));
});

// ================================================
// END OF PART 5
// NEXT: PART 6 — LIKES, COMMENTS, FOLLOWS AND GIFTS
// ================================================
// ================================================
// PART 6: LIKES, COMMENTS, FOLLOWS AND GIFTS
// ================================================

// ================================================
// LIKE A VIDEO
// ================================================

app.post('/videos/:id/like', requireLogin, (req, res) => {
  try {
    const videoId = Number(req.params.id);

    if (!Number.isSafeInteger(videoId) || videoId <= 0) {
      return res.status(400).send('Invalid video ID.');
    }

    const video = db.prepare(`
      SELECT id, user_id
      FROM videos
      WHERE id = ?
    `).get(videoId);

    if (!video) {
      return res.status(404).send('Video not found.');
    }

    const existingLike = db.prepare(`
      SELECT id
      FROM like_history
      WHERE user_id = ? AND video_id = ?
    `).get(req.user.id, videoId);

    if (existingLike) {
      return res.redirect(`/videos/${videoId}`);
    }

    db.prepare(`
      INSERT INTO like_history (user_id, video_id)
      VALUES (?, ?)
    `).run(req.user.id, videoId);

    res.redirect(`/videos/${videoId}`);
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).send('Could not like this video.');
  }
});

// ================================================
// ADD A COMMENT
// ================================================

app.post('/videos/:id/comments', requireLogin, (req, res) => {
  try {
    const videoId = Number(req.params.id);
    const comment = String(req.body.comment || '').trim();

    if (!Number.isSafeInteger(videoId) || videoId <= 0) {
      return res.status(400).send('Invalid video ID.');
    }

    if (!comment || comment.length > 1000) {
      return res.status(400).send(
        'Comment must contain between 1 and 1000 characters.'
      );
    }

    const video = db.prepare(`
      SELECT id
      FROM videos
      WHERE id = ?
    `).get(videoId);

    if (!video) {
      return res.status(404).send('Video not found.');
    }

    db.prepare(`
      INSERT INTO comments (video_id, user_id, comment)
      VALUES (?, ?, ?)
    `).run(videoId, req.user.id, comment);

    res.redirect(`/videos/${videoId}`);
  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).send('Could not save your comment.');
  }
});

// ================================================
// FOLLOW A USER
// ================================================

app.post('/users/:id/follow', requireLogin, (req, res) => {
  try {
    const targetId = Number(req.params.id);

    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      return res.status(400).send('Invalid user ID.');
    }

    if (targetId === Number(req.user.id)) {
      return res.status(400).send(
        'You cannot follow your own account.'
      );
    }

    const target = getUserById(targetId);

    if (!target || Number(target.suspended) === 1) {
      return res.status(404).send('User not found.');
    }

    db.prepare(`
      INSERT OR IGNORE INTO follows (follower_id, following_id)
      VALUES (?, ?)
    `).run(req.user.id, targetId);

    res.redirect('/feed');
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).send('Could not follow this user.');
  }
});

// ================================================
// SEND MOONS AS A GIFT
// ================================================

app.get('/gifts', requireLogin, (req, res) => {
  const body = `
    <h2>🎁 Send MOONS</h2>

    <p>
      Share your MOONS with another MOONET user.
    </p>

    <form method="POST" action="/gifts">
      <label>Recipient user ID</label>
      <input
        type="number"
        name="receiver_id"
        min="1"
        required
      >

      <label>Amount in whole MOONS</label>
      <input
        type="number"
        name="moon"
        min="1"
        step="1"
        required
      >

      <label>Message (optional)</label>
      <input
        type="text"
        name="message"
        maxlength="250"
      >

      <button type="submit">Send gift</button>
    </form>
  `;

  res.send(pageLayout('Send gifts', body, req.user));
});

app.post('/gifts', requireLogin, (req, res) => {
  const receiverId = Number(req.body.receiver_id);
  const amount = Number(req.body.moon);
  const message = String(req.body.message || '').trim();

  if (
    !Number.isSafeInteger(receiverId) ||
    receiverId <= 0 ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > 100000000 ||
    message.length > 250
  ) {
    return res.status(400).send('Invalid gift details.');
  }

  if (receiverId === Number(req.user.id)) {
    return res.status(400).send(
      'You cannot send a gift to yourself.'
    );
  }

  const transfer = db.prepare(`
    UPDATE users
    SET moon = moon - ?
    WHERE id = ?
      AND moon >= ?
      AND suspended = 0
  `);

  const credit = db.prepare(`
    UPDATE users
    SET moon = moon + ?
    WHERE id = ?
      AND suspended = 0
  `);

  try {
    db.exec('BEGIN IMMEDIATE');

    const receiver = getUserById(receiverId);

    if (!receiver || Number(receiver.suspended) === 1) {
      db.exec('ROLLBACK');
      return res.status(404).send('Recipient not found.');
    }

    const senderUpdate = transfer.run(
      amount,
      req.user.id,
      amount
    );

    if (Number(senderUpdate.changes) !== 1) {
      db.exec('ROLLBACK');
      return res.status(400).send(
        'You do not have enough MOONS.'
      );
    }

    const receiverUpdate = credit.run(amount, receiverId);

    if (Number(receiverUpdate.changes) !== 1) {
      db.exec('ROLLBACK');
      return res.status(400).send(
        'Could not credit the recipient.'
      );
    }

    db.prepare(`
      INSERT INTO gifts (
        sender_id,
        receiver_id,
        moon,
        message
      )
      VALUES (?, ?, ?, ?)
    `).run(
      req.user.id,
      receiverId,
      amount,
      message
    );

    db.prepare(`
      INSERT INTO transactions (
        user_id,
        type,
        moon,
        description,
        reference
      )
      VALUES (?, 'gift_sent', ?, ?, ?)
    `).run(
      req.user.id,
      -amount,
      `Gift sent to user ${receiverId}`,
      `gift-sent-${randomToken(16)}`
    );

    db.prepare(`
      INSERT INTO transactions (
        user_id,
        type,
        moon,
        description,
        reference
      )
      VALUES (?, 'gift_received', ?, ?, ?)
    `).run(
      receiverId,
      amount,
      `Gift received from user ${req.user.id}`,
      `gift-received-${randomToken(16)}`
    );

    db.exec('COMMIT');

    res.redirect('/wallet');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}

    console.error('Gift transfer error:', error);

    res.status(500).send(
      'Gift transfer failed. Please try again.'
    );
  }
});

// ================================================
// END OF PART 6
// NEXT: PART 7 — WATCH/LISTEN REWARDS AND WITHDRAWALS
// ================================================
// ================================================
// PART 7: WATCH/LISTEN REWARDS AND WITHDRAWALS
// ================================================

// Use database transactions for atomic balance updates.
function runInTransaction(work) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}

    throw error;
  }
}

// ================================================
// START WATCH SESSION
// ================================================

app.post('/videos/:id/watch/start', requireLogin, (req, res) => {
  try {
    const videoId = Number(req.params.id);

    if (!Number.isSafeInteger(videoId) || videoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid video ID.'
      });
    }

    const video = db.prepare(`
      SELECT id
      FROM videos
      WHERE id = ?
    `).get(videoId);

    if (!video) {
      return res.status(404).json({
        ok: false,
        error: 'Video not found.'
      });
    }

    const result = db.prepare(`
      INSERT INTO watch_sessions (
        user_id,
        video_id
      )
      VALUES (?, ?)
    `).run(req.user.id, videoId);

    res.json({
      ok: true,
      sessionId: Number(result.lastInsertRowid),
      requiredSeconds: STREAM_DURATION_MS / 1000
    });
  } catch (error) {
    console.error('Start watch session error:', error);

    res.status(500).json({
      ok: false,
      error: 'Could not start watch session.'
    });
  }
});

// ================================================
// COMPLETE WATCH SESSION
// ================================================

app.post('/watch/complete', requireLogin, (req, res) => {
  try {
    const sessionId = Number(req.body.sessionId);

    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid session.'
      });
    }

    const result = runInTransaction(() => {
      const watchSession = db.prepare(`
        SELECT *
        FROM watch_sessions
        WHERE id = ?
          AND user_id = ?
      `).get(sessionId, req.user.id);

      if (!watchSession) {
        throw new Error('SESSION_NOT_FOUND');
      }

      if (Number(watchSession.rewarded) === 1) {
        throw new Error('ALREADY_REWARDED');
      }

      // Do not trust a completion timestamp supplied by the browser.
      // The server-side session creation time is used.
      const startedAt = Date.parse(
        watchSession.started_at.replace(' ', 'T') + 'Z'
      );

      if (
        !Number.isFinite(startedAt) ||
        Date.now() - startedAt < STREAM_DURATION_MS
      ) {
        throw new Error('WATCH_TOO_SHORT');
      }

      // Stored balances are INTEGER, so this reward is rounded
      // to whole MOONS. A fractional reward needs a separate
      // design before it can safely be credited.
      const reward = Math.round(STREAM_REWARD_MOON);

      if (reward <= 0) {
        throw new Error('INVALID_REWARD');
      }

      db.prepare(`
        UPDATE users
        SET moon = moon + ?,
            watch_moon = watch_moon + ?
        WHERE id = ?
          AND suspended = 0
      `).run(reward, reward, req.user.id);

      db.prepare(`
        UPDATE watch_sessions
        SET rewarded = 1,
            completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND user_id = ?
          AND rewarded = 0
      `).run(sessionId, req.user.id);

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          moon,
          description,
          reference
        )
        VALUES (?, 'watch_reward', ?, ?, ?)
      `).run(
        req.user.id,
        reward,
        'MOONET watch reward',
        `watch-${sessionId}`
      );

      return reward;
    });

    res.json({
      ok: true,
      reward: result,
      currency: 'MOONS'
    });
  } catch (error) {
    if (error.message === 'SESSION_NOT_FOUND') {
      return res.status(404).json({
        ok: false,
        error: 'Watch session not found.'
      });
    }

    if (error.message === 'ALREADY_REWARDED') {
      return res.status(409).json({
        ok: false,
        error: 'This session was already rewarded.'
      });
    }

    if (error.message === 'WATCH_TOO_SHORT') {
      return res.status(400).json({
        ok: false,
        error: 'Watch for at least 30 seconds.'
      });
    }

    console.error('Complete watch session error:', error);

    res.status(500).json({
      ok: false,
      error: 'Could not complete watch session.'
    });
  }
});

// ================================================
// WITHDRAWAL PAGE
// ================================================

app.get('/withdraw', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const body = `
    <h2>Withdraw MOONS</h2>

    <div class="card">
      <p>Available balance</p>
      <h3>${Number(user.moon).toLocaleString()} MOONS</h3>
      <p>Minimum request: ${MIN_WITHDRAWAL_MOON} MOONS</p>
    </div>

    <form method="POST" action="/withdraw">
      <label>Amount in whole MOONS</label>

      <input
        type="number"
        name="moon"
        min="${MIN_WITHDRAWAL_MOON}"
        step="1"
        required
      >

      <label>Payment method</label>

      <select name="method" required>
        <option value="MTN MoMo">MTN Mobile Money</option>
        <option value="Bank">Bank transfer</option>
      </select>

      <label>Phone number or account details</label>

      <input
        type="text"
        name="phone"
        maxlength="100"
        required
      >

      <button type="submit">Submit withdrawal request</button>
    </form>

    <p class="muted">
      Submitting a request does not guarantee immediate payment.
      Requests are subject to review and approval.
    </p>
  `;

  res.send(pageLayout('Withdraw', body, user));
});

// ================================================
// CREATE WITHDRAWAL REQUEST
// ================================================

app.post('/withdraw', requireLogin, (req, res) => {
  const amount = Number(req.body.moon);
  const method = String(req.body.method || '').trim();
  const phone = String(req.body.phone || '').trim();

  const allowedMethods = ['MTN MoMo', 'Bank'];

  if (
    !Number.isSafeInteger(amount) ||
    amount < MIN_WITHDRAWAL_MOON ||
    phone.length < 5 ||
    phone.length > 100 ||
    !allowedMethods.includes(method)
  ) {
    return res.status(400).send(
      'Withdrawal details are invalid.'
    );
  }

  try {
    runInTransaction(() => {
      const debit = db.prepare(`
        UPDATE users
        SET moon = moon - ?
        WHERE id = ?
          AND moon >= ?
          AND suspended = 0
      `).run(amount, req.user.id, amount);

      if (Number(debit.changes) !== 1) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      const amountRwf = amount * MOON_VALUE_RWF;

      const withdrawal = db.prepare(`
        INSERT INTO withdrawals (
          user_id,
          moon,
          amount_rwf,
          method,
          phone,
          status
        )
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(
        req.user.id,
        amount,
        amountRwf,
        method,
        phone
      );

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          moon,
          description,
          reference
        )
        VALUES (?, 'withdrawal_request', ?, ?, ?)
      `).run(
        req.user.id,
        -amount,
        `Withdrawal request #${Number(withdrawal.lastInsertRowid)}`,
        `withdrawal-${Number(withdrawal.lastInsertRowid)}`
      );
    });

    res.redirect('/transactions');
  } catch (error) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).send(
        'You do not have enough MOONS.'
      );
    }

    console.error('Withdrawal request error:', error);

    res.status(500).send(
      'Could not submit withdrawal request.'
    );
  }
});

// ================================================
// END OF PART 7
// NEXT: PART 8 — OFFERWALL.ME INTEGRATION
// ================================================
// ================================================
// PART 8A: OFFERWALL PAGE AND SIGNED USER IDENTITY
// ================================================

app.get('/offers', requireLogin, (req, res) => {
  if (
    !OFFERWALL_PUBLIC_API_KEY ||
    !OFFERWALL_IDENTITY_SECRET
  ) {
    return res.status(503).send(
      pageLayout(
        'Offers',
        `
          <h2>MOONET Offers</h2>
          <p>Offerwall is being configured. Please try again later.</p>
          <a href="/dashboard">Return to dashboard</a>
        `,
        req.user
      )
    );
  }

  // Use the authenticated user's database ID.
  // Never accept an arbitrary user ID from the browser.
  const userId = String(req.user.id);

  // Signature expires after one hour.
  const expiry = Math.floor(Date.now() / 1000) + 3600;

  const message = [
    'offerwall-user-v1',
    OFFERWALL_PUBLIC_API_KEY,
    userId,
    String(expiry)
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', OFFERWALL_IDENTITY_SECRET)
    .update(message, 'utf8')
    .digest('hex');

  const wallUrl = new URL(
    `https://offerwall.me/offerwall/${encodeURIComponent(
      OFFERWALL_PUBLIC_API_KEY
    )}/${encodeURIComponent(userId)}`
  );

  wallUrl.searchParams.set(
    'identityExpires',
    String(expiry)
  );

  wallUrl.searchParams.set(
    'identitySignature',
    signature
  );

  const body = `
    <h2>🌙 Earn MOONS with Offers</h2>

    <p>
      Complete eligible offers through our offer partner.
      Rewards are credited after the partner confirms completion.
    </p>

    <div class="card">
      <p><strong>Your MOONET user ID:</strong> ${escapeHtml(userId)}</p>

      <a
        href="${escapeHtml(wallUrl.toString())}"
        target="_blank"
        rel="noopener noreferrer"
      >
        <button type="button">Open Offers</button>
      </a>
    </div>

    <p>
      <a href="/transactions">View your transaction history</a>
    </p>
  `;

  res.send(pageLayout('Earn MOONS', body, req.user));
});
// ================================================
// PART 8B: OFFERWALL.ME POSTBACK
// ================================================

app.get('/offerwall/callback', (req, res) => {
  if (!OFFERWALL_POSTBACK_SECRET) {
    console.error('Offerwall postback secret is not configured.');

    return res.status(503).send('not_configured');
  }

  try {
    const {
      subId,
      transId,
      reward,
      status,
      signature
    } = req.query;

    if (
      typeof subId !== 'string' ||
      typeof transId !== 'string' ||
      typeof reward !== 'string' ||
      typeof status !== 'string' ||
      typeof signature !== 'string'
    ) {
      return res.status(400).send('invalid_parameters');
    }

    if (
      !/^\d+$/.test(subId) ||
      transId.length < 1 ||
      transId.length > 200 ||
      !/^\d+$/.test(status) ||
      !/^[a-fA-F0-9]{32}$/.test(signature)
    ) {
      return res.status(400).send('invalid_parameters');
    }

    const rewardValue = Number(reward);

    if (
      !Number.isFinite(rewardValue) ||
      rewardValue <= 0
    ) {
      return res.status(400).send('invalid_reward');
    }

    // Offerwall.me signature:
    // MD5(subId + transId + reward + secret)
    // No separators are added.
    const expectedSignature = crypto
      .createHash('md5')
      .update(
        subId + transId + reward + OFFERWALL_POSTBACK_SECRET,
        'utf8'
      )
      .digest('hex');

    if (!safeEqualText(
      expectedSignature.toLowerCase(),
      signature.toLowerCase()
    )) {
      console.warn('Invalid Offerwall callback signature.');

      return res.status(403).send('invalid_signature');
    }

    // Status 2 represents a reversal/chargeback.
    // Never credit it as a new reward.
    if (status === '2') {
      console.warn(
        'Offerwall reversal received for transaction:',
        transId
      );

      // Reversal accounting must be handled separately.
      // A reversal must not be mistaken for a new credit.
      return res.status(200).send('ok');
    }

    if (status !== '1') {
      return res.status(400).send('unsupported_status');
    }

    const userId = Number(subId);

    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).send('invalid_user');
    }

    const user = getUserById(userId);

    if (!user || Number(user.suspended) === 1) {
      return res.status(404).send('user_not_found');
    }

    // The database currently stores MOONS as INTEGER.
    // A provider reward must be mapped to whole MOONS using
    // the exact conversion agreed with the Offerwall settings.
    //
    // Do not assume provider USD payout equals user MOONS.
    // Configure this mapping before enabling real credits.
    const moonsToCredit = Math.floor(rewardValue);

    if (moonsToCredit <= 0) {
      console.warn(
        'Offerwall reward is below one whole MOON:',
        transId
      );

      return res.status(400).send('reward_below_minimum');
    }

    runInTransaction(() => {
      const duplicate = db.prepare(`
        SELECT id
        FROM offerwall_events
        WHERE transaction_id = ?
      `).get(transId);

      if (duplicate) {
        return;
      }

      // Store the event and credit the balance atomically.
      db.prepare(`
        INSERT INTO offerwall_events (
          transaction_id,
          user_id,
          reward
        )
        VALUES (?, ?, ?)
      `).run(transId, userId, rewardValue);

      const update = db.prepare(`
        UPDATE users
        SET moon = moon + ?
        WHERE id = ?
          AND suspended = 0
      `).run(moonsToCredit, userId);

      if (Number(update.changes) !== 1) {
        throw new Error('USER_CREDIT_FAILED');
      }

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          moon,
          description,
          reference
        )
        VALUES (?, 'offerwall_reward', ?, ?, ?)
      `).run(
        userId,
        moonsToCredit,
        'Offerwall.me reward',
        `offerwall:${transId}`
      );
    });

    return res.status(200).send('ok');
  } catch (error) {
    // A failed transaction should be retried by the provider.
    console.error('Offerwall callback error:', error);

    return res.status(500).send('processing_failed');
  }
});
// ============================================
// MOONET — PART 9A: ADMIN DASHBOARD
// ============================================

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  try {
    const totalUsers = db.prepare(`
      SELECT COUNT(*) AS total
      FROM users
    `).get().total;

    const totalVideos = db.prepare(`
      SELECT COUNT(*) AS total
      FROM videos
    `).get().total;

    const pendingWithdrawals = db.prepare(`
      SELECT COUNT(*) AS total
      FROM withdrawals
      WHERE LOWER(status) = 'pending'
    `).get().total;

    const totalMoons = db.prepare(`
      SELECT COALESCE(SUM(moon), 0) AS total
      FROM users
    `).get().total;

    const totalRevenue = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM revenue
    `).get().total;

    const totalExpenses = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM expenses
    `).get().total;

    const recentUsers = db.prepare(`
      SELECT id, name, email, moon, created_at
      FROM users
      ORDER BY id DESC
      LIMIT 10
    `).all();

    const recentWithdrawals = db.prepare(`
      SELECT *
      FROM withdrawals
      ORDER BY id DESC
      LIMIT 10
    `).all();

    const money = value =>
      Number(value || 0).toLocaleString('en-US', {
        maximumFractionDigits: 2
      });

    const escapeHtml = value =>
      String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]);

    const usersRows = recentUsers.map(user => `
      <tr>
        <td>${escapeHtml(user.id)}</td>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${money(user.moon)} MOONS</td>
        <td>${escapeHtml(user.created_at)}</td>
      </tr>
    `).join('');

    const withdrawalRows = recentWithdrawals.map(item => `
      <tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.user_id)}</td>
        <td>${escapeHtml(item.amount)}</td>
        <td>${escapeHtml(item.status)}</td>
      </tr>
    `).join('');

    res.send(pageLayout('Admin Dashboard', `
      <main class="container">
        <h1>🌙 MOONET Admin Dashboard</h1>

        <div class="grid">
          <section class="card">
            <h3>👥 Abakoresha</h3>
            <h2>${money(totalUsers)}</h2>
          </section>

          <section class="card">
            <h3>🎬 Videos</h3>
            <h2>${money(totalVideos)}</h2>
          </section>

          <section class="card">
            <h3>💸 Pending Withdrawals</h3>
            <h2>${money(pendingWithdrawals)}</h2>
          </section>

          <section class="card">
            <h3>🌙 MOONS z'abakoresha</h3>
            <h2>${money(totalMoons)}</h2>
          </section>

          <section class="card">
            <h3>💰 Revenue</h3>
            <h2>${money(totalRevenue)}</h2>
          </section>

          <section class="card">
            <h3>📉 Expenses</h3>
            <h2>${money(totalExpenses)}</h2>
          </section>

          <section class="card">
            <h3>📊 Revenue minus expenses</h3>
            <h2>${money(totalRevenue - totalExpenses)}</h2>
          </section>
        </div>

        <h2>👥 Abakoresha baheruka kwiyandikisha</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Amazina</th>
                <th>Email</th>
                <th>MOONS</th>
                <th>Itariki</th>
              </tr>
            </thead>
            <tbody>
              ${usersRows || '<tr><td colspan="5">Nta bakoresha babonetse.</td></tr>'}
            </tbody>
          </table>
        </div>

        <h2>💸 Withdrawals ziheruka</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>User ID</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${withdrawalRows || '<tr><td colspan="4">Nta withdrawals ziraboneka.</td></tr>'}
            </tbody>
          </table>
        </div>
      </main>

      <style>
        .container {
          max-width: 1100px;
          margin: 24px auto;
          padding: 16px;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(
            auto-fit,
            minmax(190px, 1fr)
          );
          gap: 16px;
        }

        .card {
          padding: 20px;
          border-radius: 14px;
          background: #f0fff4;
          border: 1px solid #b7ebc6;
          overflow-wrap: anywhere;
        }

        .card h2 {
          color: #078447;
        }

        .table-wrap {
          width: 100%;
          overflow-x: auto;
          margin-bottom: 28px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 600px;
        }

        th, td {
          padding: 12px;
          border-bottom: 1px solid #ddd;
          text-align: left;
        }

        th {
          background: #087f46;
          color: white;
        }
      </style>
    `));
  } catch (error) {
    console.error('MOONET Admin Dashboard error:', error);
    res.status(500).send(
      'Admin Dashboard ntiyashoboye gufunguka. Reba server logs.'
    );
  }
});
// ============================================
// MOONET — PART 9B: ADMIN WITHDRAWALS
// ============================================

// Reba ubusabe bwose bwo kubikuza
app.get('/admin/withdrawals', requireAdmin, (req, res) => {
  try {
    const withdrawals = db.prepare(`
      SELECT
        w.*,
        u.name AS user_name,
        u.email AS user_email
      FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY w.id DESC
      LIMIT 200
    `).all();

    const escapeHtml = value =>
      String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]);

    const rows = withdrawals.map(w => `
      <tr>
        <td>${escapeHtml(w.id)}</td>
        <td>${escapeHtml(w.user_name)}</td>
        <td>${escapeHtml(w.user_email)}</td>
        <td>${escapeHtml(w.amount)}</td>
        <td>${escapeHtml(w.status)}</td>
        <td>${escapeHtml(w.created_at)}</td>
      </tr>
    `).join('');

    res.send(pageLayout('MOONET Withdrawals', `
      <main style="max-width:1100px;margin:25px auto;padding:16px">
        <h1>💸 MOONET Withdrawals</h1>

        <p>
          Hano ureba ubusabe bwo kubikuza MOONS.
          Kwemeza cyangwa kwanga ubusabe bizongerwamo
          nyuma yo kugenzura uburyo amafaranga abikwa.
        </p>

        <div style="overflow-x:auto">
          <table style="
            width:100%;
            border-collapse:collapse;
            min-width:650px
          ">
            <thead>
              <tr style="background:#087f46;color:white">
                <th>ID</th>
                <th>Umukoresha</th>
                <th>Email</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Itariki</th>
              </tr>
            </thead>

            <tbody>
              ${rows || `
                <tr>
                  <td colspan="6">
                    Nta busabe bwo kubikuza buraboneka.
                  </td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </main>

      <style>
        th,td {
          padding:12px;
          border-bottom:1px solid #ddd;
          text-align:left;
        }
      </style>
    `));
  } catch (error) {
    console.error('MOONET withdrawals error:', error);

    res.status(500).send(
      'Ntibyashobotse kubona withdrawals. Reba server logs.'
    );
  }
});
// ============================================
// MOONET — PART 9C: REVENUE & EXPENSES
// ============================================

// ADMIN: Reba amafaranga yinjiye n'ayasohotse
app.get('/admin/finances', requireAdmin, (req, res) => {
  try {
    const revenue = db.prepare(`
      SELECT *
      FROM revenue
      ORDER BY id DESC
      LIMIT 100
    `).all();

    const expenses = db.prepare(`
      SELECT *
      FROM expenses
      ORDER BY id DESC
      LIMIT 100
    `).all();

    const totalRevenue = Number(
      db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM revenue
      `).get().total
    );

    const totalExpenses = Number(
      db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM expenses
      `).get().total
    );

    const escapeHtml = value =>
      String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]);

    const formatMoney = value =>
      Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });

    const revenueRows = revenue.map(item => `
      <tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.description)}</td>
        <td>${formatMoney(item.amount)}</td>
        <td>${escapeHtml(item.created_at)}</td>
      </tr>
    `).join('');

    const expenseRows = expenses.map(item => `
      <tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.description)}</td>
        <td>${formatMoney(item.amount)}</td>
        <td>${escapeHtml(item.created_at)}</td>
      </tr>
    `).join('');

    res.send(pageLayout('MOONET Finances', `
      <main class="finance-container">
        <h1>💰 MOONET Financial Dashboard</h1>

        <section class="finance-cards">
          <div class="finance-card">
            <h3>Total Revenue</h3>
            <h2>${formatMoney(totalRevenue)}</h2>
          </div>

          <div class="finance-card">
            <h3>Total Expenses</h3>
            <h2>${formatMoney(totalExpenses)}</h2>
          </div>

          <div class="finance-card">
            <h3>Net Balance</h3>
            <h2>${formatMoney(totalRevenue - totalExpenses)}</h2>
          </div>
        </section>

        <h2>📈 Revenue Records</h2>

        <div class="finance-table">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${revenueRows || `
                <tr><td colspan="4">Nta revenue records ziraboneka.</td></tr>
              `}
            </tbody>
          </table>
        </div>

        <h2>📉 Expense Records</h2>

        <div class="finance-table">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${expenseRows || `
                <tr><td colspan="4">Nta expense records ziraboneka.</td></tr>
              `}
            </tbody>
          </table>
        </div>
      </main>

      <style>
        .finance-container {
          max-width: 1100px;
          margin: 25px auto;
          padding: 16px;
        }

        .finance-cards {
          display: grid;
          grid-template-columns:
            repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
        }

        .finance-card {
          background: #effff4;
          border: 1px solid #b7ebc6;
          border-radius: 14px;
          padding: 20px;
          overflow-wrap: anywhere;
        }

        .finance-card h2 {
          color: #087f46;
        }

        .finance-table {
          overflow-x: auto;
          margin-bottom: 28px;
        }

        table {
          width: 100%;
          min-width: 600px;
          border-collapse: collapse;
        }

        th, td {
          padding: 12px;
          border-bottom: 1px solid #ddd;
          text-align: left;
        }

        th {
          background: #087f46;
          color: white;
        }
      </style>
    `));

  } catch (error) {
    console.error('MOONET finances error:', error);

    res.status(500).send(
      'Financial Dashboard ntiyafungutse. Reba server logs.'
    );
  }
});
// ============================================
// MOONET — PART 10B: SIGNED OFFERWALL URL
// ============================================

app.get('/offers', requireLogin, (req, res) => {
  try {
    const publicKey = String(
      process.env.OFFERWALL_PUBLIC_API_KEY || ''
    ).trim();

    const identitySecret = String(
      process.env.OFFERWALL_IDENTITY_SECRET || ''
    ).trim();

    if (!publicKey || !identitySecret) {
      return res.status(503).send(
        pageLayout('Offers', `
          <main style="max-width:700px;margin:30px auto;padding:20px">
            <h1>🌙 MOONET Offers</h1>
            <p>Offerwall ntirategurwa neza. Ongera ugerageze nyuma.</p>
          </main>
        `)
      );
    }

    const userId = String(req.session.userId);
    const expires = Math.floor(Date.now() / 1000) + 3600;

    const message = [
      'offerwall-user-v1',
      publicKey,
      userId,
      String(expires)
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', identitySecret)
      .update(message)
      .digest('hex');

    const offerUrl =
      'https://offerwall.me/offerwall/' +
      encodeURIComponent(publicKey) + '/' +
      encodeURIComponent(userId) +
      '?identityExpires=' + expires +
      '&identitySignature=' + signature;

    res.send(pageLayout('MOONET Offers', `
      <main style="max-width:700px;margin:30px auto;padding:20px">
        <h1>🌙 MOONET Offers</h1>
        <p>Complete eligible offers to earn MOONS.</p>

        <a
          href="${offerUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="
            display:inline-block;
            background:#087f46;
            color:white;
            padding:14px 24px;
            border-radius:10px;
            text-decoration:none;
            font-weight:bold
          "
        >
          Open Offers
        </a>

        <p style="margin-top:20px">
          MOONS zizongerwa nyuma yo kwemezwa na offer provider.
        </p>
      </main>
    `));
  } catch (error) {
    console.error('MOONET offers error:', error);

    res.status(500).send(
      'Offers ntizashoboye gufunguka.'
    );
  }
});
// ============================================
// MOONET — PART 10C: OFFERWALL POSTBACK
// ============================================

app.get('/offerwall/callback', (req, res) => {
  try {
    const secret = String(
      process.env.OFFERWALL_POSTBACK_SECRET || ''
    ).trim();

    if (!secret) {
      console.error('Offerwall postback secret is missing.');
      return res.status(503).send('not configured');
    }

    const {
      subId,
      transId,
      reward,
      signature,
      status
    } = req.query;

    // 1. Validate required fields
    if (
      typeof subId !== 'string' ||
      typeof transId !== 'string' ||
      typeof reward !== 'string' ||
      typeof signature !== 'string' ||
      typeof status !== 'string'
    ) {
      return res.status(400).send('missing parameters');
    }

    // 2. Validate reward format
    const rewardNumber = Number(reward);

    if (
      !Number.isFinite(rewardNumber) ||
      rewardNumber <= 0 ||
      !/^\d+$/.test(subId) ||
      !/^[a-fA-F0-9-]{1,200}$/.test(transId)
    ) {
      return res.status(400).send('invalid parameters');
    }

    // 3. Verify provider signature:
    // MD5(subId + transId + reward + secret)
    const expectedSignature = crypto
      .createHash('md5')
      .update(subId + transId + reward + secret)
      .digest('hex');

    const supplied = Buffer.from(signature.toLowerCase(), 'utf8');
    const expected = Buffer.from(expectedSignature, 'utf8');

    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(supplied, expected)
    ) {
      console.warn('Invalid Offerwall signature.');
      return res.status(403).send('invalid signature');
    }

    // 4. Only known statuses are accepted
    if (status !== '1' && status !== '2') {
      return res.status(400).send('invalid status');
    }

    // 5. Find the MOONET user
    const userId = Number(subId);

    const user = db.prepare(`
      SELECT id, moon
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!user) {
      return res.status(404).send('user not found');
    }

    /*
      IMPORTANT:
      Before enabling this route, confirm with Offerwall.me
      whether "reward" represents MOONS or USD/publisher payout.

      Do not credit a dollar amount directly as MOONS.
      The conversion must match your Offerwall configuration.
    */

    if (status === '2') {
      // Chargebacks require a separate, verified reversal flow.
      // Do not silently treat a reversal as a new reward.
      console.warn(
        'Offerwall chargeback received; manual review required.',
        transId
      );

      return res.status(200).send('ok');
    }

    // Reward conversion must be explicitly configured.
    const moonsPerRewardUnit = Number(
      process.env.OFFERWALL_MOONS_PER_REWARD_UNIT || '0'
    );

    if (
      !Number.isFinite(moonsPerRewardUnit) ||
      moonsPerRewardUnit <= 0
    ) {
      console.error('Offerwall reward conversion is not configured.');
      return res.status(503).send('reward conversion not configured');
    }

    const moons = Math.floor(
      rewardNumber * moonsPerRewardUnit
    );

    if (!Number.isSafeInteger(moons) || moons <= 0) {
      return res.status(400).send('invalid converted reward');
    }

    // 6. Credit transactionally and prevent duplicate transactions.
    runInTransaction(() => {
      const alreadyProcessed = db.prepare(`
        SELECT transaction_id
        FROM offerwall_events
        WHERE transaction_id = ?
      `).get(transId);

      if (alreadyProcessed) {
        return;
      }

      db.prepare(`
        INSERT INTO offerwall_events (
          transaction_id,
          user_id,
          reward
        ) VALUES (?, ?, ?)
      `).run(transId, userId, moons);

      db.prepare(`
        UPDATE users
        SET moon = moon + ?
        WHERE id = ?
      `).run(moons, userId);

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          moon,
          description,
          reference
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        userId,
        'offerwall_reward',
        moons,
        'Offerwall reward',
        'offerwall:' + transId
      );
    });

    return res.status(200).send('ok');

  } catch (error) {
    console.error('Offerwall callback error:', error);
    return res.status(500).send('temporary error');
  }
});
// ============================================
// MOONET — PART 10D: OFFERWALL EVENT MIGRATION
// ============================================

db.exec(`
  CREATE TABLE IF NOT EXISTS offerwall_event_status (
    transaction_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reward_moon INTEGER NOT NULL CHECK(reward_moon > 0),
    status TEXT NOT NULL
      CHECK(status IN ('credited', 'reversed')),
    credited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reversed_at TEXT
  );
`);
// ============================================
// MOONET — PART 10E: OFFERWALL RECONCILIATION
// ============================================

// Admin-only report.
// This route READS data; it does not change user balances.

app.get('/admin/offerwall-audit', requireAdmin, (req, res) => {
  try {
    const eventTableExists = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'offerwall_events'
    `).get();

    if (!eventTableExists) {
      return res.status(503).send(
        'Offerwall events table is not configured.'
      );
    }

    const totalEvents = db.prepare(`
      SELECT COUNT(*) AS total
      FROM offerwall_events
    `).get().total;

    const totalRecordedRewards = db.prepare(`
      SELECT COALESCE(SUM(reward), 0) AS total
      FROM offerwall_events
    `).get().total;

    const recentEvents = db.prepare(`
      SELECT
        transaction_id,
        user_id,
        reward,
        created_at
      FROM offerwall_events
      ORDER BY id DESC
      LIMIT 100
    `).all();

    const escapeHtml = value =>
      String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]);

    const rows = recentEvents.map(event => `
      <tr>
        <td>${escapeHtml(event.transaction_id)}</td>
        <td>${escapeHtml(event.user_id)}</td>
        <td>${escapeHtml(event.reward)}</td>
        <td>${escapeHtml(event.created_at)}</td>
      </tr>
    `).join('');

    res.send(pageLayout('Offerwall Audit', `
      <main style="max-width:1000px;margin:25px auto;padding:16px">
        <h1>🌙 MOONET Offerwall Audit</h1>

        <section style="
          background:#effff4;
          border:1px solid #b7ebc6;
          border-radius:12px;
          padding:18px;
          margin-bottom:20px
        ">
          <h3>Transactions recorded</h3>
          <p>${escapeHtml(totalEvents)}</p>

          <h3>Total recorded reward value</h3>
          <p>${escapeHtml(totalRecordedRewards)}</p>
        </section>

        <h2>Recent Offerwall events</h2>

        <div style="overflow-x:auto">
          <table style="
            width:100%;
            border-collapse:collapse;
            min-width:600px
          ">
            <thead>
              <tr style="background:#087f46;color:white">
                <th>Transaction ID</th>
                <th>User ID</th>
                <th>Recorded reward</th>
                <th>Date</th>
              </tr>
            </thead>

            <tbody>
              ${rows || `
                <tr>
                  <td colspan="4">No events recorded yet.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>

        <p>
          This report shows recorded events only.
          It does not independently verify provider payments.
        </p>
      </main>

      <style>
        th, td {
          padding:12px;
          border-bottom:1px solid #ddd;
          text-align:left;
          overflow-wrap:anywhere;
        }
      </style>
    `));

  } catch (error) {
    console.error('MOONET Offerwall audit error:', error);

    res.status(500).send(
      'Offerwall audit failed. Check server logs.'
    );
  }
});
