import {
  api, stream, applyTheme, esc, toast, modal, confirmDialog, fmtTime, fmtDateTime, fmtDuration,
  STATUS_TH, STATUS_CLASS, connectionBanner, fontsReady,
} from './common.js';
import { announce, unlockAudio } from './voice.js';
import { PrinterClient } from './printer-client.js';
import { renderTicket } from './ticket.js';
import * as settingsViews from './admin-settings.js';
import * as printerView from './admin-printer.js';

const $ = (id) => document.getElementById(id);

export const state = {
  me: null,
  snapshot: null,
  config: null,
  displays: [],
  printer: null,
  printjobs: [],
  sms: [],
};
export const printer = new PrinterClient();

// ====================================================================== auth
let needsSetup = false;

async function boot() {
  fontsReady();
  let status;
  try { status = await api('/api/auth/status'); } catch (e) { toast(e.message, 'error'); setTimeout(boot, 3000); return; }
  needsSetup = status.needs_setup;
  if (!status.user) return showAuth();
  state.me = status.user;
  startApp();
}

function showAuth() {
  $('appView').hidden = true;
  $('authView').hidden = false;
  document.querySelectorAll('[data-setup]').forEach((el) => { el.hidden = !needsSetup; });
  $('authTitle').textContent = needsSetup ? 'ตั้งค่าระบบครั้งแรก' : 'เข้าสู่ระบบ';
  $('authSubtitle').textContent = needsSetup ? 'สร้างบัญชีผู้ดูแลระบบ (Admin) สำหรับร้านของคุณ' : 'สำหรับผู้ดูแลระบบและพนักงาน';
  $('authSubmit').textContent = needsSetup ? 'สร้างบัญชีและเริ่มใช้งาน' : 'เข้าสู่ระบบ';
  $('authPass').autocomplete = needsSetup ? 'new-password' : 'current-password';
  $('authUser').focus();
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('authSubmit');
  btn.disabled = true;
  $('authError').hidden = true;
  try {
    if (needsSetup) {
      await api('/api/auth/setup', {
        method: 'POST',
        body: { username: $('authUser').value.trim(), password: $('authPass').value, display_name: $('setupName').value.trim(), store_name: $('setupStore').value.trim() },
      });
    } else {
      await api('/api/auth/login', { method: 'POST', body: { username: $('authUser').value.trim(), password: $('authPass').value } });
    }
    $('authPass').value = '';
    const s = await api('/api/auth/status');
    state.me = s.user;
    startApp();
  } catch (ex) {
    $('authError').textContent = ex.message;
    $('authError').hidden = false;
  } finally { btn.disabled = false; }
});

