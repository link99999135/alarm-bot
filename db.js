const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);

// Enable WAL mode to reduce SD card wear
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT,
    label TEXT,
    fire_at INTEGER NOT NULL,
    timezone TEXT DEFAULT 'UTC',
    repeat_rule TEXT,
    shock_enabled INTEGER DEFAULT 0,
    shock_op INTEGER DEFAULT 1,
    shock_intensity INTEGER DEFAULT 20,
    shock_duration INTEGER DEFAULT 1,
    max_snoozes INTEGER DEFAULT 3,
    snooze_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS alarm_dismiss (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alarm_id INTEGER NOT NULL,
    phrase TEXT NOT NULL,
    snooze_phrase TEXT,
    attempts INTEGER DEFAULT 0,
    snooze_count INTEGER DEFAULT 0,
    dismissed_at INTEGER,
    FOREIGN KEY (alarm_id) REFERENCES alarms(id)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    timezone TEXT DEFAULT 'UTC',
    default_shock_op INTEGER DEFAULT 1,
    default_shock_intensity INTEGER DEFAULT 20,
    default_shock_duration INTEGER DEFAULT 1,
    default_max_snoozes INTEGER DEFAULT 3,
    shock_intensity_cap INTEGER DEFAULT 50
  );

  CREATE TABLE IF NOT EXISTS pishock_credentials (
    user_id TEXT PRIMARY KEY,
    username_enc TEXT NOT NULL,
    apikey_enc TEXT NOT NULL,
    sharecode_enc TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS lock_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wearer_id TEXT NOT NULL UNIQUE,
    keyholder_id TEXT NOT NULL,
    is_locked INTEGER DEFAULT 0,
    locked_at INTEGER,
    min_unlock_at INTEGER,
    scheduled_unlock_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS unlock_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wearer_id TEXT NOT NULL,
    keyholder_id TEXT NOT NULL,
    requested_at INTEGER DEFAULT (unixepoch()),
    message_id TEXT,
    status TEXT DEFAULT 'pending'
  );
`);

// ── Encryption helpers ────────────────────────────────────────────────────────

const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: Buffer.concat([encrypted, tag]).toString('hex'),
    iv: iv.toString('hex'),
  };
}

function decrypt(encHex, ivHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(encHex, 'hex');
  const tag = data.slice(-16);
  const encrypted = data.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ── User settings ─────────────────────────────────────────────────────────────

function getUser(userId) {
  let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
    row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  }
  return row;
}

function setUserTimezone(userId, timezone) {
  db.prepare('INSERT INTO user_settings (user_id, timezone) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone')
    .run(userId, timezone);
}

function setUserShockDefaults(userId, { op, intensity, duration, maxSnoozes, intensityCap }) {
  getUser(userId);
  db.prepare(`UPDATE user_settings SET
    default_shock_op = COALESCE(?, default_shock_op),
    default_shock_intensity = COALESCE(?, default_shock_intensity),
    default_shock_duration = COALESCE(?, default_shock_duration),
    default_max_snoozes = COALESCE(?, default_max_snoozes),
    shock_intensity_cap = COALESCE(?, shock_intensity_cap)
    WHERE user_id = ?`).run(op ?? null, intensity ?? null, duration ?? null, maxSnoozes ?? null, intensityCap ?? null, userId);
}

// ── PiShock credentials ───────────────────────────────────────────────────────
function savePishockCredentials(userId, username, apikey, sharecode) {
  const iv = crypto.randomBytes(16).toString('hex');
  const uEnc = encryptWithIv(username, iv);
  const aEnc = encryptWithIv(apikey, iv);
  const sEnc = encryptWithIv(sharecode, iv);
  db.prepare(`INSERT INTO pishock_credentials (user_id, username_enc, apikey_enc, sharecode_enc, iv)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username_enc=excluded.username_enc,
    apikey_enc=excluded.apikey_enc, sharecode_enc=excluded.sharecode_enc, iv=excluded.iv`)
    .run(userId, uEnc, aEnc, sEnc, iv);
}
function encryptWithIv(text, ivHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString('hex');
}
function getPishockCredentials(userId) {
  const row = db.prepare('SELECT * FROM pishock_credentials WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    username: decrypt(row.username_enc, row.iv),
    apikey: decrypt(row.apikey_enc, row.iv),
    sharecode: decrypt(row.sharecode_enc, row.iv),
  };
}

// ── Alarms ────────────────────────────────────────────────────────────────────

function createAlarm(data) {
  const user = getUser(data.userId);
  const stmt = db.prepare(`INSERT INTO alarms
    (user_id, channel_id, label, fire_at, timezone, repeat_rule,
     shock_enabled, shock_op, shock_intensity, shock_duration, max_snoozes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    data.userId,
    data.channelId || null,
    data.label || null,
    data.fireAt,
    data.timezone || user.timezone,
    data.repeatRule || null,
    data.shockEnabled ? 1 : 0,
    data.shockOp ?? user.default_shock_op,
    Math.min(data.shockIntensity ?? user.default_shock_intensity, user.shock_intensity_cap),
    data.shockDuration ?? user.default_shock_duration,
    data.maxSnoozes ?? user.default_max_snoozes,
  );
  return info.lastInsertRowid;
}

