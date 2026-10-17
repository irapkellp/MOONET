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
const OFFERWALL_POSTBACK_SECRET = String(process.env.OFFERWALL_POSTBACK_SECRET || '');
const OFFERWALL_WALL_ID = '5126c45ff0096181b7ad353b735ad976';

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

 CREATE TABLE IF NOT EXISTS offerwall_events(
   event_key TEXT PRIMARY KEY,
   user_id INTEGER NOT NULL REFERENCES users(id),
   offer_id TEXT NOT NULL DEFAULT '',
   payout_usd REAL NOT NULL DEFAULT 0,
   reward_moon REAL NOT NULL DEFAULT 0,
   status TEXT NOT NULL,
   credited INTEGER NOT NULL DEFAULT 0,
   reversed INTEGER NOT NULL DEFAULT 0,
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
