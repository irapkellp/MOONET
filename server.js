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
// END OF PART 1
// PART 2: DATABASE TABLES AND SAFE MIGRATIONS
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
    `PRAGMA table_info("${tableName}")`
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
      `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
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
// END OF PART 2
// PART 3: AUTHENTICATION AND USER HELPERS
// ================================================
// ============================================
// PART 3: USER HELPERS, AUTHENTICATION & LAYOUT
// ============================================

// Generate a unique referral code for a user.
function generateReferralCode() {
  return 'MOON' + crypto.randomBytes(4).toString('hex').toUpperCase();
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

  if (!configuredAdminEmail || userEmail !== configuredAdminEmail) {
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

// Create the shared HTML page layout.
// IMPORTANT: Keep only ONE pageLayout() function in the final file.
function pageLayout(title, body, user = null) {
  const safeTitle = escapeHtml(title || 'MOONET');

  const nav = user
    ? `
      <nav class="navigation">
        <a href="/">Home</a>
        <a href="/feed">Videos</a>
        <a href="/offers">Earn MOONS</a>
        <a href="/wallet">Wallet</a>
        <a href="/transactions">History</a>
        <a href="/profile">Profile</a>
        ${
          String(user.email || '').trim().toLowerCase() ===
          String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
            ? '<a href="/admin">Admin</a>'
            : ''
        }
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
        <span>Your balance</span>
        <strong>${escapeHtml(formatMoons(user.moon))}</strong>
      </div>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#16a34a">
  <title>${safeTitle} | MOONET</title>

  <style>
    * {
      box-sizing: border-box;
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
      max-width: 1000px;
      margin: auto;
    }

    .brand {
      color: #15803d;
      font-size: 27px;
      font-weight: 800;
      text-decoration: none;
    }

    .tagline {
      margin: 2px 0 12px;
      color: #65736a;
      font-size: 14px;
    }

    .navigation {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }

    .navigation a {
      color: #166534;
      text-decoration: none;
      background: #f0fdf4;
      padding: 7px 11px;
      border-radius: 8px;
      font-size: 14px;
    }

    .navigation a:hover {
      background: #dcfce7;
    }

    main {
      max-width: 1000px;
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
      font-size: 22px;
    }

    .card {
      background: #ffffff;
      padding: 20px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      margin-bottom: 18px;
    }

    input,
    select,
    textarea,
    button {
      width: 100%;
      padding: 12px;
      margin: 7px 0 14px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      font: inherit;
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
    }

    button:hover,
    .button:hover {
      background: #15803d;
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
      }

      .navigation {
        gap: 7px;
      }

      .navigation a {
        font-size: 13px;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="header-inner">
      <a class="brand" href="/">MOONET 🌙</a>
      <p class="tagline">Watch. Create. Connect.</p>
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
// ============================================
// PART 4: SIGNUP, LOGIN AND LOGOUT
// ============================================

// Create a new account.
app.get('/signup', (req, res) => {
  if (currentUser(req)) {
    return res.redirect('/dashboard');
  }

  const body = `
    <section class="card">
      <h2>Create your MOONET account 🌙</h2>
      <p>Join MOONET to watch, create and connect.</p>

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

        <label for="referralCode">
          Referral code (optional)
        </label>
        <input
          id="referralCode"
          name="referralCode"
          type="text"
          maxlength="30"
        >

        <button type="submit">Create account</button>
      </form>

      <p>Already registered?
        <a href="/login">Log in</a>
      </p>
    </section>
  `;

  return res.send(pageLayout('Create account', body));
});


// Process signup form.
app.post('/signup', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body.password || '');
    const referralCode = String(req.body.referralCode || '')
      .trim()
      .toUpperCase();

    if (name.length < 2 || name.length > 80) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<section class="card"><h2>Invalid name</h2><p>Enter a name between 2 and 80 characters.</p><a href="/signup">Try again</a></section>'
        )
      );
    }

    if (!isValidEmail(email)) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<section class="card"><h2>Invalid email</h2><p>Please enter a valid email address.</p><a href="/signup">Try again</a></section>'
        )
      );
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).send(
        pageLayout(
          'Signup error',
          '<section class="card"><h2>Invalid password</h2><p>Your password must contain between 8 and 128 characters.</p><a href="/signup">Try again</a></section>'
        )
      );
    }

    // Prevent duplicate email registrations.
    if (getUserByEmail(email)) {
      return res.status(409).send(
        pageLayout(
          'Account exists',
          '<section class="card"><h2>Email already registered</h2><p>Try logging in with this email address.</p><a href="/login">Log in</a></section>'
        )
      );
    }

    // Look up an optional referral code.
    let referrer = null;

    if (referralCode) {
      referrer = db.prepare(`
        SELECT id, referral_code
        FROM users
        WHERE UPPER(referral_code) = ?
        LIMIT 1
      `).get(referralCode) || null;

      if (!referrer) {
        return res.status(400).send(
          pageLayout(
            'Signup error',
            '<section class="card"><h2>Invalid referral code</h2><p>Check the code or leave the referral field blank.</p><a href="/signup">Try again</a></section>'
          )
        );
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Generate a referral code that is not already in use.
    let newReferralCode;
    let attempts = 0;

    do {
      newReferralCode = generateReferralCode();
      attempts++;

      if (attempts > 10) {
        throw new Error('Could not generate a unique referral code.');
      }

    } while (
      db.prepare(`
        SELECT id
        FROM users
        WHERE UPPER(referral_code) = ?
        LIMIT 1
      `).get(newReferralCode)
    );

    /*
      IMPORTANT:
      This INSERT assumes the users table contains:
      name, email, password_hash, moon, referral_code,
      referred_by and created_at.

      Verify these columns against the existing MOONET
      database before integrating this route.
    */

    const insertUser = db.prepare(`
      INSERT INTO users (
        name,
        email,
        password_hash,
        moon,
        referral_code,
        referred_by,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    let result;

    try {
      result = insertUser.run(
        name,
        email,
        passwordHash,
        0,
        newReferralCode,
        referrer ? referrer.id : null
      );
    } catch (error) {
      // A database UNIQUE constraint can also prevent
      // duplicate registrations when simultaneous requests occur.
      if (
        String(error.message || '').toLowerCase().includes('unique')
      ) {
        return res.status(409).send(
          pageLayout(
            'Account exists',
            '<section class="card"><h2>Account already exists</h2><p>Try logging in.</p><a href="/login">Log in</a></section>'
          )
        );
      }

      throw error;
    }

    const newUser = getUserById(Number(result.lastInsertRowid));

    if (!newUser) {
      throw new Error('New account could not be loaded.');
    }

    // Regenerate the session ID after authentication.
    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error('Signup session error:', sessionError);
        return res.status(500).send(
          'Your account was created, but login could not be completed. Please log in.'
        );
      }

      req.session.userId = newUser.id;

      req.session.save((saveError) => {
        if (saveError) {
          console.error('Signup session save error:', saveError);
          return res.status(500).send(
            'Your account was created, but login could not be completed. Please log in.'
          );
        }

        return res.redirect('/dashboard');
      });
    });

  } catch (error) {
    console.error('Signup error:', error);

    return res.status(500).send(
      pageLayout(
        'Signup error',
        '<section class="card"><h2>Something went wrong</h2><p>Please try again later.</p><a href="/signup">Back to signup</a></section>'
      )
    );
  }
});


// Login page.
app.get('/login', (req, res) => {
  if (currentUser(req)) {
    return res.redirect('/dashboard');
  }

  const body = `
    <section class="card">
      <h2>Welcome back 🌙</h2>

      <form method="POST" action="/login">
        <label for="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          autocomplete="email"
          required
        >

        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        >

        <button type="submit">Log in</button>
      </form>

      <p>New to MOONET?
        <a href="/signup">Create an account</a>
      </p>
    </section>
  `;

  return res.send(pageLayout('Log in', body));
});


// Process login.
app.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');

    if (!isValidEmail(email) || !password || password.length > 128) {
      return res.status(400).send(
        pageLayout(
          'Login error',
          '<section class="card"><h2>Check your details</h2><p>Enter a valid email and password.</p><a href="/login">Try again</a></section>'
        )
      );
    }

    const user = getUserByEmail(email);

    // Keep the response generic so we do not reveal
    // whether a particular email has an account.
    const passwordMatches = user
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    if (!user || !passwordMatches) {
      return res.status(401).send(
        pageLayout(
          'Login error',
          '<section class="card"><h2>Unable to log in</h2><p>The email or password is incorrect.</p><a href="/login">Try again</a></section>'
        )
      );
    }

    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error('Login session error:', sessionError);
        return res.status(500).send('Unable to start your session. Please try again.');
      }

      req.session.userId = user.id;

      req.session.save((saveError) => {
        if (saveError) {
          console.error('Login session save error:', saveError);
          return res.status(500).send('Unable to save your session. Please try again.');
        }

        return res.redirect('/dashboard');
      });
    });

  } catch (error) {
    console.error('Login error:', error);

    return res.status(500).send(
      pageLayout(
        'Login error',
        '<section class="card"><h2>Something went wrong</h2><p>Please try again later.</p></section>'
      )
    );
  }
});


// Logout.
app.get('/logout', (req, res) => {
  if (!req.session) {
    return res.redirect('/');
  }

  req.session.destroy((error) => {
    if (error) {
      console.error('Logout error:', error);
      return res.status(500).send('Unable to log out. Please try again.');
    }

    res.clearCookie('moonet.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });

    return res.redirect('/');
  });
});
// ============================================
// PART 5: DASHBOARD, VIDEO FEED AND MOONS
// ============================================

// Dashboard
app.get('/dashboard', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const videoCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM videos
  `).get().total;

  const recentTransactions = db.prepare(`
    SELECT *
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 5
  `).all(user.id);

  const transactionRows = recentTransactions.length
    ? recentTransactions.map((transaction) => `
        <tr>
          <td>${escapeHtml(transaction.type || 'Activity')}</td>
          <td>${escapeHtml(formatMoons(transaction.amount || 0))}</td>
          <td>${escapeHtml(transaction.status || 'Completed')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3">No transactions yet.</td></tr>';

  const body = `
    <section class="card">
      <h2>Welcome to MOONET, ${escapeHtml(user.name || 'User')}! 🌙</h2>
      <p>Watch videos, connect with people and earn MOONS.</p>

      <h3>Your balance</h3>
      <p><strong>${escapeHtml(formatMoons(user.moon))}</strong></p>

      <a class="button" href="/feed">Watch videos</a>
      <a class="button" href="/offers">Earn MOONS</a>
      <a class="button" href="/wallet">Open wallet</a>
    </section>

    <section class="card">
      <h3>MOONET community</h3>
      <p>Videos available: ${Number(videoCount)}</p>
      <p>Share your creativity and discover new content.</p>
    </section>

    <section class="card">
      <h3>Recent transactions</h3>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th align="left">Activity</th>
              <th align="left">Amount</th>
              <th align="left">Status</th>
            </tr>
          </thead>
          <tbody>${transactionRows}</tbody>
        </table>
      </div>

      <p><a href="/transactions">View transaction history</a></p>
    </section>
  `;

  return res.send(pageLayout('Dashboard', body, user));
});


// Video feed
app.get('/feed', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const videos = db.prepare(`
    SELECT
      videos.*,
      users.name AS creator_name
    FROM videos
    LEFT JOIN users ON users.id = videos.user_id
    ORDER BY videos.id DESC
    LIMIT 100
  `).all();

  const videoCards = videos.length
    ? videos.map((video) => {
        const mediaType = String(video.media_type || 'video')
          .toLowerCase();

        const isAudio = mediaType === 'audio';

        const mediaPath = String(video.file_path || video.url || '');

        const safeMediaPath = escapeHtml(mediaPath);

        const mediaElement = isAudio
          ? `
            <audio controls preload="metadata" style="width:100%">
              <source src="${safeMediaPath}">
              Your browser does not support audio.
            </audio>
          `
          : `
            <video controls playsinline preload="metadata"
              style="width:100%;max-height:520px;background:#111;border-radius:10px">
              <source src="${safeMediaPath}">
              Your browser does not support video playback.
            </video>
          `;

        return `
          <article class="card">
            <h3>${escapeHtml(video.title || 'MOONET video')}</h3>
            <p>Creator: ${escapeHtml(video.creator_name || 'MOONET creator')}</p>

            ${mediaElement}

            <p>${escapeHtml(video.description || '')}</p>

            <form method="POST" action="/videos/${Number(video.id)}/like">
              <button type="submit">💚 Like</button>
            </form>
          </article>
        `;
      }).join('')
    : `
      <section class="card">
        <h2>No videos yet</h2>
        <p>Be the first to share something with the MOONET community.</p>
      </section>
    `;

  const body = `
    <h2>MOONET Video Feed 🎬</h2>
    <p>Discover videos and creators.</p>
    ${videoCards}
  `;

  return res.send(pageLayout('Video Feed', body, user));
});


// Like a video.
// The user can only like a particular video once.
app.post('/videos/:id/like', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);
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

  if (Number(video.user_id) === Number(user.id)) {
    return res.redirect('/feed');
  }

  /*
    IMPORTANT:
    This route assumes like_history has video_id and user_id,
    with a UNIQUE constraint or equivalent duplicate protection.

    Confirm the existing database schema before enabling it.
    This route intentionally does not award MOONS for a like:
    rewards must be protected against abuse and duplicate claims.
  */

  try {
    db.prepare(`
      INSERT INTO like_history (user_id, video_id, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(user.id, videoId);

  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('unique')) {
      return res.redirect('/feed');
    }

    console.error('Video like error:', error);
    return res.status(500).send('Unable to like this video right now.');
  }

  return res.redirect('/feed');
});
// ============================================
// PART 6: WALLET, TRANSACTIONS AND WITHDRAWALS
// ============================================

