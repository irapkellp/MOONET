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

// ================================================
// MOONET CONFIGURATION
// ================================================

const PORT = Number(process.env.PORT || 10000);
const APP_NAME = 'MOONET';

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

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

fs.mkdirSync(UPLOAD_DIR, {
  recursive: true
});

// ================================================
// DATABASE CONNECTION
// Preserve the existing database.
// Never delete or reset moonet.db.
// ================================================

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

  return crypto.timingSafeEqual(
    first,
    second
  );
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
  return crypto
    .randomBytes(bytes)
    .toString('hex');
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
// END OF CODE A
// Next: CODE B — DATABASE TABLES AND MIGRATIONS
// ================================================
// ================================================
// PART 2: DATABASE TABLES
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
  return db.prepare(
    \`PRAGMA table_info("\${tableName}")\`
  ).all().map(column => column.name);
}

function addColumnIfMissing(
  tableName,
  columnName,
  definition
) {
  const columns = getTableColumns(tableName);

  if (!columns.includes(columnName)) {
    db.exec(
      \`ALTER TABLE "\${tableName}" ADD COLUMN "\${columnName}" \${definition}\`
    );
  }
}

// ================================================
// SAFE MIGRATIONS
// ================================================

// Add media_type without deleting existing videos.
addColumnIfMissing(
  'videos',
  'media_type',
  "TEXT NOT NULL DEFAULT 'video'"
);

// Add reward breakdown columns without resetting balances.
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

// ================================================
// DATABASE INDEXES
// ================================================

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
// END OF CODE B
// Next: CODE C — AUTHENTICATION & USER HELPERS
// ================================================
// ================================================
// PART 3: USER HELPERS & AUTHENTICATION
// ================================================

// Generate a unique referral code for a user.
function generateReferralCode() {
  return 'MOON' +
    crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Find a user by database ID.
function getUserById(id) {
  return db.prepare(`
    SELECT *
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(Number(id)) || null;
}

// Find a user by email address.
function getUserByEmail(email) {
  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();

  return db.prepare(`
    SELECT *
    FROM users
    WHERE LOWER(email) = ?
    LIMIT 1
  `).get(normalizedEmail) || null;
}

// Get the currently authenticated user.
function currentUser(req) {
  if (!req.session || !req.session.userId) {
    return null;
  }

  return getUserById(req.session.userId);
}

// Check whether a user is logged in.
function requireLogin(req, res, next) {
  const user = currentUser(req);

  if (!user) {
    return res.redirect('/login');
  }

  if (Number(user.suspended) === 1) {
    req.session.destroy(() => {
      res.status(403).send(
        'Your MOONET account is suspended.'
      );
    });
    return;
  }

  req.user = user;
  next();
}

// Check whether a user has Admin access.
function requireAdmin(req, res, next) {
  const user = currentUser(req);

  if (!user) {
    return res.redirect('/login');
  }

  const configuredAdminEmail = String(
    process.env.ADMIN_EMAIL || ''
  ).trim().toLowerCase();

  const userEmail = String(user.email || '')
    .trim()
    .toLowerCase();

  if (
    !configuredAdminEmail ||
    userEmail !== configuredAdminEmail
  ) {
    return res.status(403).send(
      'Access denied. Admin permission is required.'
    );
  }

  req.user = user;
  next();
}

// Format MOONS for display.
function formatMoons(value) {
  const amount = Number(value || 0);

  if (!Number.isFinite(amount)) {
    return '0 MOONS';
  }

  return `${amount.toLocaleString('en-US', {
    maximumFractionDigits: 4
  })} MOONS`;
}

// ================================================
// END OF CODE C
// NEXT: CODE D — PAGE LAYOUT AND DESIGN
// ================================================
// ================================================
// PART 4: PAGE LAYOUT AND DESIGN
// ================================================

