'use strict';
const crypto = require('crypto');
const { db, DEFAULT_STORE_ID } = require('./db');
const { randomToken, sha256, HttpError } = require('./util');

const COOKIE = 'qms_sid';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days, sliding

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, hashB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (pw.length > 200) throw new HttpError(400, 'รหัสผ่านยาวเกินไป');
}

function validateUsername(u) {
  if (typeof u !== 'string' || !/^[a-zA-Z0-9._-]{3,40}$/.test(u)) {
    throw new HttpError(400, 'ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ความยาว 3–40 ตัวอักษร');
  }
}

const hasStaff = () => db.prepare('SELECT COUNT(*) c FROM staff').get().c > 0;

function createStaff({ storeId = DEFAULT_STORE_ID, username, password, displayName, role }) {
  validateUsername(username);
  validatePassword(password);
  if (!['admin', 'staff'].includes(role)) throw new HttpError(400, 'สิทธิ์ไม่ถูกต้อง');
  const exists = db.prepare('SELECT id FROM staff WHERE username = ?').get(username);
  if (exists) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const info = db.prepare(`INSERT INTO staff (store_id, username, display_name, password_hash, role, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)`)
    .run(storeId, username, String(displayName || username).slice(0, 80), hashPassword(password), role, Date.now());
  return info.lastInsertRowid;
}

function createSession(staffId) {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, staff_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), staffId, now, now + SESSION_TTL, now);
  db.prepare('UPDATE staff SET last_login_at = ? WHERE id = ?').run(now, staffId);
  return token;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(req) {
  const secure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && req.secure);
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', `${COOKIE}=${token}; Max-Age=${SESSION_TTL / 1000}; ${cookieOptions(req)}`);
}
function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieOptions(req)}`);
}

const qSession = db.prepare(`SELECT s.token_hash, s.expires_at, s.last_seen_at, st.id, st.store_id, st.username, st.display_name, st.role, st.active
                             FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE s.token_hash = ?`);

function staffFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = qSession.get(sha256(token));
  const now = Date.now();
  if (!row || row.expires_at < now || !row.active) return null;
  if (now - row.last_seen_at > 60000) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, now + SESSION_TTL, row.token_hash);
  }
  return { id: row.id, store_id: row.store_id, username: row.username, display_name: row.display_name, role: row.role, token_hash: row.token_hash };
}

/** Requires a logged-in staff member. Mutating requests must also carry X-QMS (CSRF guard). */
function requireStaff(role) {
  return (req, res, next) => {
    const staff = staffFromRequest(req);
    if (!staff) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    if (role === 'admin' && staff.role !== 'admin') return res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบเท่านั้น' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-QMS') !== '1') {
      return res.status(403).json({ error: 'คำขอไม่ถูกต้อง' });
    }
    req.staff = staff;
    next();
  };
}

function destroySession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600000).unref();

module.exports = {
  hashPassword, verifyPassword, validatePassword, hasStaff, createStaff, createSession, staffFromRequest,
  requireStaff, setSessionCookie, clearSessionCookie, destroySession, parseCookies,
};