// Wallet page
app.get('/wallet', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const withdrawals = db.prepare(`
    SELECT *
    FROM withdrawals
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(user.id);

  const withdrawalRows = withdrawals.length
    ? withdrawals.map((item) => `
        <tr>
          <td>${Number(item.id)}</td>
          <td>${escapeHtml(formatMoons(item.amount || 0))}</td>
          <td>${escapeHtml(item.status || 'Pending')}</td>
          <td>${escapeHtml(item.created_at || '')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4">No withdrawal requests yet.</td></tr>';

  const body = `
    <section class="card">
      <h2>My MOONET Wallet 🌙</h2>

      <p>Available balance:</p>
      <h2>${escapeHtml(formatMoons(user.moon))}</h2>

      <p>Minimum withdrawal:
        ${escapeHtml(formatMoons(MIN_WITHDRAWAL_MOON))}
      </p>
    </section>

    <section class="card">
      <h3>Request a withdrawal</h3>

      <form method="POST" action="/withdraw">
        <label for="amount">Amount in MOONS</label>
        <input
          id="amount"
          name="amount"
          type="number"
          min="${MIN_WITHDRAWAL_MOON}"
          step="1"
          required
        >

        <label for="method">Payment method</label>
        <select id="method" name="method" required>
          <option value="">Choose a method</option>
          <option value="MTN MoMo">MTN MoMo</option>
          <option value="Airtel Money">Airtel Money</option>
          <option value="Bank transfer">Bank transfer</option>
        </select>

        <label for="account">Payment account or phone number</label>
        <input
          id="account"
          name="account"
          type="text"
          maxlength="100"
          required
        >

        <button type="submit">Submit withdrawal request</button>
      </form>

      <p>Withdrawal requests are subject to review and approval.</p>
    </section>

    <section class="card">
      <h3>Recent withdrawal requests</h3>

      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th align="left">ID</th>
              <th align="left">Amount</th>
              <th align="left">Status</th>
              <th align="left">Date</th>
            </tr>
          </thead>
          <tbody>${withdrawalRows}</tbody>
        </table>
      </div>
    </section>
  `;

  return res.send(pageLayout('My Wallet', body, user));
});


// Submit withdrawal request
app.post('/withdraw', requireLogin, (req, res) => {
  const userId = Number(req.user.id);
  const amount = Number(req.body.amount);
  const method = String(req.body.method || '').trim();
  const account = String(req.body.account || '').trim();

  const allowedMethods = [
    'MTN MoMo',
    'Airtel Money',
    'Bank transfer'
  ];

  if (
    !Number.isSafeInteger(amount) ||
    amount < MIN_WITHDRAWAL_MOON
  ) {
    return res.status(400).send(
      'Enter a whole-number MOONS amount that meets the minimum withdrawal.'
    );
  }

  if (!allowedMethods.includes(method)) {
    return res.status(400).send('Select a supported payment method.');
  }

  if (!account || account.length > 100) {
    return res.status(400).send('Enter valid payment account details.');
  }

  /*
    IMPORTANT:
    Before enabling this route, verify the existing withdrawals
    schema and its status values.

    This implementation reserves the requested MOONS by deducting
    them from the user's balance inside a database transaction.
    If the request is later rejected, the Admin workflow must refund
    the reserved amount exactly once.
  */

  db.exec('BEGIN IMMEDIATE');

  try {
    const freshUser = getUserById(userId);

    if (!freshUser || Number(freshUser.moon) < amount) {
      db.exec('ROLLBACK');
      return res.status(400).send('Insufficient MOONS balance.');
    }

    const updateBalance = db.prepare(`
      UPDATE users
      SET moon = moon - ?
      WHERE id = ?
        AND moon >= ?
    `);

    const balanceUpdate = updateBalance.run(
      amount,
      userId,
      amount
    );

    if (Number(balanceUpdate.changes) !== 1) {
      db.exec('ROLLBACK');
      return res.status(400).send('Unable to reserve your MOONS.');
    }

    const withdrawalInsert = db.prepare(`
      INSERT INTO withdrawals (
        user_id,
        amount,
        method,
        account,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
    `);

    withdrawalInsert.run(
      userId,
      amount,
      method,
      account
    );

    db.prepare(`
      INSERT INTO transactions (
        user_id,
        type,
        amount,
        status,
        created_at
      )
      VALUES (?, 'withdrawal', ?, 'pending', datetime('now'))
    `).run(userId, -amount);

    db.exec('COMMIT');

    return res.redirect('/wallet');

  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // The transaction may already have rolled back.
    }

    console.error('Withdrawal request error:', error);

    return res.status(500).send(
      'Unable to submit the withdrawal request. Please try again later.'
    );
  }
});


