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
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 // MOONET: Safe migration for the settings table.
// Adds the missing column without deleting existing settings.
const settingsColumns = db
  .prepare('PRAGMA table_info(settings)')
  .all()
  .map(column => column.name);

if (!settingsColumns.includes('updated_at')) {
  db.exec('ALTER TABLE settings ADD COLUMN updated_at TEXT');
}

console.log('MOONET settings migration checked.');

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
  db.exec(
    "ALTER TABLE videos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'"
  );
} catch (e) {
  if (!String(e.message).includes('duplicate column name')) {
    throw e;
  }
}

// Safe, additive migrations: existing users and records are preserved.
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
   liker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   moon REAL NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   UNIQUE(video_id, liker_id)
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
  }[c]));
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

function page(title, content, user = null) {
  const nav = user
    ? `<a href="/app">Home</a>
       <a href="/videos">Feed</a>
       <a href="/wallet">Wallet</a>
       <a href="/transactions">History</a>
       <a href="/profile">Profile</a>
       <form action="/logout" method="post" class="inline">
         ${csrfFieldForPage()}
         <button class="secondary" type="submit">Logout</button>
       </form>`
    : `<a href="/">Home</a><a href="/login">Login</a><a href="/signup">Sign Up</a>`;

  function csrfFieldForPage() {
    return `<input type="hidden" name="_csrf" value="${esc(user && user._csrf || '')}">`;
  }

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
      .feed-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line)}
      .tiny{font-size:12px}
      .comment{padding:9px 0;border-bottom:1px solid #edf3ee}
      .pill{display:inline-block;background:var(--pale);color:var(--deep);padding:5px 9px;border-radius:20px;font-size:12px;font-weight:700}
      .feed-compose{border:2px dashed #b9dec6}
      .gift-form{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
      .gift-form select{width:auto;flex:1;min-width:140px}
      .gift-form button{white-space:nowrap}
      @media(max-width:520px){
        nav{gap:9px}
        nav a{font-size:12px}
        .feed-head{align-items:flex-start}
        .feed-video{max-height:62vh}
      }
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

function render(req, title, content, user = req.user || null) {
  if (user) user = { ...user, _csrf: req.session.csrfToken || '' };
  resSend(req, title, content, user);
}

function resSend(req, title, content, user) {
  req._res.send(page(title, content, user));
}

function requireUser(req, res, next) {
  const id = req.session.userId;

  if (!id) return res.redirect('/login');

  const u = get(
    'SELECT id,name,email,moon,like_moon,watch_moon,listen_moon,referral_code,suspended FROM users WHERE id=?',
    id
  );

  if (!u || u.suspended) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }

  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin !== true) return res.redirect('/admin/login');
  next();
}

function validateCsrf(req, res, next) {
  const submitted = String(req.body?._csrf || '');
  const expected = String(req.session?.csrfToken || '');
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);

  if (!a.length || !b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(video\/|image\/|audio\/)/.test(file.mimetype || '');

    if (!allowed) return cb(new Error('Only video, image, or audio files are allowed.'));
    cb(null, true);
  }
});

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

