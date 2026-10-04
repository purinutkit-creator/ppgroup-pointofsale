import { api, stream, applyTheme, fmtTime, fmtDuration } from './common.js';
import { chime, unlockAudio } from './voice.js';

const $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.pathname.split('/').pop() || '');
const TRAIL_KEY = `qms.trail.${token.slice(0, 12)}`;

let last = null;
let alertsOn = false;

function trail() {
  try { return JSON.parse(localStorage.getItem(TRAIL_KEY) || '[]'); } catch { return []; }
}
function pushTrail(n) {
  const t = trail();
  if (t[t.length - 1] !== n) t.push(n);
  try { localStorage.setItem(TRAIL_KEY, JSON.stringify(t.slice(-12))); } catch { /* ignore */ }
  return t;
}

function setLive(ok) {
  $('liveDot').className = `dot ${ok ? 'ok' : 'danger'}`;
  $('liveText').textContent = ok ? 'อัปเดตสด' : 'กำลังเชื่อมต่อใหม่';
}

function render({ store, queue: q }) {
  $('loading').hidden = true;
  applyTheme(store.theme_color);
  document.title = `คิว ${q.queue_number} · ${store.name}`;
  $('storeName').textContent = store.name;
  if (store.logo_url) { $('logo').src = store.logo_url; $('logo').hidden = false; $('logo').onerror = () => { $('logo').hidden = true; }; }

  const prev = last;
  last = q;
  const isWaiting = q.status === 'waiting';
  const isCalled = q.status === 'called';
  const isFinal = ['seated', 'completed', 'cancelled', 'no_show'].includes(q.status);

  $('waitingView').hidden = !isWaiting && !isCalled;
  $('calledView').hidden = !isCalled;
  $('finalView').hidden = !isFinal;

  $('number').textContent = q.queue_number;
  $('pax').textContent = `จำนวน ${q.pax} ท่าน`;
  $('name').textContent = q.customer_name ? `ชื่อ: ${q.customer_name}` : '';
  $('status').textContent = q.status_text;
  $('status').className = `t-status ${q.status}`;
  $('created').textContent = `${fmtTime(q.created_at, store.timezone)} น.`;
  updateWaited();

  if (isWaiting) {
    const t = pushTrail(q.ahead);
    const first = Math.max(...t, q.ahead, 1);
    const el = $('ahead');
    if (prev && prev.ahead !== q.ahead) {
      el.classList.add('bump');
      setTimeout(() => el.classList.remove('bump'), 500);
      if (navigator.vibrate && q.ahead < prev.ahead) navigator.vibrate(80);
    }
    el.textContent = q.ahead;
    $('bar').style.width = `${Math.round(((first - q.ahead) / first) * 100)}%`;
    const shown = t.slice(-5);
    $('trail').innerHTML = shown.map((n, i) => `<span class="${i === shown.length - 1 ? 'cur' : ''}">${n} คิว</span>`).join('<i>→</i>');
    $('hint').textContent = q.ahead === 0 ? 'คุณเป็นคิวถัดไป กรุณาอยู่ใกล้บริเวณร้าน' : q.ahead <= 2 ? 'ใกล้ถึงคิวของคุณแล้ว กรุณาเตรียมตัว' : 'ระบบจะแจ้งบนหน้านี้ทันทีเมื่อถึงคิวของคุณ';
  }

  if (isCalled) {
    $('calledNumber').textContent = q.queue_number;
    $('calledPax').textContent = `จำนวน ${q.pax} ท่าน`;
    if (!prev || prev.status !== 'called') notifyCalled(q);
  }

  if (isFinal) {
    $('finalNumber').textContent = q.queue_number;
    $('finalStatus').textContent = q.status_text;
    $('finalStatus').className = `t-status ${q.status}`;
    $('finalText').textContent = {
      seated: 'ขอให้เพลิดเพลินกับมื้ออาหาร',
      completed: 'ขอบคุณที่ใช้บริการ',
      cancelled: 'คิวนี้ถูกยกเลิกแล้ว หากมีข้อสงสัยกรุณาติดต่อพนักงาน',
      no_show: 'พนักงานเรียกคิวแล้วแต่ไม่พบลูกค้า กรุณาติดต่อพนักงาน',
    }[q.status];
  }
}

function notifyCalled(q) {
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  if (alertsOn) chime(1);
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try { new Notification(`ถึงคิว ${q.queue_number} ของคุณแล้ว`, { body: 'กรุณาติดต่อพนักงาน', tag: 'queue-called', renotify: true }); } catch { /* ignore */ }
  }
}

function updateWaited() {
  if (!last) return;
  const end = last.called_at || Date.now();
  $('waited').textContent = fmtDuration(end - last.created_at);
}
setInterval(updateWaited, 30000);

$('enableAlerts').onclick = async () => {
  unlockAudio();
  alertsOn = true;
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
  $('enableAlerts').textContent = '✓ เปิดการแจ้งเตือนแล้ว';
  $('enableAlerts').disabled = true;
};

async function init() {
  try {
    render(await api(`/api/track/${encodeURIComponent(token)}`));
  } catch (e) {
    $('loading').hidden = true;
    if (e.status === 404) { $('notFound').hidden = false; return; }
    setTimeout(init, 3000);
    return;
  }
  stream(`/api/stream/track/${encodeURIComponent(token)}`, {
    state: (d) => render(d),
    call: () => { if (last && last.status === 'called') notifyCalled(last); },
  }, { onStatus: setLive });
}
init();
