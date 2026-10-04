'use strict';
/** Queue Display pairing + data. Displays authenticate with a device token issued at pairing. */
const express = require('express');
const crypto = require('crypto');
const { db, DEFAULT_STORE_ID } = require('../db');
const { publicSettings } = require('../settings');
const queueSvc = require('../queue');
const realtime = require('../realtime');
const { uuid, randomToken, sha256, rateLimiter, clientIp, HttpError, BUILD_ID } = require('../util');

const router = express.Router();

const PAIR_CODE_LENGTH = 6;
const PAIR_CODE_TTL = 5 * 60 * 1000;
const ONLINE_MS = 60000;

// Brute-force protection: per IP and globally.
const pairIpLimiter = rateLimiter({ windowMs: 10 * 60000, max: 10 });
const pairGlobalLimiter = rateLimiter({ windowMs: 10 * 60000, max: 200 });

function generatePairingCode(storeId, staffId) {
  const now = Date.now();
  // Only one live code per store: generating a new one invalidates the old.
  db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE store_id = ? AND used_at IS NULL AND expires_at > ?').run(now, storeId, now);
  let code;
  for (let i = 0; i < 20; i += 1) {
    code = String(crypto.randomInt(0, 10 ** PAIR_CODE_LENGTH)).padStart(PAIR_CODE_LENGTH, '0');
    const clash = db.prepare('SELECT 1 FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?').get(code, now);
    if (!clash) break;
  }
  db.prepare('INSERT INTO pairing_codes (store_id, code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(storeId, code, staffId, now, now + PAIR_CODE_TTL);
  return { code, expires_at: now + PAIR_CODE_TTL, ttl_ms: PAIR_CODE_TTL };
}

const pairTx = db.transaction((code, userAgent) => {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1').get(code, now);
  if (!row) return null;
  const count = db.prepare('SELECT COUNT(*) c FROM display_devices WHERE store_id = ?').get(row.store_id).c;
  const token = randomToken(32);
  const device = { id: uuid(), name: `Queue Display ${String(count + 1).padStart(2, '0')}` };
  db.prepare(`INSERT INTO display_devices (id, store_id, name, token_hash, user_agent, paired_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(device.id, row.store_id, device.name, sha256(token), String(userAgent || '').slice(0, 300), now, now);
  // Mark used inside the same transaction → a code can never pair two devices.
  db.prepare('UPDATE pairing_codes SET used_at = ?, used_by_device = ? WHERE id = ?').run(now, device.id, row.id);
  return { token, device, storeId: row.store_id };
});

function deviceFromToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const d = db.prepare('SELECT * FROM display_devices WHERE token_hash = ?').get(sha256(token));
  if (!d || d.revoked_at) return null;
  return d;
}

function bearer(req) {
  const h = req.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
}

function requireDevice(req, res, next) {
  const d = deviceFromToken(bearer(req));
  if (!d) return res.status(401).json({ error: 'หน้าจอนี้ยังไม่ได้เชื่อมต่อ หรือถูกยกเลิกการเชื่อมต่อแล้ว', code: 'UNPAIRED' });
  req.device = d;
  next();
}

function touch(device) {
  const now = Date.now();
  const wasOffline = !device.last_seen_at || now - device.last_seen_at > ONLINE_MS;
  db.prepare('UPDATE display_devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
  if (wasOffline) realtime.notify(device.store_id, ['displays']);
}

function promotions(storeId) {
  return db.prepare('SELECT id, url, title FROM promotion_images WHERE store_id = ? AND active = 1 ORDER BY sort_order, id').all(storeId);
}

function displayConfig(storeId, device) {
  return {
    device: { id: device.id, name: device.name },
    store: queueSvc.publicStore(storeId),
    settings: publicSettings(storeId),
    promotions: promotions(storeId),
    build: BUILD_ID,
  };
}

function listDevices(storeId) {
  const now = Date.now();
  return db.prepare('SELECT id, name, user_agent, paired_at, last_seen_at FROM display_devices WHERE store_id = ? AND revoked_at IS NULL ORDER BY paired_at')
    .all(storeId)
    .map((d) => ({
      ...d,
      online: !!d.last_seen_at && now - d.last_seen_at < ONLINE_MS
        || realtime.countClients((c) => c.kind === 'display' && c.meta.deviceId === d.id) > 0,
    }));
}

// ---------------------------------------------------------------- routes
router.post('/api/display/pair', (req, res, next) => {
  try {
    const ip = clientIp(req);
    const a = pairIpLimiter.hit(ip);
    const b = pairGlobalLimiter.hit('global');
    if (!a.ok || !b.ok) {
      const retry = Math.max(a.ok ? 0 : a.retryAfter, b.ok ? 0 : b.retryAfter);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `ลองรหัสผิดหลายครั้งเกินไป กรุณารอ ${Math.ceil(retry / 60)} นาที`, retry_after: retry });
    }
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (code.length !== PAIR_CODE_LENGTH) throw new HttpError(400, `กรุณากรอกรหัส ${PAIR_CODE_LENGTH} หลัก`);
    const result = pairTx(code, req.get('User-Agent'));
    if (!result) throw new HttpError(400, 'รหัสไม่ถูกต้อง หมดอายุ หรือถูกใช้งานแล้ว');
    pairIpLimiter.reset(ip);
    realtime.notify(result.storeId, ['displays']);
    realtime.emit(result.storeId, 'paired', { device: result.device }, (c) => c.kind === 'admin');
    res.status(201).json({ token: result.token, device: result.device });
  } catch (e) { next(e); }
});

router.get('/api/display/state', requireDevice, (req, res) => {
  touch(req.device);
  res.json({ ...displayConfig(req.device.store_id, req.device), board: queueSvc.displayBoard(req.device.store_id) });
});

router.post('/api/display/heartbeat', requireDevice, (req, res) => {
  touch(req.device);
  res.json({ ok: true, server_time: Date.now() });
});

router.post('/api/display/unpair', requireDevice, (req, res) => {
  db.prepare('UPDATE display_devices SET revoked_at = ? WHERE id = ?').run(Date.now(), req.device.id);
  realtime.notify(req.device.store_id, ['displays']);
  res.json({ ok: true });
});

router.get('/api/stream/display', requireDevice, (req, res) => {
  const device = req.device;
  touch(device);
  realtime.open(req, res, {
    storeId: device.store_id, kind: 'display', topics: ['queues', 'settings', 'promos'],
    meta: { deviceId: device.id, onClose: () => realtime.notify(device.store_id, ['displays']) },
    render: (topic) => {
      const current = db.prepare('SELECT * FROM display_devices WHERE id = ?').get(device.id);
      if (!current || current.revoked_at) return { event: 'revoked', data: {} };
      return topic === 'queues'
        ? { event: 'board', data: queueSvc.displayBoard(device.store_id) }
        : { event: 'config', data: displayConfig(device.store_id, current) };
    },
  });
  realtime.notify(device.store_id, ['displays']);
});

module.exports = { router, generatePairingCode, listDevices, ONLINE_MS };