// Transaction history page
app.get('/transactions', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const transactions = db.prepare(`
    SELECT *
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 100
  `).all(user.id);

  const rows = transactions.length
    ? transactions.map((item) => `
        <tr>
          <td>${escapeHtml(item.type || 'Activity')}</td>
          <td>${escapeHtml(formatMoons(item.amount || 0))}</td>
          <td>${escapeHtml(item.status || '')}</td>
          <td>${escapeHtml(item.created_at || '')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4">No transactions recorded yet.</td></tr>';

  const body = `
    <section class="card">
      <h2>Transaction History</h2>
      <p>Your MOONS activity is shown below.</p>

      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th align="left">Activity</th>
              <th align="left">Amount</th>
              <th align="left">Status</th>
              <th align="left">Date</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;

  return res.send(pageLayout('Transaction History', body, user));
});
// ============================================
// PART 7: PROFILE, FOLLOW AND COMMENTS
// ============================================

// User profile
app.get('/profile', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const followers = db.prepare(`
    SELECT COUNT(*) AS total
    FROM follows
    WHERE following_id = ?
  `).get(user.id).total;

  const following = db.prepare(`
    SELECT COUNT(*) AS total
    FROM follows
    WHERE follower_id = ?
  `).get(user.id).total;

  const body = `
    <section class="card">
      <h2>My Profile 👤</h2>

      <p><strong>Name:</strong> ${escapeHtml(user.name || '')}</p>
      <p><strong>Email:</strong> ${escapeHtml(user.email || '')}</p>
      <p><strong>MOONS:</strong> ${escapeHtml(formatMoons(user.moon))}</p>

      <p><strong>Followers:</strong> ${Number(followers)}</p>
      <p><strong>Following:</strong> ${Number(following)}</p>

      <form method="POST" action="/profile">
        <label for="name">Update your name</label>
        <input
          id="name"
          name="name"
          type="text"
          minlength="2"
          maxlength="80"
          value="${escapeHtml(user.name || '')}"
          required
        >

        <button type="submit">Save profile</button>
      </form>
    </section>
  `;

  return res.send(pageLayout('My Profile', body, user));
});