function pageLayout(title, body, user = null) {
  const safeTitle = escapeHtml(title || 'MOONET');

  const configuredAdminEmail = String(
    process.env.ADMIN_EMAIL || ''
  ).trim().toLowerCase();

  const userEmail = String(user?.email || '')
    .trim()
    .toLowerCase();

  const isAdmin =
    Boolean(configuredAdminEmail) &&
    userEmail === configuredAdminEmail;

  const nav = user
    ? `
      <nav class="navigation">
        <a href="/">Home</a>
        <a href="/feed">Videos</a>
        <a href="/upload">Upload</a>
        <a href="/offers">Earn MOONS</a>
        <a href="/wallet">Wallet</a>
        <a href="/withdraw">Withdraw</a>
        <a href="/transactions">History</a>
        <a href="/profile">Profile</a>
        ${isAdmin ? '<a href="/admin">Admin</a>' : ''}
        <a href="/logout">Log out</a>
      </nav>
    `
    : `
      <nav class="navigation">
        <a href="/">Home</a>
        <a href="/login">Log in</a>
        <a href="/signup">Create account</a>
      </nav>
    `;

  const balance = user
    ? `
      <div class="balance-card">
        <span>Your MOONET wallet</span>
        <strong>${escapeHtml(formatMoons(user.moon))}</strong>
      </div>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <meta name="theme-color" content="#16a34a">

  <title>${safeTitle} | MOONET</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #f5f7f5;
      color: #17211b;
      line-height: 1.6;
    }

    header {
      background: #ffffff;
      border-bottom: 1px solid #e1e8e2;
      padding: 16px;
    }

    .header-inner {
      max-width: 1100px;
      margin: auto;
    }

    .brand {
      color: #15803d;
      font-size: 28px;
      font-weight: 800;
      text-decoration: none;
      letter-spacing: -1px;
    }

    .tagline {
      margin: 2px 0 12px;
      color: #65736a;
      font-size: 14px;
    }

    .navigation {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .navigation a {
      color: #166534;
      text-decoration: none;
      background: #f0fdf4;
      padding: 8px 11px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
    }

    .navigation a:hover {
      background: #dcfce7;
    }

    main {
      max-width: 1100px;
      margin: 24px auto;
      padding: 0 16px;
      min-height: 55vh;
    }

    .balance-card {
      background: #166534;
      color: #ffffff;
      border-radius: 12px;
      padding: 14px 18px;
      margin-top: 15px;
    }

    .balance-card span {
      display: block;
      font-size: 13px;
      opacity: 0.9;
    }

    .balance-card strong {
      display: block;
      font-size: 24px;
      overflow-wrap: anywhere;
    }

    .card {
      background: #ffffff;
      padding: 20px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      margin-bottom: 18px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
    }

    h1,
    h2,
    h3 {
      line-height: 1.3;
    }

    h1 {
      font-size: clamp(26px, 5vw, 40px);
    }

    input,
    select,
    textarea {
      display: block;
      width: 100%;
      padding: 12px;
      margin: 7px 0 14px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      font: inherit;
      background: #ffffff;
    }

    input:focus,
    select:focus,
    textarea:focus {
      outline: 2px solid #86efac;
      border-color: #16a34a;
    }

    button,
    .button {
      display: inline-block;
      width: auto;
      background: #16a34a;
      color: #ffffff;
      border: none;
      padding: 11px 17px;
      cursor: pointer;
      text-decoration: none;
      border-radius: 8px;
      font: inherit;
      font-weight: 600;
    }

    button:hover,
    .button:hover {
      background: #15803d;
    }

    .muted {
      color: #65736a;
    }

    .success {
      color: #166534;
      background: #dcfce7;
      padding: 12px;
      border-radius: 8px;
    }

    .error {
      color: #991b1b;
      background: #fee2e2;
      padding: 12px;
      border-radius: 8px;
    }

    .video-grid {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }

    .video-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 14px;
      overflow-wrap: anywhere;
    }

    .video-card video {
      display: block;
      width: 100%;
      max-height: 480px;
      background: #111111;
      border-radius: 8px;
    }

    .video-card img {
      display: block;
      max-width: 100%;
      border-radius: 8px;
    }

    .table-wrap {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
    }

    th,
    td {
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid #e5e7eb;
      overflow-wrap: anywhere;
    }

    th {
      background: #f0fdf4;
    }

    footer {
      text-align: center;
      padding: 22px 16px;
      color: #6b7280;
      font-size: 13px;
    }

    @media (max-width: 600px) {
      main {
        margin-top: 16px;
        padding: 0 12px;
      }

      .navigation {
        gap: 6px;
      }

      .navigation a {
        font-size: 12px;
        padding: 7px 9px;
      }

      .card {
        padding: 15px;
      }

      .balance-card strong {
        font-size: 21px;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="header-inner">
      <a class="brand" href="/">MOONET 🌙</a>

      <p class="tagline">
        Watch. Create. Connect. Earn MOONS.
      </p>

      ${nav}
      ${balance}
    </div>
  </header>

  <main>
    ${body || ''}
  </main>

  <footer>
    MOONET &copy; ${new Date().getFullYear()}
    — Watch, create, connect.
  </footer>
</body>
</html>`;
}

// ================================================
// END OF CODE D
// NEXT: CODE E — SIGNUP, LOGIN AND LOGOUT
// ================================================
// ================================================
// CODE E — SIGNUP, LOGIN AND LOGOUT
// ================================================

