import { api, stream, applyTheme, esc, uuid, connectionBanner, fontsReady } from './common.js';
import { PrinterClient, TRANSPORT_LABEL } from './printer-client.js';
import { renderTicket } from './ticket.js';

const $ = (id) => document.getElementById(id);
const screens = { home: $('screenHome'), pax: $('screenPax'), info: $('screenInfo'), done: $('screenDone') };

let config = null;
let groups = [];
let pax = 2;
let current = null; // last created ticket
let requestId = null;
let submitting = false;
let countdownTimer = null;
let idleTimer = null;
const printer = new PrinterClient();

// ------------------------------------------------------------------ helpers
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  clearTimeout(idleTimer);
  if (name === 'pax' || name === 'info') armIdle();
  if (name !== 'done') stopCountdown();
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => show('home'), 90000);
}
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => {
  if (!screens.pax.hidden || !screens.info.hidden) armIdle();
}, { passive: true }));

function groupFor(n) {
  return groups.find((g) => n >= g.min_pax && n <= g.max_pax) || null;
}
const maxPax = () => (config ? config.max_pax : 12);
const rangeText = (g) => (g.min_pax === g.max_pax ? `${g.min_pax} ท่าน` : `${g.min_pax}–${g.max_pax} ท่าน`);

// ------------------------------------------------------------------ config
let build = null;
let reloadPending = false; // new server version: reload once the customer is done
function applyConfig(c) {
  if (build && c.build !== build) {
    if (!screens.home.hidden) { location.reload(); return; }
    reloadPending = true;
  }
  build = build || c.build;
  config = c;
  groups = c.groups;
  applyTheme(c.store.theme_color);
  document.title = `${c.store.name} · รับบัตรคิว`;
  $('storeName').textContent = c.store.name;
  $('storeSmall').textContent = c.store.name;
  $('welcome').textContent = c.store.welcome_text || '';
  $('startLabel').textContent = c.settings.kiosk_button_label || 'รับบัตรคิว';
  for (const [id, show] of [['logo', true], ['logoSmall', false]]) {
    const img = $(id);
    if (c.store.logo_url) { img.src = c.store.logo_url; img.hidden = !show; img.onerror = () => { img.hidden = true; }; } else img.hidden = true;
  }
  $('nameLabel').innerHTML = c.settings.kiosk_require_name ? 'ชื่อลูกค้า <span style="color:var(--danger)">*</span>' : 'ชื่อลูกค้า <span class="muted">(ไม่บังคับ)</span>';
  $('phoneField').hidden = !c.settings.kiosk_ask_phone;
  printer.setConfig(c.printer);
  renderWaiting();
  renderPax();
  renderPrinterBadge();
}

function renderWaiting() {
  $('waitingSummary').innerHTML = groups.map((g) => `<div class="chip">คิว <b>${esc(g.prefix)}</b> · ${esc(rangeText(g))} · รอ <b>${g.waiting}</b> คิว</div>`).join('');
}

// ------------------------------------------------------------------ pax screen
function buildPaxGrid() {
  const max = Math.min(maxPax(), 24);
  const grid = $('paxGrid');
  grid.innerHTML = '';
  for (let i = 1; i <= max; i += 1) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'k-pax';
    b.dataset.n = i;
    b.innerHTML = `${i}<small>คน</small>`;
    b.onclick = () => { pax = i; renderPax(); };
    grid.appendChild(b);
  }
}

function renderPax() {
  if (!config) return;
  if ($('paxGrid').children.length !== Math.min(maxPax(), 24)) buildPaxGrid();
  for (const b of $('paxGrid').children) b.classList.toggle('on', Number(b.dataset.n) === pax);
  $('paxValue').textContent = pax;
  $('paxMinus').disabled = pax <= 1;
  const g = groupFor(pax);
  const over = pax > maxPax();
  $('overLimit').hidden = !over && !!g;
  if (over || !g) {
    const msg = config.settings.over_limit_message.replace('{max}', maxPax());
    $('overLimit').textContent = config.settings.over_limit_policy === 'deny'
      ? `ขออภัย ไม่สามารถรับคิวสำหรับ ${pax} ท่านได้ (${msg})` : msg;
    $('groupInfo').innerHTML = '';
    $('paxNext').disabled = true;
  } else {
    $('groupInfo').innerHTML = `<div class="k-group-card"><div class="k-group-letter">${esc(g.prefix)}</div>
      <div class="k-group-text">จำนวนลูกค้า: <b>${pax} คน</b><br>ประเภทคิว: <b>${esc(g.prefix)}</b> <span class="muted">(${esc(rangeText(g))})</span> · รออยู่ <b>${g.waiting}</b> คิว</div></div>`;
    $('paxNext').disabled = false;
  }
  $('paxPlus').disabled = pax > maxPax();
}

