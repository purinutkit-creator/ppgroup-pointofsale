'use strict';
/** Kiosk + customer tracking endpoints. No login; never exposes other customers' data. */
const express = require('express');
const QRCode = require('qrcode');
const { DEFAULT_STORE_ID } = require('../db');
const { publicSettings, getSettings } = require('../settings');
const queueSvc = require('../queue');
const printer = require('../printer');
const realtime = require('../realtime');
const { rateLimiter, limit, clientIp, normalizePhone, HttpError, BUILD_ID } = require('../util');

const router = express.Router();
const STORE = DEFAULT_STORE_ID;

const createLimiter = rateLimiter({ windowMs: 60000, max: Number(process.env.KIOSK_RATE_LIMIT) || 60 });
const printLimiter = rateLimiter({ windowMs: 60000, max: 60 });
const trackLimiter = rateLimiter({ windowMs: 60000, max: 120 });

function baseUrl(req) {
  const configured = getSettings(STORE).public_base_url || process.env.PUBLIC_BASE_URL;
  return (configured || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function kioskConfig() {
  const s = publicSettings(STORE);
  return {
    store: queueSvc.publicStore(STORE),
    settings: s,
    groups: queueSvc.kioskGroups(STORE),
    max_pax: queueSvc.maxPax(STORE),
    printer: printer.publicPrinterSettings(STORE),
    build: BUILD_ID,
  };
}

async function ticketData(req, q) {
  const s = getSettings(STORE);
  const url = `${baseUrl(req)}/queue/track/${q.tracking_token}`;
  const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
  const store = queueSvc.publicStore(STORE);
  return {
    store_name: store.name,
    logo_url: s.ticket_show_logo ? store.logo_url : '',
    queue_number: q.queue_number,
    pax: q.pax,
    customer_name: q.customer_name,
    created_at: q.created_at,
    ahead: queueSvc.aheadCount(q),
    status: q.status,
    tracking_token: q.tracking_token,
    tracking_url: url,
    qr_data_url: s.ticket_show_qr ? qr : '',
    note: s.ticket_note,
    footer: s.ticket_footer,
    timezone: s.timezone,
  };
}

function queueFromToken(token) {
  const q = queueSvc.getByToken(token);
  if (!q || q.store_id !== STORE) throw new HttpError(404, 'ไม่พบคิว');
  return q;
}

// ---------------------------------------------------------------- kiosk
router.get('/api/kiosk/config', (req, res) => {
  queueSvc.ensureBusinessDate(STORE);
  res.json(kioskConfig());
});

router.post('/api/kiosk/queues', limit(createLimiter, clientIp), async (req, res, next) => {
  try {
    const { pax, name, phone, sms_opt_in: smsOptIn, request_id: requestId } = req.body || {};
    const settings = getSettings(STORE);
    const normalized = normalizePhone(phone);
    if (normalized === null) throw new HttpError(400, 'เบอร์โทรศัพท์ไม่ถูกต้อง');
    if (requestId != null && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(requestId))) {
      throw new HttpError(400, 'request_id ไม่ถูกต้อง');
    }
    const { queue } = queueSvc.createQueue({
      storeId: STORE, pax, name, phone: normalized,
      smsOptIn: !!smsOptIn && settings.sms_enabled && !!normalized,
      requestId, source: 'kiosk',
    });
    res.status(201).json({ ticket: await ticketData(req, queue) });
  } catch (e) { next(e); }
});

router.get('/api/kiosk/tickets/:token', limit(printLimiter, clientIp), async (req, res, next) => {
  try {
    res.json({ ticket: await ticketData(req, queueFromToken(req.params.token)) });
  } catch (e) { next(e); }
});

// Same-origin copy of the store logo so the ticket canvas isn't tainted by a
// cross-origin image (canvas pixels must be readable to build the raster).
// Only ever fetches the URL configured by the admin.
const logoCache = { url: null, type: null, body: null, at: 0 };
router.get('/api/kiosk/logo', async (req, res, next) => {
  try {
    const url = queueSvc.getStore(STORE).logo_url;
    if (!url) throw new HttpError(404, 'ไม่มีโลโก้');
    if (logoCache.url !== url || Date.now() - logoCache.at > 10 * 60000) {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.startsWith('image/')) throw new HttpError(502, 'โหลดโลโก้ไม่สำเร็จ');
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > 5 * 1024 * 1024) throw new HttpError(502, 'ไฟล์โลโก้ใหญ่เกินไป');
      Object.assign(logoCache, { url, type, body, at: Date.now() });
    }
    res.set('Content-Type', logoCache.type);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(logoCache.body);
  } catch (e) { next(e.status ? e : new HttpError(502, 'โหลดโลโก้ไม่สำเร็จ')); }
});

