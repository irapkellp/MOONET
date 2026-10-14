'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
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
   video_url TEXT NOT NULL,
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
@media(max-width:520px){nav{gap:9px}nav a{font-size:12px}.feed-head{align-items:flex-start}.feed-video{max-height:62vh}}
</style>
</head>
<body>
<header><div class="top">
<a class="brand" href="${user ? '/app' : '/'}">🌙 MOONET</a>
<nav>${nav}</nav>
</div></header>
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
    'SELECT id,name,email,moon,referral_code,suspended FROM users WHERE id=?',
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

  if (!a.length || !b.length || a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)) {
    return res.status(403).send(
      page('Security Check',
        '<div class="card">Security check failed. Reload the page and try again.</div>')
    );
  }

  next();
}

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
  req._res = res;
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: APP_NAME });
});

app.get('/', (req, res) => res.send(page('Home', `
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
`)));

app.get('/signup', (req, res) => res.send(page('Sign Up', `
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
`)));

app.post('/signup', validateCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (name.length < 2 || name.length > 60 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 || password.length < 10 || password.length > 128) {
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

  let by = null;
  if (referral) {
    const r = get('SELECT id FROM users WHERE referral_code=?', referral);
    if (r) by = r.id;
  }

  const hash = await bcrypt.hash(password, 12);
  let code = referralCode();

  while (get('SELECT id FROM users WHERE referral_code=?', code)) {
    code = referralCode();
  }

  try {
    const result = run(
      'INSERT INTO users(name,email,password_hash,referral_code,referred_by) VALUES(?,?,?,?,?)',
      name, email, hash, code, by
    );

    req.session.regenerate(err => {
      if (err) return res.status(500).send('Could not create session.');

      req.session.userId = Number(result.lastInsertRowid);
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.redirect('/app');
    });
  } catch (e) {
    console.error('Signup error:', e.message);
    res.status(500).send('Could not create account.');
  }
});

app.get('/login', (req, res) => res.send(page('Login', `
<div class="card">
<h1>Login to MOONET</h1>
<form class="stack" method="post" action="/login">
${csrfField(req)}
<label>Email<input name="email" type="email" required></label>
<label>Password<input name="password" type="password" required></label>
<button>Login</button>
</form>
<p class="muted">New? <a href="/signup">Create an account</a></p>
</div>
`)));

app.post('/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = get(
    'SELECT id,password_hash,suspended FROM users WHERE email=?',
    email
  );

  if (!u || u.suspended ||
      !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).send(page('Login', `
      <div class="card">
      ${msg('Invalid email or password.', 'error')}
      <a href="/login">Try again</a>
      </div>
    `));
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).send('Could not create session.');

    req.session.userId = u.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.redirect('/app');
  });
});

app.post('/logout', requireUser, validateCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/app', requireUser, (req, res) => res.send(page('Home', `
<section class="hero">
<h1>Hello, ${esc(req.user.name)} 💚</h1>
<p class="muted">Your MOONET community dashboard</p>
<div class="number">${fmt(req.user.m