// Update profile
app.post('/profile', requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim();

  if (name.length < 2 || name.length > 80) {
    return res.status(400).send(
      'Name must contain between 2 and 80 characters.'
    );
  }

  db.prepare(`
    UPDATE users
    SET name = ?
    WHERE id = ?
  `).run(name, req.user.id);

  return res.redirect('/profile');
});


// Follow another user
app.post('/users/:id/follow', requireLogin, (req, res) => {
  const followerId = Number(req.user.id);
  const followingId = Number(req.params.id);

  if (
    !Number.isSafeInteger(followingId) ||
    followingId <= 0
  ) {
    return res.status(400).send('Invalid user ID.');
  }

  if (followerId === followingId) {
    return res.status(400).send(
      'You cannot follow your own account.'
    );
  }

  const target = getUserById(followingId);

  if (!target) {
    return res.status(404).send('User not found.');
  }

  try {
    db.prepare(`
      INSERT INTO follows (
        follower_id,
        following_id,
        created_at
      )
      VALUES (?, ?, datetime('now'))
    `).run(followerId, followingId);

  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('unique')) {
      return res.redirect('/feed');
    }

    console.error('Follow error:', error);
    return res.status(500).send('Unable to follow this user.');
  }

  return res.redirect('/feed');
});


// Unfollow a user
app.post('/users/:id/unfollow', requireLogin, (req, res) => {
  const followerId = Number(req.user.id);
  const followingId = Number(req.params.id);

  if (
    !Number.isSafeInteger(followingId) ||
    followingId <= 0
  ) {
    return res.status(400).send('Invalid user ID.');
  }

  db.prepare(`
    DELETE FROM follows
    WHERE follower_id = ?
      AND following_id = ?
  `).run(followerId, followingId);

  return res.redirect('/feed');
});


