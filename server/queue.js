'use strict';
const { db } = require('./db');
const { getSettings } = require('./settings');
const realtime = require('./realtime');
const { uuid, randomToken, businessDate, localDate, localMidnight, HttpError } = require('./util');

const ACTIVE = ['waiting', 'called', 'seated'];

const STATUS_TH = {
  waiting: 'กำลังรอคิว',
  called: 'ถึงคิวของคุณแล้ว',
  seated: 'กำลังให้บริการ',
  completed: 'เสร็จสิ้น',
  cancelled: 'คิวถูกยกเลิก',
  no_show: 'ไม่พบลูกค้า',
};

// --------------------------------------------------------------------------
// Store & groups
// --------------------------------------------------------------------------
const qStore = db.prepare('SELECT * FROM stores WHERE id = ?');
const qGroups = db.prepare('SELECT * FROM queue_groups WHERE store_id = ? ORDER BY sort_order, prefix');

function getStore(storeId) {
  const s = qStore.get(storeId);
  if (!s) throw new HttpError(404, 'ไม่พบร้าน');
  return s;
}

function getGroups(storeId, { activeOnly = false } = {}) {
  const rows = qGroups.all(storeId);
  return activeOnly ? rows.filter((g) => g.active) : rows;
}

function groupForPax(storeId, pax) {
  return getGroups(storeId, { activeOnly: true }).find((g) => pax >= g.min_pax && pax <= g.max_pax) || null;
}

function maxPax(storeId) {
  return getGroups(storeId, { activeOnly: true }).reduce((m, g) => Math.max(m, g.max_pax), 0);
}

function publicStore(storeId) {
  const s = getStore(storeId);
  return { name: s.name, logo_url: s.logo_url, welcome_text: s.welcome_text, theme_color: s.theme_color };
}

