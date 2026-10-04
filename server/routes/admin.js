'use strict';
/** Staff/Admin API. Everything here requires login; settings & staff management require the admin role. */
const express = require('express');
const QRCode = require('qrcode');
const { db, DEFAULT_STORE_ID } = require('../db');
const auth = require('../auth');
const { getSettings, updateSettings, maskSecrets } = require('../settings');
const queueSvc = require('../queue');
const printer = require('../printer');
const sms = require('../sms');
const realtime = require('../realtime');
const displayRoutes = require('./display');
const {
  rateLimiter, limit, clientIp, normalizePhone, HttpError, randomToken, localMidnight, zonedParts, pad,
} = require('../util');

const router = express.Router();
const STORE = DEFAULT_STORE_ID;
const staffOnly = auth.requireStaff('staff');
const adminOnly = auth.requireStaff('admin');
const loginLimiter = rateLimiter({ windowMs: 15 * 60000, max: 10 });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ================================================================== auth
router.get('/api/auth/status', (req, res) => {
  const staff = auth.staffFromRequest(req);
  res.json({
    needs_setup: !auth.hasStaff(),
    user: staff && { id: staff.id, username: staff.username, display_name: staff.display_name, role: staff.role },
  });
});

router.post('/api/auth/setup', limit(loginLimiter, clientIp), (req, res) => {
  if (auth.hasStaff()) throw new HttpError(409, 'ระบบถูกตั้งค่าแล้ว');
  const { username, password, display_name: displayName, store_name: storeName } = req.body || {};
  const id = auth.createStaff({ username, password, displayName, role: 'admin' });
  if (typeof storeName === 'string' && storeName.trim()) {
    db.prepare('UPDATE stores SET name = ?, updated_at = ? WHERE id = ?').run(storeName.trim().slice(0, 120), Date.now(), STORE);
  }
  auth.setSessionCookie(req, res, auth.createSession(id));
  res.status(201).json({ ok: true });
});

router.post('/api/auth/login', limit(loginLimiter, (req) => `${clientIp(req)}:${String(req.body?.username || '').toLowerCase()}`,
  'เข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ 15 นาที'), (req, res) => {
  const { username, password } = req.body || {};
  const row = typeof username === 'string' && db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
  if (!row || !row.active || typeof password !== 'string' || !auth.verifyPassword(password, row.password_hash)) {
    throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  auth.setSessionCookie(req, res, auth.createSession(row.id));
  res.json({ ok: true, user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role } });
});

router.post('/api/auth/logout', (req, res) => {
  const staff = auth.staffFromRequest(req);
  if (staff) auth.destroySession(staff.token_hash);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

router.post('/api/auth/password', staffOnly, (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.staff.id);
  if (!auth.verifyPassword(String(current || ''), row.password_hash)) throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  auth.validatePassword(next);
  db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), row.id);
  db.prepare('DELETE FROM sessions WHERE staff_id = ? AND token_hash != ?').run(row.id, req.staff.token_hash);
  res.json({ ok: true });
});

// ================================================================== queue control
router.get('/api/admin/snapshot', staffOnly, (req, res) => {
  queueSvc.ensureBusinessDate(STORE);
  res.json(queueSvc.adminSnapshot(STORE));
});

router.post('/api/admin/queues', staffOnly, wrap(async (req, res) => {
  const { pax, name, phone, sms_opt_in: smsOptIn } = req.body || {};
  const normalized = normalizePhone(phone);
  if (normalized === null) throw new HttpError(400, 'เบอร์โทรศัพท์ไม่ถูกต้อง');
  const { queue } = queueSvc.createQueue({
    storeId: STORE, pax, name, phone: normalized, smsOptIn: !!smsOptIn && getSettings(STORE).sms_enabled,
    source: 'staff', staffId: req.staff.id,
  });
  res.status(201).json({ queue: queueSvc.adminQueue(queue) });
}));

