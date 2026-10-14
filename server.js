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
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
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
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

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
    moon INTEGER NOT NULL CHECK(moon > 0),
    amount_rwf INTEGER NOT NULL CHECK(amount_rwf > 0),
    payment_method TEXT NOT NULL,
    payment_account TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS revenue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_rwf INTEGER NOT NULL CHECK(amount_rwf >= 0),
    source TEXT NOT NULL,
    reference TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_rwf INTEGER NOT NULL CHECK(amount_rwf >= 0),
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
`);

const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function createReferralCode() {
  return 'MOON' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function makeReference() {
  return crypto.randomUUID();
}

function page(title, content, user = null) {
  const nav = user
    ? `
      <a href="/app">Home</a>
      <a href="/videos">Videos</a>
      <a href="/wallet">Wallet</a>
      <a href="/transactions">History</a>
      <a href="/profile">Profile</a>
      <form action="/logout" method="post" class="inline">
        <button class="secondary" type="submit">Logout</button>
      </form>
    `
    : `
      <a href="/">Home</a>
      <a href="/login">Login</a>
      <a href="/signup">Sign Up</a>
    `;

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#090b1c">
    <title>${escapeHtml(title)} | MOONET</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #090b1c;
        color: #f8fafc;
        font-family: Arial, sans-serif;
      }
      header {
        background: #111633;
        padding: 16px;
        border-bottom: 1px solid #29345f;
      }
      .top {
        max-width: 1000px;
        margin: auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .brand {
        font-size: 26px;
        font-weight: bold;
        color: #c4b5fd;
        text-decoration: none;
      }
      nav {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      a { color: #c4b5fd; text-decoration: none; }
      nav a { font-size: 14px; }
      main {
        width: min(94%, 900px);
        margin: 28px auto;
        min-height: 65vh;
      }
      .hero, .card {
        background: #111633;
        border: 1px solid #29345f;
        padding: 22px;
        border-radius: 16px;
        margin-bottom: 18px;
      }
      .hero { text-align: center; padding: 40px 20px; }
      h1, h2, h3 { margin-top: 0; }
      .muted { color: #aeb8d4; line-height: 1.6; }
      .gold { color: #facc15; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
      }
      .number { font-size: 28px; font-weight: bold; margin: 10px 0; }
      .button, button {
        display: inline-block;
        background: #7c3aed;
        color: white;
        border: 0;
        border-radius: 9px;
        padding: 12px 17px;
        font-weight: bold;
        cursor: pointer;
        font-size: 14px;
      }
      .secondary { background: #303858; }
      .danger { background: #b91c1c; }
      .inline { display: inline; }
      form.stack { display: grid; gap: 13px; }
      input, select {
        width: 100%;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #465078;
        background: #090b1c;
        color: white;
      }
      label { display: grid; gap: 7px; color: #cbd5e1; }
      .message {
        padding: 12px;
        border-radius: 8px;
        background: #20294b;
        margin-bottom: 15px;
      }
      .error { color: #fecaca; }
      .success { color: #bbf7d0; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; }
      th, td {
        text-align: left;
        padding: 10px;
        border-bottom: 1px solid #303858;
        font-size: 13px;
      }
      footer { text-align: center; padding: 25px; color: #94a3b8; }
      video {
        width: 100%;
        max-height: 550px;
        background: #000;
        border-radius: 12px;
      }
      @media(max-width: 500px) {
        nav { gap: 9px; }
        nav a { font-size: 12px; }
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
    <footer>MOONET &copy; ${new Date().getFullYear()} | Watch. Create. Connect.</footer>
  </body>
  </html>`;
}

function messageBox(message, type = '') {
  return `<div class="message ${type}">${escapeHtml(message)}</div>`;
}

function requireUser(req, res, next) {
  const userId = req.session.userId;

  if (!userId) {
    return res.redirect('/login');
  }

  const user = get(
    'SELECT id, name, email, moon, referral_code, suspended FROM users WHERE id = ?',
    userId
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

function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfField(req) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrfToken || '')}">`;
}

function validateCsrf(req, res, next) {
  const submitted = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;

  if (!submitted || !expected ||
      !crypto.timingSafeEqual(
        Buffer.from(String(submitted)),
        Buffer.from(String(expected))
      )) {
    return res.status(403).send(
      page('Security Check', '<div class="card">Security check failed. Please go back, reload the page, and try again.</div>')
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
    maxAge: 1000 * 60 * 60 * 24
  }
}));

