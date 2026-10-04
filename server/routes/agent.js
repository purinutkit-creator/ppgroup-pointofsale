'use strict';
/** API used by the Local Print Agent (agent/print-agent.js). Auth: X-Agent-Key header (or ?key= for SSE). */
const express = require('express');
const printer = require('../printer');
const realtime = require('../realtime');
const { HttpError } = require('../util');

const router = express.Router();

function requireAgent(req, res, next) {
  const key = req.get('X-Agent-Key') || req.query.key;
  const a = printer.agentFromKey(key);
  if (!a) return res.status(401).json({ error: 'Agent key ไม่ถูกต้อง' });
  const number = String(req.get('X-Printer-Number') || req.query.printer || '').trim();
  if (!number) return res.status(400).json({ error: 'ต้องระบุ Printer Number' });
  req.agent = { storeId: a.store_id, printerNumber: number };
  next();
}

router.post('/api/agent/heartbeat', requireAgent, (req, res) => {
  printer.agentHeartbeat(req.agent.storeId, req.agent.printerNumber, req.body?.info);
  res.json({ ok: true, server_time: Date.now() });
});

router.get('/api/agent/jobs', requireAgent, (req, res) => {
  const jobs = printer.pendingAgentJobs(req.agent.storeId, req.agent.printerNumber);
  for (const j of jobs) printer.setJobStatus(j.id, 'printing');
  res.json({ jobs });
});

router.post('/api/agent/jobs/:id/status', requireAgent, (req, res) => {
  const job = printer.qJob.get(req.params.id);
  if (!job || job.store_id !== req.agent.storeId || job.printer_number !== req.agent.printerNumber) throw new HttpError(404, 'ไม่พบงานพิมพ์');
  const { status, error } = req.body || {};
  if (!['printed', 'failed'].includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  res.json({ job: printer.jobView(printer.setJobStatus(job.id, status, error || '')) });
});

router.get('/api/agent/stream', requireAgent, (req, res) => {
  const { storeId, printerNumber } = req.agent;
  printer.agentHeartbeat(storeId, printerNumber, req.query.info);
  realtime.open(req, res, {
    storeId, kind: 'agent', topics: ['printjobs'], meta: { printerNumber },
    render: () => ({ event: 'jobs', data: { pending: printer.pendingAgentJobs(storeId, printerNumber).length } }),
  });
});

module.exports = router;