router.get('/api/admin/queues/:id', staffOnly, wrap(async (req, res) => {
  const q = queueSvc.byId.get(req.params.id);
  if (!q || q.store_id !== STORE) throw new HttpError(404, 'ไม่พบคิว');
  const events = db.prepare(`SELECT e.event, e.from_status, e.to_status, e.note, e.created_at, s.display_name staff_name
                             FROM queue_events e LEFT JOIN staff s ON s.id = e.staff_id WHERE e.queue_id = ? ORDER BY e.id`).all(q.id);
  const calledBy = q.called_by ? db.prepare('SELECT display_name FROM staff WHERE id = ?').get(q.called_by) : null;
  res.json({ queue: { ...queueSvc.adminQueue(q), ahead: queueSvc.aheadCount(q), called_by_name: calledBy?.display_name || '' }, events });
}));

// Ticket data so staff can (re)print a ticket from the dashboard.
router.get('/api/admin/queues/:id/ticket', staffOnly, wrap(async (req, res) => {
  const q = queueSvc.byId.get(req.params.id);
  if (!q || q.store_id !== STORE) throw new HttpError(404, 'ไม่พบคิว');
  const s = getSettings(STORE);
  const base = (s.public_base_url || process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const url = `${base}/queue/track/${q.tracking_token}`;
  const store = queueSvc.publicStore(STORE);
  res.json({
    ticket: {
      store_name: store.name, logo_url: s.ticket_show_logo ? store.logo_url : '', queue_number: q.queue_number,
      pax: q.pax, customer_name: q.customer_name, created_at: q.created_at, ahead: queueSvc.aheadCount(q),
      tracking_token: q.tracking_token, tracking_url: url,
      qr_data_url: s.ticket_show_qr ? await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 360 }) : '',
      note: s.ticket_note, footer: s.ticket_footer, timezone: s.timezone,
    },
  });
}));

const ACTIONS = ['call', 'recall', 'seat', 'complete', 'no_show', 'cancel', 'restore'];
router.post('/api/admin/queues/:id/:action', staffOnly, (req, res) => {
  if (!ACTIONS.includes(req.params.action)) throw new HttpError(404, 'ไม่พบคำสั่ง');
  const q = queueSvc.transition(STORE, req.params.id, req.params.action, req.staff.id);
  res.json({ queue: queueSvc.adminQueue(q) });
});

router.post('/api/admin/groups/:id/call-next', staffOnly, (req, res) => {
  const q = queueSvc.callNext(STORE, Number(req.params.id), req.staff.id);
  res.json({ queue: queueSvc.adminQueue(q) });
});

router.post('/api/admin/queue/reset', adminOnly, (req, res) => {
  const cancelActive = req.body?.cancel_active !== false;
  queueSvc.resetSession(STORE, { cancelActive, staffId: req.staff.id, reason: 'รีเซ็ตหมายเลขคิวโดยผู้ดูแล' });
  realtime.notify(STORE, ['queues', 'settings']);
  res.json({ ok: true });
});

// ================================================================== history
function historyQuery(q) {
  const s = getSettings(STORE);
  const where = ['q.store_id = ?'];
  const args = [STORE];
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (isDate(q.from)) { where.push('q.created_at >= ?'); args.push(localMidnight(q.from, s.timezone)); }
  if (isDate(q.to)) { where.push('q.created_at < ?'); args.push(localMidnight(q.to, s.timezone) + 86400000); }
  if (q.prefix) { where.push('q.queue_prefix = ?'); args.push(String(q.prefix)); }
  if (q.status) { where.push('q.status = ?'); args.push(String(q.status)); }
  if (q.q) {
    const term = `%${String(q.q).trim().replace(/[%_]/g, '')}%`;
    where.push('(q.queue_number LIKE ? OR q.customer_name LIKE ? OR q.customer_phone LIKE ?)');
    args.push(term, term, term);
  }
  return { sql: where.join(' AND '), args };
}