app.use(csrfMiddleware);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: APP_NAME });
});

app.get('/', (req, res) => {
  const content = `
    <section class="hero">
      <div style="font-size:58px">🌙</div>
      <h1>Welcome to MOONET</h1>
      <p class="muted">Discover short videos, share your creativity, and connect with people.</p>
      <p class="gold"><strong>1 MOON = ${MOON_VALUE_RWF} RWF</strong></p>
      <a class="button" href="/signup">Create Account</a>
      <a class="button secondary" href="/login">Login</a>
    </section>
    <section class="grid">
      <div class="card"><h3>🎬 Short Videos</h3><p class="muted">Discover videos shared by the community.</p></div>
      <div class="card"><h3>🌙 MOON Wallet</h3><p class="muted">See your points and transaction history.</p></div>
      <div class="card"><h3>🤝 Community</h3><p class="muted">Create a profile and share your interests.</p></div>
    </section>
    <p class="muted">Rewards are subject to eligibility, available funding, and the platform rules. MOON points are not cash until an eligible withdrawal has been approved and paid.</p>
  `;

  res.send(page('Home', content));
});

app.get('/signup', (req, res) => {
  const content = `
    <div class="card">
      <h1>Create your MOONET account</h1>
      <p class="muted">Join the community.</p>
      <form class="stack" method="post" action="/signup">
        ${csrfField(req)}
        <label>Full name
          <input name="name" required minlength="2" maxlength="60" autocomplete="name">
        </label>
        <label>Email
          <input name="email" type="email" required maxlength="254" autocomplete="email">
        </label>
        <label>Password
          <input name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password">
        </label>
        <label>Referral code (optional)
          <input name="referral" maxlength="30">
        </label>
        <button type="submit">Create Account</button>
      </form>
      <p class="muted">Already registered? <a href="/login">Login here</a>.</p>
    </div>
  `;

  res.send(page('Sign Up', content));
});

app.post('/signup', validateCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (name.length < 2 || name.length > 60 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      password.length < 10 || password.length > 128) {
    return res.status(400).send(page(
      'Sign Up',
      `<div class="card">${messageBox('Please check your name, email, and password length.', 'error')}<a href="/signup">Try again</a></div>`
    ));
  }

  if (get('SELECT id FROM users WHERE email = ?', email)) {
    return res.status(409).send(page(
      'Sign Up',
      `<div class="card">${messageBox('Email already registered. Please login.', 'error')}<a href="/login">Login</a></div>`
    ));
  }

  let referredBy = null;

  if (referral) {
    const referrer = get('SELECT id FROM users WHERE referral_code = ?', referral);
    if (referrer) referredBy = referrer.id;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let referralCode = createReferralCode();

  while (get('SELECT id FROM users WHERE referral_code = ?', referralCode)) {
    referralCode = createReferralCode();
  }

  try {
    const result = run(
      `INSERT INTO users (name, email, password_hash, referral_code, referred_by)
       VALUES (?, ?, ?, ?, ?)`,
      name,
      email,
      passwordHash,
      referralCode,
      referredBy
    );

    const userId = Number(result.lastInsertRowid);

    req.session.regenerate(err => {
      if (err) return res.status(500).send('Could not create session.');

      req.session.userId = userId;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.redirect('/app');
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).send(page(
        'Sign Up',
        `<div class="card">${messageBox('Email already registered. Please login.', 'error')}<a href="/login">Login</a></div>`
      ));
    }

    console.error('Signup error:', error.message);
    res.status(500).send('Could not create account. Please try again.');
  }
});

app.get('/login', (req, res) => {
  const content = `
    <div class="card">
      <h1>Login to MOONET</h1>
      <form class="stack" method="post" action="/login">
        ${csrfField(req)}
        <label>Email
          <input name="email" type="email" required autocomplete="email">
        </label>
        <label>Password
          <input name="password" type="password" required autocomplete="current-password">
        </label>
        <button type="submit">Login</button>
      </form>
      <p class="muted">New to MOONET? <a href="/signup">Create an account</a>.</p>
    </div>
  `;

  res.send(page('Login', content));
});

