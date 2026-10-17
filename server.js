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

const OFFERWALL_POSTBACK_SECRET =
  String(process.env.OFFERWALL_POSTBACK_SECRET || '');

const OFFERWALL_WALL_ID =
  '5126c45ff0096181b7ad353b735ad976';
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
  
Muri server.js, nyuma y'aho tables zisanzwe zikorwa na db.exec(...), onger
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

// Safe migration: preserve existing settings and add updated_at only if missing.
{
  const settingsColumns = db
    .prepare('PRAGMA table_info(settings)')
    .all()
    .map(column => column.name);

  if (!settingsColumns.includes('updated_at')) {
    db.exec('ALTER TABLE settings ADD COLUMN updated_at TEXT');
  }
}

// Safe, additive migrations. Existing users and records are preserved.
try {
  db.exec("ALTER TABLE videos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'");
} catch (error) {
  if (!String(error.message).includes('duplicate column name')) {
    throw error;
  }
}

for (const [column, definition] of [
  ['like_moon', 'REAL NOT NULL DEFAULT 0'],
  ['watch_moon', 'REAL NOT NULL DEFAULT 0'],
  ['listen_moon', 'REAL NOT NULL DEFAULT 0']
]) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) {
      throw error;
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
  liker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moon REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id, liker_id)
 );
`);
// Offerwall.me: save credited offer transactions
db.exec(`
  CREATE TABLE IF NOT EXISTS offerwall_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reward REAL NOT NULL CHECK(reward > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

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

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function fmt(value) {
  return Number(value || 0).toLocaleString('en-US');
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

function msg(text, cls = '') {
  return `<div class="message ${cls}">${esc(text)}</div>`;
}

function page(title, content, user = null) {
  const csrf = esc(user && user._csrf || '');

  const nav = user
    ? `
      <a href="/app">Home</a>
      <a href="/videos">Feed</a>
      <a href="/wallet">Wallet</a>
      <a href="/transactions">History</a>
      <a href="/profile">Profile</a>
      <form action="/logout" method="post" class="inline">
        <input type="hidden" name="_csrf" value="${csrf}">
        <button class="secondary" type="submit">Logout</button>
      </form>`
    : `
      <a href="/">Home</a>
      <a href="/login">Login</a>
      <a href="/signup">Sign Up</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b8f54">
<title>${esc(title)} | MOONET</title>
<style>
:root{--green:#0b8f54;--deep:#087443;--pale:#e9f9ef;--line:#dce9e0;--ink:#183126;--muted:#63756b}
*{box-sizing:border-box}
body{margin:0;background:#f5faf6;color:var(--ink);font-family:Arial,sans-serif}
header{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--line);padding:13px 16px}
.top{max-width:1050px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{font-size:25px;font-weight:800;color:var(--green);text-decoration:none}
nav{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
a{color:var(--green);text-decoration:none}
nav a{font-size:14px;font-weight:700}
main{width:min(94%,900px);margin:22px auto;min-height:68vh}
.hero,.card{background:#fff;border:1px solid var(--line);padding:20px;border-radius:17px;margin-bottom:16px;box-shadow:0 4px 16px #0b5b2b0a}
.hero{text-align:center;padding:34px 20px}
h1,h2,h3{margin-top:0}
.muted{color:var(--muted);line-height:1.55}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.number{font-size:29px;font-weight:800;margin:10px 0;color:var(--green)}
button,.button{display:inline-block;background:var(--green);color:white;border:0;border-radius:10px;padding:11px 16px;font-weight:700;cursor:pointer;font-size:14px}
.secondary{background:#e8f4ec;color:var(--deep)}
.danger{background:#b42318}
.inline{display:inline}
form.stack{display:grid;gap:12px}
input,select,textarea{width:100%;padding:12px;border:1px solid #cbded0;border-radius:9px;background:#fff;color:var(--ink);font:inherit}
label{display:grid;gap:7px;color:#30493a;font-weight:600}
.message{padding:12px;border-radius:9px;background:var(--pale);margin-bottom:14px}
.error{color:#a11}
.success{color:var(--deep)}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);font-size:13px}
footer{text-align:center;padding:25px;color:var(--muted)}
video{width:100%;max-height:600px;background:#111;border-radius:13px}
.feed-card{padding:0;overflow:hidden}
.feed-head,.feed-actions,.feed-body{padding:15px}
.feed-head{display:flex;justify-content:space-between;gap:10px;align-items:center}
.feed-video{display:block;width:100%;max-height:70vh;aspect-ratio:9/14;object-fit:contain;background:#101010;border-radius:0}
.feed-photo{display:block;width:100%;max-height:70vh;object-fit:contain;background:#101010}
.feed-audio{width:100%}
.text-post{padding:25px;white-space:pre-wrap;overflow-wrap:anywhere}
.feed-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.tiny{font-size:12px}
.comment{padding:9px 0;border-bottom:1px solid #edf3ee}
.pill{display:inline-block;background:var(--pale);color:var(--deep);padding:5px 9px;border-radius:20px;font-size:12px;font-weight:700}
.feed-compose{border:2px dashed #b9dec6}
.gift-form{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.gift-form select{width:auto;flex:1;min-width:140px}
.gift-form button{white-space:nowrap}
@media(max-width:520px){nav{gap:9px}nav a{font-size:12px}.feed-head{align-items:flex-start}.feed-video{max-height:62vh}}
</style>
</head>
<body>
<header>
<div class="top">
<a class="brand" href="${user ? '/app' : '/'}">🌙 MOONET</a>
<nav>${nav}</nav>
</div>
</header>
<main>${content}</main>
<footer>MOONET © ${new Date().getFullYear()} · Create · Like · Comment · Connect</footer>
</body>
</html>`;
}

function requireUser(req, res, next) {
  const id = req.session.userId;

  if (!id) {
    return res.redirect('/login');
  }

  const user = get(
    'SELECT id,name,email,moon,like_moon,watch_moon,listen_moon,referral_code,suspended FROM users WHERE id=?',
    id
  );

  if (!user || user.suspended) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin !== true) {
    return res.redirect('/admin/login');
  }

  next();
}

function validateCsrf(req, res, next) {
  const submitted = String(req.body?._csrf || '');
  const expected = String(req.session?.csrfToken || '');
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);

  if (
    !a.length ||
    !b.length ||
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(403).send(
      page('Security Check', '<div class="card">Security check failed. Reload the page and try again.</div>')
    );
  }

  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),

    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '')
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, '')
        .slice(0, 12);

      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  }),

  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  },

  fileFilter: (_req, file, cb) => {
    const allowed = /^(video\/(mp4|webm|quicktime|ogg)|image\/(jpeg|png|gif|webp)|audio\/(mpeg|mp3|mp4|wav|ogg|webm|aac|x-wav))$/i;

    if (allowed.test(file.mimetype)) {
      return cb(null, true);
    }

    cb(new Error('Unsupported file type. Choose a video, photo, or audio file.'));
  }
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  fallthrough: false,
  maxAge: '1d'
}));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));