app.use(session({
  name: 'moonet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  req._res = res;

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: APP_NAME,
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.send(page('Welcome', `
    <section class="hero">
      <h1>🌙 Welcome to MOONET</h1>
      <p>Create, share, connect, and earn MOONS.</p>
      <p class="muted">Build your community by posting media, watching content, and interacting with creators.</p>
      <a class="button" href="/signup">Create Account</a>
      <a class="button secondary" href="/login">Login</a>
    </section>
    <section class="grid">
      <div class="card"><h3>🎬 Create</h3><p>Share videos, images, audio, and updates.</p></div>
      <div class="card"><h3>❤️ Connect</h3><p>Like posts, comment, follow creators, and send gifts.</p></div>
      <div class="card"><h3>🌙 Earn MOONS</h3><p>Qualifying activity may earn MOONS under platform rules.</p></div>
    </section>
  `));
});

app.get('/signup', (req, res) => {
  res.send(page('Sign Up', `
    <div class="card">
      <h1>Create your MOONET account</h1>
      <form class="stack" method="post" action="/signup">
        ${csrfField(req)}
        <label>Full name<input name="name" required minlength="2" maxlength="80"></label>
        <label>Email<input name="email" type="email" required maxlength="254"></label>
        <label>Password<input name="password" type="password" required minlength="8" maxlength="128"></label>
        <label>Referral code (optional)<input name="referral" maxlength="30"></label>
        <button type="submit">Create Account</button>
      </form>
      <p>Already registered? <a href="/login">Login</a></p>
    </div>
  `));
});

app.post('/signup', validateCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (name.length < 2 || name.length > 80) {
    return res.status(400).send('Name must contain 2–80 characters.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).send('Enter a valid email address.');
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).send('Password must contain 8–128 characters.');
  }

  if (get('SELECT id FROM users WHERE email=?', email)) {
    return res.status(409).send(
      page('Sign Up', `<div class="card">${msg('Email already registered. Please login.', 'error')}<a href="/login">Login</a></div>`)
    );
  }

  let referredBy = null;

  if (referral) {
    const referrer = get('SELECT id FROM users WHERE referral_code=?', referral);
    if (referrer) referredBy = referrer.id;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  let code;

  do {
    code = referralCode();
  } while (get('SELECT id FROM users WHERE referral_code=?', code));

  try {
    const result = run(
      'INSERT INTO users(name,email,password_hash,referral_code,referred_by) VALUES(?,?,?,?,?)',
      name,
      email,
      passwordHash,
      code,
      referredBy
    );

    const userId = Number(result.lastInsertRowid);

    transaction(() => {
      run(
        'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
        userId,
        'welcome_bonus',
        10,
        'MOONET welcome bonus',
        ref()
      );

      run('UPDATE users SET moon=moon+10 WHERE id=?', userId);
    })();

    req.session.regenerate(err => {
      if (err) return res.status(500).send('Could not create your session.');

      req.session.userId = userId;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.redirect('/app');
    });
  } catch (e) {
    console.error('Signup error:', e.message);

    if (String(e.message).includes('UNIQUE constraint failed: users.email')) {
      return res.status(409).send(
        page('Sign Up', `<div class="card">${msg('Email already registered. Please login.', 'error')}<a href="/login">Login</a></div>`)
      );
    }

    res.status(500).send('Could not create account. Please try again.');
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
        <button type="submit">Login</button>
      </form>
      <p>New to MOONET? <a href="/signup">Create an account</a></p>
    </div>
  `));
});

app.post('/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const
   // ============================================================
// MOONET — IGICE CYA 2/2
// ADMIN LOGIN, DASHBOARD, REVENUE, EXPENSES, WITHDRAWALS
// ============================================================

app.get('/admin/login', (req, res) => {
  res.send(page('Admin Login', `
    <div class="card">
      <h1>MOONET Admin Login</h1>
      <form class="stack" method="post" action="/admin/login">
        ${csrfField(req)}
        <label>Email
          <input name="email" type="email" required>
        </label>
        <label>Password
          <input name="password" type="password" required>
        </label>
        <button type="submit">Admin Login</button>
      </form>
    </div>
  `));
});

app.post('/admin/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const emailBuffer = Buffer.from(
    email.padEnd(254, '\0').slice(0, 254)
  );
  const adminEmailBuffer = Buffer.from(
    ADMIN_EMAIL.padEnd(254, '\0').slice(0, 254)
  );

  const validEmail = crypto.timingSafeEqual(
    emailBuffer,
    adminEmailBuffer
  );

  const passwordBuffer = Buffer.from(password);
  const adminPasswordBuffer = Buffer.from(ADMIN_PASSWORD);

  const validPassword =
    passwordBuffer.length === adminPasswordBuffer.length &&
    crypto.timingSafeEqual(passwordBuffer, adminPasswordBuffer);

  if (!validEmail || !validPassword) {
    return res.status(401).send(page(
      'Admin Login',
      `<div class="card">
        ${msg('Invalid admin credentials.', 'error')}
        <a href="/admin/login">Try again</a>
      </div>`
    ));
  }

  req.session.regenerate(err => {
    if (err) {
      console.error('Admin session error:', err.message);
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
  const users = Number(
    get('SELECT COUNT(*) AS total FROM users').total
  );

  const outstanding = Number(
    get('SELECT COALESCE(SUM(moon),0) AS total FROM users').total
  );

  const revenue = Number(
    get('SELECT COALESCE(SUM(amount_rwf),0) AS total FROM revenue').total
  );

  const expenses = Number(
    get('SELECT COALESCE(SUM(amount_rwf),0) AS total FROM expenses').total
  );

  const paid = Number(
    get("SELECT COALESCE(SUM(amount_rwf),0) AS total FROM withdrawals WHERE status='paid'").total
  );

  const pending = Number(
    get("SELECT COALESCE(SUM(amount_rwf),0) AS total FROM withdrawals WHERE status='pending'").total
  );

  const profit = revenue - expenses - paid;

  const rows = all(`
    SELECT w.*, u.name, u.email
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ORDER BY w.id DESC
    LIMIT 100
  `).map(w => `
    <tr>
      <td>${w.id}</td>
      <td>${esc(w.name)}<br>${esc(w.email)}</td>
      <td>${fmt(w.moon)} MOONS</td>
      <td>${fmt(w.amount_rwf)} RWF</td>
      <td>${esc(w.payment_method)}<br>${esc(w.payment_account)}</td>
      <td>${esc(w.status)}</td>
      <td>
        ${w.status === 'pending' ? `
          <form method="post" action="/admin/withdrawals/${w.id}/paid">
            ${csrfField(req)}
            <button type="submit">Mark Paid</button>
          </form>
          <form method="post" action="/admin/withdrawals/${w.id}/reject">
            ${csrfField(req)}
            <button class="danger" type="submit">Reject</button>
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
        <button class="secondary" type="submit">Logout Admin</button>
      </form>
    </section>

    <section class="grid">
      <div class="card">
        <h3>Users</h3>
        <div class="number">${fmt(users)}</div>
      </div>
      <div class="card">
        <h3>Outstanding MOONS</h3>
        <div class="number">${fmt(outstanding)}</div>
      </div>
      <div class="card">
        <h3>Revenue</h3>
        <div class="number">${fmt(revenue)} RWF</div>
      </div>
      <div class="card">
        <h3>Expenses</h3>
        <div class="number">${fmt(expenses)} RWF</div>
      </div>
      <div class="card">
        <h3>Paid Withdrawals</h3>
        <div class="number">${fmt(paid)} RWF</div>
      </div>
      <div class="card">
        <h3>Pending Withdrawals</h3>
        <div class="number">${fmt(pending)} RWF</div>
      </div>
      <div class="card">
        <h3>Calculated Net Profit</h3>
        <div class="number">${fmt(profit)} RWF</div>
      </div>
    </section>

    <div class="card">
      <h2>Record Revenue</h2>
      <form class="stack" method="post" action="/admin/revenue">
        ${csrfField(req)}
        <label>Amount (RWF)
          <input name="amount" type="number" min="1" required>
        </label>
        <label>Source
          <input name="source" maxlength="150" required>
        </label>
        <button type="submit">Record Revenue</button>
      </form>
      <p class="muted">
        Only record money actually received and verifiable.
      </p>
    </div>

    <div class="card">
      <h2>Record Expense</h2>
      <form class="stack" method="post" action="/admin/expenses">
        ${csrfField(req)}
        <label>Amount (RWF)
          <input name="amount" type="number" min="1" required>
        </label>
        <label>Description
          <input name="description" maxlength="200" required>
        </label>
        <button type="submit">Record Expense</button>
      </form>
    </div>

    <div class="card">
      <h2>Withdrawal Requests</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>User</th>
              <th>MOONS</th>
              <th>Amount</th>
              <th>Payment Details</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="7">No withdrawal requests.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <p class="muted">
        Calculated net profit = recorded revenue minus recorded expenses
        minus paid withdrawals. This is a management estimate, not audited
        accounting profit. Only mark a withdrawal paid after verifying that
        the real payment was completed.
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

app.post(
  '/admin/withdrawals/:id/paid',
  requireAdmin,
  validateCsrf,
  (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).send('Invalid withdrawal ID.');
    }

    const withdrawal = get(
      'SELECT * FROM withdrawals WHERE id=?',
      id
    );

    if (!withdrawal || withdrawal.status !== 'pending') {
      return res.status(409).send('Withdrawal is not pending.');
    }

    try {
      transaction(() => {
        const updated = run(
          "UPDATE withdrawals SET status='paid' WHERE id=? AND status='pending'",
          id
        );

        if (Number(updated.changes) !== 1) {
          throw new Error('NOT_PENDING');
        }

        run(
          `INSERT INTO transactions
           (user_id,type,moon,description,reference)
           VALUES(?,?,?,?,?)`,
          withdrawal.user_id,
          'withdrawal_paid',
          0,
          `Withdrawal ${id} marked paid (${withdrawal.amount_rwf} RWF)`,
          ref()
        );
      })();

      res.redirect('/admin');
    } catch (error) {
      console.error('Mark-paid error:', error.message);
      res.status(500).send('Could not update withdrawal status.');
    }
  }
);

app.post(
  '/admin/withdrawals/:id/reject',
  requireAdmin,
  validateCsrf,
  (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).send('Invalid withdrawal ID.');
    }

    const withdrawal = get(
      'SELECT * FROM withdrawals WHERE id=?',
      id
    );

    if (!withdrawal || withdrawal.status !== 'pending') {
      return res.status(409).send('Withdrawal is not pending.');
    }

    try {
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
          `INSERT INTO transactions
           (user_id,type,moon,description,reference)
           VALUES(?,?,?,?,?)`,
          withdrawal.user_id,
          'withdrawal_refund',
          withdrawal.moon,
          `Refund for rejected withdrawal ${id}`,
          ref()
        );
      })();

      res.redirect('/admin');
    } catch (error) {
      console.error('Reject-withdrawal error:', error.message);
      res.status(500).send('Could not reject withdrawal.');
    }
  }
);

// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
  res.status(404).send(page(
    'Not Found',
    '<div class="card"><h1>404</h1><p>Page not found.</p><a href="/">Go Home</a></div>'
  ));
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).send(page(
    'Server Error',
    '<div class="card"><h1>Something went wrong</h1><p>Please try again later.</p></div>'
  ));
});

// ============================================================
// START SERVER — IHEREZO YA server.js
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} is running on port ${PORT}`);
});