// View comments on a video
app.get('/videos/:id/comments', requireLogin, (req, res) => {
  const videoId = Number(req.params.id);

  if (!Number.isSafeInteger(videoId) || videoId <= 0) {
    return res.status(400).send('Invalid video ID.');
  }

  const video = db.prepare(`
    SELECT id, title
    FROM videos
    WHERE id = ?
  `).get(videoId);

  if (!video) {
    return res.status(404).send('Video not found.');
  }

  const comments = db.prepare(`
    SELECT
      comments.id,
      comments.comment,
      comments.created_at,
      users.name AS author_name
    FROM comments
    LEFT JOIN users ON users.id = comments.user_id
    WHERE comments.video_id = ?
    ORDER BY comments.id DESC
    LIMIT 100
  `).all(videoId);

  const commentRows = comments.length
    ? comments.map((item) => `
        <article class="card">
          <strong>${escapeHtml(item.author_name || 'MOONET user')}</strong>
          <p>${escapeHtml(item.comment || '')}</p>
          <small>${escapeHtml(item.created_at || '')}</small>
        </article>
      `).join('')
    : '<p>No comments yet. Be the first to comment.</p>';

  const body = `
    <section class="card">
      <h2>Comments</h2>
      <h3>${escapeHtml(video.title || 'Video')}</h3>

      <form method="POST" action="/videos/${videoId}/comments">
        <label for="comment">Write a comment</label>
        <textarea
          id="comment"
          name="comment"
          maxlength="1000"
          required
        ></textarea>

        <button type="submit">Post comment</button>
      </form>
    </section>

    ${commentRows}
  `;

  return res.send(
    pageLayout('Video Comments', body, currentUser(req))
  );
});