$('logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

$('pwBtn').onclick = () => {
  modal({
    title: 'เปลี่ยนรหัสผ่าน',
    body: `<div class="field"><label>รหัสผ่านปัจจุบัน</label><input class="input" type="password" id="pwCur" autocomplete="current-password"></div>
           <div class="field"><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input class="input" type="password" id="pwNew" autocomplete="new-password"></div>`,
    actions: [
      { label: 'ยกเลิก' },
      {
        label: 'บันทึก', class: 'btn-primary',
        onClick: async (b) => {
          await api('/api/auth/password', { method: 'POST', body: { current_password: b.querySelector('#pwCur').value, new_password: b.querySelector('#pwNew').value } });
          toast('เปลี่ยนรหัสผ่านแล้ว', 'ok');
        },
      },
    ],
  });
};

// ====================================================================== shell & routing
const ROUTES = [
  { sec: 'หน้าร้าน' },
  { id: 'queue', label: 'จัดการคิว', ico: '🎫', title: 'จัดการคิว' },
  { id: 'dashboard', label: 'ภาพรวมวันนี้', ico: '📊', title: 'ภาพรวมวันนี้' },
  { id: 'history', label: 'ประวัติคิว', ico: '🕘', title: 'ประวัติคิว' },
  { sec: 'ตั้งค่า', admin: true },
  { id: 'store', label: 'ตั้งค่าร้าน', ico: '🏪', title: 'ตั้งค่าร้าน', admin: true },
  { id: 'groups', label: 'ประเภทคิว A/B/C/D', ico: '🔤', title: 'ประเภทคิวตามจำนวนลูกค้า', admin: true },
  { id: 'display', label: 'หน้าจอบอกคิว', ico: '📺', title: 'หน้าจอบอกคิว (Queue Display)', admin: true },
  { id: 'sound', label: 'เสียงเรียกคิว', ico: '🔊', title: 'เสียงเรียกคิว', admin: true },
  { id: 'printer', label: 'เครื่องพิมพ์', ico: '🖨️', title: 'ตั้งค่าเครื่องพิมพ์', admin: true },
  { id: 'sms', label: 'SMS แจ้งเตือน', ico: '💬', title: 'SMS แจ้งเตือนลูกค้า', admin: true },
  { id: 'staff', label: 'พนักงาน', ico: '👥', title: 'พนักงาน', admin: true },
];

const VIEWS = {
  queue: { render: renderQueue, on: { snapshot: renderQueueBoard } },
  dashboard: { render: renderDashboard, on: { snapshot: renderDashboard } },
  history: { render: renderHistory },
  store: settingsViews.store,
  groups: settingsViews.groups,
  display: settingsViews.display,
  sound: settingsViews.sound,
  sms: settingsViews.sms,
  staff: settingsViews.staff,
  printer: printerView,
};

let currentRoute = null;
const isAdmin = () => state.me && state.me.role === 'admin';

function buildNav() {
  $('nav').innerHTML = ROUTES.filter((r) => !r.admin || isAdmin()).map((r) => (r.sec
    ? `<div class="sec">${esc(r.sec)}</div>`
    : `<a href="#/${r.id}" data-route="${r.id}"><span class="ico">${r.ico}</span>${esc(r.label)}${r.id === 'queue' ? '<span class="badge" id="navWaiting" hidden></span>' : ''}</a>`)).join('');
}

function route() {
  const id = (location.hash.replace(/^#\/?/, '') || 'queue').split('?')[0];
  const r = ROUTES.find((x) => x.id === id && (!x.admin || isAdmin())) || ROUTES[1];
  currentRoute = r.id;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === r.id));
  $('pageTitle').textContent = r.title;
  $('side').classList.remove('open');
  $('sideBackdrop').classList.remove('open');
  const content = $('content');
  content.innerHTML = '';
  window.scrollTo(0, 0);
  VIEWS[r.id].render(content);
}
window.addEventListener('hashchange', route);
$('menuBtn').onclick = () => { $('side').classList.add('open'); $('sideBackdrop').classList.add('open'); };
$('sideBackdrop').onclick = () => { $('side').classList.remove('open'); $('sideBackdrop').classList.remove('open'); };

export async function reloadConfig() {
  state.config = await api('/api/admin/config');
  applyBrand();
  return state.config;
}

function applyBrand() {
  const s = state.config.store;
  applyTheme(s.theme_color);
  $('brandName').textContent = s.name;
  document.title = `${s.name} · จัดการคิว`;
  if (s.logo_url) { $('brandLogo').src = s.logo_url; $('brandLogo').hidden = false; } else $('brandLogo').hidden = true;
}

function dispatch(event) {
  const v = VIEWS[currentRoute];
  if (v && v.on && v.on[event]) v.on[event]();
}

async function startApp() {
  $('authView').hidden = true;
  $('appView').hidden = false;
  $('userName').textContent = state.me.display_name || state.me.username;
  $('userRole').textContent = state.me.role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน';
  $('userAvatar').textContent = (state.me.display_name || state.me.username).slice(0, 1).toUpperCase();
  buildNav();
  const [cfg, snap, pr] = await Promise.all([
    api('/api/admin/config'), api('/api/admin/snapshot'), api('/api/admin/printer'),
  ]);
  state.config = cfg;
  state.snapshot = snap;
  state.printer = pr.printer;
  state.printjobs = pr.jobs;
  printer.setConfig(pr.printer);
  printer.autoConnect();
  applyBrand();
  route();

  const banner = connectionBanner();
  stream('/api/stream/admin', {
    snapshot: (d) => { state.snapshot = d; updateNavBadge(); dispatch('snapshot'); },
    displays: (d) => { state.displays = d; dispatch('displays'); },
    printjobs: (d) => { state.printjobs = d; dispatch('printjobs'); },
    printer: (d) => { state.printer = { ...state.printer, ...d }; printer.setConfig(state.printer); dispatch('printer'); },
    sms: (d) => { state.sms = d; dispatch('sms'); },
    config: async () => { await reloadConfig().catch(() => {}); dispatch('config'); },
    call: (c) => { if (state.config?.settings.sound_on_admin) announce(c.queue_number, state.config.settings); },
    paired: (d) => { toast(`เชื่อมต่อ ${d.device.name} สำเร็จ`, 'ok'); dispatch('paired'); },
  }, {
    onStatus: (ok) => { banner(ok); $('live').querySelector('.dot').className = `dot ${ok ? 'ok' : 'danger'}`; },
    onError: async () => {
      const s = await api('/api/auth/status').catch(() => null);
      if (s && !s.user) { location.reload(); return false; }
      return true;
    },
  });
  document.addEventListener('pointerdown', () => unlockAudio(), { once: true });
  setInterval(() => { if (currentRoute === 'queue') updateWaitTimes(); }, 30000);
}

function updateNavBadge() {
  const b = $('navWaiting');
  if (!b) return;
  const n = state.snapshot.stats.waiting;
  b.textContent = n;
  b.hidden = !n;
}

// ====================================================================== queue control
const ACTION_LABEL = {
  call: 'เรียกคิว', recall: 'เรียกซ้ำ', seat: 'รับลูกค้า', complete: 'เสร็จสิ้น', no_show: 'ไม่พบลูกค้า', cancel: 'ยกเลิก', restore: 'คืนคิว',
};
const knownIds = new Set();
let firstRender = true;

function renderQueue(el) {
  el.innerHTML = `
    <div class="stats" id="qStats"></div>
    <div class="row" style="margin-bottom:14px">
      <button class="btn btn-primary" id="walkinBtn" type="button">＋ เพิ่มคิว (Walk-in)</button>
      <span class="muted" style="font-size:.9rem">คิวจาก Kiosk จะแสดงที่นี่ทันทีโดยไม่ต้องรีเฟรช</span>
    </div>
    <div class="board" id="board"></div>
    <div class="recent panel">
      <div class="panel-head"><h2>คิวที่จบแล้ววันนี้</h2><span class="hint">กด “คืนคิว” หากกดผิด</span></div>
      <div class="recent-list" id="recent"></div>
    </div>`;
  $('walkinBtn').onclick = walkIn;
  el.addEventListener('click', onQueueClick);
  firstRender = true;
  renderQueueBoard();
}

function statsHtml(s) {
  return `
    <div class="stat hl"><small>คิวที่กำลังรอ</small><b>${s.waiting}</b><div class="sub">คิว</div></div>
    <div class="stat"><small>คิวที่เรียกแล้ว (รอลูกค้า)</small><b>${s.called}</b><div class="sub">กำลังให้บริการ ${s.seated}</div></div>
    <div class="stat"><small>ลูกค้ารวมวันนี้</small><b>${s.customers_today}</b><div class="sub">ท่าน</div></div>
    <div class="stat"><small>จำนวนกลุ่มวันนี้</small><b>${s.groups_today}</b><div class="sub">เรียกแล้ว ${s.called_today}</div></div>
    <div class="stat"><small>เวลารอเฉลี่ย</small><b style="font-size:1.5rem">${s.avg_wait_ms ? fmtDuration(s.avg_wait_ms) : '–'}</b><div class="sub">จากออกบัตรถึงเรียก</div></div>`;
}

function waitText(q, now) {
  const end = q.status === 'waiting' ? now : (q.called_at || now);
  return fmtDuration(end - q.created_at);
}

function cardHtml(q, now, tz) {
  const waitMs = (q.status === 'waiting' ? now : (q.called_at || now)) - q.created_at;
  const actions = {
    waiting: ['call', 'seat', 'cancel'],
    called: ['recall', 'seat', 'no_show'],
    seated: ['complete', 'cancel'],
  }[q.status] || [];
  const more = { waiting: ['no_show', 'complete'], called: ['cancel', 'complete'], seated: [] }[q.status] || [];
  const btnClass = { call: 'btn-primary', recall: 'btn-soft', seat: 'btn-ok', complete: 'btn-ok', no_show: '', cancel: '' };
  return `<div class="qcard ${q.status}${!firstRender && !knownIds.has(q.id) ? ' fresh' : ''}" data-id="${q.id}">
    <div class="qcard-top">
      <div class="qnum">${esc(q.queue_number)}</div>
      <div class="qinfo">
        <b>${q.customer_name ? esc(q.customer_name) : '<span class="muted">ไม่ระบุชื่อ</span>'}</b>
        <div class="muted">${q.customer_phone ? `📞 ${esc(q.customer_phone)}${q.sms_opt_in ? ' · SMS' : ''}` : 'ไม่มีเบอร์โทร'}</div>
      </div>
      <span class="pill ${STATUS_CLASS[q.status]}">${STATUS_TH[q.status]}${q.status === 'called' && q.call_count > 1 ? ` ×${q.call_count}` : ''}</span>
    </div>
    <div class="qmeta">
      <span>👥 ${q.pax} ท่าน</span>
      <span>🕘 ${fmtTime(q.created_at, tz)}</span>
      <span class="wait ${waitMs > 30 * 60000 && q.status === 'waiting' ? 'wait-long' : ''}" data-wait="${q.id}">⏱ ${waitText(q, now)}</span>
      ${q.source === 'staff' ? '<span>Walk-in</span>' : ''}
    </div>
    <div class="qactions">${actions.map((a) => `<button class="btn ${btnClass[a]}" data-act="${a}" type="button">${ACTION_LABEL[a]}</button>`).join('')}</div>
    <div class="qmore">
      ${more.map((a) => `<button class="btn btn-ghost" data-act="${a}" type="button">${ACTION_LABEL[a]}</button>`).join('')}
      <button class="btn btn-ghost" data-act="print" type="button">🖨 พิมพ์บัตร</button>
      <button class="btn btn-ghost" data-act="detail" type="button">รายละเอียด</button>
    </div>
  </div>`;
}

function renderQueueBoard() {
  const snap = state.snapshot;
  if (!snap || !$('board')) return;
  const tz = state.config?.settings.timezone;
  const now = Date.now() + (snap.server_time ? 0 : 0);
  $('qStats').innerHTML = statsHtml(snap.stats);
  $('board').innerHTML = snap.groups.filter((g) => g.active || snap.active.some((q) => q.group_id === g.id)).map((g) => {
    const list = snap.active.filter((q) => q.group_id === g.id);
    const order = { called: 0, seated: 1, waiting: 2 };
    list.sort((a, b) => (order[a.status] - order[b.status]) || 0);
    const waiting = list.filter((q) => q.status === 'waiting').length;
    const range = g.min_pax === g.max_pax ? `${g.min_pax} PAX` : `${g.min_pax}–${g.max_pax} PAX`;
    return `<section class="col">
      <div class="col-head">
        <div class="col-letter">${esc(g.prefix)}</div>
        <div class="col-title"><b>${esc(g.prefix)} — ${range}</b><small>รอ ${waiting} คิว · ทั้งหมด ${list.length}</small></div>
        <button class="btn btn-primary btn-sm" data-callnext="${g.id}" ${waiting ? '' : 'disabled'} type="button">เรียกคิวถัดไป</button>
      </div>
      <div class="col-list">${list.length ? list.map((q) => cardHtml(q, now, tz)).join('') : '<div class="empty">ไม่มีคิว</div>'}</div>
    </section>`;
  }).join('');
  $('recent').innerHTML = snap.recent.length ? snap.recent.map((q) => `
    <div class="recent-item" data-id="${q.id}">
      <b>${esc(q.queue_number)}</b><span class="pill ${STATUS_CLASS[q.status]}">${STATUS_TH[q.status]}</span>
      <button class="btn btn-sm btn-ghost" data-act="restore" type="button">คืนคิว</button>
      <button class="btn btn-sm btn-ghost" data-act="detail" type="button">ดู</button>
    </div>`).join('') : '<div class="muted">ยังไม่มี</div>';
  snap.active.forEach((q) => knownIds.add(q.id));
  firstRender = false;
}

function updateWaitTimes() {
  const now = Date.now();
  for (const q of state.snapshot?.active || []) {
    const el = document.querySelector(`[data-wait="${q.id}"]`);
    if (el) el.textContent = `⏱ ${waitText(q, now)}`;
  }
}

async function onQueueClick(e) {
  const next = e.target.closest('[data-callnext]');
  if (next) {
    next.disabled = true;
    try {
      const { queue } = await api(`/api/admin/groups/${next.dataset.callnext}/call-next`, { method: 'POST' });
      toast(`เรียกคิว ${queue.queue_number}`, 'ok');
    } catch (ex) { toast(ex.message, 'error'); } finally { next.disabled = false; }
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const act = btn.dataset.act;
  if (act === 'detail') return showDetail(id);
  if (act === 'print') return printQueue(id, btn);
  const q = [...(state.snapshot.active || []), ...(state.snapshot.recent || [])].find((x) => x.id === id);
  if ((act === 'cancel' || act === 'no_show')
    && !(await confirmDialog(`${ACTION_LABEL[act]} ${q?.queue_number || ''}`, `ยืนยันการ${ACTION_LABEL[act]}คิวนี้?`, { danger: true, okLabel: ACTION_LABEL[act] }))) return;
  btn.disabled = true;
  try {
    const { queue } = await api(`/api/admin/queues/${id}/${act}`, { method: 'POST' });
    if (act === 'call' || act === 'recall') toast(`${ACTION_LABEL[act]} ${queue.queue_number}`, 'ok');
  } catch (ex) { toast(ex.message, 'error'); } finally { btn.disabled = false; }
}

function walkIn() {
  const groups = state.snapshot.groups.filter((g) => g.active);
  const max = Math.max(...groups.map((g) => g.max_pax));
  const m = modal({
    title: 'เพิ่มคิว (Walk-in)',
    body: `<div class="form-row">
        <div class="field"><label>จำนวนคน</label><input class="input" type="number" id="wPax" min="1" max="${max}" value="2"></div>
        <div class="field"><label>ประเภทคิว</label><div class="input" id="wGroup" style="display:flex;align-items:center;font-weight:700"></div></div>
      </div>
      <div class="field"><label>ชื่อลูกค้า (ไม่บังคับ)</label><input class="input" id="wName"></div>
      <div class="field"><label>เบอร์โทรศัพท์ (ไม่บังคับ)</label><input class="input" id="wPhone" inputmode="tel"></div>
      ${state.config.settings.sms_enabled ? '<label class="check"><input type="checkbox" id="wSms"> ส่ง SMS เมื่อถึงคิว</label>' : ''}`,
    actions: [
      { label: 'ยกเลิก' },
      {
        label: 'สร้างคิว', class: 'btn-primary',
        onClick: async (b) => {
          const { queue } = await api('/api/admin/queues', {
            method: 'POST',
            body: { pax: Number(b.querySelector('#wPax').value), name: b.querySelector('#wName').value, phone: b.querySelector('#wPhone').value, sms_opt_in: !!b.querySelector('#wSms')?.checked },
          });
          toast(`สร้างคิว ${queue.queue_number} แล้ว`, 'ok');
          if (await confirmDialog('พิมพ์บัตรคิว', `ต้องการพิมพ์บัตรคิว ${queue.queue_number} หรือไม่?`, { okLabel: 'พิมพ์' })) printQueue(queue.id);
        },
      },
    ],
  });
  const upd = () => {
    const n = Number(m.body.querySelector('#wPax').value);
    const g = groups.find((x) => n >= x.min_pax && n <= x.max_pax);
    m.body.querySelector('#wGroup').textContent = g ? `${g.prefix} (${g.min_pax}–${g.max_pax} ท่าน)` : 'เกินจำนวนที่รองรับ';
  };
  m.body.querySelector('#wPax').addEventListener('input', upd);
  upd();
}

export function adminJobs(queueId, kind = 'ticket') {
  return {
    create: (b) => api('/api/admin/print-jobs', { method: 'POST', body: { ...b, queue_id: queueId, kind } }),
    update: (id, status, error) => api(`/api/admin/print-jobs/${id}`, { method: 'PATCH', body: { status, error } }),
    get: (id) => api(`/api/admin/print-jobs/${id}`),
  };
}

async function printQueue(id, btn) {
  if (btn) btn.disabled = true;
  try {
    const { ticket } = await api(`/api/admin/queues/${id}/ticket`);
    const canvas = await renderTicket(ticket, { paperWidth: state.printer.paper_width });
    if (printer.direct && !printer.status().connected) await printer.connectInteractive();
    await printer.printCanvas(canvas, adminJobs(id));
    toast(`พิมพ์บัตรคิว ${ticket.queue_number} แล้ว`, 'ok');
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(`พิมพ์ไม่สำเร็จ: ${e.message}`, 'error');
  } finally { if (btn) btn.disabled = false; }
}

const EVENT_TH = { created: 'ออกบัตรคิว', call: 'เรียกคิว', recall: 'เรียกซ้ำ', seat: 'รับลูกค้า', complete: 'เสร็จสิ้น', no_show: 'ไม่พบลูกค้า', cancel: 'ยกเลิก', restore: 'คืนคิว', reset: 'รีเซ็ตคิว' };

export async function showDetail(id) {
  try {
    const { queue: q, events } = await api(`/api/admin/queues/${id}`);
    const tz = state.config?.settings.timezone;
    const trackUrl = `${state.config.settings.public_base_url || location.origin}/queue/track/${q.tracking_token}`;
    modal({
      title: `คิว ${q.queue_number}`,
      body: `<dl class="kv">
          <dt>สถานะ</dt><dd><span class="pill ${STATUS_CLASS[q.status]}">${STATUS_TH[q.status]}</span>${q.status === 'waiting' ? ` · มีคิวก่อนหน้า ${q.ahead} คิว` : ''}</dd>
          <dt>ชื่อลูกค้า</dt><dd>${esc(q.customer_name || '–')}</dd>
          <dt>เบอร์โทร</dt><dd>${esc(q.customer_phone || '–')}${q.sms_opt_in ? ' (รับ SMS)' : ''}</dd>
          <dt>จำนวน</dt><dd>${q.pax} ท่าน</dd>
          <dt>เวลาออกคิว</dt><dd>${fmtDateTime(q.created_at, tz)}</dd>
          <dt>เวลาเรียก</dt><dd>${fmtDateTime(q.called_at, tz)}${q.called_by_name ? ` โดย ${esc(q.called_by_name)}` : ''}</dd>
          <dt>เวลารับลูกค้า</dt><dd>${fmtDateTime(q.seated_at, tz)}</dd>
          <dt>เวลาจบ</dt><dd>${fmtDateTime(q.completed_at || q.cancelled_at || q.no_show_at, tz)}</dd>
          <dt>เวลารอ</dt><dd>${q.called_at ? fmtDuration(q.called_at - q.created_at) : '–'}</dd>
          <dt>ลิงก์ติดตาม</dt><dd><a href="${esc(trackUrl)}" target="_blank" rel="noopener">เปิดหน้าติดตามคิว</a></dd>
        </dl>
        <b>ประวัติการเปลี่ยนสถานะ</b>
        <ul class="timeline" style="margin-top:8px">${events.map((ev) => `<li><time>${fmtTime(ev.created_at, tz)}</time><span>${EVENT_TH[ev.event] || ev.event}${ev.staff_name ? ` · ${esc(ev.staff_name)}` : ''}${ev.note ? ` <span class="muted">(${esc(ev.note)})</span>` : ''}</span></li>`).join('')}</ul>`,
      actions: [{ label: 'ปิด' }],
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ====================================================================== dashboard
function renderDashboard(el = $('content')) {
  const snap = state.snapshot;
  if (!snap || currentRoute !== 'dashboard') return;
  const s = snap.stats;
  const maxTotal = Math.max(1, ...s.per_group.map((g) => g.total));
  el.innerHTML = `
    <div class="stats">${statsHtml(s)}</div>
    <div class="grid grid-2">
      <div class="panel">
        <h2>จำนวนกลุ่มวันนี้แยกตามประเภท</h2><span class="hint">ไม่นับคิวที่ถูกยกเลิก</span>
        <div class="bars">${s.per_group.map((g) => `
          <div class="bar-row"><div class="col-letter">${esc(g.prefix)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(g.total / maxTotal) * 100}%"></div></div>
            <div><b>${g.total}</b> กลุ่ม · ${g.pax} ท่าน</div></div>`).join('')}
        </div>
      </div>
      <div class="panel">
        <h2>สถานะคิวปัจจุบัน</h2><span class="hint">อัปเดตแบบ Real-time</span>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>ประเภท</th><th>รอ</th><th>เรียกแล้ว</th><th>ให้บริการ</th></tr></thead>
        <tbody>${s.per_group.map((g) => `<tr><td class="num">${esc(g.prefix)}</td><td>${g.waiting}</td><td>${g.called}</td><td>${g.seated}</td></tr>`).join('')}</tbody></table></div>
      </div>
    </div>`;
}

// ====================================================================== history
function renderHistory(el) {
  const tz = state.config?.settings.timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined }).format(new Date());
  el.innerHTML = `
    <div class="panel">
      <form class="filters" id="hForm">
        <div class="field"><label>ตั้งแต่วันที่</label><input class="input" type="date" name="from" value="${today}"></div>
        <div class="field"><label>ถึงวันที่</label><input class="input" type="date" name="to" value="${today}"></div>
        <div class="field"><label>ค้นหา</label><input class="input" name="q" placeholder="เลขคิว / ชื่อ / เบอร์โทร"></div>
        <div class="field"><label>ประเภทคิว</label><select class="input" name="prefix"><option value="">ทั้งหมด</option>
          ${(state.snapshot?.groups || []).filter((g) => !g.prefix.startsWith('~')).map((g) => `<option>${esc(g.prefix)}</option>`).join('')}</select></div>
        <div class="field"><label>สถานะ</label><select class="input" name="status"><option value="">ทั้งหมด</option>
          ${Object.entries(STATUS_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="row"><button class="btn btn-primary" type="submit">ค้นหา</button><a class="btn" id="csvBtn" href="#">ส่งออก CSV</a></div>
      </form>
      <div class="row muted" id="hSummary" style="margin-bottom:10px"></div>
      <div class="table-wrap"><table class="tbl"><thead><tr>
        <th>คิว</th><th>ประเภท</th><th>จำนวน</th><th>ชื่อ</th><th>เบอร์โทร</th><th>สถานะ</th>
        <th>ออกคิว</th><th>เรียก</th><th>รับลูกค้า</th><th>จบ</th><th>เวลารอ</th><th>เรียกโดย</th>
      </tr></thead><tbody id="hBody"></tbody></table></div>
      <div class="pager"><button class="btn btn-sm" id="hPrev" type="button">ก่อนหน้า</button><span id="hPage"></span><button class="btn btn-sm" id="hNext" type="button">ถัดไป</button></div>
    </div>`;
  let page = 1;
  const form = $('hForm');
  const params = () => {
    const p = new URLSearchParams(new FormData(form));
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return p;
  };
  async function load() {
    const p = params();
    p.set('page', page);
    $('csvBtn').href = `/api/admin/history.csv?${params()}`;
    try {
      const d = await api(`/api/admin/history?${p}`);
      $('hBody').innerHTML = d.rows.length ? d.rows.map((r) => `<tr data-id="${r.id}">
          <td class="num">${esc(r.queue_number)}</td><td>${esc(r.prefix)}</td><td>${r.pax}</td>
          <td>${esc(r.customer_name || '–')}</td><td>${esc(r.customer_phone || '–')}</td>
          <td><span class="pill ${STATUS_CLASS[r.status]}">${STATUS_TH[r.status]}</span></td>
          <td>${fmtDateTime(r.created_at, tz)}</td><td>${fmtTime(r.called_at, tz)}</td><td>${fmtTime(r.seated_at, tz)}</td>
          <td>${fmtTime(r.completed_at || r.cancelled_at || r.no_show_at, tz)}</td>
          <td>${r.called_at ? fmtDuration(r.called_at - r.created_at) : '–'}</td><td>${esc(r.called_by_name || '–')}</td></tr>`).join('')
        : '<tr><td colspan="12" class="empty">ไม่พบข้อมูล</td></tr>';
      const pages = Math.max(1, Math.ceil(d.total / d.size));
      $('hPage').textContent = `หน้า ${d.page} / ${pages} (${d.total} รายการ)`;
      $('hPrev').disabled = d.page <= 1;
      $('hNext').disabled = d.page >= pages;
      $('hSummary').innerHTML = `ทั้งหมด <b>&nbsp;${d.summary.n || 0}&nbsp;</b> กลุ่ม · <b>&nbsp;${d.summary.pax || 0}&nbsp;</b> ท่าน · เวลารอเฉลี่ย <b>&nbsp;${d.summary.avg_wait ? fmtDuration(d.summary.avg_wait) : '–'}</b> <span>&nbsp;(ไม่นับคิวที่ยกเลิก)</span>`;
    } catch (e) { toast(e.message, 'error'); }
  }
  form.onsubmit = (e) => { e.preventDefault(); page = 1; load(); };
  $('hPrev').onclick = () => { page -= 1; load(); };
  $('hNext').onclick = () => { page += 1; load(); };
  $('hBody').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) showDetail(tr.dataset.id); };
  load();
}

boot();