// --------------------------------------------------------------------------
// Daily reset / sessions
// --------------------------------------------------------------------------
const logEvent = db.prepare(`INSERT INTO queue_events (queue_id, store_id, event, from_status, to_status, staff_id, note, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

/**
 * Start a new numbering session: counters go back to start_number and,
 * optionally, queues still active get cancelled so numbers can't be confused.
 */
const resetSession = db.transaction((storeId, { cancelActive, staffId = null, reason, newBusinessDate }) => {
  const now = Date.now();
  if (cancelActive) {
    const active = db.prepare(`SELECT id, status FROM queues WHERE store_id = ? AND status IN ('waiting','called','seated')`).all(storeId);
    const upd = db.prepare(`UPDATE queues SET status = 'cancelled', cancelled_at = ? WHERE id = ?`);
    for (const q of active) {
      upd.run(now, q.id);
      logEvent.run(q.id, storeId, 'reset', q.status, 'cancelled', staffId, reason, now);
    }
  }
  db.prepare('UPDATE queue_groups SET last_seq = 0 WHERE store_id = ?').run(storeId);
  db.prepare('UPDATE stores SET queue_session = queue_session + 1, business_date = COALESCE(?, business_date), updated_at = ? WHERE id = ?')
    .run(newBusinessDate || null, now, storeId);
});

/** Called before issuing numbers and periodically: performs the automatic daily reset. */
function ensureBusinessDate(storeId) {
  const s = getSettings(storeId);
  const store = getStore(storeId);
  const today = businessDate(Date.now(), s.timezone, s.auto_reset_enabled ? s.auto_reset_time : '00:00');
  if (!store.business_date) {
    db.prepare('UPDATE stores SET business_date = ? WHERE id = ?').run(today, storeId);
    return false;
  }
  if (store.business_date === today) return false;
  if (!s.auto_reset_enabled) {
    db.prepare('UPDATE stores SET business_date = ? WHERE id = ?').run(today, storeId);
    return false;
  }
  resetSession(storeId, { cancelActive: true, reason: 'รีเซ็ตคิวอัตโนมัติประจำวัน', newBusinessDate: today });
  console.log(`[queue] auto reset store=${storeId} business_date=${today}`);
  realtime.notify(storeId, ['queues', 'settings']);
  return true;
}

// --------------------------------------------------------------------------
// Creating queues (atomic numbering)
// --------------------------------------------------------------------------
const insertCustomer = db.prepare(`INSERT INTO customers (id, store_id, name, phone, sms_opt_in, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const insertQueue = db.prepare(`
  INSERT INTO queues (id, store_id, group_id, queue_session, business_date, queue_number, queue_prefix, sequence, pax,
                      customer_id, customer_name, customer_phone, sms_opt_in, status, tracking_token, request_id, source, created_at)
  VALUES (@id, @store_id, @group_id, @queue_session, @business_date, @queue_number, @queue_prefix, @sequence, @pax,
          @customer_id, @customer_name, @customer_phone, @sms_opt_in, 'waiting', @tracking_token, @request_id, @source, @created_at)`);
const bumpSeq = db.prepare(`UPDATE queue_groups SET last_seq = MAX(last_seq, start_number - 1) + 1 WHERE id = ? RETURNING last_seq`);
const byRequest = db.prepare('SELECT * FROM queues WHERE request_id = ?');
const byId = db.prepare('SELECT * FROM queues WHERE id = ?');
const byToken = db.prepare('SELECT * FROM queues WHERE tracking_token = ?');

/**
 * The whole number allocation happens inside one IMMEDIATE transaction, so
 * concurrent kiosks can never receive the same number (and the UNIQUE index on
 * (store, session, number) backs that up). `request_id` makes the call
 * idempotent: a double-tap / network retry returns the queue already created.
 */
const createQueueTx = db.transaction((p) => {
  if (p.requestId) {
    const existing = byRequest.get(p.requestId);
    if (existing) return { queue: existing, duplicate: true };
  }
  const store = getStore(p.storeId);
  const settings = getSettings(p.storeId);
  const group = groupForPax(p.storeId, p.pax);
  if (!group) {
    const max = maxPax(p.storeId);
    throw new HttpError(422, settings.over_limit_message.replace('{max}', max), { code: 'OVER_LIMIT', max });
  }
  const seq = bumpSeq.get(group.id).last_seq;
  const number = `${group.prefix}${String(seq).padStart(settings.queue_digits, '0')}`;
  const now = Date.now();
  const customerId = uuid();
  insertCustomer.run(customerId, p.storeId, p.name, p.phone, p.smsOptIn ? 1 : 0, now);
  const q = {
    id: uuid(),
    store_id: p.storeId,
    group_id: group.id,
    queue_session: store.queue_session,
    business_date: store.business_date || localDate(now, settings.timezone),
    queue_number: number,
    queue_prefix: group.prefix,
    sequence: seq,
    pax: p.pax,
    customer_id: customerId,
    customer_name: p.name,
    customer_phone: p.phone,
    sms_opt_in: p.smsOptIn && p.phone ? 1 : 0,
    tracking_token: randomToken(24),
    request_id: p.requestId || null,
    source: p.source || 'kiosk',
    created_at: now,
  };
  insertQueue.run(q);
  logEvent.run(q.id, p.storeId, 'created', null, 'waiting', p.staffId || null, p.source || 'kiosk', now);
  return { queue: byId.get(q.id), duplicate: false };
});

function createQueue(params) {
  ensureBusinessDate(params.storeId);
  const pax = Number(params.pax);
  if (!Number.isInteger(pax) || pax < 1 || pax > 999) throw new HttpError(400, 'จำนวนคนไม่ถูกต้อง');
  const settings = getSettings(params.storeId);
  const name = String(params.name || '').trim().slice(0, 80);
  if (settings.kiosk_require_name && !name && params.source !== 'staff') throw new HttpError(400, 'กรุณากรอกชื่อลูกค้า');
  const result = createQueueTx({ ...params, pax, name });
  if (!result.duplicate) realtime.notify(params.storeId, ['queues']);
  return result;
}

// --------------------------------------------------------------------------
// "Queues ahead"
// --------------------------------------------------------------------------
/**
 * Number of queues still WAITING that were issued before this one.
 * Policy "group": only the same A/B/C/D group (tables are allocated by size).
 * Policy "all": every waiting queue in the store, in issue order.
 */
const aheadGroup = db.prepare(`SELECT COUNT(*) c FROM queues
  WHERE store_id = ? AND group_id = ? AND status = 'waiting' AND rowid < (SELECT rowid FROM queues WHERE id = ?)`);
const aheadAll = db.prepare(`SELECT COUNT(*) c FROM queues
  WHERE store_id = ? AND status = 'waiting' AND rowid < (SELECT rowid FROM queues WHERE id = ?)`);

function aheadCount(q, policy) {
  if (q.status !== 'waiting') return 0;
  const p = policy || getSettings(q.store_id).ahead_policy;
  return p === 'all' ? aheadAll.get(q.store_id, q.id).c : aheadGroup.get(q.store_id, q.group_id, q.id).c;
}

// --------------------------------------------------------------------------
// Status transitions
// --------------------------------------------------------------------------
const TRANSITIONS = {
  call:     { from: ['waiting', 'called', 'no_show'], to: 'called' },
  recall:   { from: ['called', 'seated'], to: null },
  seat:     { from: ['waiting', 'called'], to: 'seated' },
  complete: { from: ['called', 'seated', 'waiting'], to: 'completed' },
  no_show:  { from: ['waiting', 'called'], to: 'no_show' },
  cancel:   { from: ['waiting', 'called', 'seated'], to: 'cancelled' },
  restore:  { from: ['cancelled', 'no_show', 'completed', 'called', 'seated'], to: 'waiting' },
};

const callHooks = [];
function onCall(fn) { callHooks.push(fn); }

const transitionTx = db.transaction((queueId, action, staffId, storeId) => {
  const q = byId.get(queueId);
  if (!q || q.store_id !== storeId) throw new HttpError(404, 'ไม่พบคิว');
  const rule = TRANSITIONS[action];
  if (!rule) throw new HttpError(400, 'คำสั่งไม่ถูกต้อง');
  if (!rule.from.includes(q.status)) {
    throw new HttpError(409, `ไม่สามารถ${ACTION_TH[action]}ได้ เนื่องจากคิวอยู่ในสถานะ "${STATUS_TH[q.status]}"`);
  }
  const now = Date.now();
  const sets = [];
  const vals = {};
  const to = rule.to || q.status;
  if (to !== q.status) { sets.push('status = @status'); vals.status = to; }
  switch (action) {
    case 'call':
    case 'recall':
      sets.push('last_called_at = @now', 'call_count = call_count + 1', 'called_by = @staff');
      sets.push('called_at = COALESCE(called_at, @now)');
      break;
    case 'seat': sets.push('seated_at = @now'); break;
    case 'complete': sets.push('completed_at = @now'); break;
    case 'no_show': sets.push('no_show_at = @now'); break;
    case 'cancel': sets.push('cancelled_at = @now'); break;
    case 'restore':
      sets.push('cancelled_at = NULL', 'no_show_at = NULL', 'completed_at = NULL', 'seated_at = NULL',
        'called_at = NULL', 'last_called_at = NULL');
      break;
    default: break;
  }
  vals.now = now; vals.staff = staffId || null; vals.id = queueId;
  db.prepare(`UPDATE queues SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  logEvent.run(queueId, storeId, action, q.status, to, staffId || null, '', now);
  return { before: q, after: byId.get(queueId) };
});

const ACTION_TH = {
  call: 'เรียกคิว', recall: 'เรียกซ้ำ', seat: 'รับลูกค้า', complete: 'จบคิว',
  no_show: 'บันทึกไม่พบลูกค้า', cancel: 'ยกเลิกคิว', restore: 'คืนคิว',
};

function transition(storeId, queueId, action, staffId) {
  const { before, after } = transitionTx(queueId, action, staffId, storeId);
  realtime.notify(storeId, ['queues']);
  if (action === 'call' || action === 'recall') {
    const isRecall = action === 'recall' || before.status === 'called';
    const payload = callPayload(after, isRecall);
    realtime.emit(storeId, 'call', payload, (c) => c.kind === 'display' || c.kind === 'admin');
    realtime.emit(storeId, 'call', payload, (c) => c.kind === 'track' && c.meta.queueId === after.id);
    for (const fn of callHooks) {
      try { fn(after, { recall: isRecall }); } catch (e) { console.error('[queue] call hook', e); }
    }
  }
  return after;
}

function callPayload(q, recall) {
  return { id: q.id, queue_number: q.queue_number, prefix: q.queue_prefix, group_id: q.group_id, recall, at: Date.now() };
}

const nextWaiting = db.prepare(`SELECT id FROM queues WHERE store_id = ? AND group_id = ? AND status = 'waiting' ORDER BY rowid LIMIT 1`);
function callNext(storeId, groupId, staffId) {
  const row = nextWaiting.get(storeId, groupId);
  if (!row) throw new HttpError(404, 'ไม่มีคิวที่รออยู่ในกลุ่มนี้');
  return transition(storeId, row.id, 'call', staffId);
}

// --------------------------------------------------------------------------
// Views
// --------------------------------------------------------------------------
function adminQueue(q) {
  return {
    id: q.id, queue_number: q.queue_number, prefix: q.queue_prefix, group_id: q.group_id, pax: q.pax,
    customer_name: q.customer_name, customer_phone: q.customer_phone, sms_opt_in: !!q.sms_opt_in,
    status: q.status, created_at: q.created_at, called_at: q.called_at, last_called_at: q.last_called_at,
    call_count: q.call_count, seated_at: q.seated_at, completed_at: q.completed_at,
    cancelled_at: q.cancelled_at, no_show_at: q.no_show_at, source: q.source,
    tracking_token: q.tracking_token, queue_session: q.queue_session,
  };
}

function dayStart(storeId) {
  const s = getSettings(storeId);
  return localMidnight(localDate(Date.now(), s.timezone), s.timezone);
}

function stats(storeId) {
  const since = dayStart(storeId);
  const groups = getGroups(storeId);
  const rows = db.prepare(`SELECT group_id, status, COUNT(*) c, SUM(pax) pax FROM queues
                           WHERE store_id = ? AND created_at >= ? GROUP BY group_id, status`).all(storeId, since);
  const activeRows = db.prepare(`SELECT group_id, status, COUNT(*) c FROM queues
                                 WHERE store_id = ? AND status IN ('waiting','called','seated') GROUP BY group_id, status`).all(storeId);
  const wait = db.prepare(`SELECT AVG(called_at - created_at) avg_wait, COUNT(*) n FROM queues
                           WHERE store_id = ? AND created_at >= ? AND called_at IS NOT NULL`).get(storeId, since);
  const per = {};
  for (const g of groups) per[g.id] = { group_id: g.id, prefix: g.prefix, total: 0, pax: 0, waiting: 0, called: 0, seated: 0 };
  let groupsToday = 0; let customersToday = 0; let calledToday = 0;
  for (const r of rows) {
    if (!per[r.group_id]) continue;
    if (r.status !== 'cancelled') {
      per[r.group_id].total += r.c; per[r.group_id].pax += r.pax || 0;
      groupsToday += r.c; customersToday += r.pax || 0;
    }
    if (['called', 'seated', 'completed', 'no_show'].includes(r.status)) calledToday += r.c;
  }
  let waiting = 0; let called = 0; let seated = 0;
  for (const r of activeRows) {
    if (!per[r.group_id]) continue;
    per[r.group_id][r.status] += r.c;
    if (r.status === 'waiting') waiting += r.c;
    if (r.status === 'called') called += r.c;
    if (r.status === 'seated') seated += r.c;
  }
  return {
    waiting, called, seated, called_today: calledToday,
    customers_today: customersToday, groups_today: groupsToday,
    avg_wait_ms: wait.avg_wait ? Math.round(wait.avg_wait) : 0,
    per_group: Object.values(per),
  };
}

function adminSnapshot(storeId) {
  const active = db.prepare(`SELECT * FROM queues WHERE store_id = ? AND status IN ('waiting','called','seated') ORDER BY rowid`).all(storeId);
  const recent = db.prepare(`SELECT * FROM queues WHERE store_id = ? AND status IN ('completed','cancelled','no_show')
                             AND created_at >= ? ORDER BY COALESCE(completed_at, cancelled_at, no_show_at) DESC LIMIT 40`)
    .all(storeId, dayStart(storeId));
  return {
    groups: getGroups(storeId).map(publicGroup),
    active: active.map(adminQueue),
    recent: recent.map(adminQueue),
    stats: stats(storeId),
    server_time: Date.now(),
  };
}

function publicGroup(g) {
  return { id: g.id, prefix: g.prefix, name: g.name, min_pax: g.min_pax, max_pax: g.max_pax, active: !!g.active };
}

/** Board for the public Queue Display: numbers only, never names or phones. */
function displayBoard(storeId) {
  const s = getSettings(storeId);
  const store = getStore(storeId);
  const groups = getGroups(storeId, { activeOnly: true });
  const recentCalled = db.prepare(`SELECT queue_number, status, last_called_at FROM queues
     WHERE store_id = ? AND group_id = ? AND queue_session = ? AND last_called_at IS NOT NULL
       AND status IN ('called','seated','completed')
     ORDER BY last_called_at DESC LIMIT ?`);
  const waitingCount = db.prepare(`SELECT COUNT(*) c FROM queues WHERE store_id = ? AND group_id = ? AND status = 'waiting'`);
  return {
    groups: groups.map((g) => ({
      ...publicGroup(g),
      waiting: waitingCount.get(storeId, g.id).c,
      called: recentCalled.all(storeId, g.id, store.queue_session, s.display_count)
        .map((r) => ({ queue_number: r.queue_number, active: r.status === 'called', at: r.last_called_at })),
    })),
  };
}

/** What a customer sees on their own tracking page — only their own queue. */
function trackingView(q) {
  const policy = getSettings(q.store_id).ahead_policy;
  const group = db.prepare('SELECT prefix, name FROM queue_groups WHERE id = ?').get(q.group_id);
  return {
    queue_number: q.queue_number,
    prefix: q.queue_prefix,
    group_name: group ? group.name : '',
    pax: q.pax,
    customer_name: q.customer_name,
    status: q.status,
    status_text: STATUS_TH[q.status],
    ahead: aheadCount(q, policy),
    created_at: q.created_at,
    called_at: q.called_at,
    last_called_at: q.last_called_at,
    sms_opt_in: !!q.sms_opt_in,
    server_time: Date.now(),
  };
}

function kioskGroups(storeId) {
  const waitingCount = db.prepare(`SELECT COUNT(*) c FROM queues WHERE store_id = ? AND group_id = ? AND status = 'waiting'`);
  return getGroups(storeId, { activeOnly: true }).map((g) => ({ ...publicGroup(g), waiting: waitingCount.get(storeId, g.id).c }));
}

function getByToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
  return byToken.get(token) || null;
}

module.exports = {
  STATUS_TH, ACTIVE, getStore, getGroups, groupForPax, maxPax, publicStore, publicGroup,
  ensureBusinessDate, resetSession, createQueue, aheadCount, transition, callNext, onCall,
  adminQueue, adminSnapshot, stats, displayBoard, trackingView, kioskGroups, getByToken, byId,
  dayStart,
};