// Add a comment
app.post('/videos/:id/comments', requireLogin, (req, res) => {
  const videoId = Number(req.params.id);
  const comment = String(req.body.comment || '').trim();

  if (!Number.isSafeInteger(videoId) || videoId <= 0) {
    return res.status(400).send('Invalid video ID.');
  }

  if (!comment || comment.length > 1000) {
    return res.status(400).send(
      'Your comment must contain between 1 and 1000 characters.'
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
    INSERT INTO comments (
      user_id,
      video_id,
      comment,
      created_at
    )
    VALUES (?, ?, ?, datetime('now'))
  `).run(req.user.id, videoId, comment);

  return res.redirect(`/videos/${videoId}/comments`);
});
// ============================================
// PART 8: OFFERWALL AND MOONS REWARDS
// ============================================

// Read offerwall settings from environment variables.
// Never place private API keys or secrets directly in this file.
const OFFERWALL_REWARD_SECRET =
  String(process.env.OFFERWALL_REWARD_SECRET || '').trim();

const OFFERWALL_MOONS_PER_DOLLAR = 100;

// Offerwall page
app.get('/offers', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const body = `
    <section class="card">
      <h2>Earn MOONS 🌙</h2>
      <p>Complete eligible offers to earn MOONS.</p>
      <p>Your current balance:
        <strong>${escapeHtml(formatMoons(user.moon))}</strong>
      </p>
    </section>

    <section class="card">
      <h3>Available offers</h3>
      <p>Offer availability depends on your location and the provider.</p>

      <p>
        Complete an offer honestly and wait for the provider
        to confirm your reward.
      </p>

      <p>
        If the Offerwall provider supplies an official embed code,
        it should be integrated here after its documentation and
        security requirements have been checked.
      </p>
    </section>
  `;

  return res.send(pageLayout('Earn MOONS', body, user));
});


// Offerwall reward callback.
// The exact callback format must be confirmed with your provider.
app.get('/offerwall/callback', (req, res) => {
  if (!OFFERWALL_REWARD_SECRET) {
    return res.status(503).send('Offerwall callback is not configured.');
  }

  /*
    SECURITY WARNING:
    Do not credit a reward based only on user_id, amount,
    or transaction_id supplied by an incoming URL.

    Before activating this endpoint, confirm the provider's
    official signature algorithm, required parameters, and
    transaction verification procedure.

    This placeholder deliberately does not credit MOONS.
  */

  return res.status(501).send(
    'Offerwall callback requires provider-specific signature verification.'
  );
});
// ============================================
// PART 9: VIDEO UPLOADS, REVENUE AND EXPENSES
// ============================================

// Configure video uploads.
// UPLOAD_DIR should already be defined in Part 1.

const videoStorage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, UPLOAD_DIR);
  },

  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();

    const allowedExtensions = [
      '.mp4',
      '.webm',
      '.mov',
      '.mp3',
      '.wav',
      '.ogg'
    ];

    if (!allowedExtensions.includes(extension)) {
      return callback(new Error('Unsupported file extension.'));
    }

    const filename =
      `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`;

    callback(null, filename);
  }
});

const videoUpload = multer({
  storage: videoStorage,

  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  },

  fileFilter: (req, file, callback) => {
    const allowedMimeTypes = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/ogg',
      'audio/webm'
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return callback(
        new Error('Unsupported video or audio format.')
      );
    }

    callback(null, true);
  }
});


// Video upload page
app.get('/upload', requireLogin, (req, res) => {
  const user = getUserById(req.user.id);

  const body = `
    <section class="card">
      <h2>Upload a Video 🎬</h2>

      <p>Share your creativity with the MOONET community.</p>

      <form
        method="POST"
        action="/upload"
        enctype="multipart/form-data"
      >
        <label for="title">Video title</label>
        <input
          id="title"
          name="title"
          type="text"
          maxlength="150"
          required
        >

        <label for="description">Description</label>
        <textarea
          id="description"
          name="description"
          maxlength="2000"
        ></textarea>

        <label for="media">Choose video or audio</label>
        <input
          id="media"
          name="media"
          type="file"
          accept="video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/ogg"
          required
        >

        <button type="submit">Upload</button>
      </form>
    </section>
  `;

  return res.send(pageLayout('Upload Video', body, user));
});


// Process upload
app.post(
  '/upload',
  requireLogin,
  (req, res, next) => {
    videoUpload.single('media')(req, res, (error) => {
      if (error) {
        console.error('Upload error:', error.message);

        return res.status(400).send(
          'Upload failed. Check the file format and maximum file size.'
        );
      }

      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).send('Please select a video or audio file.');
    }

    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();

    if (!title || title.length > 150 || description.length > 2000) {
      fs.unlink(req.file.path, () => {});

      return res.status(400).send('Invalid title or description.');
    }

    const extension = path.extname(req.file.filename).toLowerCase();

    const mediaType = [
      '.mp3',
      '.wav',
      '.ogg'
    ].includes(extension)
      ? 'audio'
      : 'video';

    try {
      /*
        Verify the existing videos schema before using this INSERT.
        It assumes the table has:
        user_id, title, description, file_path, media_type, created_at.
      */

      db.prepare(`
        INSERT INTO videos (
          user_id,
          title,
          description,
          file_path,
          media_type,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(
        req.user.id,
        title,
        description,
        `/uploads/${req.file.filename}`,
        mediaType
      );

      return res.redirect('/feed');

    } catch (error) {
      fs.unlink(req.file.path, () => {});

      console.error('Saving video error:', error);

      return res.status(500).send(
        'The video could not be saved. Please try again.'
      );
    }
  }
);


// Admin: financial summary
app.get('/admin/finances', requireAdmin, (req, res) => {
  const revenueSummary = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM revenue
  `).get();

  const expenseSummary = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM expenses
  `).get();

  const totalRevenue = Number(revenueSummary.total || 0);
  const totalExpenses = Number(expenseSummary.total || 0);

  const body = `
    <section class="card">
      <h2>MOONET Financial Summary</h2>

      <p>Total recorded revenue:
        <strong>${escapeHtml(totalRevenue.toLocaleString('en-US'))}</strong>
      </p>

      <p>Total recorded expenses:
        <strong>${escapeHtml(totalExpenses.toLocaleString('en-US'))}</strong>
      </p>

      <p>Recorded difference:
        <strong>${escapeHtml(
          (totalRevenue - totalExpenses).toLocaleString('en-US')
        )}</strong>
      </p>

      <p>
        These totals reflect database records only. They do not
        independently confirm that money has been received or paid.
      </p>
    </section>
  `;

  return res.send(
    pageLayout('Financial Summary', body, req.user)
  );
});


// Admin: record revenue
app.post('/admin/revenue', requireAdmin, (req, res) => {
  const source = String(req.body.source || '').trim();
  const amount = Number(req.body.amount);

  if (
    !source ||
    source.length > 150 ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1_000_000_000
  ) {
    return res.status(400).send('Invalid revenue details.');
  }

  try {
    db.prepare(`
      INSERT INTO revenue (source, amount, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(source, amount);

    return res.redirect('/admin/finances');

  } catch (error) {
    console.error('Revenue record error:', error);
    return res.status(500).send('Unable to record revenue.');
  }
});


// Admin: record expense
app.post('/admin/expenses', requireAdmin, (req, res) => {
  const description = String(req.body.description || '').trim();
  const amount = Number(req.body.amount);

  if (
    !description ||
    description.length > 200 ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1_000_000_000
  ) {
    return res.status(400).send('Invalid expense details.');
  }

  try {
    db.prepare(`
      INSERT INTO expenses (description, amount, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(description, amount);

    return res.redirect('/admin/finances');

  } catch (error) {
    console.error('Expense record error:', error);
    return res.status(500).send('Unable to record expense.');
  }
});
// ============================================
// PART 10: ADMIN DASHBOARD AND WITHDRAWALS
// ============================================


// Admin dashboard
app.get('/admin', requireAdmin, (req, res) => {
  const userCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
  `).get().total;

  const videoCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM videos
  `).get().total;

  const pendingWithdrawals = db.prepare(`
    SELECT COUNT(*) AS total
    FROM withdrawals
    WHERE LOWER(status) = 'pending'
  `).get().total;

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM revenue
  `).get().total;

  const expenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM expenses
  `).get().total;

  const body = `
    <section class="card">
      <h2>MOONET Admin Dashboard 🛡️</h2>

      <p>Total users: <strong>${Number(userCount)}</strong></p>
      <p>Total videos: <strong>${Number(videoCount)}</strong></p>
      <p>Pending withdrawals:
        <strong>${Number(pendingWithdrawals)}</strong>
      </p>

      <p>Recorded revenue:
        <strong>${escapeHtml(Number(revenue).toLocaleString('en-US'))}</strong>
      </p>

      <p>Recorded expenses:
        <strong>${escapeHtml(Number(expenses).toLocaleString('en-US'))}</strong>
      </p>

      <a class="button" href="/admin/users">Manage users</a>
      <a class="button" href="/admin/withdrawals">Manage withdrawals</a>
      <a class="button" href="/admin/finances">Financial records</a>
    </section>
  `;

  return res.send(pageLayout('Admin Dashboard', body, req.user));
});


// Admin: view users
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, moon, created_at
    FROM users
    ORDER BY id DESC
    LIMIT 200
  `).all();

  const rows = users.map((user) => `
    <tr>
      <td>${Number(user.id)}</td>
      <td>${escapeHtml(user.name || '')}</td>
      <td>${escapeHtml(user.email || '')}</td>
      <td>${escapeHtml(formatMoons(user.moon))}</td>
      <td>${escapeHtml(user.created_at || '')}</td>
    </tr>
  `).join('');

  const body = `
    <section class="card">
      <h2>Registered users</h2>

      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th align="left">ID</th>
              <th align="left">Name</th>
              <th align="left">Email</th>
              <th align="left">Balance</th>
              <th align="left">Joined</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5">No users found.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;

  return res.send(pageLayout('Manage Users', body, req.user));
});


