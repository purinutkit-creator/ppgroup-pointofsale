'use strict';
/**
 * Server-side print transports and the print job queue.
 *
 *   usb / bluetooth / serial / browser -> the kiosk browser talks to the printer
 *        directly (WebUSB / Web Bluetooth / Web Serial / OS print dialog) and
 *        reports the result back so the job queue stays accurate.
 *   lan / wifi -> this server opens a raw TCP socket (port 9100) to the printer.
 *        Requires the server to be on the same network as the printer.
 *   printer_number -> a Local Print Agent (agent/print-agent.js) running in the
 *        shop picks jobs for its printer number over SSE and prints them.
 *
 * Payloads are ESC/POS byte streams produced by the browser, which renders the
 * ticket with Noto Sans Thai to a bitmap (GS v 0 raster) so Thai text prints
 * correctly even on printers without a Thai code page.
 */
const net = require('net');
const { db } = require('./db');
const realtime = require('./realtime');
const { uuid, HttpError } = require('./util');

const CLIENT_TRANSPORTS = ['usb', 'bluetooth', 'serial', 'browser'];
const SERVER_TRANSPORTS = ['lan', 'wifi'];
const AGENT_TRANSPORTS = ['printer_number'];
const ALL_TRANSPORTS = [...CLIENT_TRANSPORTS, ...SERVER_TRANSPORTS, ...AGENT_TRANSPORTS];
const MAX_PAYLOAD = 1.5 * 1024 * 1024;
const AGENT_ONLINE_MS = 45000;

function getPrinterSettings(storeId) {
  return db.prepare('SELECT * FROM printer_settings WHERE store_id = ?').get(storeId);
}

function publicPrinterSettings(storeId) {
  const p = getPrinterSettings(storeId);
  return {
    connection_type: p.connection_type, paper_width: p.paper_width, printer_number: p.printer_number,
    device_label: p.device_label, auto_print: !!p.auto_print, copies: p.copies, cut_paper: !!p.cut_paper,
    agent_online: p.connection_type === 'printer_number' ? agentOnline(storeId, p.printer_number) : undefined,
  };
}

function isValidIp(ip) {
  return net.isIP(ip) !== 0 || /^[a-zA-Z0-9.-]{1,253}$/.test(ip);
}

function tcpConnect(ip, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('หมดเวลาเชื่อมต่อ (timeout)')); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function tcpTest(ip, port) {
  if (!isValidIp(ip)) throw new HttpError(400, 'IP Address ไม่ถูกต้อง');
  const started = Date.now();
  const sock = await tcpConnect(ip, port);
  sock.destroy();
  return { ok: true, latency_ms: Date.now() - started };
}

async function tcpPrint(ip, port, buf) {
  if (!isValidIp(ip)) throw new Error('IP Address ไม่ถูกต้อง');
  const sock = await tcpConnect(ip, port);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.destroy(); reject(new Error('ส่งข้อมูลไม่สำเร็จ (timeout)')); }, 15000);
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
    sock.write(buf, () => sock.end());
    sock.once('close', () => { clearTimeout(t); resolve(); });
  });
}