// SIGNUP PAGE
app.get('/signup', (req, res) => {
  if (currentUser(req)) {
    return res.redirect('/');
  }

  const body = `
    <section class="card">
      <h1>Create your MOONET account 🌙</h1>
      <p class="muted">
        Join MOONET to watch videos, create content
        and earn MOONS.
      </p>

      <form method="POST" action="/signup">
        <label for="name">Full name</label>
        <input
          id="name"
          name="name"
          type="text"
          minlength="2"
          maxlength="80"
          autocomplete="name"
          required
        >

        <label for="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          maxlength="254"
          autocomplete="email"
          required
        >

        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          minlength="8"
          maxlength="128"
          autocomplete="new-password"
          required
        >

        <label for="referral_code">
          Referral code (optional)
        </label>
        <input
          id="referral_code"
          name="referral_code"
          type="text"
          maxlength="30"
        >

        <button type="submit">
          Create account
        </button>
      </form>

      <p>
        Already registered?
        <a href="/login">Log in</a>
      </p>
    </section>
  `;

  res.send(pageLayout('Create account', body));
});


// PROCESS SIGNUP
app.post('/signup', (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body.password || '');
    const referralCode = String(
      req.body.referral_code || ''
    ).trim().toUpperCase();

    if (name.length < 2 || name.length > 80) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<section class="card error">Enter a name between 2 and 80 characters.</section>'
        )
      );
    }

    if (!isValidEmail(email) || email.length > 254) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<section class="card error">Enter a valid email address.</section>'
        )
      );
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<section class="card error">Your password must contain between 8 and 128 characters.</section>'
        )
      );
    }

    if (getUserByEmail(email)) {
      return res.status(409).send(
        pageLayout(
          'Signup error',
          '<section class="card error">This email is already registered. Please log in.</section><p><a href="/login">Go to login</a></p>'
        )
      );
    }

    let referredBy = null;

    if (referralCode) {
      const referrer = db.prepare(`
        SELECT id
        FROM users
        WHERE UPPER(referral_code) = ?
        LIMIT 1
      `).get(referralCode);

      if (referrer) {
        referredBy = Number(referrer.id);
      }
    }

    const passwordHash = bcrypt.hashSync(password, 12);

    let newUserId;

    // Transaction keeps account creation consistent.
    db.exec('BEGIN IMMEDIATE');

    try {
      let uniqueReferralCode;
      let attempts = 0;

      do {
        uniqueReferralCode = generateReferralCode();
        attempts++;

        if (attempts > 10) {
          throw new Error(
            'Could not generate a unique referral code.'
          );
        }
      } while (
        db.prepare(`
          SELECT id
          FROM users
          WHERE referral_code = ?
        `).get(uniqueReferralCode)
      );

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
        uniqueReferralCode,
        referredBy
      );

      newUserId = Number(result.lastInsertRowid);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // Establish the session only after the account is saved.
    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error(
          'MOONET signup session error:',
          sessionError.message
        );

        return res.redirect('/login');
      }

      req.session.userId = newUserId;

      req.session.save((saveError) => {
        if (saveError) {
          console.error(
            'MOONET signup session save error:',
            saveError.message
          );

          return res.redirect('/login');
        }

        return res.redirect('/');
      });
    });
  } catch (error) {
    if (
      String(error.message || '').includes('UNIQUE constraint failed')
    ) {
      return res.status(409).send(
        pageLayout(
          'Signup error',
          '<section class="card error">This email or referral code is already in use. Please try again.</section>'
        )
      );
    }

    console.error('MOONET signup error:', error.message);

    return res.status(500).send(
      pageLayout(
        'Signup error',
        '<section class="card error">We could not create your account. Please try again later.</section>'
      )
    );
  }
});


// LOGIN PAGE
app.get('/login', (req, res) => {
  if (currentUser(req)) {
    return res.redirect('/');
  }

  const body = `
    <section class="card">
      <h1>Welcome back 🌙</h1>
      <p class="muted">
        Log in to your MOONET account.
      </p>

      <form method="POST" action="/login">
        <label for="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          maxlength="254"
          autocomplete="email"
          required
        >

        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          maxlength="128"
          autocomplete="current-password"
          required
        >

        <button type="submit">Log in</button>
      </form>

      <p>
        New to MOONET?
        <a href="/signup">Create an account</a>
      </p>
    </section>
  `;

  res.send(pageLayout('Log in', body));
});