$('paxMinus').onclick = () => { if (pax > 1) { pax -= 1; renderPax(); } };
$('paxPlus').onclick = () => { if (pax <= maxPax()) { pax += 1; renderPax(); } };
$('paxNext').onclick = () => {
  if (!groupFor(pax)) return;
  requestId = uuid(); // one id per attempt → server dedupes double taps / retries
  const g = groupFor(pax);
  $('infoSummary').innerHTML = `<span class="pill primary">${pax} ท่าน</span><span class="pill primary">คิวประเภท ${esc(g.prefix)}</span>`;
  $('infoError').hidden = true;
  updateSms();
  show('info');
  setTimeout(() => $('custName').focus({ preventScroll: true }), 50);
};

// ------------------------------------------------------------------ info screen
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'ลบ', '0', 'ล้าง'];
$('keypad').innerHTML = keys.map((k) => `<button type="button" data-k="${k}">${k}</button>`).join('');
$('keypad').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (!k) return;
  const input = $('custPhone');
  if (k === 'ลบ') input.value = input.value.slice(0, -1);
  else if (k === 'ล้าง') input.value = '';
  else if (input.value.length < 15) input.value += k;
  updateSms();
});
$('custPhone').addEventListener('input', () => {
  $('custPhone').value = $('custPhone').value.replace(/[^\d+]/g, '');
  updateSms();
});

function updateSms() {
  const enabled = config?.settings.sms_enabled && config.settings.kiosk_ask_phone;
  const hasPhone = $('custPhone').value.replace(/\D/g, '').length >= 9;
  $('smsField').hidden = !enabled;
  $('smsOptIn').disabled = !hasPhone;
  if (!hasPhone) $('smsOptIn').checked = false;
  $('smsField').style.opacity = hasPhone ? 1 : 0.55;
}

$('infoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return; // double-click guard (server also dedupes by request_id)
  const name = $('custName').value.trim();
  const phone = $('custPhone').value.trim();
  const err = $('infoError');
  err.hidden = true;
  if (config.settings.kiosk_require_name && !name) {
    err.textContent = 'กรุณากรอกชื่อลูกค้า'; err.hidden = false; return;
  }
  if (phone && phone.replace(/\D/g, '').length < 9) {
    err.textContent = 'เบอร์โทรศัพท์ไม่ถูกต้อง'; err.hidden = false; return;
  }
  submitting = true;
  const btn = $('confirmBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> กำลังออกบัตรคิว…';
  try {
    const { ticket } = await api('/api/kiosk/queues', {
      method: 'POST',
      body: { pax, name, phone, sms_opt_in: $('smsOptIn').checked, request_id: requestId },
    });
    current = ticket;
    showDone();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    submitting = false;
    btn.disabled = false;
    btn.textContent = 'ยืนยันรับบัตรคิว';
  }
});

document.querySelectorAll('[data-back]').forEach((b) => {
  b.onclick = () => show(!screens.info.hidden ? 'pax' : 'home');
});

// ------------------------------------------------------------------ done screen
let trackStream = null;

function showDone() {
  const t = current;
  $('doneNumber').textContent = t.queue_number;
  $('donePax').textContent = `จำนวน ${t.pax} ท่าน`;
  $('doneName').textContent = t.customer_name ? `ชื่อ: ${t.customer_name}` : '';
  $('doneAhead').textContent = t.ahead;
  $('doneQr').src = t.qr_data_url || '';
  $('doneQr').parentElement.hidden = !t.qr_data_url;
  $('printError').hidden = true;
  $('printStatus').innerHTML = '';
  show('done');
  startCountdown(config.settings.kiosk_return_seconds);
  // Keep "queues ahead" live while the screen is shown.
  trackStream?.close();
  trackStream = stream(`/api/stream/track/${encodeURIComponent(t.tracking_token)}`, {
    state: (d) => { if (current && current.tracking_token === t.tracking_token) $('doneAhead').textContent = d.queue.ahead; },
  });
  if (config.printer.auto_print) doPrint();
  else $('printStatus').textContent = 'กด "พิมพ์อีกครั้ง" เพื่อพิมพ์บัตรคิว';
}