function decodePayload(b64) {
  if (typeof b64 !== 'string' || !b64) throw new HttpError(400, 'ไม่มีข้อมูลสำหรับพิมพ์');
  if (b64.length > MAX_PAYLOAD * 1.4) throw new HttpError(413, 'ข้อมูลพิมพ์ใหญ่เกินไป');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(400, 'ข้อมูลพิมพ์ไม่ถูกต้อง');
  return buf;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
const qJob = db.prepare('SELECT * FROM print_jobs WHERE id = ?');

function jobView(j) {
  if (!j) return null;
  const q = j.queue_id ? db.prepare('SELECT queue_number FROM queues WHERE id = ?').get(j.queue_id) : null;
  return {
    id: j.id, queue_id: j.queue_id, queue_number: q ? q.queue_number : null, kind: j.kind, transport: j.transport,
    printer_number: j.printer_number, status: j.status, error: j.error, attempts: j.attempts,
    created_at: j.created_at, updated_at: j.updated_at, printed_at: j.printed_at, has_payload: !!j.payload,
  };
}

function setJobStatus(id, status, error = '') {
  const now = Date.now();
  db.prepare(`UPDATE print_jobs SET status = ?, error = ?, updated_at = ?,
              printed_at = CASE WHEN ? = 'printed' THEN ? ELSE printed_at END,
              attempts = attempts + CASE WHEN ? = 'printing' THEN 1 ELSE 0 END WHERE id = ?`)
    .run(status, String(error).slice(0, 500), now, status, now, status, id);
  const job = qJob.get(id);
  if (job) {
    if (status === 'printed' || status === 'failed') {
      db.prepare('UPDATE printer_settings SET last_status = ?, last_checked_at = ? WHERE store_id = ?')
        .run(status === 'printed' ? 'connected' : 'disconnected', now, job.store_id);
    }
    realtime.notify(job.store_id, ['printjobs', 'printer']);
  }
  return job;
}

/**
 * Create a job and, for server-side transports, dispatch it.
 * Returns the job view after dispatch (LAN) or immediately (others).
 */
async function createJob({ storeId, queueId = null, kind = 'ticket', transport, payloadB64 }) {
  if (!ALL_TRANSPORTS.includes(transport)) throw new HttpError(400, 'ประเภทการเชื่อมต่อไม่ถูกต้อง');
  const settings = getPrinterSettings(storeId);
  const needsPayload = !CLIENT_TRANSPORTS.includes(transport);
  const payload = needsPayload ? decodePayload(payloadB64).toString('base64') : null;
  const id = uuid();
  const now = Date.now();
  db.prepare(`INSERT INTO print_jobs (id, store_id, queue_id, kind, transport, printer_number, status, payload, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, storeId, queueId, kind, transport, transport === 'printer_number' ? settings.printer_number : '',
      CLIENT_TRANSPORTS.includes(transport) ? 'printing' : 'pending', payload, now, now);
  realtime.notify(storeId, ['printjobs']);
  if (SERVER_TRANSPORTS.includes(transport)) await dispatchServerJob(id);
  return jobView(qJob.get(id));
}

async function dispatchServerJob(id) {
  const job = qJob.get(id);
  if (!job || !job.payload) return;
  if (AGENT_TRANSPORTS.includes(job.transport)) {
    setJobStatus(id, 'pending');
    return;
  }
  const s = getPrinterSettings(job.store_id);
  setJobStatus(id, 'printing');
  try {
    if (!s.ip) throw new Error('ยังไม่ได้ตั้งค่า IP เครื่องพิมพ์');
    await tcpPrint(s.ip, s.port, Buffer.from(job.payload, 'base64'));
    setJobStatus(id, 'printed');
  } catch (e) {
    setJobStatus(id, 'failed', e.message || String(e));
  }
}

function retryJob(storeId, id) {
  const job = qJob.get(id);
  if (!job || job.store_id !== storeId) throw new HttpError(404, 'ไม่พบงานพิมพ์');
  if (!job.payload) throw new HttpError(409, 'งานพิมพ์นี้ต้องสั่งพิมพ์ใหม่จากหน้าเครื่อง Kiosk');
  if (job.transport === 'printer_number') { setJobStatus(id, 'pending'); return jobView(qJob.get(id)); }
  return dispatchServerJob(id).then(() => jobView(qJob.get(id)));
}

function recentJobs(storeId, limit = 50) {
  return db.prepare('SELECT * FROM print_jobs WHERE store_id = ? ORDER BY created_at DESC LIMIT ?').all(storeId, limit).map(jobView);
}

// ---------------------------------------------------------------------------
// Local print agent
// ---------------------------------------------------------------------------
function agentFromKey(key) {
  if (typeof key !== 'string' || key.length < 16) return null;
  return db.prepare('SELECT store_id FROM printer_settings WHERE agent_key = ?').get(key) || null;
}

function agentHeartbeat(storeId, printerNumber, info) {
  db.prepare(`INSERT INTO print_agents (store_id, printer_number, info, last_seen_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(store_id, printer_number) DO UPDATE SET info = excluded.info, last_seen_at = excluded.last_seen_at`)
    .run(storeId, String(printerNumber).slice(0, 60), String(info || '').slice(0, 300), Date.now());
  realtime.notify(storeId, ['printer']);
}

function agentOnline(storeId, printerNumber) {
  const row = db.prepare('SELECT last_seen_at FROM print_agents WHERE store_id = ? AND printer_number = ?').get(storeId, printerNumber);
  return !!row && Date.now() - row.last_seen_at < AGENT_ONLINE_MS;
}

function listAgents(storeId) {
  return db.prepare('SELECT printer_number, info, last_seen_at FROM print_agents WHERE store_id = ? ORDER BY last_seen_at DESC').all(storeId)
    .map((a) => ({ ...a, online: Date.now() - a.last_seen_at < AGENT_ONLINE_MS }));
}

function pendingAgentJobs(storeId, printerNumber) {
  // Jobs stuck in "printing" for over 2 minutes (agent crashed mid-job) are offered again.
  return db.prepare(`SELECT id, kind, payload, created_at FROM print_jobs
                     WHERE store_id = ? AND transport = 'printer_number' AND printer_number = ?
                       AND (status = 'pending' OR (status = 'printing' AND updated_at < ?))
                     ORDER BY created_at LIMIT 10`).all(storeId, printerNumber, Date.now() - 120000);
}

// housekeeping: drop payloads after a day and job rows after 30 days
setInterval(() => {
  const now = Date.now();
  db.prepare(`UPDATE print_jobs SET payload = NULL WHERE payload IS NOT NULL AND created_at < ?`).run(now - 86400000);
  db.prepare(`DELETE FROM print_jobs WHERE created_at < ?`).run(now - 30 * 86400000);
}, 3600000).unref();

module.exports = {
  ALL_TRANSPORTS, CLIENT_TRANSPORTS, getPrinterSettings, publicPrinterSettings, tcpTest, createJob, setJobStatus,
  retryJob, recentJobs, jobView, qJob, agentFromKey, agentHeartbeat, agentOnline, listAgents, pendingAgentJobs,
  isValidIp,
};
