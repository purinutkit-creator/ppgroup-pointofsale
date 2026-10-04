'use strict';
/**
 * SMS notifications for customers who opted in at the kiosk.
 * Providers: ThaiBulkSMS (api-v2), Twilio, or a generic JSON webhook
 * (for any other gateway). Every attempt is written to sms_logs.
 */
const { db } = require('./db');
const { getSettings } = require('./settings');
const queueSvc = require('./queue');
const realtime = require('./realtime');

function trackingUrl(storeId, token, fallbackBase) {
  const base = getSettings(storeId).public_base_url || fallbackBase || process.env.PUBLIC_BASE_URL || '';
  return base ? `${base.replace(/\/+$/, '')}/queue/track/${token}` : '';
}

function toE164(phone, cc) {
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('0')) return `+${cc}${phone.slice(1)}`;
  return `+${phone}`;
}

function toThaiLocal(phone) {
  // ThaiBulkSMS accepts 0XXXXXXXXX or 66XXXXXXXXX
  if (phone.startsWith('+')) return phone.slice(1);
  return phone;
}

async function sendRaw(storeId, phone, message) {
  const s = getSettings(storeId);
  const timeout = AbortSignal.timeout(15000);
  if (s.sms_provider === 'thaibulksms') {
    if (!s.sms_tbs_key || !s.sms_tbs_secret) throw new Error('ยังไม่ได้ตั้งค่า API Key/Secret ของ ThaiBulkSMS');
    const body = new URLSearchParams({ msisdn: toThaiLocal(phone), message });
    if (s.sms_tbs_sender) body.set('sender', s.sms_tbs_sender);
    const r = await fetch('https://api-v2.thaibulksms.com/sms', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.sms_tbs_key}:${s.sms_tbs_secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      },
      body, signal: timeout,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`ThaiBulkSMS ${r.status}: ${text.slice(0, 200)}`);
    return text;
  }
  if (s.sms_provider === 'twilio') {
    if (!s.sms_twilio_sid || !s.sms_twilio_token || !s.sms_twilio_from) throw new Error('ยังไม่ได้ตั้งค่า Twilio');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.sms_twilio_sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.sms_twilio_sid}:${s.sms_twilio_token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(phone, s.sms_country_code), From: s.sms_twilio_from, Body: message }),
      signal: timeout,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Twilio ${r.status}: ${text.slice(0, 200)}`);
    return text;
  }
  if (s.sms_provider === 'webhook') {
    if (!s.sms_webhook_url) throw new Error('ยังไม่ได้ตั้งค่า Webhook URL');
    const headers = { 'Content-Type': 'application/json' };
    if (s.sms_webhook_auth) headers.Authorization = s.sms_webhook_auth;
    const r = await fetch(s.sms_webhook_url, {
      method: 'POST', headers, signal: timeout,
      body: JSON.stringify({ to: phone, to_e164: toE164(phone, s.sms_country_code), message }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Webhook ${r.status}: ${text.slice(0, 200)}`);
    return text;
  }
  throw new Error('ไม่รู้จักผู้ให้บริการ SMS');
}

function render(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)).replace(/\s+$/, '');
}

async function send(storeId, { phone, message, queueId = null, kind = 'manual' }) {
  const s = getSettings(storeId);
  const log = db.prepare(`INSERT INTO sms_logs (store_id, queue_id, phone, message, kind, provider, status, error, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    await sendRaw(storeId, phone, message);
    log.run(storeId, queueId, phone, message, kind, s.sms_provider, 'sent', '', Date.now());
    return { ok: true };
  } catch (e) {
    log.run(storeId, queueId, phone, message, kind, s.sms_provider, 'failed', String(e.message || e).slice(0, 500), Date.now());
    console.error('[sms] failed', e.message);
    return { ok: false, error: e.message };
  } finally {
    realtime.notify(storeId, ['sms']);
  }
}

function varsFor(q, extra = {}) {
  const store = queueSvc.getStore(q.store_id);
  return { store: store.name, queue: q.queue_number, name: q.customer_name, pax: q.pax, url: trackingUrl(q.store_id, q.tracking_token), ...extra };
}

// "It's your turn" SMS when staff calls the queue.
queueSvc.onCall((q, { recall }) => {
  const s = getSettings(q.store_id);
  if (!s.sms_enabled || !q.sms_opt_in || !q.customer_phone) return;
  if (recall && !s.sms_resend_on_recall) return;
  if (!recall && q.sms_called_sent_at) return;
  db.prepare('UPDATE queues SET sms_called_sent_at = ? WHERE id = ?').run(Date.now(), q.id);
  send(q.store_id, { phone: q.customer_phone, message: render(s.sms_template_called, varsFor(q)), queueId: q.id, kind: 'called' });
});

// "Almost your turn" SMS whenever the queue list changes.
realtime.onFlush((storeId, topics) => {
  if (!topics.has('queues')) return;
  const s = getSettings(storeId);
  if (!s.sms_enabled || !s.sms_near_threshold) return;
  const candidates = db.prepare(`SELECT * FROM queues WHERE store_id = ? AND status = 'waiting' AND sms_opt_in = 1
                                 AND customer_phone != '' AND sms_near_sent_at IS NULL`).all(storeId);
  for (const q of candidates) {
    const ahead = queueSvc.aheadCount(q, s.ahead_policy);
    // Skip brand-new tickets (they just saw the count on the kiosk) and the queue at the front.
    if (ahead < 1 || ahead > s.sms_near_threshold || Date.now() - q.created_at < 120000) continue;
    db.prepare('UPDATE queues SET sms_near_sent_at = ? WHERE id = ?').run(Date.now(), q.id);
    send(storeId, { phone: q.customer_phone, message: render(s.sms_template_near, varsFor(q, { ahead })), queueId: q.id, kind: 'near' });
  }
});

function recentLogs(storeId, limit = 50) {
  return db.prepare('SELECT * FROM sms_logs WHERE store_id = ? ORDER BY id DESC LIMIT ?').all(storeId, limit);
}

module.exports = { send, render, recentLogs, trackingUrl };