app.post('/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = get(
    'SELECT id, password_hash, suspended FROM users WHERE email = ?',
    email
  );

  if (!user || user.suspended || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).send(page(
      'Login',
      `<div class="card">${messageBox('Invalid email or password.', 'error')}<a href="/login">Try again</a></div>`
    ));
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).send('Could not create session.');

    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.redirect('/app');
  });
});

app.post('/logout', requireUser, validateCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/app', requireUser, (req, res) => {
  const user = req.user;
  const valueRwf = user.moon * MOON_VALUE_RWF;

  const content = `
    <section class="hero">
      <h1>Hello, ${escapeHtml(user.name)} 🌙</h1>
      <p class="muted">Welcome to your MOONET dashboard.</p>
      <p class="gold">Your MOON balance</p>
      <div class="number">${formatMoney(user.moon)} MOON</div>
      <p class="muted">Indicative value: ${formatMoney(valueRwf)} RWF</p>
      <a class="button" href="/wallet">Open Wallet</a>
      <a class="button secondary" href="/videos">Explore Videos</a>
    </section>
    <section class="grid">
      <div class="card"><h3>🌙 Wallet</h3><p>Balance: ${formatMoney(user.moon)} MOON</p><a href="/wallet">View wallet →</a></div>
      <div class="card"><h3>🎬 Videos</h3><p class="muted">Explore videos shared by the community.</p><a href="/videos">View videos →</a></div>
      <div class="card"><h3>👤 Profile</h3><p class="muted">Your account information.</p><a href="/profile">View profile →</a></div>
    </section>
  `;

  res.send(page('Dashboard', content, user));
});

app.get('/profile', requireUser, (req, res) => {
  const user = req.user;

  const content = `
    <div class="card">
      <h1>Your Profile</h1>
      <p><strong>Name:</strong> ${escapeHtml(user.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(user.email)}</p>
      <p><strong>Referral code:</strong> <span class="gold">${escapeHtml(user.referral_code)}</span></p>
      <p class="muted">Share your referral code with friends. Referral rewards are not enabled yet.</p>
      <p><strong>Joined:</strong> ${escapeHtml(get('SELECT created_at FROM users WHERE id = ?', user.id).created_at)}</p>
    </div>
  `;

  res.send(page('Profile', content, user));
});

app.get('/wallet', requireUser, (req, res) => {
  const user = req.user;

  const content = `
    <div class="card">
      <h1>🌙 MOON Wallet</h1>
      <div class="number gold">${formatMoney(user.moon)} MOON</div>
      <p>Indicative value: ${formatMoney(user.moon * MOON_VALUE_RWF)} RWF</p>
      <p class="muted">1 MOON = ${MOON_VALUE_RWF} RWF for display purposes. This does not guarantee cash redemption.</p>
      <a class="button" href="/withdraw">Request Withdrawal</a>
    </div>
    <div class="card">
      <h3>Withdrawal requirements</h3>
      <p>Minimum request: ${formatMoney(MIN_WITHDRAWAL_MOON)} MOON (${formatMoney(MIN_WITHDRAWAL_MOON * MOON_VALUE_RWF)} RWF).</p>
      <p class="muted">Withdrawals are subject to review, available funds, and payment-provider approval.</p>
    </div>
  `;

  res.send(page('Wallet', content, user));
});

