'use strict';
// On Render the public https URL is provided automatically; use it for QR codes / SMS links.
if (!process.env.PUBLIC_BASE_URL && process.env.RENDER_EXTERNAL_URL) process.env.PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL;
const path = require('path');
const express = require('express');
const { DEFAULT_STORE_ID } = require('./db');
const queueSvc = require('./queue');
require('./sms'); // registers SMS hooks
const publicRoutes = require('./routes/public');
const displayRoutes = require('./routes/display');
const adminRoutes = require('./routes/admin');
const agentRoutes = require('./routes/agent');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const tp = process.env.TRUST_PROXY;
if (tp) app.set('trust proxy', tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '3mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, time: Date.now() }));

app.use(publicRoutes);
app.use(displayRoutes.router);
app.use(adminRoutes);
app.use(agentRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ----- static front-end -----
app.use('/fonts/noto-sans-thai', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource', 'noto-sans-thai'), { maxAge: '30d', immutable: true }));
// no-cache = always revalidate (ETag), so a deploy reaches kiosks/displays immediately
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const page = (file) => (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, file));
};
app.get('/kiosk', page('kiosk.html'));
app.get(['/admin', '/admin/*'], page('admin.html'));
app.get('/display', page('display.html'));
app.get('/display/pair', page('pair.html'));
app.get('/queue/track/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'track.html'));
});

// ----- errors -----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'ข้อมูลใหญ่เกินไป' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'เกิดข้อผิดพลาดในระบบ' : err.message, ...(err.extra || {}) });
});

// daily auto-reset check
setInterval(() => {
  try { queueSvc.ensureBusinessDate(DEFAULT_STORE_ID); } catch (e) { console.error('[reset]', e); }
}, 30000).unref();
queueSvc.ensureBusinessDate(DEFAULT_STORE_ID);

if (require.main === module) {
  app.listen(PORT, () => console.log(`Queue system running on http://localhost:${PORT}`));
}

module.exports = app;