app.use(session({
  name: 'moonet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 86400000
  }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: APP_NAME });
});

app.get('/', (_req, res) => {
  res.send(page('Home', `
    <section class="hero">
      <div style="font-size:54px">🌙💚</div>
      <h1>Welcome to MOONET</h1>
      <p class="muted">Your green social video community. Post videos, collect likes, comment, follow creators and send MOON gifts.</p>
      <p><span class="pill">1 MOON = ${MOON_VALUE_RWF} RWF indicative value</span></p>
      <a class="button" href="/signup">Create Account</a>
      <a class="button secondary" href="/login">Login</a>
    </section>
    <section class="grid">
      <div class="card"><h3>🎬 Video Feed</h3><p class="muted">Discover creators and videos from the community.</p></div>
      <div class="card"><h3>💚 Likes & Comments</h3><p class="muted">Show support and share your thoughts.</p></div>
      <div class="card"><h3>🌙 MOON Wallet</h3><p class="muted">Keep gifts and other MOONS separate from your like count.</p></div>
    </section>
    <p class="muted">Likes are popularity counts and do not automatically create MOONS. Gift MOONS are transferred from a sender's balance. Withdrawals require review and available funding.</p>
  `));
});

app.get('/signup', (req, res) => {
  res.send(page('Sign Up', `
    <div class="card">
      <h1>Create your MOONET account</h1>
      <form class="stack" method="post" action="/signup">
        ${csrfField(req)}
        <label>Full name<input name="name" required minlength="2" maxlength="60"></label>
        <label>Email<input name="email" type="email" required maxlength="254"></label>
        <label>Password<input name="password" type="password" required minlength="10" maxlength="128"></label>
        <label>Referral code (optional)<input name="referral" maxlength="30"></label>
        <button>Create Account</button>
      </form>
      <p class="muted">Already registered? <a href="/login">Login</a></p>
    </div>
  `));
});

app.post('/signup', validateCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (
    name.length < 2 ||
    name.length > 60 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    password.length < 10 ||
    password.length > 128
  ) {
    return res.status(400).send(page('Sign Up', `
      <div class="card">
        ${msg('Check your name, email and password length.', 'error')}
        <a href="/signup">Try again</a>
      </div>
    `));
  }

  if (get('SELECT id FROM users WHERE email=?', email)) {
    return res.status(409).send(page('Sign Up', `
      <div class="card">
        ${msg('Email already registered. Please login.', 'error')}
        <a href="/login">Login</a>
      </div>
    `));
  }

  let referredBy = null;

  if (referral) {
    const referringUser = get(
      'SELECT id FROM users WHERE referral_code=?',
      referral
    );

    if (referringUser) {
      referredBy = referringUser.id;
    }
  }

  const hash = await bcrypt.hash(password, 12);

  let code = referralCode();

  while (get('SELECT id FROM users WHERE referral_code=?', code)) {
    code = referralCode();
  }

  try {
    const result = run(
      'INSERT INTO users(name,email,password_hash,referral_code,referred_by) VALUES(?,?,?,?,?)',
      name,
      email,
      hash,
      code,
      referredBy
    );

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).send('Could not create session.');
      }

      req.session.userId = Number(result.lastInsertRowid);
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');

      res.redirect('/app');
    });
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).send('Could not create account.');
  }
});

app.get('/login', (req, res) => {
  res.send(page('Login', `
    <div class="card">
      <h1>Login to MOONET</h1>
      <form class="stack" method="post" action="/login">
        ${csrfField(req)}
        <label>Email<input name="email" type="email" required></label>
        <label>Password<input name="password" type="password" required></label>
        <button>Login</button>
      </form>
      <p class="muted">New to MOONET? <a href="/signup">Create account</a></p>
    </div>
  `));
});

app.post('/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = get('SELECT * FROM users WHERE email=?', email);

  if (!user || user.suspended) {
    return res.status(401).send(page('Login', `
      <div class="card">
        ${msg('Invalid email or password.', 'error')}
        <a href="/login">Try again</a>
      </div>
    `));
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    return res.status(401).send(page('Login', `
      <div class="card">
        ${msg('Invalid email or password.', 'error')}
        <a href="/login">Try again</a>
      </div>
    `));
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).send('Could not create session.');
    }

    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');

    res.redirect('/app');
  });
});