// Admin: view withdrawal requests
app.get('/admin/withdrawals', requireAdmin, (req, res) => {
  const withdrawals = db.prepare(`
    SELECT
      withdrawals.id,
      withdrawals.user_id,
      withdrawals.amount,
      withdrawals.method,
      withdrawals.status,
      withdrawals.created_at,
      users.name,
      users.email
    FROM withdrawals
    LEFT JOIN users ON users.id = withdrawals.user_id
    ORDER BY withdrawals.id DESC
    LIMIT 200
  `).all();

  const rows = withdrawals.map((item) => {
    const isPending =
      String(item.status || '').toLowerCase() === 'pending';

    return `
      <tr>
        <td>${Number(item.id)}</td>
        <td>${escapeHtml(item.name || '')}</td>
        <td>${escapeHtml(item.email || '')}</td>
        <td>${escapeHtml(formatMoons(item.amount))}</td>
        <td>${escapeHtml(item.method || '')}</td>
        <td>${escapeHtml(item.status || '')}</td>
        <td>
          ${
            isPending
              ? `
                <form method="POST"
                  action="/admin/withdrawals/${Number(item.id)}/approve">
                  <button type="submit">Approve</button>
                </form>

                <form method="POST"
                  action="/admin/withdrawals/${Number(item.id)}/reject">
                  <button type="submit">Reject and refund</button>
                </form>
              `
              : 'Processed'
          }
        </td>
      </tr>
    `;
  }).join('');

  const body = `
    <section class="card">
      <h2>Withdrawal Requests</h2>

      <p>
        Approving a request records the decision only.
        It does not send money automatically.
      </p>

      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th align="left">ID</th>
              <th align="left">Name</th>
              <th align="left">Email</th>
              <th align="left">Amount</th>
              <th align="left">Method</th>
              <th align="left">Status</th>
              <th align="left">Action</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7">No withdrawals found.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;

  return res.send(pageLayout('Manage Withdrawals', body, req.user));
});


// Admin: approve a pending withdrawal.
// This records approval; it does not transfer money.
app.post(
  '/admin/withdrawals/:id/approve',
  requireAdmin,
  (req, res) => {
    const withdrawalId = Number(req.params.id);

    if (
      !Number.isSafeInteger(withdrawalId) ||
      withdrawalId <= 0
    ) {
      return res.status(400).send('Invalid withdrawal ID.');
    }

    try {
      const result = db.prepare(`
        UPDATE withdrawals
        SET status = 'approved'
        WHERE id = ?
          AND LOWER(status) = 'pending'
      `).run(withdrawalId);

      if (Number(result.changes) !== 1) {
        return res.status(409).send(
          'Withdrawal not found or already processed.'
        );
      }

      return res.redirect('/admin/withdrawals');

    } catch (error) {
      console.error('Withdrawal approval error:', error);

      return res.status(500).send(
        'Unable to approve this withdrawal.'
      );
    }
  }
);


// Admin: reject a pending withdrawal and refund the reserved MOONS.
// This assumes the request route deducted MOONS when submitted.
app.post(
  '/admin/withdrawals/:id/reject',
  requireAdmin,
  (req, res) => {
    const withdrawalId = Number(req.params.id);

    if (
      !Number.isSafeInteger(withdrawalId) ||
      withdrawalId <= 0
    ) {
      return res.status(400).send('Invalid withdrawal ID.');
    }

    db.exec('BEGIN IMMEDIATE');

    try {
      const withdrawal = db.prepare(`
        SELECT id, user_id, amount, status
        FROM withdrawals
        WHERE id = ?
      `).get(withdrawalId);

      if (
        !withdrawal ||
        String(withdrawal.status || '').toLowerCase() !== 'pending'
      ) {
        db.exec('ROLLBACK');

        return res.status(409).send(
          'Withdrawal not found or already processed.'
        );
      }

      const refundAmount = Number(withdrawal.amount);

      if (
        !Number.isSafeInteger(refundAmount) ||
        refundAmount <= 0
      ) {
        db.exec('ROLLBACK');

        return res.status(400).send(
          'Invalid withdrawal amount; manual review is required.'
        );
      }

      const updateWithdrawal = db.prepare(`
        UPDATE withdrawals
        SET status = 'rejected'
        WHERE id = ?
          AND LOWER(status) = 'pending'
      `).run(withdrawalId);

      if (Number(updateWithdrawal.changes) !== 1) {
        db.exec('ROLLBACK');

        return res.status(409).send(
          'Withdrawal was already processed.'
        );
      }

      db.prepare(`
        UPDATE users
        SET moon = moon + ?
        WHERE id = ?
      `).run(refundAmount, withdrawal.user_id);

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          amount,
          status,
          created_at
        )
        VALUES (?, 'withdrawal_refund', ?, 'completed', datetime('now'))
      `).run(withdrawal.user_id, refundAmount);

      db.exec('COMMIT');

      return res.redirect('/admin/withdrawals');

    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {
        // Transaction may already be rolled back.
      }

      console.error('Withdrawal rejection error:', error);

      return res.status(500).send(
        'Unable to reject this withdrawal safely.'
      );
    }
  }
);
// ============================================
// PART 11: HEALTH CHECK, ERROR HANDLING & STARTUP
// ============================================