// PROCESS LOGIN
app.post('/login', (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');

    if (
      !isValidEmail(email) ||
      email.length > 254 ||
      password.length === 0 ||
      password.length > 128
    ) {
      return res.status(400).send(
        pageLayout(
          'Login error',
          '<section class="card error">Enter a valid email and password.</section><p><a href="/login">Try again</a></p>'
        )
      );
    }

    const user = getUserByEmail(email);

    // Use a generic error to avoid revealing whether an email exists.
    if (
      !user ||
      !bcrypt.compareSync(password, user.password_hash)
    ) {
      return res.status(401).send(
        pageLayout(
          'Login error',
          '<section class="card error">Email or password is incorrect.</section><p><a href="/login">Try again</a></p>'
        )
      );
    }

    if (Number(user.suspended) === 1) {
      return res.status(403).send(
        pageLayout(
          'Account suspended',
          '<section class="card error">Your MOONET account is suspended. Please contact support.</section>'
        )
      );
    }

    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error(
          'MOONET login session error:',
          sessionError.message
        );

        return res.status(500).send(
          'Unable to log in right now. Please try again.'
        );
      }

      req.session.userId = Number(user.id);

      req.session.save((saveError) => {
        if (saveError) {
          console.error(
            'MOONET login session save error:',
            saveError.message
          );

          return res.status(500).send(
            'Unable to save your login session. Please try again.'
          );
        }

        return res.redirect('/');
      });
    });
  } catch (error) {
    console.error('MOONET login error:', error.message);

    return res.status(500).send(
      'An unexpected error occurred. Please try again later.'
    );
  }
});


// LOGOUT
app.get('/logout', (req, res) => {
  if (!req.session) {
    return res.redirect('/login');
  }

  req.session.destroy((error) => {
    if (error) {
      console.error(
        'MOONET logout error:',
        error.message
      );

      return res.status(500).send(
        'Unable to log out. Please try again.'
      );
    }

    res.clearCookie('moonet.sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    return res.redirect('/login');
  });
});


// ================================================
// END OF CODE E
// NEXT: CODE F — HOME PAGE AND VIDEO FEED
// ================================================
// ============================================
// MOONET - PART 12
// Offerwall environment configuration
// ============================================

const OFFERWALL_CONFIG = {
  appId:
    process.env.OFFERWALL_APP_ID ||
    process.env.OFFERWALL_ID ||
    '',

  offerwallUrl:
    process.env.OFFERWALL_URL || '',

  rewardSecret:
    process.env.OFFERWALL_REWARD_SECRET ||
    process.env.OFFERWALL_SECRET ||
    '',

  moonsPerDollar: Number(
    process.env.OFFERWALL_MOONS_PER_DOLLAR || 100
  )
};


// ============================================
// PART 13: Offerwall configuration status
// ============================================

function getOfferwallConfigStatus() {
  const rate = OFFERWALL_CONFIG.moonsPerDollar;

  return {
    appIdConfigured: Boolean(OFFERWALL_CONFIG.appId),

    urlConfigured: Boolean(
      OFFERWALL_CONFIG.offerwallUrl
    ),

    rewardSecretConfigured: Boolean(
      OFFERWALL_CONFIG.rewardSecret
    ),

    moonsPerDollar:
      Number.isFinite(rate) && rate > 0
        ? rate
        : 100
  };
}


function getOfferwallStatus() {
  const status = getOfferwallConfigStatus();

  return {
    configured:
      status.appIdConfigured &&
      status.urlConfigured,

    appIdConfigured: status.appIdConfigured,

    urlConfigured: status.urlConfigured,

    rewardSecretConfigured:
      status.rewardSecretConfigured,

    moonsPerDollar: status.moonsPerDollar
  };
}


// ============================================
// PART 14: Offerwall URL helper
// ============================================

function getOfferwallUrlForUser(userId) {
  const baseUrl = OFFERWALL_CONFIG.offerwallUrl;
  const appId = OFFERWALL_CONFIG.appId;

  if (!baseUrl) {
    throw new Error(
      'Offerwall URL is not configured.'
    );
  }

  if (!userId) {
    throw new Error(
      'A valid user ID is required.'
    );
  }

  let url;

  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(
      'The configured Offerwall URL is invalid.'
    );
  }

  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:'
  ) {
    throw new Error(
      'The Offerwall URL must use HTTP or HTTPS.'
    );
  }

  if (
    appId &&
    !url.searchParams.has('app_id')
  ) {
    url.searchParams.set('app_id', appId);
  }

  // Add the user's ID only after confirming
  // the parameter required by the offerwall provider.
  // Do not invent provider-specific parameters.

  return url.toString();
}


// ============================================
// MOONET SERVER STARTUP
// Keep this section at the very end.
// ============================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `MOONET is listening on port ${PORT}`
  );
});


// ============================================
// Graceful shutdown
// ============================================

function shutdown(signal) {
  console.log(
    `${signal} received. Shutting down MOONET...`
  );

  server.close(() => {
    try {
      db.close();

      console.log(
        'MOONET database connection closed.'
      );

      process.exit(0);
    } catch (error) {
      console.error(
        'Database shutdown error:',
        error
      );

      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('Shutdown timed out.');
    process.exit(1);
  }, 10000).unref();
}


process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  shutdown('SIGINT');
});