// Print jobs created by the kiosk. The ticket's tracking token proves the kiosk issued that queue.
router.post('/api/kiosk/print-jobs', limit(printLimiter, clientIp), async (req, res, next) => {
  try {
    const { token, transport, payload } = req.body || {};
    const q = queueFromToken(token);
    if (Date.now() - q.created_at > 12 * 3600000) throw new HttpError(403, 'บัตรคิวนี้หมดอายุสำหรับการพิมพ์ซ้ำ');
    const job = await printer.createJob({ storeId: STORE, queueId: q.id, kind: 'ticket', transport, payloadB64: payload });
    res.status(201).json({ job });
  } catch (e) { next(e); }
});

function kioskJob(req) {
  const job = printer.qJob.get(req.params.id);
  const token = req.body?.token || req.query.token;
  const q = queueSvc.getByToken(token);
  if (!job || !q || job.queue_id !== q.id) throw new HttpError(404, 'ไม่พบงานพิมพ์');
  return job;
}

router.get('/api/kiosk/print-jobs/:id', limit(printLimiter, clientIp), (req, res, next) => {
  try { res.json({ job: printer.jobView(kioskJob(req)) }); } catch (e) { next(e); }
});

router.patch('/api/kiosk/print-jobs/:id', limit(printLimiter, clientIp), (req, res, next) => {
  try {
    const job = kioskJob(req);
    if (!printer.CLIENT_TRANSPORTS.includes(job.transport)) throw new HttpError(409, 'งานพิมพ์นี้ถูกจัดการโดยเซิร์ฟเวอร์');
    const { status, error } = req.body || {};
    if (!['printing', 'printed', 'failed'].includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
    res.json({ job: printer.jobView(printer.setJobStatus(job.id, status, error || '')) });
  } catch (e) { next(e); }
});

router.get('/api/stream/kiosk', (req, res) => {
  realtime.open(req, res, {
    storeId: STORE, kind: 'kiosk', topics: ['settings', 'queues', 'printer'],
    render: (topic) => (topic === 'queues'
      ? { event: 'groups', data: queueSvc.kioskGroups(STORE) }
      : { event: 'config', data: kioskConfig() }),
  });
});

// ---------------------------------------------------------------- customer tracking
function trackPayload(q) {
  return { store: { ...queueSvc.publicStore(STORE), timezone: getSettings(STORE).timezone }, queue: queueSvc.trackingView(queueSvc.byId.get(q.id)) };
}

router.get('/api/track/:token', limit(trackLimiter, clientIp), (req, res, next) => {
  try { res.json(trackPayload(queueFromToken(req.params.token))); } catch (e) { next(e); }
});

router.get('/api/stream/track/:token', limit(trackLimiter, clientIp), (req, res, next) => {
  let q;
  try { q = queueFromToken(req.params.token); } catch (e) { return next(e); }
  realtime.open(req, res, {
    storeId: STORE, kind: 'track', topics: ['queues', 'settings'], meta: { queueId: q.id },
    render: () => ({ event: 'state', data: trackPayload(q) }),
  });
});

module.exports = router;