// Basic health check for Render.
app.get('/health', (req, res) => {
  try {
    // Confirm that the database can execute a simple query.
    db.prepare('SELECT 1 AS ok').get();

    return res.status(200).json({
      status: 'ok',
      app: 'MOONET',
      database: 'connected'
    });
  } catch (error) {
    console.error('MOONET health check failed:', error);

    return res.status(503).json({
      status: 'error',
      app: 'MOONET',
      database: 'unavailable'
    });
  }
});


// Handle unknown pages.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'Endpoint not found'
    });
  }

  return res.status(404).send(
    pageLayout(
      'Page not found',
      `
        <section class="card">
          <h2>404 — Page not found</h2>
          <p>The page you requested could not be found.</p>
          <a class="button" href="/">Return home</a>
        </section>
      `,
      currentUser(req)
    )
  );
});


// Central error handler.
// Keep this after all application routes and the 404 handler.
app.use((err, req, res, next) => {
  console.error('MOONET application error:', err);

  if (res.headersSent) {
    return next(err);
  }

  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      error: 'An internal server error occurred'
    });
  }

  return res.status(500).send(
    pageLayout(
      'Server error',
      `
        <section class="card">
          <h2>Something went wrong</h2>
          <p>Please try again later.</p>
          <a class="button" href="/">Return home</a>
        </section>
      `,
      currentUser(req)
    )
  );
});


// Start the server only once.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`MOONET is listening on port ${PORT}`);
});

// Graceful shutdown.
function shutdown(signal) {
  console.log(`${signal} received. Shutting down MOONET...`);

  server.close(() => {
    try {
      db.close();
      console.log('MOONET database connection closed.');
      process.exit(0);
    } catch (error) {
      console.error('Database shutdown error:', error);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('Shutdown timed out.');
    process.exit(1);
  }, 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
// ============================================
// MOONET - PART 12
// Offerwall environment configuration check
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

// Check configuration without exposing secrets.
function getOfferwallConfigStatus() {
  return {
    appIdConfigured: Boolean(OFFERWALL_CONFIG.appId),
    urlConfigured: Boolean(OFFERWALL_CONFIG.offerwallUrl),
    rewardSecretConfigured: Boolean(
      OFFERWALL_CONFIG.rewardSecret
    ),
    moonsPerDollar:
      Number.isFinite(OFFERWALL_CONFIG.moonsPerDollar) &&
      OFFERWALL_CONFIG.moonsPerDollar > 0
        ? OFFERWALL_CONFIG.moonsPerDollar
        : 100
  };
}

// This function only checks configuration.
// It does not award MOONS or modify the database.
// ============================================
// MOONET - PART 13
// Offerwall configuration status
// ============================================

function getOfferwallStatus() {
  const appId =
    process.env.OFFERWALL_APP_ID ||
    process.env.OFFERWALL_ID ||
    '';

  const offerwallUrl =
    process.env.OFFERWALL_URL || '';

  const rewardSecret =
    process.env.OFFERWALL_REWARD_SECRET ||
    process.env.OFFERWALL_SECRET ||
    '';

  const rawRate =
    process.env.OFFERWALL_MOONS_PER_DOLLAR || '100';

  const moonsPerDollar = Number(rawRate);

  return {
    configured: Boolean(appId && offerwallUrl),
    appIdConfigured: Boolean(appId),
    urlConfigured: Boolean(offerwallUrl),
    rewardSecretConfigured: Boolean(rewardSecret),
    moonsPerDollar:
      Number.isFinite(moonsPerDollar) && moonsPerDollar > 0
        ? moonsPerDollar
        : 100
  };
    }
// ============================================
// MOONET - PART 14
// Offerwall URL helper
// ============================================

function getOfferwallUrlForUser(userId) {
  const baseUrl =
    process.env.OFFERWALL_URL ||
    '';

  const appId =
    process.env.OFFERWALL_APP_ID ||
    process.env.OFFERWALL_ID ||
    '';

  if (!baseUrl) {
    throw new Error('Offerwall URL is not configured.');
  }

  if (!userId) {
    throw new Error('A valid user ID is required.');
  }

  const url = new URL(baseUrl);

  // Only add app_id if your Offerwall provider requires it.
  if (appId && !url.searchParams.has('app_id')) {
    url.searchParams.set('app_id', appId);
  }

  // Do not guess the provider's user identifier parameter.
  // Add it only after confirming the provider's documentation.

  return url.toString();
    }