router.get('/api/admin/history', staffOnly, (req, res) => {
  const { sql, args } = historyQuery(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(10, Number(req.query.size) || 50));
  const total = db.prepare(`SELECT COUNT(*) c FROM queues q WHERE ${sql}`).get(...args).c;
  const rows = db.prepare(`SELECT q.*, s.display_name called_by_name FROM queues q LEFT JOIN staff s ON s.id = q.called_by
                           WHERE ${sql} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  const summary = db.prepare(`SELECT COUNT(*) n, SUM(pax) pax, AVG(CASE WHEN called_at IS NOT NULL THEN called_at - created_at END) avg_wait
                              FROM queues q WHERE ${sql} AND q.status != 'cancelled'`).get(...args);
  res.json({
    total, page, size, summary,
    rows: rows.map((r) => ({ ...queueSvc.adminQueue(r), called_by_name: r.called_by_name || '' })),
  });
});

router.get('/api/admin/history.csv', staffOnly, (req, res) => {
  const { sql, args } = historyQuery(req.query);
  const s = getSettings(STORE);
  const rows = db.prepare(`SELECT q.* FROM queues q WHERE ${sql} ORDER BY q.created_at DESC LIMIT 50000`).all(...args);
  const fmt = (ts) => {
    if (!ts) return '';
    const p = zonedParts(ts, s.timezone);
    return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}:${pad(p.s)}`;
  };
  const esc = (v) => {
    let str = String(v ?? '');
    if (/^[=+\-@]/.test(str)) str = `'${str}`; // CSV formula injection guard
    return `"${str.replace(/"/g, '""')}"`;
  };
  const header = ['queue_number', 'type', 'pax', 'customer_name', 'customer_phone', 'status', 'created_at', 'called_at', 'seated_at', 'completed_at', 'cancelled_at', 'no_show_at', 'wait_minutes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const wait = r.called_at ? ((r.called_at - r.created_at) / 60000).toFixed(1) : '';
    lines.push([r.queue_number, r.queue_prefix, r.pax, r.customer_name, r.customer_phone, r.status, fmt(r.created_at), fmt(r.called_at),
      fmt(r.seated_at), fmt(r.completed_at), fmt(r.cancelled_at), fmt(r.no_show_at), wait].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="queue-history-${Date.now()}.csv"`);
  res.send(`﻿${lines.join('\r\n')}`);
});

// ================================================================== store settings
function adminConfig(req) {
  const store = queueSvc.getStore(STORE);
  return {
    store: { name: store.name, logo_url: store.logo_url, welcome_text: store.welcome_text, theme_color: store.theme_color },
    settings: maskSecrets(getSettings(STORE)),
    groups: queueSvc.getGroups(STORE).map((g) => ({ ...queueSvc.publicGroup(g), start_number: g.start_number, last_seq: g.last_seq })),
    promotions: db.prepare('SELECT * FROM promotion_images WHERE store_id = ? ORDER BY sort_order, id').all(STORE),
    detected_base_url: `${req.protocol}://${req.get('host')}`,
  };
}

router.get('/api/admin/config', staffOnly, (req, res) => res.json(adminConfig(req)));

const isImageUrl = (v) => {
  if (v === '') return true;
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol); } catch { return false; }
};

router.put('/api/admin/store', adminOnly, (req, res) => {
  const { name, logo_url: logo, welcome_text: welcome, theme_color: theme } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'กรุณากรอกชื่อร้าน');
  if (typeof logo !== 'string' || !isImageUrl(logo.trim())) throw new HttpError(400, 'URL โลโก้ไม่ถูกต้อง (ต้องขึ้นต้นด้วย http:// หรือ https://)');
  if (typeof theme !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(theme)) throw new HttpError(400, 'สี Theme ไม่ถูกต้อง');
  db.prepare('UPDATE stores SET name = ?, logo_url = ?, welcome_text = ?, theme_color = ?, updated_at = ? WHERE id = ?')
    .run(name.trim().slice(0, 120), logo.trim(), String(welcome || '').slice(0, 300), theme, Date.now(), STORE);
  realtime.notify(STORE, ['settings']);
  res.json(adminConfig(req));
});

router.put('/api/admin/settings', adminOnly, (req, res) => {
  const { errors } = updateSettings(STORE, req.body || {});
  if (Object.keys(errors).length) {
    throw new HttpError(400, `ค่าบางรายการไม่ถูกต้อง: ${Object.keys(errors).join(', ')}`, { fields: errors });
  }
  realtime.notify(STORE, ['settings', 'queues']);
  res.json(adminConfig(req));
});