function jobsApi(token) {
  return {
    create: (b) => api('/api/kiosk/print-jobs', { method: 'POST', body: { token, ...b } }),
    update: (id, status, error) => api(`/api/kiosk/print-jobs/${id}`, { method: 'PATCH', body: { token, status, error } }),
    get: (id) => api(`/api/kiosk/print-jobs/${id}?token=${encodeURIComponent(token)}`),
  };
}

let printing = false;
async function doPrint() {
  if (!current || printing) return;
  printing = true;
  $('reprintBtn').disabled = true;
  $('retryPrintBtn').disabled = true;
  $('printError').hidden = true;
  $('printStatus').innerHTML = '<span class="spinner"></span> กำลังพิมพ์บัตรคิว…';
  try {
    // refresh "ahead" for the printout
    const fresh = await api(`/api/kiosk/tickets/${encodeURIComponent(current.tracking_token)}`).catch(() => null);
    if (fresh) current = { ...current, ahead: fresh.ticket.ahead };
    const canvas = await renderTicket(current, { paperWidth: config.printer.paper_width });
    await printer.printCanvas(canvas, jobsApi(current.tracking_token));
    $('printStatus').innerHTML = '<span class="dot ok"></span> พิมพ์บัตรคิวแล้ว กรุณารับบัตรคิวด้านล่าง';
  } catch (e) {
    $('printStatus').innerHTML = '';
    $('printErrorDetail').textContent = e.message || String(e);
    $('connectPrinterBtn').hidden = !printer.direct;
    $('printError').hidden = false;
    startCountdown(Math.max(30, config.settings.kiosk_return_seconds));
  } finally {
    printing = false;
    $('reprintBtn').disabled = false;
    $('retryPrintBtn').disabled = false;
    renderPrinterBadge();
  }
}

$('reprintBtn').onclick = () => { startCountdown(config.settings.kiosk_return_seconds); doPrint(); };
$('retryPrintBtn').onclick = () => doPrint();
$('connectPrinterBtn').onclick = async () => {
  try {
    await printer.connectInteractive();
    renderPrinterBadge();
    doPrint();
  } catch (e) {
    if (e.name !== 'NotFoundError') $('printErrorDetail').textContent = e.message;
  }
};
$('doneBtn').onclick = () => goHome();

function goHome() {
  if (reloadPending) { location.reload(); return; }
  stopCountdown();
  trackStream?.close();
  trackStream = null;
  current = null;
  $('custName').value = '';
  $('custPhone').value = '';
  $('smsOptIn').checked = false;
  pax = 2;
  renderPax();
  show('home');
}

function startCountdown(seconds) {
  stopCountdown();
  let left = seconds;
  $('countdown').textContent = `(${left})`;
  countdownTimer = setInterval(() => {
    left -= 1;
    $('countdown').textContent = `(${left})`;
    if (left <= 0) goHome();
  }, 1000);
}
function stopCountdown() { clearInterval(countdownTimer); countdownTimer = null; $('countdown').textContent = ''; }

// ------------------------------------------------------------------ printer badge (for staff)
function renderPrinterBadge() {
  const s = printer.status();
  $('printerDot').className = `dot ${s.connected ? 'ok' : 'danger'}`;
  $('printerText').textContent = s.connected ? `${TRANSPORT_LABEL[s.type] || ''} พร้อมพิมพ์` : 'เครื่องพิมพ์ไม่ได้เชื่อมต่อ';
}
printer.onChange(renderPrinterBadge);
$('printerBadge').onclick = async () => {
  if (!printer.direct) return;
  try { await printer.connectInteractive(); } catch { /* user cancelled */ }
  renderPrinterBadge();
};

// ------------------------------------------------------------------ misc
$('startBtn').onclick = () => { pax = Math.min(2, maxPax()); renderPax(); show('pax'); };
$('fullscreenBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
};
function tick() {
  const tz = config?.settings.timezone;
  $('clock').textContent = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined }).format(new Date());
}
setInterval(tick, 10000);

async function init() {
  fontsReady();
  try {
    applyConfig(await api('/api/kiosk/config'));
  } catch (e) {
    $('welcome').textContent = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กำลังลองใหม่…';
    setTimeout(init, 3000);
    return;
  }
  tick();
  await printer.autoConnect();
  renderPrinterBadge();
  const banner = connectionBanner();
  stream('/api/stream/kiosk', {
    config: (c) => applyConfig(c),
    groups: (g) => { groups = g; renderWaiting(); renderPax(); },
  }, { onStatus: banner });
  // Re-check direct printer every 30s (USB unplugged etc.)
  setInterval(async () => { if (printer.direct && !printer.status().connected) { await printer.autoConnect(); renderPrinterBadge(); } }, 30000);
}
init();