app.post('/logout', validateCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('moonet.sid');
    res.redirect('/');
  });
});

app.get('/app', requireUser, (req, res) => {
  const user = req.user;

  const content = `
    <section class="hero">
      <h1>Welcome, ${esc(user.name)}!</h1>
      <p>Your MOONET dashboard</p>
      <div class="number">${fmt(user.moon)} MOONS</div>
      <p class="muted">Indicative value: ${fmt(user.moon * MOON_VALUE_RWF)} RWF</p>
      <a class="button" href="/videos">Open Feed</a>
      <a class="button secondary" href="/wallet">My Wallet</a>
    </section>

    <section class="grid">
      <div class="card">
        <h3>🌙 MOONS Balance</h3>
        <div class="number">${fmt(user.moon)}</div>
        <a href="/wallet">View wallet</a>
      </div>

      <div class="card">
        <h3>💚 Likes</h3>
        <div class="number">${fmt(user.like_moon)}</div>
        <p class="muted">Like-related statistics</p>
      </div>

      <div class="card">
        <h3>🎬 Watch rewards</h3>
        <div class="number">${fmt(user.watch_moon)}</div>
        <p class="muted">Recorded watch rewards</p>
      </div>

      <div class="card">
        <h3>🎵 Listen rewards</h3>
        <div class="number">${fmt(user.listen_moon)}</div>
        <p class="muted">Recorded listening rewards</p>
      </div>
    </section>

    <section class="card">
      <h2>Your referral code</h2>
      <p><b>${esc(user.referral_code)}</b></p>
      <p class="muted">Share this code with people signing up to MOONET.</p>
    </section>
  `;

  res.send(page('Dashboard', content, {
    ...user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/profile', requireUser, (req, res) => {
  const user = req.user;

  res.send(page('Profile', `
    <div class="card">
      <h1>My Profile</h1>
      <p><b>Name:</b> ${esc(user.name)}</p>
      <p><b>Email:</b> ${esc(user.email)}</p>
      <p><b>Referral code:</b> ${esc(user.referral_code)}</p>
      <p><b>MOONS:</b> ${fmt(user.moon)}</p>
    </div>
  `, {
    ...user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/wallet', requireUser, (req, res) => {
  const user = req.user;

  res.send(page('Wallet', `
    <div class="card">
      <h1>🌙 My Wallet</h1>
      <div class="number">${fmt(user.moon)} MOONS</div>
      <p class="muted">Indicative value: ${fmt(user.moon * MOON_VALUE_RWF)} RWF</p>
      <p class="muted">1 MOON is configured at ${MOON_VALUE_RWF} RWF as an indicative platform value. This does not guarantee cash redemption.</p>
      <a class="button" href="/withdraw">Request Withdrawal</a>
      <a class="button secondary" href="/transactions">Transaction History</a>
    </div>
  `, {
    ...user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/transactions', requireUser, (req, res) => {
  const rows = all(
    'SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 200',
    req.user.id
  );

  const table = rows.map(row => `
    <tr>
      <td>${esc(row.created_at)}</td>
      <td>${esc(row.type)}</td>
      <td>${fmt(row.moon)}</td>
      <td>${esc(row.description)}</td>
    </tr>
  `).join('');

  res.send(page('Transactions', `
    <div class="card">
      <h1>Transaction History</h1>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>MOONS</th><th>Description</th></tr></thead>
          <tbody>${table || '<tr><td colspan="4">No transactions yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/videos', requireUser, (req, res) => {
  const videos = all(`
    SELECT v.*,u.name,
      (SELECT COUNT(*) FROM video_likes l WHERE l.video_id=v.id) AS like_count,
      (SELECT COUNT(*) FROM video_comments c WHERE c.video_id=v.id) AS comment_count,
      EXISTS(SELECT 1 FROM video_likes l WHERE l.video_id=v.id AND l.user_id=?) AS liked,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=v.user_id) AS following
    FROM videos v
    JOIN users u ON u.id=v.user_id
    ORDER BY v.id DESC
    LIMIT 100
  `, req.user.id, req.user.id);

  const cards = videos.map(video => {
    const comments = all(`
      SELECT c.comment,c.created_at,u.name
      FROM video_comments c
      JOIN users u ON u.id=c.user_id
      WHERE c.video_id=?
      ORDER BY c.id DESC
      LIMIT 10
    `, video.id).map(comment => `
      <div class="comment">
        <b>${esc(comment.name)}</b>
        <span class="muted tiny">${esc(comment.created_at)}</span>
        <div>${esc(comment.comment)}</div>
      </div>
    `).join('');

    const owner = video.user_id === req.user.id;

    let media;

    if (video.media_type === 'photo') {
      media = `<img class="feed-photo" src="${esc(video.video_url)}" alt="${esc(video.title)}" loading="lazy">`;
    } else if (video.media_type === 'audio') {
      media = `<audio class="feed-audio" data-post-id="${video.id}" controls preload="metadata" src="${esc(video.video_url)}"></audio>`;
    } else if (video.media_type === 'text') {
      media = `<div class="text-post">${esc(video.title)}</div>`;
    } else {
      media = `<video class="feed-video" data-post-id="${video.id}" controls playsinline preload="metadata" src="${esc(video.video_url)}"></video>`;
    }

    const gifts = Number(get(
      'SELECT COALESCE(SUM(moon),0) AS n FROM gifts WHERE video_id=?',
      video.id
    ).n);

    return `
      <article class="card feed-card" id="post-${video.id}">
        <div class="feed-head">
          <div>
            <b>${esc(video.name)}</b>
            <div class="muted tiny">${esc(video.created_at)}</div>
          </div>

          ${owner
            ? '<span class="pill">Your post</span>'
            : `<form method="post" action="/follow/${video.user_id}">
                ${csrfField(req)}
                <button class="secondary" type="submit">${video.following ? 'Following ✓' : '＋ Follow'}</button>
              </form>`
          }
        </div>

        ${media}

        <div class="feed-body">
          <h3>${esc(video.title)}</h3>
          <div class="stream-message muted tiny" aria-live="polite">
            Watch or listen for 30 seconds to check reward eligibility.
          </div>
        </div>

        <div class="feed-actions">
          <form method="post" action="/videos/${video.id}/like">
            ${csrfField(req)}
            <button class="${video.liked ? '' : 'secondary'}" type="submit">
              ${video.liked ? '💚 Liked' : '🤍 Like'} · ${fmt(video.like_count)}
            </button>
          </form>

          <span class="pill">💬 ${fmt(video.comment_count)} comments</span>

          <button class="secondary" type="button" onclick="shareMoonetPost(${video.id})">🔗 Share</button>

          <span class="pill">🌙 ${fmt(gifts)} gifted MOONS</span>
        </div>

        <div class="feed-body">
          <form class="stack" method="post" action="/videos/${video.id}/comments">
            ${csrfField(req)}
            <label>Write a comment
              <textarea name="comment" required maxlength="500" rows="2" placeholder="Write your thoughts..."></textarea>
            </label>
            <button type="submit">Post Comment</button>
          </form>

          <div style="margin-top:12px">
            ${comments || '<p class="muted">No comments yet. Be the first!</p>'}
          </div>

          <form class="gift-form" method="post" action="/videos/${video.id}/gift" style="margin-top:14px">
            ${csrfField(req)}
            <select name="gift" required>
              <option value="">Send a MOON gift</option>
              <option value="Moon:1">🌙 Moon · 1 MOON</option>
              <option value="Heart:5">💚 Heart · 5 MOONS</option>
              <option value="Rose:10">🌹 Rose · 10 MOONS</option>
              <option value="Diamond:100">💎 Diamond · 100 MOONS</option>
            </select>
            <button type="submit">Send Gift</button>
          </form>
        </div>
      </article>
    `;
  }).join('');

  const content = `
    <div class="card feed-compose">
      <h1>🎬 MOONET Feed</h1>
      <p class="muted">Publish a video, photo, audio, or text post. Upload limit: 100 MB.</p>

      <form class="stack" method="post" action="/videos" enctype="multipart/form-data">
        ${csrfField(req)}

        <label>Post type
          <select name="media_type" id="post-type" required onchange="updatePostFields()">
            <option value="video">🎬 Video</option>
            <option value="photo">📷 Photo</option>
            <option value="audio">🎵 Song / Audio</option>
            <option value="text">✍️ Text post</option>
          </select>
        </label>

        <label>Caption / text
          <input name="title" required maxlength="1000" placeholder="What do you want to share?">
        </label>

        <label id="file-label">Choose file
          <input type="file" name="media_file" id="media-file"
          accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,audio/aac">
        </label>

        <label id="url-label">Or direct HTTPS video URL (optional)
          <input name="video_url" type="url" maxlength="1000" placeholder="https://example.com/video.mp4">
        </label>

        <button>＋ Publish Post</button>
      </form>
    </div>

    ${cards || '<div class="card"><h3>No posts yet</h3><p class="muted">Be the first to publish a post.</p></div>'}
  `;

  res.send(page('Video Feed', content + `
    <script>
      function updatePostFields() {
        const type = document.getElementById('post-type').value;
        const file = document.getElementById('media-file');
        const fileLabel = document.getElementById('file-label');
        const urlLabel = document.getElementById('url-label');

        const accept = {
          video: 'video/mp4,video/webm,video/quicktime',
          photo: 'image/jpeg,image/png,image/gif,image/webp',
          audio: 'audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,audio/aac',
          text: ''
        };

        file.accept = accept[type] || '';
        fileLabel.style.display = type === 'text' ? 'none' : 'block';
        urlLabel.style.display = type === 'video' ? 'block' : 'none';

        const videoUrl = document.querySelector('[name=video_url]').value.trim();
        file.required = type !== 'text' && !(type === 'video' && videoUrl);
      }

      document.querySelector('[name=video_url]').addEventListener('input', updatePostFields);
      updatePostFields();

      const csrf = document.querySelector('input[name="_csrf"]')?.value || '';

      async function rewardRequest(id, kind, action, sessionId = '') {
        const endpoint = kind === 'audio'
          ? '/videos/' + id + '/listen'
          : '/videos/' + id + '/stream';

        const body = new URLSearchParams({
          _csrf: csrf,
          action
        });

        if (sessionId) body.set('sessionId', sessionId);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body,
          credentials: 'same-origin'
        });

        return response.json();
      }

      document.querySelectorAll('video[data-post-id],audio[data-post-id]').forEach(media => {
        const id = media.dataset.postId;
        const kind = media.tagName.toLowerCase() === 'audio' ? 'audio' : 'video';

        let sessionId = '';
        let started = false;
        let completed = false;

        media.addEventListener('play', async () => {
          if (started || completed) return;

          started = true;

          try {
            const result = await rewardRequest(id, kind, 'start');

            if (result.ok) {
              sessionId = result.sessionId;
            } else {
              started = false;
            }
          } catch (_) {
            started = false;
          }
        });

        media.addEventListener('timeupdate', async () => {
          if (completed || !sessionId || media.currentTime < 30) return;

          completed = true;

          try {
            const result = await rewardRequest(id, kind, 'complete', sessionId);
            const box = media.closest('.feed-card')?.querySelector('.stream-message');

            if (box) box.textContent = result.message || 'Playback checked.';
          } catch (_) {
            completed = false;
          }
        });
      });

      async function shareMoonetPost(id) {
        const url = location.origin + '/videos#post-' + id;

        try {
          if (navigator.share) {
            await navigator.share({
              title: 'MOONET post',
              text: 'Check out this post on MOONET',
              url
            });
          } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            alert('Post link copied. Share it with your friends!');
          } else {
            prompt('Copy this post link:', url);
          }
        } catch (error) {
          if (error.name !== 'AbortError') prompt('Copy this post link:', url);
        }
      }
    </script>
  `, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.post('/videos', requireUser, (req, res, next) => {
  upload.single('media_file')(req, res, error => {
    if (error) {
      console.error('Upload error:', error.message);

      return res.status(400).send(page('Upload Post', `
        <div class="card">
          ${msg(error.message || 'Upload failed.', 'error')}
          <a href="/videos">Back to Feed</a>
        </div>
      `, {
        ...req.user,
        _csrf: req.session.csrfToken
      }));
    }

    validateCsrf(req, res, () => {
      try {
        const title = String(req.body.title || '').trim();
        const type = String(req.body.media_type || 'video');
        const videoUrl = String(req.body.video_url || '').trim();

        if (!title || title.length > (type === 'text' ? 1000 : 120)) {
          return res.status(400).send('Please enter a valid caption or text.');
        }

        if (!['video', 'photo', 'audio', 'text'].includes(type)) {
          return res.status(400).send('Invalid post type.');
        }

        let storedUrl = '';

        if (req.file) {
          storedUrl = '/uploads/' + req.file.filename;
          const mime = req.file.mimetype;

          if (type === 'video' && !mime.startsWith('video/')) {
            return res.status(400).send('Choose a video file.');
          }

          if (type === 'photo' && !mime.startsWith('image/')) {
            return res.status(400).send('Choose a photo file.');
          }

          if (type === 'audio' && !mime.startsWith('audio/')) {
            return res.status(400).send('Choose an audio file.');
          }
        } else if (type === 'video' && videoUrl) {
          let url;

          try {
            url = new URL(videoUrl);
          } catch (_) {
            return res.status(400).send('Invalid video URL.');
          }

          if (url.protocol !== 'https:' || !url.hostname || videoUrl.length > 1000) {
            return res.status(400).send('Please provide a valid HTTPS video URL.');
          }

          storedUrl = videoUrl;
        } else if (type !== 'text') {
          return res.status(400).send('Please choose a file to upload.');
        }

        run(
          'INSERT INTO videos(user_id,title,video_url,media_type) VALUES(?,?,?,?)',
          req.user.id,
          title,
          storedUrl,
          type
        );

        return res.redirect('/videos');
      } catch (error) {
        console.error('Create post error:', error.message);
        return res.status(500).send('Could not publish post.');
      }
    });
  });
});

function rewardMedia(req, res, id, mediaType, sessionTable, balanceColumn, transactionType, reward, durationMs) {
  const post = get(
    'SELECT id,user_id,media_type FROM videos WHERE id=?',
    id
  );

  if (!post) {
    return res.status(404).json({ok: false, message: 'Post not found.'});
  }

  if (post.media_type !== mediaType) {
    return res.status(400).json({ok: false, message: 'Wrong media type.'});
  }

  if (post.user_id === req.user.id) {
    return res.status(400).json({
      ok: false,
      message: 'You cannot earn a reward by playing your own post.'
    });
  }

  const action = String(req.body.action || '');

  if (action === 'start') {
    const sessionId = crypto.randomUUID();

    run(
      `INSERT INTO ${sessionTable}(id,video_id,user_id,started_at,completed) VALUES(?,?,?,?,0)`,
      sessionId,
      id,
      req.user.id,
      Date.now()
    );

    return res.json({
      ok: true,
      sessionId,
      message: 'Playback started. Keep playing for at least 30 seconds.'
    });
  }

  if (action !== 'complete') {
    return res.status(400).json({ok: false, message: 'Invalid action.'});
  }

  const sessionId = String(req.body.sessionId || '');

  const playback = get(
    `SELECT * FROM ${sessionTable} WHERE id=? AND video_id=? AND user_id=?`,
    sessionId,
    id,
    req.user.id
  );

  if (!playback) {
    return res.status(400).json({ok: false, message: 'Playback session not found.'});
  }

  if (playback.completed) {
    return res.json({ok: true, counted: false, message: 'This playback was already processed.'});
  }

  if (Date.now() - playback.started_at < durationMs) {
    return res.status(400).json({ok: false, message: 'Keep playing for at least 30 seconds.'});
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const result = transaction(() => {
      run(
        `UPDATE ${sessionTable} SET completed=1 WHERE id=? AND completed=0`,
        sessionId
      );

      const existing = get(
        'SELECT id FROM video_streams WHERE video_id=? AND user_id=? AND stream_date=?',
        id,
        req.user.id,
        today
      );

      if (existing) {
        return {counted: false, message: 'Reward already claimed for this post today.'};
      }

      run(
        'INSERT INTO video_streams(video_id,user_id,stream_date) VALUES(?,?,?)',
        id,
        req.user.id,
        today
      );

      run(
        `UPDATE users SET moon=moon+?, ${balanceColumn}=${balanceColumn}+? WHERE id=?`,
        reward,
        reward,
        req.user.id
      );

      run(
        'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
        req.user.id,
        transactionType,
        reward,
        `Playback reward for post ${id}`,
        ref()
      );

      return {counted: true, message: `You earned ${reward} MOON.`};
    })();

    return res.json({ok: true, ...result});
  } catch (error) {
    console.error('Reward error:', error.message);
    return res.status(500).json({ok: false, message: 'Could not process reward.'});
  }
}

app.post('/videos/:id/stream', requireUser, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ok: false, message: 'Invalid post ID.'});
  }

  return rewardMedia(
    req, res, id, 'video', 'watch_sessions',
    'watch_moon', 'watch_reward', STREAM_REWARD_MOON,
    STREAM_DURATION_MS
  );
});

app.post('/videos/:id/listen', requireUser, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ok: false, message: 'Invalid post ID.'});
  }

  return rewardMedia(
    req, res, id, 'audio', 'listen_sessions',
    'listen_moon', 'listen_reward', STREAM_REWARD_MOON,
    STREAM_DURATION_MS
  );
});

app.post('/videos/:id/like', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);
  const video = get('SELECT * FROM videos WHERE id=?', id);

  if (!video) {
    return res.status(404).send('Post not found.');
  }

  if (video.user_id === req.user.id) {
    return res.status(400).send('You cannot like your own post.');
  }

  try {
    transaction(() => {
      run(
        'INSERT OR IGNORE INTO video_likes(video_id,user_id) VALUES(?,?)',
        id,
        req.user.id
      );

      run(
        'INSERT OR IGNORE INTO like_history(video_id,user_id) VALUES(?,?)',
        id,
        req.user.id
      );
    })();

    res.redirect('/videos#post-' + id);
  } catch (error) {
    console.error('Like error:', error.message);
    res.status(500).send('Could not record like.');
  }
});

app.post('/videos/:id/comments', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);
  const comment = String(req.body.comment || '').trim();

  if (!get('SELECT id FROM videos WHERE id=?', id)) {
    return res.status(404).send('Post not found.');
  }

  if (!comment || comment.length > 500) {
    return res.status(400).send('Please enter a comment up to 500 characters.');
  }

  run(
    'INSERT INTO video_comments(video_id,user_id,comment) VALUES(?,?,?)',
    id,
    req.user.id,
    comment
  );

  res.redirect('/videos#post-' + id);
});

app.post('/follow/:id', requireUser, validateCsrf, (req, res) => {
  const targetId = Number(req.params.id);

  if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === req.user.id) {
    return res.status(400).send('Invalid follow request.');
  }

  if (!get('SELECT id FROM users WHERE id=? AND suspended=0', targetId)) {
    return res.status(404).send('User not found.');
  }

  run(
    'INSERT OR IGNORE INTO follows(follower_id,following_id) VALUES(?,?)',
    req.user.id,
    targetId
  );

  res.redirect('/videos');
});

app.post('/videos/:id/gift', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);
  const video = get('SELECT * FROM videos WHERE id=?', id);

  if (!video) {
    return res.status(404).send('Post not found.');
  }

  if (video.user_id === req.user.id) {
    return res.status(400).send('You cannot send a gift to yourself.');
  }

  const gifts = {
    Moon: 1,
    Heart: 5,
    Rose: 10,
    Diamond: 100
  };

  const parts = String(req.body.gift || '').split(':');
  const name = parts[0];
  const amount = Number(parts[1]);

  if (!gifts[name] || gifts[name] !== amount) {
    return res.status(400).send('Invalid gift.');
  }

  try {
    transaction(() => {
      const debit = run(
        'UPDATE users SET moon=moon-? WHERE id=? AND moon>=?',
        amount,
        req.user.id,
        amount
      );

      if (Number(debit.changes) !== 1) {
        throw new Error('INSUFFICIENT');
      }

      run(
        'UPDATE users SET moon=moon+? WHERE id=?',
        amount,
        video.user_id
      );

      run(
        'INSERT INTO gifts(video_id,sender_id,receiver_id,gift_name,moon) VALUES(?,?,?,?,?)',
        id,
        req.user.id,
        video.user_id,
        name,
        amount
      );

      run(
        'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
        req.user.id,
        'gift_sent',
        -amount,
        `Sent ${name} gift on post ${id}`,
        ref()
      );

      run(
        'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
        video.user_id,
        'gift_received',
        amount,
        `Received ${name} gift on post ${id}`,
        ref()
      );
    })();

    res.redirect('/videos#post-' + id);
  } catch (error) {
    if (error.message === 'INSUFFICIENT') {
      return res.status(400).send('Insufficient MOONS balance.');
    }

    console.error('Gift error:', error.message);
    res.status(500).send('Could not send gift.');
  }
});

app.get('/withdraw', requireUser, (req, res) => {
  res.send(page('Withdraw', `
    <div class="card">
      <h1>Request a Withdrawal</h1>
      <p>Available balance: <b>${fmt(req.user.moon)} MOONS</b></p>
      <p>Minimum request: ${fmt(MIN_WITHDRAWAL_MOON)} MOONS.</p>

      <form class="stack" method="post" action="/withdraw">
        ${csrfField(req)}

        <label>Amount in MOONS
          <input name="moon" type="number" min="${MIN_WITHDRAWAL_MOON}" max="${req.user.moon}" step="1" required>
        </label>

        <label>Payment method
          <select name="method" required>
            <option value="">Select method</option>
            <option>MTN MoMo</option>
            <option>Airtel Money</option>
            <option>Bank</option>
          </select>
        </label>

        <label>Payment account or number
          <input name="account" required minlength="5" maxlength="120">
        </label>

        <button>Submit Request</button>
      </form>

      <p class="muted">This creates a request for review; it does not send money automatically.</p>
    </div>
  `, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.post('/withdraw', requireUser, validateCsrf, (req, res) => {
  const moon = Number(req.body.moon);
  const method = String(req.body.method || '');
  const account = String(req.body.account || '').trim();

  if (
    !Number.isSafeInteger(moon) ||
    moon < MIN_WITHDRAWAL_MOON ||
    moon > req.user.moon ||
    !['MTN MoMo', 'Airtel Money', 'Bank'].includes(method) ||
    account.length < 5 ||
    account.length > 120
  ) {
    return res.status(400).send('Invalid withdrawal request.');
  }

  const amount = moon * MOON_VALUE_RWF;

  try {
    transaction(() => {
      const debit = run(
        'UPDATE users SET moon=moon-? WHERE id=? AND moon>=?',
        moon,
        req.user.id,
        moon
      );

      if (Number(debit.changes) !== 1) {
        throw new Error('INSUFFICIENT');
      }

      run(
        'INSERT INTO withdrawals(user_id,moon,amount_rwf,payment_method,payment_account) VALUES(?,?,?,?,?)',
        req.user.id,
        moon,
        amount,
        method,
        account
      );

      run(
        'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
        req.user.id,
        'withdrawal_pending',
        -moon,
        `Withdrawal request pending review (${amount} RWF)`,
        ref()
      );
    })();

    const user = get(
      'SELECT id,name,email,moon,like_moon,watch_moon,listen_moon,referral_code,suspended FROM users WHERE id=?',
      req.user.id
    );

    res.send(page('Withdrawal Submitted', `
      <div class="card">
        ${msg('Your withdrawal request has been submitted for review.', 'success')}
        <a href="/wallet">Return to wallet</a>
      </div>
    `, {
      ...user,
      _csrf: req.session.csrfToken
    }));
  } catch (error) {
    if (error.message === 'INSUFFICIENT') {
      return res.status(400).send('Insufficient MOONS balance.');
    }

    console.error(error.message);
    res.status(500).send('Could not submit withdrawal request.');
  }
});

app.get('/admin/login', (req, res) => {
  res.send(page('Admin Login', `
    <div class="card">
      <h1>MOONET Admin Login</h1>
      <form class="stack" method="post" action="/admin/login">
        ${csrfField(req)}
        <label>Email<input name="email" type="email" required></label>
        <label>Password<input name="password" type="password" required></label>
        <button>Admin Login</button>
      </form>
    </div>
  `));
});

app.post('/admin/login', validateCsrf, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const emailBuffer = Buffer.from(email.padEnd(254, '\0').slice(0, 254));
  const adminEmailBuffer = Buffer.from(ADMIN_EMAIL.padEnd(254, '\0').slice(0, 254));

  const validEmail = crypto.timingSafeEqual(emailBuffer, adminEmailBuffer);

  const passwordBuffer = Buffer.from(password);
  const adminPasswordBuffer = Buffer.from(ADMIN_PASSWORD);

  const validPassword =
    passwordBuffer.length === adminPasswordBuffer.length &&
    crypto.timingSafeEqual(passwordBuffer, adminPasswordBuffer);

  if (!validEmail || !validPassword) {
    return res.status(401).send(page('Admin Login', `
      <div class="card">
        ${msg('Invalid admin credentials.', 'error')}
        <a href="/admin/login">Try again</a>
      </div>
    `));
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).send('Could not create admin session.');
    }

    req.session.isAdmin = true;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');

    res.redirect('/admin');
  });
});

app.post('/admin/logout', requireAdmin, validateCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAdmin, (req, res) => {
  const users = Number(get('SELECT COUNT(*) AS total FROM users').total);
  const outstanding = Number(get('SELECT COALESCE(SUM(moon),0) AS total FROM users').total);
  const revenue = Number(get('SELECT COALESCE(SUM(amount_rwf),0) AS total FROM revenue').total);
  const expenses = Number(get('SELECT COALESCE(SUM(amount_rwf),0) AS total FROM expenses').total);
  const paid = Number(get("SELECT COALESCE(SUM(amount_rwf),0) AS total FROM withdrawals WHERE status='paid'").total);
  const pending = Number(get("SELECT COALESCE(SUM(amount_rwf),0) AS total FROM withdrawals WHERE status='pending'").total);
  const profit = revenue - expenses - paid;

  const rows = all(`
    SELECT w.*,u.name,u.email
    FROM withdrawals w
    JOIN users u ON u.id=w.user_id
    ORDER BY w.id DESC
    LIMIT 100
  `).map(withdrawal => `
    <tr>
      <td>${withdrawal.id}</td>
      <td>${esc(withdrawal.name)}<br>${esc(withdrawal.email)}</td>
      <td>${fmt(withdrawal.moon)}</td>
      <td>${fmt(withdrawal.amount_rwf)} RWF</td>
      <td>${esc(withdrawal.payment_method)}<br>${esc(withdrawal.payment_account)}</td>
      <td>${esc(withdrawal.status)}</td>
      <td>
        ${withdrawal.status === 'pending' ? `
          <form method="post" action="/admin/withdrawals/${withdrawal.id}/paid">
            ${csrfField(req)}
            <button>Mark Paid</button>
          </form>

          <form method="post" action="/admin/withdrawals/${withdrawal.id}/reject">
            ${csrfField(req)}
            <button class="danger">Reject</button>
          </form>
        ` : ''}
      </td>
    </tr>
  `).join('');

  const content = `
    <section class="hero">
      <h1>🌙 MOONET Admin</h1>
      <p>Financial overview and platform management</p>
      <form method="post" action="/admin/logout">
        ${csrfField(req)}
        <button class="secondary">Logout Admin</button>
      </form>
    </section>

    <section class="grid">
      <div class="card"><h3>Users</h3><div class="number">${fmt(users)}</div></div>
      <div class="card"><h3>Outstanding MOONS</h3><div class="number">${fmt(outstanding)}</div></div>
      <div class="card"><h3>Revenue</h3><div class="number">${fmt(revenue)} RWF</div></div>
      <div class="card"><h3>Expenses</h3><div class="number">${fmt(expenses)} RWF</div></div>
      <div class="card"><h3>Paid Withdrawals</h3><div class="number">${fmt(paid)} RWF</div></div>
      <div class="card"><h3>Pending Withdrawals</h3><div class="number">${fmt(pending)} RWF</div></div>
      <div class="card"><h3>Calculated Net Profit</h3><div class="number">${fmt(profit)} RWF</div></div>
    </section>

    <div class="card">
      <h2>Record Revenue</h2>
      <form class="stack" method="post" action="/admin/revenue">
        ${csrfField(req)}
        <label>Amount (RWF)<input name="amount" type="number" min="1" required></label>
        <label>Source<input name="source" maxlength="150" required></label>
        <button>Record Revenue</button>
      </form>
      <p class="muted">Only record money actually received and verifiable.</p>
    </div>

    <div class="card">
      <h2>Record Expense</h2>
      <form class="stack" method="post" action="/admin/expenses">
        ${csrfField(req)}
        <label>Amount (RWF)<input name="amount" type="number" min="1" required></label>
        <label>Description<input name="description" maxlength="200" required></label>
        <button>Record Expense</button>
      </form>
    </div>

    <div class="card">
      <h2>Withdrawal Requests</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>User</th><th>MOONS</th><th>Amount</th>
              <th>Payment details</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7">No withdrawal requests.</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <p class="muted">
        Calculated net profit = recorded revenue − recorded expenses − paid withdrawals.
        This is a management estimate, not audited accounting profit.
        Only mark a withdrawal paid after independently verifying that the real payment was completed.
      </p>
    </div>
  `;

  res.send(page('Admin Dashboard', content));
});

app.post('/admin/revenue', requireAdmin, validateCsrf, (req, res) => {
  const amount = Number(req.body.amount);
  const source = String(req.body.source || '').trim();

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > 100000000000 ||
    !source ||
    source.length > 150
  ) {
    return res.status(400).send('Invalid revenue entry.');
  }

  run(
    'INSERT INTO revenue(amount_rwf,source,reference) VALUES(?,?,?)',
    amount,
    source,
    ref()
  );

  res.redirect('/admin');
});

app.post('/admin/expenses', requireAdmin, validateCsrf, (req, res) => {
  const amount = Number(req.body.amount);
  const description = String(req.body.description || '').trim();

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > 100000000000 ||
    !description ||
    description.length > 200
  ) {
    return res.status(400).send('Invalid expense entry.');
  }

  run(
    'INSERT INTO expenses(amount_rwf,description) VALUES(?,?)',
    amount,
    description
  );

  res.redirect('/admin');
});

app.post('/admin/withdrawals/:id/paid', requireAdmin, validateCsrf, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).send('Invalid withdrawal ID.');
  }

  const withdrawal = get('SELECT * FROM withdrawals WHERE id=?', id);

  if (!withdrawal || withdrawal.status !== 'pending') {
    return res.status(409).send('Withdrawal is not pending.');
  }

  transaction(() => {
    const updated = run(
      "UPDATE withdrawals SET status='paid' WHERE id=? AND status='pending'",
      id
    );

    if (Number(updated.changes) !== 1) {
      throw new Error('NOT_PENDING');
    }

    run(
      'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
      withdrawal.user_id,
      'withdrawal_paid',
      0,
      `Withdrawal ${id} marked paid (${withdrawal.amount_rwf} RWF)`,
      ref()
    );
  })();

  res.redirect('/admin');
});

app.post('/admin/withdrawals/:id/reject', requireAdmin, validateCsrf, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).send('Invalid withdrawal ID.');
  }

  const withdrawal = get('SELECT * FROM withdrawals WHERE id=?', id);

  if (!withdrawal || withdrawal.status !== 'pending') {
    return res.status(409).send('Withdrawal is not pending.');
  }

  transaction(() => {
    const updated = run(
      "UPDATE withdrawals SET status='rejected' WHERE id=? AND status='pending'",
      id
    );

    if (Number(updated.changes) !== 1) {
      throw new Error('NOT_PENDING');
    }

    run(
      'UPDATE users SET moon=moon+? WHERE id=?',
      withdrawal.moon,
      withdrawal.user_id
    );

    run(
      'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
      withdrawal.user_id,
      'withdrawal_refund',
      withdrawal.moon,
      `Refund for rejected withdrawal ${id}`,
      ref()
    );
  })();

  res.redirect('/admin');
});

app.use((req, res) => {
  res.status(404).send(page('Not Found', `
    <div class="card">
      <h1>404</h1>
      <p>Page not found.</p>
      <a href="/">Go Home</a>
    </div>
  `));
});

app.use((error, req, res, next) => {
  console.error('Server error:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).send(page('Server Error', `
    <div class="card">
      <h1>Something went wrong</h1>
      <p>Please try again later.</p>
    </div>
  `));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} is running on port ${PORT}`);
});