router.put('/api/admin/groups', adminOnly, (req, res) => {
  const input = Array.isArray(req.body?.groups) ? req.body.groups : null;
  if (!input || !input.length) throw new HttpError(400, 'ต้องมีกลุ่มคิวอย่างน้อย 1 กลุ่ม');
  const clean = input.map((g, i) => {
    const prefix = String(g.prefix || '').trim().toUpperCase();
    if (!/^[A-Z]{1,2}$/.test(prefix)) throw new HttpError(400, `ตัวอักษรคิว "${prefix}" ไม่ถูกต้อง (A–Z 1–2 ตัว)`);
    const min = Number(g.min_pax); const max = Number(g.max_pax); const start = Number(g.start_number ?? 1);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 999) {
      throw new HttpError(400, `ช่วงจำนวนคนของกลุ่ม ${prefix} ไม่ถูกต้อง`);
    }
    if (!Number.isInteger(start) || start < 0 || start > 99999) throw new HttpError(400, `เลขเริ่มต้นของกลุ่ม ${prefix} ไม่ถูกต้อง`);
    return { id: g.id ? Number(g.id) : null, prefix, name: String(g.name || '').slice(0, 60), min, max, start, active: g.active !== false, order: i };
  });
  const prefixes = new Set();
  for (const g of clean) {
    if (prefixes.has(g.prefix)) throw new HttpError(400, `ตัวอักษร ${g.prefix} ซ้ำกัน`);
    prefixes.add(g.prefix);
  }
  const active = clean.filter((g) => g.active).sort((a, b) => a.min - b.min);
  for (let i = 1; i < active.length; i += 1) {
    if (active[i].min <= active[i - 1].max) {
      throw new HttpError(400, `ช่วงจำนวนคนของกลุ่ม ${active[i - 1].prefix} และ ${active[i].prefix} ทับซ้อนกัน`);
    }
  }
  if (!active.length) throw new HttpError(400, 'ต้องเปิดใช้งานอย่างน้อย 1 กลุ่ม');
  const existing = queueSvc.getGroups(STORE);
  const keepIds = new Set(clean.filter((g) => g.id).map((g) => g.id));
  db.transaction(() => {
    for (const old of existing) {
      if (keepIds.has(old.id)) continue;
      const used = db.prepare('SELECT COUNT(*) c FROM queues WHERE group_id = ?').get(old.id).c;
      if (used) db.prepare('UPDATE queue_groups SET active = 0, prefix = ? WHERE id = ?').run(`~${old.id}`, old.id);
      else db.prepare('DELETE FROM queue_groups WHERE id = ?').run(old.id);
    }
    // temporary prefixes avoid UNIQUE clashes when letters are swapped between groups
    for (const g of clean) if (g.id) db.prepare('UPDATE queue_groups SET prefix = ? WHERE id = ? AND store_id = ?').run(`#${g.id}`, g.id, STORE);
    for (const g of clean) {
      if (g.id && existing.some((e) => e.id === g.id)) {
        db.prepare(`UPDATE queue_groups SET prefix = ?, name = ?, min_pax = ?, max_pax = ?, start_number = ?, active = ?, sort_order = ?
                    WHERE id = ? AND store_id = ?`).run(g.prefix, g.name, g.min, g.max, g.start, g.active ? 1 : 0, g.order, g.id, STORE);
      } else {
        db.prepare(`INSERT INTO queue_groups (store_id, prefix, name, min_pax, max_pax, start_number, active, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(STORE, g.prefix, g.name, g.min, g.max, g.start, g.active ? 1 : 0, g.order);
      }
    }
  })();
  realtime.notify(STORE, ['settings', 'queues']);
  res.json(adminConfig(req));
});

// ================================================================== promotions
router.post('/api/admin/promotions', adminOnly, (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !isImageUrl(url)) throw new HttpError(400, 'URL รูปภาพไม่ถูกต้อง');
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM promotion_images WHERE store_id = ?').get(STORE).m;
  db.prepare('INSERT INTO promotion_images (store_id, url, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(STORE, url, String(req.body?.title || '').slice(0, 120), max + 1, Date.now());
  realtime.notify(STORE, ['promos']);
  res.status(201).json(adminConfig(req));
});

router.put('/api/admin/promotions/order', adminOnly, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  const upd = db.prepare('UPDATE promotion_images SET sort_order = ? WHERE id = ? AND store_id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, STORE)))();
  realtime.notify(STORE, ['promos']);
  res.json(adminConfig(req));
});

router.put('/api/admin/promotions/:id', adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM promotion_images WHERE id = ? AND store_id = ?').get(Number(req.params.id), STORE);
  if (!p) throw new HttpError(404, 'ไม่พบรูปภาพ');
  const url = req.body?.url !== undefined ? String(req.body.url).trim() : p.url;
  if (!isImageUrl(url) || !url) throw new HttpError(400, 'URL รูปภาพไม่ถูกต้อง');
  db.prepare('UPDATE promotion_images SET url = ?, title = ?, active = ? WHERE id = ?')
    .run(url, req.body?.title !== undefined ? String(req.body.title).slice(0, 120) : p.title,
      req.body?.active !== undefined ? (req.body.active ? 1 : 0) : p.active, p.id);
  realtime.notify(STORE, ['promos']);
  res.json(adminConfig(req));
});

router.delete('/api/admin/promotions/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM promotion_images WHERE id = ? AND store_id = ?').run(Number(req.params.id), STORE);
  realtime.notify(STORE, ['promos']);
  res.json(adminConfig(req));
});

// ================================================================== printer
function printerView() {
  const p = printer.getPrinterSettings(STORE);
  return {
    ...p,
    auto_print: !!p.auto_print, cut_paper: !!p.cut_paper,
    agent_online: printer.agentOnline(STORE, p.printer_number),
    agents: printer.listAgents(STORE),
  };
}

router.get('/api/admin/printer', staffOnly, (req, res) => {
  const v = printerView();
  if (req.staff.role !== 'admin') delete v.agent_key;
  res.json({ printer: v, jobs: printer.recentJobs(STORE) });
});

router.put('/api/admin/printer', adminOnly, (req, res) => {
  const b = req.body || {};
  const type = b.connection_type;
  if (!['usb', 'lan', 'wifi', 'bluetooth', 'serial', 'printer_number', 'browser'].includes(type)) throw new HttpError(400, 'ประเภทการเชื่อมต่อไม่ถูกต้อง');
  const width = Number(b.paper_width);
  if (![58, 80].includes(width)) throw new HttpError(400, 'ขนาดกระดาษไม่ถูกต้อง');
  const ip = String(b.ip || '').trim();
  const port = Number(b.port || 9100);
  if ((type === 'lan' || type === 'wifi') && !printer.isValidIp(ip)) throw new HttpError(400, 'กรุณากรอก IP Address ให้ถูกต้อง');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port ไม่ถูกต้อง');
  const number = String(b.printer_number || '').trim().slice(0, 60);
  if (type === 'printer_number' && !number) throw new HttpError(400, 'กรุณากรอก Printer ID / Printer Number');
  const copies = Math.min(5, Math.max(1, Number(b.copies) || 1));
  db.prepare(`UPDATE printer_settings SET connection_type = ?, paper_width = ?, ip = ?, port = ?, printer_number = ?, device_label = ?,
              auto_print = ?, copies = ?, cut_paper = ?, updated_at = ? WHERE store_id = ?`)
    .run(type, width, ip, port, number, String(b.device_label || '').slice(0, 120), b.auto_print ? 1 : 0, copies, b.cut_paper ? 1 : 0, Date.now(), STORE);
  realtime.notify(STORE, ['settings', 'printer']);
  res.json({ printer: printerView() });
});

router.post('/api/admin/printer/test-connection', staffOnly, wrap(async (req, res) => {
  const p = printer.getPrinterSettings(STORE);
  const type = req.body?.connection_type || p.connection_type;
  let result;
  if (type === 'lan' || type === 'wifi') {
    const ip = String(req.body?.ip || p.ip).trim();
    const port = Number(req.body?.port || p.port);
    try {
      result = { connected: true, ...(await printer.tcpTest(ip, port)), message: `เชื่อมต่อ ${ip}:${port} สำเร็จ` };
    } catch (e) {
      result = { connected: false, message: `เชื่อมต่อ ${ip}:${port} ไม่สำเร็จ: ${e.message}` };
    }
  } else if (type === 'printer_number') {
    const number = String(req.body?.printer_number || p.printer_number).trim();
    const online = printer.agentOnline(STORE, number);
    result = { connected: online, message: online ? `Print Agent ของเครื่องพิมพ์ ${number} ออนไลน์` : `ไม่พบ Print Agent ของเครื่องพิมพ์ ${number} ที่ออนไลน์อยู่` };
  } else {
    throw new HttpError(400, 'การเชื่อมต่อประเภทนี้ตรวจสอบได้จากเบราว์เซอร์ของเครื่องที่ต่อเครื่องพิมพ์');
  }
  db.prepare('UPDATE printer_settings SET last_status = ?, last_checked_at = ? WHERE store_id = ?')
    .run(result.connected ? 'connected' : 'disconnected', Date.now(), STORE);
  realtime.notify(STORE, ['printer']);
  res.json(result);
}));

// Jobs from the admin page: test prints & reprints (client transports report back with PATCH).
router.post('/api/admin/print-jobs', staffOnly, wrap(async (req, res) => {
  const { transport, payload, queue_id: queueId, kind } = req.body || {};
  if (queueId) {
    const q = queueSvc.byId.get(queueId);
    if (!q || q.store_id !== STORE) throw new HttpError(404, 'ไม่พบคิว');
  }
  const job = await printer.createJob({ storeId: STORE, queueId: queueId || null, kind: kind === 'test' ? 'test' : 'ticket', transport, payloadB64: payload });
  res.status(201).json({ job });
}));

router.get('/api/admin/print-jobs/:id', staffOnly, (req, res) => {
  const job = printer.qJob.get(req.params.id);
  if (!job || job.store_id !== STORE) throw new HttpError(404, 'ไม่พบงานพิมพ์');
  res.json({ job: printer.jobView(job) });
});

router.patch('/api/admin/print-jobs/:id', staffOnly, (req, res) => {
  const job = printer.qJob.get(req.params.id);
  if (!job || job.store_id !== STORE) throw new HttpError(404, 'ไม่พบงานพิมพ์');
  if (!printer.CLIENT_TRANSPORTS.includes(job.transport)) throw new HttpError(409, 'งานพิมพ์นี้ถูกจัดการโดยเซิร์ฟเวอร์');
  const { status, error } = req.body || {};
  if (!['printing', 'printed', 'failed'].includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  res.json({ job: printer.jobView(printer.setJobStatus(job.id, status, error || '')) });
});

router.post('/api/admin/print-jobs/:id/retry', staffOnly, wrap(async (req, res) => {
  res.json({ job: await printer.retryJob(STORE, req.params.id) });
}));

router.post('/api/admin/printer/agent-key', adminOnly, (req, res) => {
  db.prepare('UPDATE printer_settings SET agent_key = ?, updated_at = ? WHERE store_id = ?').run(randomToken(24), Date.now(), STORE);
  res.json({ printer: printerView() });
});

// ================================================================== displays
router.get('/api/admin/displays', staffOnly, (req, res) => res.json({ devices: displayRoutes.listDevices(STORE) }));

router.post('/api/admin/displays/pairing-code', adminOnly, (req, res) => {
  res.status(201).json(displayRoutes.generatePairingCode(STORE, req.staff.id));
});

router.patch('/api/admin/displays/:id', adminOnly, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'กรุณากรอกชื่อหน้าจอ');
  const r = db.prepare('UPDATE display_devices SET name = ? WHERE id = ? AND store_id = ? AND revoked_at IS NULL').run(name, req.params.id, STORE);
  if (!r.changes) throw new HttpError(404, 'ไม่พบหน้าจอ');
  realtime.notify(STORE, ['displays', 'settings']);
  res.json({ devices: displayRoutes.listDevices(STORE) });
});

router.delete('/api/admin/displays/:id', adminOnly, (req, res) => {
  const r = db.prepare('UPDATE display_devices SET revoked_at = ? WHERE id = ? AND store_id = ? AND revoked_at IS NULL').run(Date.now(), req.params.id, STORE);
  if (!r.changes) throw new HttpError(404, 'ไม่พบหน้าจอ');
  realtime.emit(STORE, 'revoked', {}, (c) => c.kind === 'display' && c.meta.deviceId === req.params.id);
  realtime.notify(STORE, ['displays']);
  res.json({ devices: displayRoutes.listDevices(STORE) });
});

// ================================================================== staff
const staffView = (s) => ({ id: s.id, username: s.username, display_name: s.display_name, role: s.role, active: !!s.active, created_at: s.created_at, last_login_at: s.last_login_at });

router.get('/api/admin/staff', adminOnly, (req, res) => {
  res.json({ staff: db.prepare('SELECT * FROM staff WHERE store_id = ? ORDER BY id').all(STORE).map(staffView) });
});

router.post('/api/admin/staff', adminOnly, (req, res) => {
  const { username, password, display_name: displayName, role } = req.body || {};
  auth.createStaff({ storeId: STORE, username, password, displayName, role: role || 'staff' });
  res.status(201).json({ staff: db.prepare('SELECT * FROM staff WHERE store_id = ? ORDER BY id').all(STORE).map(staffView) });
});

router.put('/api/admin/staff/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT * FROM staff WHERE id = ? AND store_id = ?').get(id, STORE);
  if (!s) throw new HttpError(404, 'ไม่พบพนักงาน');
  const b = req.body || {};
  const role = b.role || s.role;
  if (!['admin', 'staff'].includes(role)) throw new HttpError(400, 'สิทธิ์ไม่ถูกต้อง');
  const active = b.active === undefined ? !!s.active : !!b.active;
  if (id === req.staff.id && (role !== 'admin' || !active)) throw new HttpError(400, 'ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
  db.prepare('UPDATE staff SET display_name = ?, role = ?, active = ? WHERE id = ?')
    .run(String(b.display_name ?? s.display_name).slice(0, 80), role, active ? 1 : 0, id);
  if (b.password) {
    auth.validatePassword(b.password);
    db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), id);
    db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(id);
  res.json({ staff: db.prepare('SELECT * FROM staff WHERE store_id = ? ORDER BY id').all(STORE).map(staffView) });
});

router.delete('/api/admin/staff/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.staff.id) throw new HttpError(400, 'ไม่สามารถลบบัญชีของตัวเองได้');
  db.prepare('UPDATE queues SET called_by = NULL WHERE called_by = ?').run(id);
  db.prepare('DELETE FROM staff WHERE id = ? AND store_id = ?').run(id, STORE);
  res.json({ staff: db.prepare('SELECT * FROM staff WHERE store_id = ? ORDER BY id').all(STORE).map(staffView) });
});

// ================================================================== sms
router.post('/api/admin/sms/test', adminOnly, wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) throw new HttpError(400, 'กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง');
  const store = queueSvc.getStore(STORE);
  const result = await sms.send(STORE, { phone, message: `${store.name}: ทดสอบการส่ง SMS จากระบบบัตรคิว`, kind: 'test' });
  if (!result.ok) throw new HttpError(502, `ส่ง SMS ไม่สำเร็จ: ${result.error}`);
  res.json({ ok: true });
}));

router.get('/api/admin/sms/logs', adminOnly, (req, res) => res.json({ logs: sms.recentLogs(STORE) }));

// ================================================================== realtime stream
router.get('/api/stream/admin', staffOnly, (req, res) => {
  const isAdmin = req.staff.role === 'admin';
  realtime.open(req, res, {
    storeId: STORE, kind: 'admin', topics: ['queues', 'displays', 'printjobs', 'printer', 'settings', 'promos', 'sms'],
    render: (topic) => {
      switch (topic) {
        case 'queues': return { event: 'snapshot', data: queueSvc.adminSnapshot(STORE) };
        case 'displays': return { event: 'displays', data: displayRoutes.listDevices(STORE) };
        case 'printjobs': return { event: 'printjobs', data: printer.recentJobs(STORE) };
        case 'printer': {
          const v = printerView();
          if (!isAdmin) delete v.agent_key;
          return { event: 'printer', data: v };
        }
        case 'sms': return isAdmin ? { event: 'sms', data: sms.recentLogs(STORE, 20) } : null;
        default: return { event: 'config', data: { changed: topic, at: Date.now() } };
      }
    },
  });
});

// the displays list's "online" flag decays with time, so refresh it periodically
setInterval(() => realtime.notify(STORE, ['displays', 'printer']), 15000).unref();

module.exports = router;
