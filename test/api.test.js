'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qms-test-'));
process.env.DATA_DIR = DATA;
process.env.COOKIE_SECURE = 'false';
process.env.KIOSK_RATE_LIMIT = '1000';
const app = require('../server/index');

let server;
let base;
let cookie = '';

async function req(method, url, body, { auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth && cookie) h.Cookie = cookie;
  if (method !== 'GET') h['X-QMS'] = '1';
  const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie && setCookie.startsWith('qms_sid=')) cookie = setCookie.split(';')[0];
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const kiosk = (body) => req('POST', '/api/kiosk/queues', body, { auth: false });

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('first-run setup creates admin and logs in', async () => {
  let r = await req('GET', '/api/auth/status');
  assert.equal(r.data.needs_setup, true);
  r = await req('POST', '/api/auth/setup', { username: 'owner', password: 'password123', store_name: 'ร้านทดสอบ' });
  assert.equal(r.status, 201);
  r = await req('GET', '/api/auth/status');
  assert.equal(r.data.user.role, 'admin');
  r = await req('POST', '/api/auth/setup', { username: 'x', password: 'password123' });
  assert.equal(r.status, 409);
});

test('admin APIs require login and CSRF header', async () => {
  let r = await req('GET', '/api/admin/snapshot', undefined, { auth: false });
  assert.equal(r.status, 401);
  const res = await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('pax maps to groups A/B/C/D and numbers are per group', async () => {
  const cases = [[1, 'A001'], [3, 'B001'], [4, 'B002'], [6, 'C001'], [10, 'D001'], [1, 'A002']];
  for (const [pax, expected] of cases) {
    const r = await kiosk({ pax, name: 'T' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.ticket.queue_number, expected);
    assert.match(r.data.ticket.qr_data_url, /^data:image\/png;base64,/);
    assert.match(r.data.ticket.tracking_url, /\/queue\/track\/[A-Za-z0-9_-]{30,}$/);
  }
  const over = await kiosk({ pax: 13 });
  assert.equal(over.status, 422);
  assert.equal(over.data.code, 'OVER_LIMIT');
});

test('concurrent kiosks never get the same number', async () => {
  const results = await Promise.all(Array.from({ length: 40 }, () => kiosk({ pax: 2 })));
  const numbers = results.map((r) => r.data.ticket.queue_number);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('request_id makes queue creation idempotent (double click)', async () => {
  const body = { pax: 5, name: 'Dup', request_id: 'req-12345678' };
  const [a, b] = await Promise.all([kiosk(body), kiosk(body)]);
  assert.equal(a.data.ticket.queue_number, b.data.ticket.queue_number);
  assert.equal(a.data.ticket.tracking_token, b.data.ticket.tracking_token);
});

test('queues ahead decreases as staff call / cancel earlier queues', async () => {
  await req('POST', '/api/admin/queue/reset', { cancel_active: true });
  const q1 = (await kiosk({ pax: 7 })).data.ticket;
  const q2 = (await kiosk({ pax: 8 })).data.ticket;
  const q3 = (await kiosk({ pax: 9, name: 'Punpun', phone: '0812345678' })).data.ticket;
  assert.equal(q1.queue_number, 'D001');
  assert.equal(q3.ahead, 2);
  const snap = (await req('GET', '/api/admin/snapshot')).data;
  const id = (n) => snap.active.find((q) => q.queue_number === n).id;
  await req('POST', `/api/admin/queues/${id('D001')}/call`);
  let t = (await req('GET', `/api/track/${q3.tracking_token}`, undefined, { auth: false })).data;
  assert.equal(t.queue.ahead, 1);
  await req('POST', `/api/admin/queues/${id('D002')}/cancel`);
  t = (await req('GET', `/api/track/${q3.tracking_token}`, undefined, { auth: false })).data;
  assert.equal(t.queue.ahead, 0);
  const call = await req('POST', `/api/admin/queues/${id('D003')}/call`);
  assert.equal(call.data.queue.status, 'called');
  t = (await req('GET', `/api/track/${q3.tracking_token}`, undefined, { auth: false })).data;
  assert.equal(t.queue.status, 'called');
  assert.equal(t.queue.status_text, 'ถึงคิวของคุณแล้ว');
  // tracking API never exposes other customers / phone / admin data
  assert.equal(t.queue.customer_phone, undefined);
  assert.equal(t.queue.id, undefined);
  assert.equal(JSON.stringify(t).includes(q1.tracking_token), false);
  void q2;
});

test('invalid transitions are rejected', async () => {
  const q = (await kiosk({ pax: 1 })).data.ticket;
  const snap = (await req('GET', '/api/admin/snapshot')).data;
  const id = snap.active.find((x) => x.tracking_token === q.tracking_token).id;
  const r = await req('POST', `/api/admin/queues/${id}/recall`);
  assert.equal(r.status, 409);
});

test('display pairing: one-time code, token auth, board without personal data', async () => {
  const code = (await req('POST', '/api/admin/displays/pairing-code')).data.code;
  assert.match(code, /^\d{6}$/);
  const p = await req('POST', '/api/display/pair', { code }, { auth: false });
  assert.equal(p.status, 201);
  const reuse = await req('POST', '/api/display/pair', { code }, { auth: false });
  assert.equal(reuse.status, 400);
  const st = await req('GET', '/api/display/state', undefined, { auth: false, headers: { Authorization: `Bearer ${p.data.token}` } });
  assert.equal(st.status, 200);
  const json = JSON.stringify(st.data);
  assert.equal(json.includes('Punpun'), false);
  assert.equal(json.includes('0812345678'), false);
  assert.ok(st.data.board.groups.find((g) => g.prefix === 'D').called.some((c) => c.queue_number === 'D003'));
  const devices = (await req('GET', '/api/admin/displays')).data.devices;
  await req('DELETE', `/api/admin/displays/${devices[0].id}`);
  const after = await req('GET', '/api/display/state', undefined, { auth: false, headers: { Authorization: `Bearer ${p.data.token}` } });
  assert.equal(after.status, 401);
});

test('pairing brute force is rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i += 1) last = await req('POST', '/api/display/pair', { code: String(100000 + i) }, { auth: false });
  assert.equal(last.status, 429);
});

test('LAN print job is sent to the printer over TCP; failure keeps the queue', async () => {
  const received = [];
  const fake = net.createServer((s) => { const chunks = []; s.on('data', (d) => chunks.push(d)); s.on('end', () => received.push(Buffer.concat(chunks))); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  let r = await req('PUT', '/api/admin/printer', { connection_type: 'lan', paper_width: 80, ip: '127.0.0.1', port, copies: 1, auto_print: true, cut_paper: true });
  assert.equal(r.status, 200);
  r = await req('POST', '/api/admin/printer/test-connection', {});
  assert.equal(r.data.connected, true);
  const q = (await kiosk({ pax: 2 })).data.ticket;
  const payload = Buffer.from([0x1b, 0x40, 0x41, 0x0a]).toString('base64');
  r = await req('POST', '/api/kiosk/print-jobs', { token: q.tracking_token, transport: 'lan', payload }, { auth: false });
  assert.equal(r.data.job.status, 'printed');
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual([...received[received.length - 1]], [0x1b, 0x40, 0x41, 0x0a]);
  fake.close();
  await new Promise((res) => setTimeout(res, 50));
  r = await req('POST', '/api/kiosk/print-jobs', { token: q.tracking_token, transport: 'lan', payload }, { auth: false });
  assert.equal(r.data.job.status, 'failed');
  const t = await req('GET', `/api/track/${q.tracking_token}`, undefined, { auth: false });
  assert.equal(t.data.queue.status, 'waiting');
});

test('print agent receives jobs for its printer number', async () => {
  await req('PUT', '/api/admin/printer', { connection_type: 'printer_number', paper_width: 58, printer_number: 'P1', port: 9100, copies: 1, auto_print: true, cut_paper: true });
  const key = (await req('GET', '/api/admin/printer')).data.printer.agent_key;
  const q = (await kiosk({ pax: 2 })).data.ticket;
  const job = (await req('POST', '/api/kiosk/print-jobs', { token: q.tracking_token, transport: 'printer_number', payload: 'G0A=' }, { auth: false })).data.job;
  assert.equal(job.status, 'pending');
  const ah = { 'X-Agent-Key': key, 'X-Printer-Number': 'P1' };
  const jobs = (await req('GET', '/api/agent/jobs', undefined, { auth: false, headers: ah })).data.jobs;
  assert.equal(jobs.length, 1);
  await req('POST', `/api/agent/jobs/${jobs[0].id}/status`, { status: 'printed' }, { auth: false, headers: ah });
  const st = (await req('GET', `/api/kiosk/print-jobs/${job.id}?token=${q.tracking_token}`, undefined, { auth: false })).data.job;
  assert.equal(st.status, 'printed');
  const bad = await req('GET', '/api/agent/jobs', undefined, { auth: false, headers: { 'X-Agent-Key': 'wrong-key-wrong-key', 'X-Printer-Number': 'P1' } });
  assert.equal(bad.status, 401);
});

test('groups can be edited (new E group for 13-20 pax)', async () => {
  const cfg = (await req('GET', '/api/admin/config')).data;
  const groups = cfg.groups.map((g) => ({ ...g }));
  groups.push({ prefix: 'E', name: '13–20 ท่าน', min_pax: 13, max_pax: 20, start_number: 1, active: true });
  let r = await req('PUT', '/api/admin/groups', { groups });
  assert.equal(r.status, 200);
  r = await kiosk({ pax: 15 });
  assert.equal(r.data.ticket.queue_number, 'E001');
  const overlap = groups.map((g) => (g.prefix === 'E' ? { ...g, min_pax: 12 } : g));
  r = await req('PUT', '/api/admin/groups', { groups: overlap });
  assert.equal(r.status, 400);
});

test('history search and CSV export', async () => {
  let r = await req('GET', '/api/admin/history?q=Punpun');
  assert.equal(r.status, 200);
  assert.equal(r.data.rows.length, 1);
  assert.equal(r.data.rows[0].queue_number, 'D003');
  r = await req('GET', '/api/admin/history.csv?prefix=D');
  assert.match(r.data, /queue_number,type,pax/);
});

test('staff role cannot change settings', async () => {
  await req('POST', '/api/admin/staff', { username: 'staff1', password: 'password123', role: 'staff' });
  const adminCookie = cookie;
  cookie = '';
  await req('POST', '/api/auth/login', { username: 'staff1', password: 'password123' });
  let r = await req('PUT', '/api/admin/settings', { marquee_text: 'x' });
  assert.equal(r.status, 403);
  r = await req('GET', '/api/admin/snapshot');
  assert.equal(r.status, 200);
  cookie = adminCookie;
});

test('SMS is sent to opted-in customers when their queue is called', async () => {
  const http = require('http');
  const received = [];
  const hook = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', (d) => { b += d; });
    rq.on('end', () => { received.push({ auth: rq.headers.authorization, body: JSON.parse(b) }); rs.end('{"ok":true}'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  let r = await req('PUT', '/api/admin/settings', {
    sms_enabled: true, sms_provider: 'webhook', sms_webhook_url: `http://127.0.0.1:${hook.address().port}/sms`,
    sms_webhook_auth: 'Bearer secret', public_base_url: 'https://queue.example.com',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.sms_webhook_auth, '••••••••'); // secrets are masked
  const q = (await kiosk({ pax: 1, name: 'SMS', phone: '0899999999', sms_opt_in: true })).data.ticket;
  const noOpt = (await kiosk({ pax: 1, phone: '0888888888', sms_opt_in: false })).data.ticket;
  const snap = (await req('GET', '/api/admin/snapshot')).data;
  const id = (t) => snap.active.find((x) => x.tracking_token === t.tracking_token).id;
  await req('POST', `/api/admin/queues/${id(q)}/call`);
  await req('POST', `/api/admin/queues/${id(noOpt)}/call`);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, 'Bearer secret');
  assert.equal(received[0].body.to, '0899999999');
  assert.equal(received[0].body.to_e164, '+66899999999');
  assert.match(received[0].body.message, new RegExp(`${q.queue_number}.*https://queue\\.example\\.com/queue/track/${q.tracking_token}`));
  // recall does not resend by default
  await req('POST', `/api/admin/queues/${id(q)}/recall`);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(received.length, 1);
  hook.close();
});