function getAlarm(id) {
  return db.prepare('SELECT * FROM alarms WHERE id = ?').get(id);
}

function getUserAlarms(userId) {
  return db.prepare('SELECT * FROM alarms WHERE user_id = ? AND active = 1 ORDER BY fire_at ASC').all(userId);
}

function getDueAlarms() {
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + 60;
  return db.prepare('SELECT * FROM alarms WHERE active = 1 AND fire_at >= ? AND fire_at < ?').all(now, windowEnd);
}

function deleteAlarm(id, userId) {
  return db.prepare('UPDATE alarms SET active = 0 WHERE id = ? AND user_id = ?').run(id, userId);
}

function rescheduleAlarm(id, nextFireAt) {
  db.prepare('UPDATE alarms SET fire_at = ?, snooze_count = 0 WHERE id = ?').run(nextFireAt, id);
}

function incrementSnooze(alarmId) {
  db.prepare('UPDATE alarms SET snooze_count = snooze_count + 1 WHERE id = ?').run(alarmId);
  return db.prepare('SELECT snooze_count, max_snoozes FROM alarms WHERE id = ?').get(alarmId);
}

// ── Alarm dismiss (typing test) ───────────────────────────────────────────────

const DISMISS_PHRASES = [
  'the quick brown fox jumps over the lazy dog',
  'pack my box with five dozen liquor jugs',
  'how vexingly quick daft zebras jump',
  'the five boxing wizards jump quickly',
  'sphinx of black quartz judge my vow',
  'bright copper kettles and warm woolen mittens',
  'i am fully awake and ready to start my day',
  'wakey wakey eggs and bakey time to rise',
];

const SNOOZE_PHRASES = [
  'snooze', 'five more minutes', 'just waking up', 'almost awake',
];

function generatePhrase() {
  return DISMISS_PHRASES[Math.floor(Math.random() * DISMISS_PHRASES.length)];
}

function generateSnoozePhrase() {
  return SNOOZE_PHRASES[Math.floor(Math.random() * SNOOZE_PHRASES.length)];
}

function createDismissChallenge(alarmId) {
  db.prepare('DELETE FROM alarm_dismiss WHERE alarm_id = ?').run(alarmId);
  const phrase = generatePhrase();
  const snoozePhrase = generateSnoozePhrase();
  db.prepare('INSERT INTO alarm_dismiss (alarm_id, phrase, snooze_phrase) VALUES (?, ?, ?)').run(alarmId, phrase, snoozePhrase);
  return { phrase, snoozePhrase };
}

function getDismissChallenge(alarmId) {
  return db.prepare('SELECT * FROM alarm_dismiss WHERE alarm_id = ? AND dismissed_at IS NULL').get(alarmId);
}

function incrementDismissAttempt(alarmId) {
  db.prepare('UPDATE alarm_dismiss SET attempts = attempts + 1 WHERE alarm_id = ?').run(alarmId);
  const newPhrase = generatePhrase();
  db.prepare('UPDATE alarm_dismiss SET phrase = ? WHERE alarm_id = ?').run(newPhrase, alarmId);
  return newPhrase;
}