app.get('/transactions', requireUser, (req, res) => {
  const transactions = all(
    `SELECT type, moon, description, created_at
     FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
    req.user.id
  );

  const rows = transactions.map(item => `
    <tr>
      <td>${escapeHtml(item.type)}</td>
      <td>${formatMoney(item.moon)}</td>
      <td>${escapeHtml(item.description)}</td>
      <td>${escapeHtml(item.created_at)}</td>
    </tr>
  `).join('');

  const content = `
    <div class="card">
      <h1>Transaction History</h1>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Type</th><th>MOON</th><th>Description</th><th>Date</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">No transactions yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;

  res.send(page('Transactions', content, req.user));
});

app.get('/videos', requireUser, (req, res) => {
  const videos = all(
    `SELECT videos.id, videos.title, videos.video_url, videos.created_at, users.name
     FROM videos JOIN users ON users.id = videos.user_id
     ORDER BY videos.id DESC LIMIT 50`
  );

  const videoCards = videos.map(video => `
    <div class="card">
      <h3>${escapeHtml(video.title)}</h3>
      <p class="muted">By ${escapeHtml(video.name)}</p>
      <video controls preload="metadata" src="${escapeHtml(video.video_url)}"></video>
      <p class="muted">${escapeHtml(video.created_at)}</p>
    </div>
  `).join('');

  const content = `
    <div class="card">
      <h1>🎬 MOONET Videos</h1>
      <p class="muted">Share a direct video URL. Uploading video files is not enabled in this initial version.</p>
      <form class="stack" method="post" action="/videos">
        ${csrfField(req)}
        <label>Video title
          <input name="title" required maxlength="120">
        </label>
        <label>Direct video URL (HTTPS)
          <input name="video_url" type="url" required maxlength="1000" placeholder="https://example.com/video.mp4">
        </label>
        <button type="submit">Add Video</button>
      </form>
    </div>
    ${videoCards || '<div class="card">No videos yet. Be the first to add one.</div>'}
  `;

  res.send(page('Videos', content, req.user));
});

app.post('/videos', requireUser, validateCsrf, (req, res) => {
  const title = String(req.body.title || '').trim();
  const videoUrl = String(req.body.video_url || '').trim();

  let parsedUrl;

  try {
    parsedUrl = new URL(videoUrl);
  } catch {
    return res.status(400).send('Invalid video URL.');
  }

  if (
    title.length < 1 ||
    title.length > 120 ||
    parsedUrl.protocol !== 'https:' ||
    !parsedUrl.hostname ||
    videoUrl.length > 1000
  ) {
    return res.status(400).send('Please provide a valid title and HTTPS video URL.');
  }

  run(
    'INSERT INTO videos (user_id, title, video_url) VALUES (?, ?, ?)',
    req.user.id,
    title,
    videoUrl
  );

  res.redirect('/videos');
});

app.get('/withdraw', requireUser, (req, res) => {
  const user = req.user;

  const content = `
    <div class="card">
      <h1>Request a Withdrawal</h1>
      <p>Available balance: <strong>${formatMoney(user.moon)} MOON</strong></p>
      <p>Minimum request: ${formatMoney(MIN_WITHDRAWAL_MOON)} MOON.</p>
      <form class="stack" method="post" action="/withdraw">
        ${csrfField(req)}
        <label>Amount in MOON
          <input name="moon" type="number" min="${MIN_WITHDRAWAL_MOON}" max="${user.moon}" step="1" required>
        </label>
        <label>Payment method
          <select name="method" required>
            <option value="">Select method</option>
            <option value="MTN MoMo">MTN Mobile Money</option>
            <option value="Airtel Money">Airtel Money</option>
            <option value="Bank">Bank transfer</option>
          </select>
        </label>
        <label>Payment account or number
          <input name="account" required minlength="5" maxlength="120">
        </label>
        <button type="submit">Submit Request</button>
      </form>
      <p class="muted">This creates a request for review. It does not send money automatically.</p>
    </div>
  `;

  res.send(page('Withdraw', content, user));
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
    return res.status(400).send(page(
      'Withdraw',
      `<div class="card">${messageBox('Invalid withdrawal request. Check your balance and details.', 'error')}<a href="/withdraw">Try again</a></div>`,
      req.user
    ));
  }

  const amountRwf = moon * MOON_VALUE_RWF;

  const submitWithdrawal = db.transaction(() => {
    const result = run(
      'UPDATE users SET moon = moon - ? WHERE id = ? AND moon >= ?',
      moon,
      req.user.id,
      moon
    );

    if (Number(result.changes) !== 1) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    run(
      `INSERT INTO withdrawals (user_id, moon, amount_rwf, payment_method, payment_account)
       VALUES (?, ?, ?, ?, ?)`,
      req.user.id,
      moon,
      amountRwf,
      method,
      account
    );

    run(
      `INSERT INTO transactions (user_id, type, moon, description, reference)
       VALUES (?, 'withdrawal_pending', ?, ?, ?)`,
      req.user.id,
      -moon,
      `Withdrawal request pending review (${amountRwf} RWF)`,
      makeReference()
    );
  });

  try {
    submitWithdrawal();
    res.send(page(
      'Withdrawal Submitted',
      `<div class="card">${messageBox('Your withdrawal request has been submitted for review.', 'success')}<a href="/wallet">Return to wallet</a></div>`,
      get('SELECT id, name, email, moon, referral_code, suspended FROM users WHERE id = ?', req.user.id)
    ));
  } catch (error) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).send('Insufficient MOON balance.');
    }
    console.error('Withdrawal request error:', error.message);
    res.status(500).send('Could not submit withdrawal request.');
  }
});

