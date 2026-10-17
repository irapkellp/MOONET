'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();

const PORT = process.env.PORT || 3000;

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, 'data');

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters');
}

if (!process.env.ADMIN_EMAIL ||
    !process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error('Configure ADMIN_EMAIL and ADMIN_PASSWORD securely');
}

app.disable('x-powered-by');

app.use(express.urlencoded({
  extended: false,
  limit: '1mb'
}));

app.use(express.json({
  limit: '1mb'
}));

app.use('/uploads', express.static(UPLOAD_DIR));

app.use(session({
  name: 'moonet.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const db = new DatabaseSync(
  path.join(DATA_DIR, 'moonet.db')
);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    moon REAL NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by INTEGER,
    suspended INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS offerwall_conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    reward REAL NOT NULL,
    status TEXT NOT NULL,
    offer_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
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

function makeReference(prefix = 'MN') {
  return prefix + '_' + crypto.randomUUID();
}

function getUser(id) {
  return db.prepare(`
    SELECT id, name, email, moon, referral_code,
           suspended, created_at
    FROM users
    WHERE id = ?
  `).get(id);
}

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const user = getUser(req.session.userId);

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

function page(title, content, user = null) {
  const nav = user
    ? `
      <a href="/app">Home</a>
      <a href="/offerwall">Earn MOONS</a>
      <a href="/wallet">Wallet</a>
      <a href="/transactions">History</a>
      <a href="/profile">Profile</a>
      <form action="/logout" method="post">
        <button type="submit">Logout</button>
      </form>
    `
    : `
      <a href="/">Home</a>
      <a href="/login">Login</a>
      <a href="/signup">Sign Up</a>
    `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b8f54">
<title>${esc(title)} | MOONET</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;background:#f4faf6;color:#183126}
header{background:#fff;padding:16px;border-bottom:1px solid #dce9e0}
nav{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
a{color:#087443;text-decoration:none}
main{max-width:1000px;margin:24px auto;padding:16px}
.card{background:#fff;border:1px solid #dce9e0;border-radius:14px;padding:18px;margin-bottom:16px}
input,select,button{padding:11px;border-radius:8px;border:1px solid #ccd8d0;margin:5px 0;max-width:100%}
button{background:#0b8f54;color:white;cursor:pointer}
table{width:100%;border-collapse:collapse}
td,th{padding:9px;border-bottom:1px solid #dce9e0;text-align:left}
.balance{font-size:28px;font-weight:bold;color:#087443}
</style>
</head>
<body>
<header>
  <nav>
    <strong>MOONET 🌙</strong>
    ${nav}
  </nav>
</header>
<main>${content}</main>
</body>
</html>`;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'MOONET' });
});

app.get('/', (req, res) => {
  res.send(page('Welcome', `
    <section class="card">
      <h1>Welcome to MOONET 🌙</h1>
      <p>Complete available activities and earn MOONS.</p>
      <a href="/signup">Create account</a> |
      <a href="/login">Login</a>
    </section>
  `));
});
// ============================================
// MOONET — AUTHENTICATION
// ============================================

function generateReferralCode() {
  return 'MOON' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

app.get('/signup', (req, res) => {
  res.send(page('Sign Up', `
    <section class="card">
      <h1>Create your MOONET account</h1>
      <form method="post" action="/signup">
        <label>Full name</label><br>
        <input name="name" required maxlength="80" autocomplete="name"><br>

        <label>Email address</label><br>
        <input name="email" type="email" required maxlength="190"
               autocomplete="email"><br>

        <label>Password</label><br>
        <input name="password" type="password" required minlength="12"
               autocomplete="new-password"><br>

        <button type="submit">Create Account</button>
      </form>
      <p>Already registered? <a href="/login">Login</a></p>
    </section>
  `));
});

app.post('/signup', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name || name.length > 80 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 190 ||
      password.length < 12 || password.length > 200) {
    return res.status(400).send(page('Sign Up', `
      <section class="card">
        <h2>Invalid registration details</h2>
        <p>Enter a valid email and a password of at least 12 characters.</p>
        <a href="/signup">Try again</a>
      </section>
    `));
  }

  const existing = db.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).get(email);

  if (existing) {
    return res.status(409).send(page('Sign Up', `
      <section class="card">
        <h2>Email already registered. Please login.</h2>
        <a href="/login">Login here</a>
      </section>
    `));
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let referralCode;
  let attempts = 0;

  do {
    referralCode = generateReferralCode();
    attempts++;
  } while (
    db.prepare('SELECT id FROM users WHERE referral_code = ?')
      .get(referralCode) && attempts < 5
  );

  try {
    const result = db.prepare(`
      INSERT INTO users
        (name, email, password_hash, moon, referral_code)
      VALUES (?, ?, ?, 0, ?)
    `).run(name, email, passwordHash, referralCode);

    req.session.regenerate(err => {
      if (err) {
        return res.status(500).send('Session creation failed.');
      }

      req.session.userId = Number(result.lastInsertRowid);

      res.redirect('/app');
    });
  } catch (err) {
    console.error('Registration error:', err.message);

    res.status(500).send(page('Sign Up', `
      <section class="card">
        <h2>Registration could not be completed.</h2>
        <a href="/signup">Try again</a>
      </section>
    `));
  }
});

app.get('/login', (req, res) => {
  res.send(page('Login', `
    <section class="card">
      <h1>Login to MOONET</h1>
      <form method="post" action="/login">
        <label>Email address</label><br>
        <input name="email" type="email" required
               autocomplete="username"><br>

        <label>Password</label><br>
        <input name="password" type="password" required
               autocomplete="current-password"><br>

        <button type="submit">Login</button>
      </form>
      <p>New user? <a href="/signup">Create an account</a></p>
    </section>
  `));
});

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = db.prepare(`
    SELECT id, password_hash, suspended
    FROM users
    WHERE email = ?
  `).get(email);

  if (!user || user.suspended ||
      !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).send(page('Login', `
      <section class="card">
        <h2>Login failed</h2>
        <p>Check your email and password, then try again.</p>
        <a href="/login">Return to Login</a>
      </section>
    `));
  }

  req.session.regenerate(err => {
    if (err) {
      return res.status(500).send('Session creation failed.');
    }

    req.session.userId = user.id;

    res.redirect('/app');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).send('Logout failed.');
    }

    res.clearCookie('moonet.sid');
    res.redirect('/');
  });
});

// ============================================
// USER DASHBOARD
// ============================================

app.get('/app', requireUser, (req, res) => {
  const user = getUser(req.user.id);

  const recentTransactions = db.prepare(`
    SELECT type, amount, description, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 5
  `).all(user.id);

  const transactionRows = recentTransactions.map(tx => `
    <tr>
      <td>${esc(tx.type)}</td>
      <td>${fmt(tx.amount)} MOONS</td>
      <td>${esc(tx.description)}</td>
      <td>${esc(tx.created_at)}</td>
    </tr>
  `).join('');

  res.send(page('Dashboard', `
    <section class="card">
      <h1>Welcome, ${esc(user.name)}!</h1>
      <p>Your MOONET account</p>
      <div class="balance">${fmt(user.moon)} MOONS</div>
      <p>Referral code: <strong>${esc(user.referral_code)}</strong></p>
    </section>

    <section class="card">
      <h2>Earn MOONS</h2>
      <p>Explore available offers and eligible activities.</p>
      <a href="/offerwall">Open Offerwall</a>
    </section>

    <section class="card">
      <h2>My Wallet</h2>
      <a href="/wallet">Open Wallet</a> |
      <a href="/transactions">Transaction History</a> |
      <a href="/withdraw">Withdraw MOONS</a>
    </section>

    <section class="card">
      <h2>Recent Transactions</h2>
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
          ${transactionRows || '<tr><td colspan="4">No transactions yet.</td></tr>'}
        </tbody>
      </table>
    </section>
  `, user));
});
// ============================================
// MOONET — WALLET AND TRANSACTION HISTORY
// ============================================

const MIN_WITHDRAWAL_MOONS = 1000;

app.get('/wallet', requireUser, (req, res) => {
  const user = getUser(req.user.id);

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)
        AS earned,
      COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0)
        AS spent
    FROM transactions
    WHERE user_id = ?
  `).get(user.id);

  res.send(page('Wallet', `
    <section class="card">
      <h1>My Wallet 🌙</h1>

      <p>Available balance</p>
      <div class="balance">${fmt(user.moon)} MOONS</div>

      <hr>

      <p>Total earned: <strong>${fmt(totals.earned)} MOONS</strong></p>
      <p>Total spent: <strong>${fmt(totals.spent)} MOONS</strong></p>

      <p>
        <a href="/transactions">Transaction History</a>
      </p>

      <p>
        <a href="/withdraw">Request Withdrawal</a>
      </p>

      <p>
        <a href="/offerwall">Earn more MOONS</a>
      </p>
    </section>
  `, user));
});

app.get('/transactions', requireUser, (req, res) => {
  const user = getUser(req.user.id);

  const transactions = db.prepare(`
    SELECT type, amount, reference, description, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 200
  `).all(user.id);

  const rows = transactions.map(tx => `
    <tr>
      <td>${esc(tx.type)}</td>
      <td>${tx.amount >= 0 ? '+' : ''}${fmt(tx.amount)}</td>
      <td>${esc(tx.description)}</td>
      <td>${esc(tx.reference)}</td>
      <td>${esc(tx.created_at)}</td>
    </tr>
  `).join('');

  res.send(page('Transaction History', `
    <section class="card">
      <h1>Transaction History</h1>

      <p>
        Current balance:
        <strong>${fmt(user.moon)} MOONS</strong>
      </p>

      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount (MOONS)</th>
              <th>Description</th>
              <th>Reference</th>
              <th>Date</th>
            </tr>
          </thead>

          <tbody>
            ${rows || `
              <tr>
                <td colspan="5">No transactions found.</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>

      <p><a href="/wallet">Back to Wallet</a></p>
    </section>
  `, user));
});

// ============================================
// MOONET — WITHDRAWAL REQUESTS
// ============================================

app.get('/withdraw', requireUser, (req, res) => {
  const user = getUser(req.user.id);

  const message = req.query.message === 'submitted'
    ? '<p>Your withdrawal request was submitted for review.</p>'
    : '';

  res.send(page('Withdraw MOONS', `
    <section class="card">
      <h1>Withdraw MOONS</h1>

      ${message}

      <p>Available balance:</p>
      <div class="balance">${fmt(user.moon)} MOONS</div>

      <p>Minimum withdrawal: ${fmt(MIN_WITHDRAWAL_MOONS)} MOONS</p>

      <form method="post" action="/withdraw">
        <label for="amount">Amount (MOONS)</label><br>
        <input
          id="amount"
          name="amount"
          type="number"
          min="${MIN_WITHDRAWAL_MOONS}"
          step="1"
          required
        ><br>

        <label for="method">Payment method</label><br>
        <select id="method" name="method" required>
          <option value="">Select payment method</option>
          <option value="MTN MoMo">MTN Mobile Money</option>
          <option value="Bank Transfer">Bank Transfer</option>
          <option value="PayPal">PayPal</option>
        </select><br>

        <label for="destination">Payment account or number</label><br>
        <input
          id="destination"
          name="destination"
          type="text"
          maxlength="190"
          required
        ><br>

        <button type="submit">Submit Withdrawal Request</button>
      </form>

      <p>
        Withdrawal requests require Admin review.
        Submission does not mean payment has been completed.
      </p>
    </section>
  `, user));
});

app.post('/withdraw', requireUser, (req, res) => {
  const amount = Number(req.body.amount);
  const method = String(req.body.method || '').trim();
  const destination = String(req.body.destination || '').trim();

  const allowedMethods = [
    'MTN MoMo',
    'Bank Transfer',
    'PayPal'
  ];

  if (
    !Number.isSafeInteger(amount) ||
    amount < MIN_WITHDRAWAL_MOONS ||
    !allowedMethods.includes(method) ||
    !destination ||
    destination.length > 190
  ) {
    return res.status(400).send(page('Withdraw MOONS', `
      <section class="card">
        <h2>Invalid withdrawal request</h2>
        <p>Check the amount, payment method, and account details.</p>
        <a href="/withdraw">Try again</a>
      </section>
    `, req.user));
  }

  const reference = makeReference('WD');

  try {
    db.exec('BEGIN IMMEDIATE');

    const user = db.prepare(`
      SELECT id, moon, suspended
      FROM users
      WHERE id = ?
    `).get(req.user.id);

    if (!user || user.suspended) {
      db.exec('ROLLBACK');
      return res.status(403).send('Account unavailable.');
    }

    if (user.moon < amount) {
      db.exec('ROLLBACK');

      return res.status(400).send(page('Withdraw MOONS', `
        <section class="card">
          <h2>Insufficient MOONS</h2>
          <p>You do not have enough MOONS for this withdrawal.</p>
          <a href="/wallet">Return to Wallet</a>
        </section>
      `, req.user));
    }

    const update = db.prepare(`
      UPDATE users
      SET moon = moon - ?
      WHERE id = ?
        AND moon >= ?
        AND suspended = 0
    `).run(amount, user.id, amount);

    if (Number(update.changes) !== 1) {
      db.exec('ROLLBACK');
      return res.status(409).send('Balance changed. Please try again.');
    }

    db.prepare(`
      INSERT INTO withdrawals
        (user_id, amount, method, destination, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(user.id, amount, method, destination);

    db.prepare(`
      INSERT INTO transactions
        (user_id, type, amount, reference, description)
      VALUES (?, 'withdrawal_request', ?, ?, ?)
    `).run(
      user.id,
      -amount,
      reference,
      'Withdrawal request submitted for review'
    );

    db.exec('COMMIT');

    return res.redirect('/withdraw?message=submitted');

  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}

    console.error('Withdrawal request error:', err.message);

    return res.status(500).send(
      'Unable to submit withdrawal request. Please try again later.'
    );
  }
})
// ============================================
// ADMIN LOGIN
// ============================================

app.get('/admin/login', (req, res) => {
// ============================================
// ADMIN LOGIN
// ============================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }

  res.send(page('MOONET Admin Login', `
    <div class="card" style="max-width:450px;margin:40px auto">
      <h1>🌙 MOONET Admin</h1>
      <p>Injira muri Admin Dashboard.</p>

      <form method="POST" action="/admin/login">
        <label>Email</label>
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

      <p><a href="/">Back to MOONET</a></p>
    </div>
  `));
});

app.post('/admin/login', (req, res, next) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();

  const password = String(req.body.password || '');

  const adminEmail = String(process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();

  const adminPassword = String(process.env.ADMIN_PASSWORD || '');

  if (!adminEmail || !adminPassword) {
    return res.status(500).send(
      'Admin credentials are not configured in Render Environment.'
    );
  }

  if (email !== adminEmail || password !== adminPassword) {
    return res.status(401).send(
      page('Login Failed', `
        <div class="card">
          <h2>Login failed</h2>
          <p>Email cyangwa password si byo.</p>
          <a href="/admin/login">Try again</a>
        </div>
      `)
    );
  }

  req.session.regenerate((err) => {
    if (err) return next(err);

    req.session.isAdmin = true;

    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect('/admin');
    });
  });
});


// ============================================
// ADMIN LOGOUT
// ============================================

app.post('/admin/logout', requireAdmin, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);

    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});


// ============================================
// ADMIN DASHBOARD
// ============================================

app.get('/admin', requireAdmin, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_users,
      COALESCE(SUM(moon), 0) AS total_moons
    FROM users
  `).get();

  const withdrawalStats = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      COALESCE(SUM(
        CASE WHEN status = 'pending' THEN amount ELSE 0 END
      ), 0) AS pending_moons
    FROM withdrawals
  `).get();

  const users = db.prepare(`
    SELECT id, name, email, moon, created_at
    FROM users
    ORDER BY id DESC
    LIMIT 100
  `).all();

  const withdrawals = db.prepare(`
    SELECT
      w.id,
      w.user_id,
      u.name,
      u.email,
      w.amount,
      w.method,
      w.destination,
      w.status,
      w.created_at
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ORDER BY w.id DESC
    LIMIT 100
  `).all();

  const userRows = users.map((u) => `
    <tr>
      <td>${escapeHtml(String(u.id))}</td>
      <td>${escapeHtml(String(u.name || ''))}</td>
      <td>${escapeHtml(String(u.email || ''))}</td>
      <td>${escapeHtml(String(u.moon ?? 0))} MOONS</td>
      <td>${escapeHtml(String(u.created_at || ''))}</td>
    </tr>
  `).join('');

  const withdrawalRows = withdrawals.map((w) => `
    <tr>
      <td>${escapeHtml(String(w.id))}</td>
      <td>${escapeHtml(String(w.name || ''))}</td>
      <td>${escapeHtml(String(w.email || ''))}</td>
      <td>${escapeHtml(String(w.amount))} MOONS</td>
      <td>${escapeHtml(String(w.method || ''))}</td>
      <td>${escapeHtml(String(w.destination || ''))}</td>
      <td>${escapeHtml(String(w.status || ''))}</td>
      <td>
        ${
          w.status === 'pending'
            ? `
              <form method="POST"
                action="/admin/withdrawals/${encodeURIComponent(String(w.id))}/approve"
                style="display:inline">
                <button type="submit">Approve</button>
              </form>

              <form method="POST"
                action="/admin/withdrawals/${encodeURIComponent(String(w.id))}/reject"
                style="display:inline">
                <button type="submit">Reject</button>
              </form>
            `
            : ''
        }
      </td>
    </tr>
  `).join('');

  res.send(page('MOONET Admin Dashboard', `
    <div class="container">
      <h1>🌙 MOONET Admin Dashboard</h1>

      <form method="POST" action="/admin/logout">
        <button type="submit">Logout</button>
      </form>

      <div class="card">
        <h2>Platform Overview</h2>
        <p>Total users:
          <strong>${escapeHtml(String(stats.total_users))}</strong>
        </p>
        <p>Total user wallet balance:
          <strong>${escapeHtml(String(stats.total_moons))} MOONS</strong>
        </p>
        <p>Withdrawal requests:
          <strong>${escapeHtml(String(withdrawalStats.total_requests))}</strong>
        </p>
        <p>Pending withdrawals:
          <strong>${escapeHtml(String(withdrawalStats.pending_moons))} MOONS</strong>
        </p>
      </div>

      <div class="card">
        <h2>Latest Users</h2>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Email</th>
                <th>Balance</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              ${userRows || '<tr><td colspan="5">No users found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Withdrawal Requests</h2>
        <p><strong>Important:</strong> Approve ihindura status gusa; ntihita yohereza amafaranga. Banza urebe ko wishyuye umukoresha mbere yo kwemeza ubwishyu.</p>

        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Email</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Destination</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${withdrawalRows || '<tr><td colspan="8">No withdrawals found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <p><a href="/">Return to MOONET</a></p>
    </div>
  `));
});


// ============================================
// APPROVE WITHDRAWAL
// ============================================

app.post(
  '/admin/withdrawals/:id/approve',
  requireAdmin,
  (req, res) => {
    const withdrawalId = Number(req.params.id);

    if (!Number.isSafeInteger(withdrawalId) || withdrawalId <= 0) {
      return res.status(400).send('Invalid withdrawal ID.');
    }

    const withdrawal = db.prepare(`
      SELECT id, status
      FROM withdrawals
      WHERE id = ?
    `).get(withdrawalId);

    if (!withdrawal) {
      return res.status(404).send('Withdrawal not found.');
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).send(
        'This withdrawal has already been processed.'
      );
    }

    db.prepare(`
      UPDATE withdrawals
      SET status = 'approved'
      WHERE id = ? AND status = 'pending'
    `).run(withdrawalId);

    return res.redirect('/admin');
  }
);


// ============================================
// REJECT WITHDRAWAL
// ============================================

app.post(
  '/admin/withdrawals/:id/reject',
  requireAdmin,
  (req, res) => {
    const withdrawalId = Number(req.params.id);

    if (!Number.isSafeInteger(withdrawalId) || withdrawalId <= 0) {
      return res.status(400).send('Invalid withdrawal ID.');
    }

    const rejectWithdrawal = db.transaction(() => {
      const withdrawal = db.prepare(`
        SELECT id, user_id, amount, status
        FROM withdrawals
        WHERE id = ?
      `).get(withdrawalId);

      if (!withdrawal) {
        return 'not_found';
      }

      if (withdrawal.status !== 'pending') {
        return 'processed';
      }

      db.prepare(`
        UPDATE withdrawals
        SET status = 'rejected'
        WHERE id = ? AND status = 'pending'
      `).run(withdrawalId);

      db.prepare(`
        UPDATE users
        SET moon = moon + ?
        WHERE id = ?
      `).run(withdrawal.amount, withdrawal.user_id);

      return 'rejected';
    });

    const result = rejectWithdrawal();

    if (result === 'not_found') {
      return res.status(404).send('Withdrawal not found.');
    }

    if (result === 'processed') {
      return res.status(400).send(
        'This withdrawal has already been processed.'
      );
    }

    return res.redirect('/admin');
  }
);
  // Start MOONET server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MOONET running on port ${PORT}`);
});