function markDismissed(alarmId) {
  db.prepare('UPDATE alarm_dismiss SET dismissed_at = ? WHERE alarm_id = ?').run(Math.floor(Date.now() / 1000), alarmId);
  db.prepare('UPDATE alarms SET active = 0 WHERE id = ?').run(alarmId);
}

// ── Lockbox ───────────────────────────────────────────────────────────────────

function getLockPairByWearer(wearerId) {
  return db.prepare('SELECT * FROM lock_pairs WHERE wearer_id = ?').get(wearerId);
}

function getLockPairByKeyholder(keyholderId) {
  return db.prepare('SELECT * FROM lock_pairs WHERE keyholder_id = ?').get(keyholderId);
}

function getLockPairByEither(userId) {
  return db.prepare('SELECT * FROM lock_pairs WHERE wearer_id = ? OR keyholder_id = ?').get(userId, userId);
}

function createLockPair(wearerId, keyholderId) {
  db.prepare('INSERT OR REPLACE INTO lock_pairs (wearer_id, keyholder_id) VALUES (?, ?)').run(wearerId, keyholderId);
}

function deleteLockPair(wearerId) {
  db.prepare('DELETE FROM lock_pairs WHERE wearer_id = ?').run(wearerId);
}

function setLocked(wearerId, { minUnlockAt, scheduledUnlockAt } = {}) {
  db.prepare(`UPDATE lock_pairs SET is_locked = 1, locked_at = ?,
    min_unlock_at = COALESCE(?, min_unlock_at),
    scheduled_unlock_at = COALESCE(?, scheduled_unlock_at)
    WHERE wearer_id = ?`)
    .run(Math.floor(Date.now() / 1000), minUnlockAt ?? null, scheduledUnlockAt ?? null, wearerId);
}

function setUnlocked(wearerId) {
  db.prepare(`UPDATE lock_pairs SET is_locked = 0, locked_at = NULL,
    min_unlock_at = NULL, scheduled_unlock_at = NULL WHERE wearer_id = ?`).run(wearerId);
}

function extendMinUnlock(wearerId, extraSeconds) {
  const pair = getLockPairByWearer(wearerId);
  if (!pair) return null;
  const base = Math.max(pair.min_unlock_at || Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  const newTime = base + extraSeconds;
  db.prepare('UPDATE lock_pairs SET min_unlock_at = ? WHERE wearer_id = ?').run(newTime, wearerId);
  return newTime;
}

function setScheduledUnlock(wearerId, timestamp) {
  db.prepare('UPDATE lock_pairs SET scheduled_unlock_at = ? WHERE wearer_id = ?').run(timestamp, wearerId);
}

function getDueScheduledUnlocks() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('SELECT * FROM lock_pairs WHERE is_locked = 1 AND scheduled_unlock_at IS NOT NULL AND scheduled_unlock_at <= ?').all(now);
}

function createUnlockRequest(wearerId, keyholderId) {
  db.prepare('UPDATE unlock_requests SET status = ? WHERE wearer_id = ? AND status = ?').run('superseded', wearerId, 'pending');
  const info = db.prepare('INSERT INTO unlock_requests (wearer_id, keyholder_id) VALUES (?, ?)').run(wearerId, keyholderId);
  return info.lastInsertRowid;
}

function getUnlockRequest(id) {
  return db.prepare('SELECT * FROM unlock_requests WHERE id = ?').get(id);
}

function updateUnlockRequest(id, status, messageId) {
  db.prepare('UPDATE unlock_requests SET status = ?, message_id = COALESCE(?, message_id) WHERE id = ?').run(status, messageId ?? null, id);
}

module.exports = {
  db,
  getUser, setUserTimezone, setUserShockDefaults,
  savePishockCredentials, getPishockCredentials,
  createAlarm, getAlarm, getUserAlarms, getDueAlarms, deleteAlarm, rescheduleAlarm, incrementSnooze,
  createDismissChallenge, getDismissChallenge, incrementDismissAttempt, markDismissed, generatePhrase,
  getLockPairByWearer, getLockPairByKeyholder, getLockPairByEither,
  createLockPair, deleteLockPair, setLocked, setUnlocked, extendMinUnlock, setScheduledUnlock,
  getDueScheduledUnlocks, createUnlockRequest, getUnlockRequest, updateUnlockRequest,
};
