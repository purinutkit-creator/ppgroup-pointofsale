#!/usr/bin/env node
'use strict';
/**
 * Local Print Agent
 * -----------------
 * Runs on a computer inside the shop. It connects to the queue server (local or
 * cloud), receives print jobs for its Printer Number in real time (SSE) and
 * sends the raw ESC/POS bytes to the printer.
 *
 * Environment variables:
 *   SERVER_URL      e.g. https://queue.example.com
 *   AGENT_KEY       from Admin → เครื่องพิมพ์ → Printer Number
 *   PRINTER_NUMBER  e.g. 01  (must match the Printer Number in Admin)
 *   PRINTER_TARGET  where to send bytes:
 *                     tcp://192.168.1.100:9100      network printer (LAN / Wi-Fi)
 *                     file:///dev/usb/lp0            USB printer on Linux
 *                     file://\\\\localhost\\POS80     shared printer on Windows
 *                     stdout                          debugging
 *
 * Requires Node.js 18+ (no npm dependencies).
 */
const net = require('net');
const fs = require('fs');
const os = require('os');

const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';
const PRINTER_NUMBER = process.env.PRINTER_NUMBER || '';
const TARGET = process.env.PRINTER_TARGET || '';

if (!AGENT_KEY || !PRINTER_NUMBER || !TARGET) {
  console.error('Missing AGENT_KEY, PRINTER_NUMBER or PRINTER_TARGET. See header of agent/print-agent.js');
  process.exit(1);
}

const headers = { 'X-Agent-Key': AGENT_KEY, 'X-Printer-Number': PRINTER_NUMBER, 'Content-Type': 'application/json' };
const info = `${os.hostname()} → ${TARGET}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function sendTcp(host, port, buf) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('printer timeout')); }, 15000);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    sock.once('connect', () => sock.end(buf));
    sock.once('close', (hadError) => { clearTimeout(timer); if (!hadError) resolve(); });
  });
}

async function printBytes(buf) {
  if (TARGET === 'stdout') { process.stdout.write(`[${buf.length} bytes]\n`); return; }
  if (TARGET.startsWith('tcp://')) {
    const u = new URL(TARGET);
    return sendTcp(u.hostname, Number(u.port) || 9100, buf);
  }
  if (TARGET.startsWith('file://')) {
    const path = TARGET.slice('file://'.length);
    await fs.promises.writeFile(path, buf);
    return;
  }
  throw new Error(`Unsupported PRINTER_TARGET: ${TARGET}`);
}

async function call(path, opts = {}) {
  const r = await fetch(`${SERVER_URL}${path}`, { ...opts, headers });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

let busy = false;
let again = false;
async function drain() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      const { jobs } = await call('/api/agent/jobs');
      for (const job of jobs) {
        try {
          await printBytes(Buffer.from(job.payload, 'base64'));
          await call(`/api/agent/jobs/${job.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'printed' }) });
          log('printed', job.id, job.kind);
        } catch (e) {
          log('FAILED', job.id, e.message);
          await call(`/api/agent/jobs/${job.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'failed', error: e.message }) }).catch(() => {});
        }
      }
      if (jobs.length) again = true;
    } while (again);
  } catch (e) {
    log('drain error:', e.message);
  } finally { busy = false; }
}

/** Minimal SSE client over fetch so the agent reacts instantly to new jobs. */
async function listen() {
  for (;;) {
    try {
      const url = `${SERVER_URL}/api/agent/stream?printer=${encodeURIComponent(PRINTER_NUMBER)}&info=${encodeURIComponent(info)}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`stream HTTP ${r.status}`);
      log(`connected to ${SERVER_URL} as printer "${PRINTER_NUMBER}" → ${TARGET}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: jobs/m.test(block)) drain();
        }
      }
      throw new Error('stream closed');
    } catch (e) {
      log('disconnected:', e.message, '— retrying in 5s');
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

setInterval(() => {
  call('/api/agent/heartbeat', { method: 'POST', body: JSON.stringify({ info }) }).catch((e) => log('heartbeat:', e.message));
  drain(); // safety net in case an SSE event was missed
}, 20000);

listen();
drain();
