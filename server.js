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

 CREATE TABLE IF NOT EXISTS users (
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

 CREATE TABLE IF NOT EXISTS transactions (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER NOT NULL REFERENCES users(id),
   type TEXT NOT NULL,
   moon INTEGER NOT NULL,
   description TEXT NOT NULL,
   reference TEXT UNIQUE,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS withdrawals (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER NOT NULL REFERENCES users(id),
   moon INTEGER NOT NULL CHECK(moon>0),
   amount_rwf INTEGER NOT NULL CHECK(amount_rwf>0),
   payment_method TEXT NOT NULL,
   payment_account TEXT NOT NULL,
   status TEXT NOT NULL DEFAULT 'pending',
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS revenue (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   amount_rwf INTEGER NOT NULL CHECK(amount_rwf>=0),
   source TEXT NOT NULL,
   reference TEXT UNIQUE,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS expenses (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   amount_rwf INTEGER NOT NULL CHECK(amount_rwf>=0),
   description TEXT NOT NULL,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS settings (
   key TEXT PRIMARY KEY,
   value TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS videos (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER NOT NULL REFERENCES users(id),
   title TEXT NOT NULL,
   video_url TEXT NOT NULL,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS video_likes (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
   user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   UNIQUE(video_id,user_id)
 );

 CREATE TABLE IF NOT EXISTS video_comments (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
   user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   comment TEXT NOT NULL,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );

 CREATE TABLE IF NOT EXISTS follows (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   UNIQUE(follower_id,following_id),
   CHECK(follower_id<>following_id)
 );

 CREATE TABLE IF NOT EXISTS gifts (
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
    ? `
      <a href="/app">Home</a>
      <a href="/videos">Feed</a>
      <a href="/wallet">Wallet</a>
      <a href="/transactions">History</a>
      <a href="/profile">Profile</a>
      <form action="/logout" method="post" class="inline">
        ${csrfFieldForPage()}
        <button class="secondary" type="submit">Logout</button>
      </form>
    `
    : `
      <a href="/">Home</a>
      <a href="/login">Login</a>
      <a href="/signup">Sign Up</a>
    `;

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
:root {
  --green: #0b8f54;
  --deep: #087443;
  --pale: #e9f9ef;
  --line: #dce9e0;
  --ink: #183126;
  --muted: #63756b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f5faf6;
  color: var(--ink);
  font-family: Arial, sans-serif;
}

header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #fff;
  border-bottom: 1px solid var(--line);
  padding: 13px 16px;
}

.top {
  max-width: 1050px;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.brand {
  font-size: 25px;
  font-weight: 800;
  color: var(--green);
  text-decoration: none;
}

nav {
  display: flex;
  align-items: center;
  gap: 13px;
  flex-wrap: wrap;
}

a {
  color: var(--green);
  text-decoration: none;
}

nav a {
  font-size: 14px;
  font-weight: 700;
}

main {
  width: min(94%, 900px);
  margin: 22px auto;
  min-height: 68vh;
}

.hero,
.card {
  background: #fff;
  border: 1px solid var(--line);
  padding: 20px;
  border-radius: 17px;
  margin-bottom: 16px;
  box-shadow: 0 4px 16px #0b5b2b0a;
}

.hero {
  text-align: center;
  padding: 34px 20px;
}

h1, h2, h3 {
  margin-top: 0;
}

.muted {
  color: var(--muted);
  line-height: 1.55;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}

.number {
  font-size: 29px;
  font-weight: 800;
  margin: 10px 0;
  color: var(--green);
}

button,
.button {
  display: inline-block;
  background: var(--green);
  color: white;
  border: 0;
  border-radius: 10px;
  padding: 11px 16px;
  font-weight: 700;
  cursor: pointer;
  font-size: 14px;
}

.secondary {
  background: #e8f4ec;
  color: var(--deep);
}

.danger {
  background: #b42318;
}

.inline {
  display: inline;
}

form.stack {
  display: grid;
  gap: 12px;
}

input,
select,
textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid #cbded0;
  border-radius: 9px;
  background: #fff;
  color: var(--ink);
  font: inherit;
}

label {
  display: grid;
  gap: 7px;
  color: #30493a;
  font-weight: 600;
}

.message {
  padding: 12px;
  border-radius: 9px;
  background: var(--pale);
  margin-bottom: 14px;
}

.error {
  color: #a11;
}

.success {
  color: var(--deep);
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  text-align: left;
  padding: 10px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

footer {
  text-align: center;
  padding: 25px;
  color: var(--muted);
}

video {
  width: 100%;
  max-height: 600px;
  background: #111;
  border-radius: 13px;
}

.feed-card {
  padding: 0;
  overflow: hidden;
}

.feed-head,
.feed-actions,
.feed-body {
  padding: 15px;
}

.feed-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}

.feed-video {
  display: block;
  width: 100%;
  max-height: 70vh;
  aspect-ratio: 9/14;
  object-fit: contain;
  background: #101010;
  border-radius: 0;
}

.feed-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--line);
}

.tiny {
  font-size: 12px;
}

.comment {
  padding: 9px 0;
  border-bottom: 1px solid #edf3ee;
}

.pill {
  display: inline-block;
  background: var(--pale);
  color: var(--deep);
  padding: 5px 9px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 700;
}

.feed-compose {
  border: 2px dashed #b9dec6;
}

.gift-form {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
}

.gift-form select {
  width: auto;
  flex: 1;
  min-width: 140px;
}

.gift-form button {
  white-space: nowrap;
}

@media(max-width:520px) {
  nav {
    gap: 9px;
  }

  nav a {
    font-size: 12px;
  }

  .feed-head {
    align-items: flex-start;
  }

  .feed-video {
    max-height: 62vh;
  }
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

<footer>
  MOONET © ${new Date().getFullYear()} · Create · Like · Comment · Connect
</footer>
</body>
</html>`;
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
      page(
        'Security Check',
        '<div class="card">Security check failed. Reload the page and try again.</div>'
      )
    );
  }

  next();
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.urlencoded({
  extended: false,
  limit: '20kb'
}));

app.use(express.json({
  limit: '20kb'
}));

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

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: APP_NAME
  });
});

app.get('/', (req, res) => {
  res.send(page('Home', `
    <section class="hero">
      <div style="font-size:54px">🌙💚</div>
      <h1>Welcome to MOONET</h1>
      <p class="muted">
        Your green social video community. Post videos, collect likes,
        comment, follow creators and send MOON gifts.
      </p>
      <p>
        <span class="pill">
          1 MOON = ${MOON_VALUE_RWF} RWF indicative value
        </span>
      </p>
      <a class="button" href="/signup">Create Account</a>
      <a class="button secondary" href="/login">Login</a>
    </section>

    <section class="grid">
      <div class="card">
        <h3>🎬 Video Feed</h3>
        <p class="muted">Discover creators and videos from the community.</p>
      </div>

      <div class="card">
        <h3>💚 Likes & Comments</h3>
        <p class="muted">Show support and share your thoughts.</p>
      </div>

      <div class="card">
        <h3>🌙 MOON Wallet</h3>
        <p class="muted">
          Keep gifts and other MOONS separate from your like count.
        </p>
      </div>
    </section>

    <p class="muted">
      Likes are popularity counts and do not automatically create MOONS.
      Gift MOONS are transferred from a sender's balance.
      Withdrawals require review and available funding.
    </p>
  `));
});

app.get('/signup', (req, res) => {
  res.send(page('Sign Up', `
    <div class="card">
      <h1>Create your MOONET account</h1>

      <form class="stack" method="post" action="/signup">
        ${csrfField(req)}

        <label>
          Full name
          <input name="name" required minlength="2" maxlength="60">
        </label>

        <label>
          Email
          <input name="email" type="email" required maxlength="254">
        </label>

        <label>
          Password
          <input name="password" type="password" required minlength="10" maxlength="128">
        </label>

        <label>
          Referral code (optional)
          <input name="referral" maxlength="30">
        </label>

        <button>Create Account</button>
      </form>

      <p class="muted">
        Already registered? <a href="/login">Login</a>
      </p>
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
      name,
      email,
      hash,
      code,
      by
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

app.get('/login', (req, res) => {
  res.send(page('Login', `
    <div class="card">
      <h1>Login to MOONET</h1>

      <form class="stack" method="post" action="/login">
        ${csrfField(req)}

        <label>
          Email
          <input name="email" type="email" required>
        </label>

        <label>
          Password
          <input name="password" type="password" required>
        </label>

        <button>Login</button>
      </form>

      <p class="muted">
        New? <a href="/signup">Create an account</a>
      </p>
    </div>
  `));
});

app.post('/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const u = get(
    'SELECT id,password_hash,suspended FROM users WHERE email=?',
    email
  );

  if (
    !u ||
    u.suspended ||
    !(await bcrypt.compare(password, u.password_hash))
  ) {
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

app.get('/app', requireUser, (req, res) => {
  res.send(page('Home', `
    <section class="hero">
      <h1>Hello, ${esc(req.user.name)} 💚</h1>
      <p class="muted">Your MOONET community dashboard</p>

      <div class="number">${fmt(req.user.moon)} MOONS</div>

      <p class="muted">
        Indicative value: ${fmt(req.user.moon * MOON_VALUE_RWF)} RWF
      </p>

      <a class="button" href="/videos">Open Video Feed</a>
      <a class="button secondary" href="/wallet">Wallet</a>
    </section>

    <section class="grid">
      <div class="card">
        <h3>🎬 Feed</h3>
        <p>Post a video, like and comment.</p>
        <a href="/videos">Open Feed →</a>
      </div>

      <div class="card">
        <h3>🌙 Wallet</h3>
        <p>${fmt(req.user.moon)} MOONS</p>
        <a href="/wallet">Open Wallet →</a>
      </div>

      <div class="card">
        <h3>👤 Profile</h3>
        <p>${esc(req.user.email)}</p>
        <a href="/profile">View Profile →</a>
      </div>
    </section>
  `, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/profile', requireUser, (req, res) => {
  const followers = get(
    'SELECT COUNT(*) n FROM follows WHERE following_id=?',
    req.user.id
  ).n;

  const following = get(
    'SELECT COUNT(*) n FROM follows WHERE follower_id=?',
    req.user.id
  ).n;

  const joined = get(
    'SELECT created_at FROM users WHERE id=?',
    req.user.id
  ).created_at;

  res.send(page('Profile', `
    <div class="card">
      <h1>Your Profile</h1>

      <p><b>Name:</b> ${esc(req.user.name)}</p>
      <p><b>Email:</b> ${esc(req.user.email)}</p>

      <p>
        <b>Referral code:</b>
        <span class="pill">${esc(req.user.referral_code)}</span>
      </p>

      <p>
        <b>Followers:</b> ${fmt(followers)}
        ·
        <b>Following:</b> ${fmt(following)}
      </p>

      <p class="muted">Referral rewards are not enabled yet.</p>
      <p><b>Joined:</b> ${esc(joined)}</p>
    </div>
  `, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/wallet', requireUser, (req, res) => {
  res.send(page('Wallet', `
    <div class="card">
      <h1>🌙 MOON Wallet</h1>

      <div class="number">${fmt(req.user.moon)} MOONS</div>

      <p>
        Indicative value:
        ${fmt(req.user.moon * MOON_VALUE_RWF)} RWF
      </p>

      <p class="muted">
        1 MOON = ${MOON_VALUE_RWF} RWF for display purposes only;
        this does not guarantee cash redemption.
      </p>

      <a class="button" href="/withdraw">Request Withdrawal</a>
    </div>

    <div class="card">
      <h3>Withdrawal requirements</h3>

      <p>
        Minimum request:
        ${fmt(MIN_WITHDRAWAL_MOON)} MOONS
        (${fmt(MIN_WITHDRAWAL_MOON * MOON_VALUE_RWF)} RWF).
      </p>

      <p class="muted">
        Requests require review, available funds and payment-provider approval.
      </p>
    </div>
  `, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.get('/transactions', requireUser, (req, res) => {
  const rows = all(
    'SELECT type,moon,description,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100',
    req.user.id
  ).map(t => `
    <tr>
      <td>${esc(t.type)}</td>
      <td>${fmt(t.moon)}</td>
      <td>${esc(t.description)}</td>
      <td>${esc(t.created_at)}</td>
    </tr>
  `).join('');

  res.send(page('History', `
    <div class="card">
      <h1>Transaction History</h1>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>MOONS</th>
              <th>Description</th>
              <th>Date</th>
            </tr>
          </thead>

          <tbody>
            ${rows || '<tr><td colspan="4">No transactions yet.</td></tr>'}
          </tbody>
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
    SELECT
      v.id,
      v.user_id,
      v.title,
      v.video_url,
      v.created_at,
      u.name,

      (SELECT COUNT(*)
       FROM video_likes l
       WHERE l.video_id=v.id) like_count,

      (SELECT COUNT(*)
       FROM video_comments c
       WHERE c.video_id=v.id) comment_count,

      (SELECT COUNT(*)
       FROM video_likes l
       WHERE l.video_id=v.id AND l.user_id=?) liked,

      (SELECT COUNT(*)
       FROM follows f
       WHERE f.follower_id=? AND f.following_id=v.user_id) following

    FROM videos v
    JOIN users u ON u.id=v.user_id
    ORDER BY v.id DESC
    LIMIT 50
  `, req.user.id, req.user.id);

  const cards = videos.map(v => {
    const comments = all(`
      SELECT c.comment,c.created_at,u.name
      FROM video_comments c
      JOIN users u ON u.id=c.user_id
      WHERE c.video_id=?
      ORDER BY c.id DESC
      LIMIT 10
    `, v.id).map(c => `
      <div class="comment">
        <b>${esc(c.name)}</b>
        ${esc(c.comment)}
        <div class="muted tiny">${esc(c.created_at)}</div>
      </div>
    `).join('');

    const owner = v.user_id === req.user.id;

    const gifted = get(
      'SELECT COALESCE(SUM(moon),0) n FROM gifts WHERE video_id=?',
      v.id
    ).n;

    return `
      <article class="card feed-card">

        <div class="feed-head">
          <div>
            <b>${esc(v.name)}</b>
            <div class="muted tiny">${esc(v.created_at)}</div>
          </div>

          ${
            owner
              ? '<span class="pill">Your post</span>'
              : `
                <form method="post" action="/follow/${v.user_id}">
                  ${csrfField(req)}
                  <button class="secondary" type="submit">
                    ${v.following ? 'Following ✓' : '＋ Follow'}
                  </button>
                </form>
              `
          }
        </div>

        <video
          class="feed-video"
          controls
          playsinline
          preload="metadata"
          src="${esc(v.video_url)}"
        ></video>

        <div class="feed-body">
          <h3>${esc(v.title)}</h3>
        </div>

        <div class="feed-actions">

          <form method="post" action="/videos/${v.id}/like">
            ${csrfField(req)}
            <button class="${v.liked ? '' : 'secondary'}" type="submit">
              ${v.liked ? '💚 Liked' : '🤍 Like'} · ${fmt(v.like_count)}
            </button>
          </form>

          <span class="pill">
            💬 ${fmt(v.comment_count)} comments
          </span>

          <span class="pill">
            🌙 ${fmt(gifted)} gifted MOONS
          </span>

        </div>

        <div class="feed-body">

          <form
            class="stack"
            method="post"
            action="/videos/${v.id}/comments"
          >
            ${csrfField(req)}

            <label>
              Write a comment
              <textarea
                name="comment"
                required
                maxlength="500"
                rows="2"
                placeholder="Write your thoughts..."
              ></textarea>
            </label>

            <button type="submit">Post Comment</button>
          </form>

          <div style="margin-top:12px">
            ${comments || '<p class="muted">No comments yet. Be the first!</p>'}
          </div>

          <form
            class="gift-form"
            method="post"
            action="/videos/${v.id}/gift"
            style="margin-top:14px"
          >
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

      <p class="muted">
        Post a direct HTTPS video link.
        File upload is not enabled in this version.
        Likes show popularity; they do not automatically add MOONS.
        MOON gifts transfer MOONS from your wallet to the creator.
      </p>

      <form class="stack" method="post" action="/videos">
        ${csrfField(req)}

        <label>
          Video caption/title
          <input
            name="title"
            required
            maxlength="120"
            placeholder="What do you want to share?"
          >
        </label>

        <label>
          Direct video URL (HTTPS)
          <input
            name="video_url"
            type="url"
            required
            maxlength="1000"
            placeholder="https://example.com/video.mp4"
          >
        </label>

        <button>＋ Publish Video</button>
      </form>
    </div>

    ${cards || `
      <div class="card">
        <h3>No videos yet</h3>
        <p class="muted">Be the first to publish a video.</p>
      </div>
    `}
  `;

  res.send(page('Video Feed', content, {
    ...req.user,
    _csrf: req.session.csrfToken
  }));
});

app.post('/videos', requireUser, validateCsrf, (req, res) => {
  const title = String(req.body.title || '').trim();
  const videoUrl = String(req.body.video_url || '').trim();

  let u;

  try {
    u = new URL(videoUrl);
  } catch {
    return res.status(400).send(page('Video', `
      <div class="card">
        ${msg('Invalid video URL.', 'error')}
        <a href="/videos">Back</a>
      </div>
    `, {
      ...req.user,
      _csrf: req.session.csrfToken
    }));
  }

  if (
    !title ||
    title.length > 120 ||
    u.protocol !== 'https:' ||
    !u.hostname ||
    videoUrl.length > 1000
  ) {
    return res.status(400).send(
      'Please provide a valid title and HTTPS video URL.'
    );
  }

  run(
    'INSERT INTO videos(user_id,title,video_url) VALUES(?,?,?)',
    req.user.id,
    title,
    videoUrl
  );

  res.redirect('/videos');
});

app.post('/videos/:id/like', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);

  if (
    !Number.isSafeInteger(id) ||
    !get('SELECT id FROM videos WHERE id=?', id)
  ) {
    return res.status(404).send('Video not found.');
  }

  const existing = get(
    'SELECT id FROM video_likes WHERE video_id=? AND user_id=?',
    id,
    req.user.id
  );

  if (existing) {
    run(
      'DELETE FROM video_likes WHERE video_id=? AND user_id=?',
      id,
      req.user.id
    );
  } else {
    run(
      'INSERT INTO video_likes(video_id,user_id) VALUES(?,?)',
      id,
      req.user.id
    );
  }

  res.redirect('/videos');
});

app.post('/videos/:id/comments', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);
  const comment = String(req.body.comment || '').trim();

  if (
    !Number.isSafeInteger(id) ||
    !get('SELECT id FROM videos WHERE id=?', id)
  ) {
    return res.status(404).send('Video not found.');
  }

  if (!comment || comment.length > 500) {
    return res.status(400).send('Comment must be 1–500 characters.');
  }

  run(
    'INSERT INTO video_comments(video_id,user_id,comment) VALUES(?,?,?)',
    id,
    req.user.id,
    comment
  );

  res.redirect('/videos');
});

app.post('/follow/:id', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);

  if (
    !Number.isSafeInteger(id) ||
    id === req.user.id ||
    !get('SELECT id FROM users WHERE id=? AND suspended=0', id)
  ) {
    return res.status(400).send('Invalid creator.');
  }

  const exists = get(
    'SELECT id FROM follows WHERE follower_id=? AND following_id=?',
    req.user.id,
    id
  );

  if (exists) {
    run(
      'DELETE FROM follows WHERE follower_id=? AND following_id=?',
      req.user.id,
      id
    );
  } else {
    run(
      'INSERT INTO follows(follower_id,following_id) VALUES(?,?)',
      req.user.id,
      id
    );
  }

  res.redirect('/videos');
});

app.post('/videos/:id/gift', requireUser, validateCsrf, (req, res) => {
  const id = Number(req.params.id);
  const choice = String(req.body.gift || '');
  const parts = choice.split(':');
  const name = parts[0];
  const amount = Number(parts[1]);

  const video = get(
    'SELECT id,user_id FROM videos WHERE id=?',
    id
  );

  if (!video) {
    return res.status(404).send('Video not found.');
  }

  if (video.user_id === req.user.id) {
    return res.status(400).send('You cannot send a gift to yourself.');
  }

  const validGift = [
    ['Moon', 1],
    ['Heart', 5],
    ['Rose', 10],
    ['Diamond', 100]
  ].some(x => x[0] === name && x[1] === amount);

  if (!validGift) {
    return res.status(400).send('Invalid gift.');
  }

  try {
    const giftTx = transaction(() => {
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
        `${name} gift sent to creator of video ${id}`,
        ref()
      );

      run(
        'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
        video.user_id,
        'gift_received',
        amount,
        `${name} gift received on video ${id}`,
        ref()
      );
    });

    giftTx();
  } catch (e) {
    if (e.message === 'INSUFFICIENT') {
      return res.status(400).send(page('Gift', `
        <div class="card">
          ${msg('You do not have enough MOONS for this gift.', 'error')}
          <a href="/wallet">Open Wallet</a>
        </div>
      `, {
        ...req.user,
        _csrf: req.session.csrfToken
      }));
    }

    console.error('Gift error', e.message);
    return res.status(500).send('Could not send gift.');
  }

  res.redirect('/videos');
});

app.get('/withdraw', requireUser, (req, res) => {
  res.send(page('Withdraw', `
    <div class="card">
      <h1>Request a Withdrawal</h1>

      <p>
        Available balance:
        <b>${fmt(req.user.moon)} MOONS</b>
      </p>

      <p>
        Minimum request: ${fmt(MIN_WITHDRAWAL_MOON)} MOONS.
      </p>

      <form class="stack" method="post" action="/withdraw">
        ${csrfField(req)}

        <label>
          Amount in MOONS
          <input
            name="moon"
            type="number"
            min="${MIN_WITHDRAWAL_MOON}"
            max="${req.user.moon}"
            step="1"
            required
          >
        </label>

        <label>
          Payment method
          <select name="method" required>
            <option value="">Select method</option>
            <option>MTN MoMo</option>
            <option>Airtel Money</option>
            <option>Bank</option>
          </select>
        </label>

        <label>
          Payment account or number
          <input name="account" required minlength="5" maxlength="120">
        </label>

        <button>Submit Request</button>
      </form>

      <p class="muted">
        This creates a request for review; it does not send money automatically.
      </p>
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
      const d = run(
        'UPDATE users SET moon=moon-? WHERE id=? AND moon>=?',
        moon,
        req.user.id,
        moon
      );

      if (Number(d.changes) !== 1) {
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

    const freshUser = get(
      'SELECT id,name,email,moon,referral_code,suspended FROM users WHERE id=?',
      req.user.id
    );

    res.send(page('Withdrawal Submitted', `
      <div class="card">
        ${msg('Your withdrawal request has been submitted for review.', 'success')}
        <a href="/wallet">Return to wallet</a>
      </div>
    `, {
      ...freshUser,
      _csrf: req.session.csrfToken
    }));
  } catch (e) {
    if (e.message === 'INSUFFICIENT') {
      return res.status(400).send('Insufficient MOONS balance.');
    }

    console.error(e.message);
    res.status(500).send('Could not submit withdrawal request.');
  }
});

app.get('/admin/login', (req, res) => {
  res.send(page('Admin Login', `
    <div class="card">
      <h1>MOONET Admin Login</h1>

      <form class="stack" method="post" action="/admin/login">
        ${csrfField(req)}

        <label>
          Email
          <input name="email" type="email" required>
        </label>

        <label>
          Password
          <input name="password" type="password" required>
        </label>

        <button>Admin Login</button>
      </form>
    </div>
  `));
});

app.post('/admin/login', validateCsrf, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const eb = Buffer.from(email.padEnd(254, '\0').slice(0, 254));
  const ab = Buffer.from(ADMIN_EMAIL.padEnd(254, '\0').slice(0, 254));

  const validEmail = crypto.timingSafeEqual(eb, ab);

  const pb = Buffer.from(password);
  const abp = Buffer.from(ADMIN_PASSWORD);

  const validPassword =
    pb.length === abp.length &&
    crypto.timingSafeEqual(pb, abp);

  if (!validEmail || !validPassword) {
    return res.status(401).send(page('Admin Login', `
      <div class="card">
        ${msg('Invalid admin credentials.', 'error')}
        <a href="/admin/login">Try again</a>
      </div>
    `));
  }

  req.session.regenerate(err => {
    if (err) {
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
    get('SELECT COUNT(*) total FROM users').total
  );

  const outstanding = Number(
    get('SELECT COALESCE(SUM(moon),0) total FROM users').total
  );

  const revenue = Number(
    get('SELECT COALESCE(SUM(amount_rwf),0) total FROM revenue').total
  );

  const expenses = Number(
    get('SELECT COALESCE(SUM(amount_rwf),0) total FROM expenses').total
  );

  const paid = Number(
    get("SELECT COALESCE(SUM(amount_rwf),0) total FROM withdrawals WHERE status='paid'").total
  );

  const pending = Number(
    get("SELECT COALESCE(SUM(amount_rwf),0) total FROM withdrawals WHERE status='pending'").total
  );

  const profit = revenue - expenses - paid;

  const rows = all(`
    SELECT w.*,u.name,u.email
    FROM withdrawals w
    JOIN users u ON u.id=w.user_id
    ORDER BY w.id DESC
    LIMIT 100
  `).map(w => `
    <tr>
      <td>${w.id}</td>

      <td>
        ${esc(w.name)}<br>
        ${esc(w.email)}
      </td>

      <td>${fmt(w.moon)}</td>
      <td>${fmt(w.amount_rwf)} RWF</td>

      <td>
        ${esc(w.payment_method)}<br>
        ${esc(w.payment_account)}
      </td>

      <td>${esc(w.status)}</td>

      <td>
        ${
          w.status === 'pending'
            ? `
              <form method="post" action="/admin/withdrawals/${w.id}/paid">
                ${csrfField(req)}
                <button>Mark Paid</button>
              </form>

              <form method="post" action="/admin/withdrawals/${w.id}/reject">
                ${csrfField(req)}
                <button class="danger">Reject</button>
              </form>
            `
            : ''
        }
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

        <label>
          Amount (RWF)
          <input name="amount" type="number" min="1" required>
        </label>

        <label>
          Source
          <input name="source" maxlength="150" required>
        </label>

        <button>Record Revenue</button>
      </form>

      <p class="muted">
        Only record money actually received and verifiable.
      </p>
    </div>

    <div class="card">
      <h2>Record Expense</h2>

      <form class="stack" method="post" action="/admin/expenses">
        ${csrfField(req)}

        <label>
          Amount (RWF)
          <input name="amount" type="number" min="1" required>
        </label>

        <label>
          Description
          <input name="description" maxlength="200" required>
        </label>

        <button>Record Expense</button>
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
              <th>Payment details</th>
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
  const w = get('SELECT * FROM withdrawals WHERE id=?', id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).send('Invalid withdrawal ID.');
  }

  if (!w || w.status !== 'pending') {
    return res.status(409).send('Withdrawal is not pending.');
  }

  transaction(() => {
    const u = run(
      "UPDATE withdrawals SET status='paid' WHERE id=? AND status='pending'",
      id
    );

    if (Number(u.changes) !== 1) {
      throw new Error('NOT_PENDING');
    }

    run(
      'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
      w.user_id,
      'withdrawal_paid',
      0,
      `Withdrawal ${id} marked paid (${w.amount_rwf} RWF)`,
      ref()
    );
  })();

  res.redirect('/admin');
});

app.post('/admin/withdrawals/:id/reject', requireAdmin, validateCsrf, (req, res) => {
  const id = Number(req.params.id);
  const w = get('SELECT * FROM withdrawals WHERE id=?', id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).send('Invalid withdrawal ID.');
  }

  if (!w || w.status !== 'pending') {
    return res.status(409).send('Withdrawal is not pending.');
  }

  transaction(() => {
    const u = run(
      "UPDATE withdrawals SET status='rejected' WHERE id=? AND status='pending'",
      id
    );

    if (Number(u.changes) !== 1) {
      throw new Error('NOT_PENDING');
    }

    run(
      'UPDATE users SET moon=moon+? WHERE id=?',
      w.moon,
      w.user_id
    );

    run(
      'INSERT INTO transactions(user_id,type,moon,description,reference) VALUES(?,?,?,?,?)',
      w.user_id,
      'withdrawal_refund',
      w.moon,
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

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  if (res.headersSent) return next(err);

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