app.get('/admin/login', (req, res) => {
  const content = `
    <div class="card">
      <h1>MOONET Admin Login</h1>
      <form class="stack" method="post" action="/admin/login">
        ${csrfField(req)}
        <label>Email
          <input name="email" type="email" required autocomplete="username">
        </label>
        <label>Password
          <input name="password" type="password" required autocomplete="current-password">
        </label>
        <button type="submit">Admin Login</button>
      </form>
    </div>
  `;

  res.send(page('Admin Login', content));
});

app.post('/admin/login', validateCsrf, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const validEmail = crypto.timingSafeEqual(
    Buffer.from(email.padEnd(254, '\0').slice(0, 254)),
    Buffer.from(ADMIN_EMAIL.padEnd(254, '\0').slice(0, 254))
  );

  const validPassword = password.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(ADMIN_PASSWORD)
    );

  if (!validEmail || !validPassword) {
    return res.status(401).send(page(
      'Admin Login',
      `<div class="card">${messageBox('Invalid admin credentials.', 'error')}<a href="/admin/login">Try again</a></div>`
    ));
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).send('Could not create admin session.');

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
  const moonOutstanding = Number(get('SELECT COALESCE(SUM(moon), 0) AS total FROM users').total);
  const revenue = Number(get('SELECT COALESCE(SUM(amount_rwf), 0) AS total FROM revenue').total);
  const expenses = Number(get('SELECT COALESCE(SUM(amount_rwf), 0) AS total FROM expenses').total);
  const paidWithdrawals = Number(get("SELECT COALESCE(SUM(amount_rwf), 0) AS total FROM withdrawals WHERE status = 'paid'").total);
  const pendingWithdrawals = Number(get("SELECT COALESCE(SUM(amount_rwf), 0) AS total FROM withdrawals WHERE status = 'pending'").total);
  const netProfit = revenue - expenses - paidWithdrawals;

  const withdrawalRows = all(
    `SELECT w.id, u.name, u.email, w.moon, w.amount_rwf, w.payment_method,
            w.payment_account, w.status, w.created_at
     FROM withdrawals w JOIN users u ON u.id = w.user_id
     ORDER BY w.id DESC LIMIT 100`
  ).map(w => `
    <tr>
      <td>${w.id}</td>
      <td>${escapeHtml(w.name)}<br>${escapeHtml(w.email)}</td>
      <td>${formatMoney(w.moon)} MOON</td>
      <td>${formatMoney(w.amount_rwf)} RWF</td>
      <td>${escapeHtml(w.payment_method)}<br>${escapeHtml(w.payment_account)}</td>
      <td>${escapeHtml(w.status)}</td>
      <td>
        ${w.status === 'pending' ? `
          <form class="stack" method="post" action="/admin/withdrawals/${w.id}/paid">
            ${csrfField(req)}
            <button type="submit">Mark Paid</button>
          </form>
          <form class="stack" method="post" action="/admin/withdrawals/${w.id}/reject">
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
      <p class="muted">Financial overview and platform management.</p>
      <form method="post" action="/admin/logout">
        ${csrfField(req)}
        <button class="secondary" type="submit">Logout Admin</button>
      </form>
    </section>

    <section class="grid">
      <div class="card"><h3>Users</h3><div class="number">${formatMoney(users)}</div></div>
      <div class="card"><h3>Outstanding MOON</h3><div class="number">${formatMoney(moonOutstanding)}</div></div>
      <div class="card"><h3>Revenue</h3><div class="number">${formatMoney(revenue)} RWF</div></div>
      <div class="card"><h3>Expenses</h3><div class="number">${formatMoney(expenses)} RWF</div></div>
      <div class="card"><h3>Paid Withdrawals</h3><div class="number">${formatMoney(paidWithdrawals)} RWF</div></div>
      <div class="card"><h3>Pending Withdrawals</h3><div class="number">${formatMoney(pendingWithdrawals)} RWF</div></div>
      <div class="card"><h3>Calculated Net Profit</h3><div class="number gold">${formatMoney(netProfit)} RWF</div></div>
    </section>

    <div class="card">
      <h2>Record Revenue</h2>
      <form class="stack" method="post" action="/admin/revenue">
        ${csrfField(req)}
        <label>Amount (RWF)<input name="amount" type="number" min="1" step="1" required></label>
        <label>Source<input name="source" maxlength="150" required></label>
        <button type="submit">Record Revenue</button>
      </form>
      <p class="muted">Only record money actually received and verifiable.</p>
    </div>

    <div class="card">
      <h2>Record Expense</h2>
      <form class="stack" method="post" action="/admin/expenses">
        ${csrfField(req)}
        <label>Amount (RWF)<input name="amount" type="number" min="1" step="1" required></label>
        <label>Description<input name="description" maxlength="200" required></label>
        <button type="submit">Record Expense</button>
      </form>
    </div>

    <div class="card">
      <h2>Withdrawal Requests</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>User</th><th>MOON</th><th>RWF</th><th>Payment details</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${withdrawalRows || '<tr><td colspan="7">No withdrawal requests.</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Financial calculation</h2>
      <p class="muted">Calculated net profit = recorded revenue − recorded expenses − paid withdrawals. This is a management estimate, not audited accounting profit. Tax, payment fees, and other obligations may need to be recorded separately.</p>
    </div>
  `;

  res.send(page('Admin Dashboard', content));
});

app.post('/admin/revenue', requireAdmin, validateCsrf, (req, res) => {
  const amount = Number(req.body.amount);
  const source = String(req.body.source || '').trim();

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000000 || !source || source.length > 150) {
    return res.status(400).send('Invalid revenue entry.');
  }

  run(
    'INSERT INTO revenue (amount_rwf, source, reference) VALUES (?, ?, ?)',
    amount,
    source,
    makeReference()
  );

  res.redirect('/admin');
});

app.post('/admin/expenses', requireAdmin, validateCsrf, (req, res) => {
  const amount = Number(req.body.amount);
  const description = String(req.body.description || '').trim();

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000000 || !description || description.length > 200) {
    return res.status(400).send('Invalid expense entry.');
  }

  run(
    'INSERT INTO expenses (amount_rwf, description) VALUES (?, ?)',
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

  const withdrawal = get('SELECT * FROM withdrawals WHERE id = ?', id);

  if (!withdrawal || withdrawal.status !== 'pending') {
    return res.status(409).send('Withdrawal is not pending.');
  }

  /*
   * Only mark a request as paid AFTER the real payment has been completed
   * and independently verified in the payment provider.
   */
  const updatePaid = db.transaction(() => {
    run(
      "UPDATE withdrawals SET status = 'paid' WHERE id = ? AND status = 'pending'",
      id
    );

    run(
      `INSERT INTO transactions (user_id, type, moon, description, reference)
       VALUES (?, 'withdrawal_paid', ?, ?, ?)`,
      withdrawal.user_id,
      0,
      `Withdrawal ${id} marked paid (${withdrawal.amount_rwf} RWF)`,
      makeReference()
    );
  });

  updatePaid();
  res.redirect('/admin');
});

app.post('/admin/withdrawals/:id/reject', requireAdmin, validateCsrf, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).send('Invalid withdrawal ID.');
  }

  const withdrawal = get('SELECT * FROM withdrawals WHERE id = ?', id);

  if (!withdrawal || withdrawal.status !== 'pending') {
    return res.status(409).send('Withdrawal is not pending.');
  }

  const rejectWithdrawal = db.transaction(() => {
    run(
      "UPDATE withdrawals SET status = 'rejected' WHERE id = ? AND status = 'pending'",
      id
    );

    run(
      'UPDATE users SET moon = moon + ? WHERE id = ?',
      withdrawal.moon,
      withdrawal.user_id
    );

    run(
      `INSERT INTO transactions (user_id, type, moon, description, reference)
       VALUES (?, 'withdrawal_refund', ?, ?, ?)`,
      withdrawal.user_id,
      withdrawal.moon,
      `Refund for rejected withdrawal ${id}`,
      makeReference()
    );
  });

  rejectWithdrawal();
  res.redirect('/admin');
});

app.use((req, res) => {
  res.status(404).send(page(
    'Not Found',
    '<div class="card"><h1>404</h1><p>The page you requested was not found.</p><a href="/">Go Home</a></div>'
  ));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  if (res.headersSent) return next(err);

  res.status(500).send(page(
    'Server Error',
    '<div class="card"><h1>Something went wrong</h1><p>Please try again later.</p></div>'
  ));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} is running on port ${PORT}`);
});
