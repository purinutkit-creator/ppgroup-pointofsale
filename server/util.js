'use strict';
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

/** Changes on every server start; long-running screens reload when it changes (new deploy). */
const BUILD_ID = `${require('../package.json').version}-${Date.now().toString(36)}`;
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Wall-clock parts of `ts` in the given IANA time zone. */
function zonedParts(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/** Offset (ms) of the zone relative to UTC at instant ts. */
function zoneOffset(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** UTC epoch for local midnight of YYYY-MM-DD in the zone. */
function localMidnight(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - zoneOffset(guess, timeZone);
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmtDate = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;

function localDate(ts, timeZone) {
  return fmtDate(zonedParts(ts, timeZone));
}

/**
 * Business date: the calendar day a queue belongs to. Before the daily reset
 * time it still counts as the previous day (e.g. a restaurant open past midnight).
 */
function businessDate(ts, timeZone, resetTime) {
  const p = zonedParts(ts, timeZone);
  const [rh, rm] = (resetTime || '00:00').split(':').map(Number);
  if (p.h * 60 + p.min < rh * 60 + rm) {
    const prev = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86400000);
    return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
  }
  return fmtDate(p);
}

/** Simple fixed-window in-memory rate limiter. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, Math.min(windowMs, 60000)).unref();
  return {
    hit(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
      e.count += 1;
      return { ok: e.count <= max, retryAfter: Math.ceil((e.reset - now) / 1000) };
    },
    reset(key) { hits.delete(key); },
  };
}

function limit(limiter, keyFn, message = 'คำขอมากเกินไป กรุณาลองใหม่ภายหลัง') {
  return (req, res, next) => {
    const r = limiter.hit(keyFn(req));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: message, retry_after: r.retryAfter });
    }
    next();
  };
}

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

function normalizePhone(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

module.exports = {
  BUILD_ID, uuid, randomToken, sha256, zonedParts, localDate, localMidnight, businessDate,
  rateLimiter, limit, HttpError, clientIp, normalizePhone, pad,
};
