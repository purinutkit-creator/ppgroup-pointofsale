import { api, stream, applyTheme, esc, fontsReady } from './common.js';
import { announce, unlockAudio, audioUnlocked } from './voice.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'qms.display.token';

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
if (!token) location.replace('/display/pair');

let settings = {};
let store = {};
let board = { groups: [] };
let promotions = [];
const flashing = new Map(); // group_id -> timeout
let es = null;

function unpaired() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  es?.close();
  location.replace('/display/pair?reason=revoked');
}

const authed = (path, opts = {}) => api(path, { ...opts, headers: { Authorization: `Bearer ${token}` } });

// ------------------------------------------------------------------ render
let build = null;
function applyConfig(c) {
  if (build && c.build !== build) { location.reload(); return; }
  build = build || c.build;
  settings = c.settings;
  store = c.store;
  applyTheme(store.theme_color);
  document.title = `${store.name} · Queue Display`;
  $('storeName').textContent = store.name;
  $('deviceName').textContent = c.device?.name || '';
  for (const img of [$('logo'), $('promoLogo')]) {
    if (store.logo_url) { img.src = store.logo_url; img.hidden = false; img.onerror = () => { img.hidden = true; }; } else img.hidden = true;
  }
  $('promoStore').textContent = store.name;
  setPromotions(c.promotions || []);
  renderMarquee();
  renderBoard();
  checkSound();
}

function rangeText(g) { return g.min_pax === g.max_pax ? `${g.min_pax} ท่าน` : `${g.min_pax}–${g.max_pax} ท่าน`; }

function renderBoard() {
  const wrap = $('queues');
  const ids = board.groups.map((g) => g.id).join(',');
  if (wrap.dataset.ids !== ids) {
    wrap.dataset.ids = ids;
    wrap.innerHTML = board.groups.map((g) => `
      <article class="d-row" data-group="${g.id}">
        <div class="d-letter"><b></b><small></small></div>
        <div class="d-calls">
          <div class="d-label">หมายเลขที่เรียก</div>
          <div class="d-now"><span class="d-number"></span><span class="d-waiting"></span></div>
          <div class="d-prev"></div>
        </div>
      </article>`).join('');
  }
  for (const g of board.groups) {
    const row = wrap.querySelector(`[data-group="${g.id}"]`);
    row.querySelector('.d-letter b').textContent = g.prefix;
    row.querySelector('.d-letter small').textContent = rangeText(g);
    const latest = g.called[0];
    const num = row.querySelector('.d-number');
    num.textContent = latest ? latest.queue_number : '–';
    num.classList.toggle('empty', !latest);
    row.querySelector('.d-waiting').innerHTML = settings.display_show_waiting ? `รอ <b>${g.waiting}</b> คิว` : '';
    row.querySelector('.d-prev').innerHTML = g.called.slice(1).map((c) => `<span>${esc(c.queue_number)}</span>`).join('');
    row.querySelector('.d-prev').hidden = g.called.length < 2;
  }
}

function flash(groupId) {
  const row = document.querySelector(`[data-group="${groupId}"]`);
  if (!row) return;
  clearTimeout(flashing.get(groupId));
  row.classList.remove('flash');
  void row.offsetWidth; // restart animation
  row.classList.add('flash');
  flashing.set(groupId, setTimeout(() => row.classList.remove('flash'), (settings.display_flash_seconds || 8) * 1000));
}

let popupTimer = null;
function popup(number) {
  if (!settings.display_popup) return;
  $('popupNumber').textContent = number;
  $('popup').hidden = false;
  clearTimeout(popupTimer);
  popupTimer = setTimeout(() => { $('popup').hidden = true; }, Math.min(6, settings.display_flash_seconds || 6) * 1000);
}

function onCall(c) {
  flash(c.group_id);
  popup(c.queue_number);
  announce(c.queue_number, settings);
}

// ------------------------------------------------------------------ promotions slideshow
let slideTimer = null;
let slideIndex = 0;
function setPromotions(list) {
  const key = JSON.stringify(list.map((p) => p.url)) + settings.image_fit + settings.slide_interval;
  if (key === setPromotions.key) return;
  setPromotions.key = key;
  promotions = list;
  const box = $('promo');
  box.querySelectorAll('.d-slide').forEach((el) => el.remove());
  clearInterval(slideTimer);
  $('promoEmpty').hidden = list.length > 0;
  list.forEach((p, i) => {
    const img = document.createElement('img');
    img.className = `d-slide ${settings.image_fit === 'cover' ? 'cover' : 'contain'}${i === 0 ? ' on' : ''}`;
    img.alt = p.title || '';
    img.src = p.url;
    img.onerror = () => { img.dataset.broken = '1'; };
    box.appendChild(img);
  });
  slideIndex = 0;
  if (list.length > 1) slideTimer = setInterval(nextSlide, (settings.slide_interval || 10) * 1000);
}
function nextSlide() {
  const slides = [...document.querySelectorAll('.d-slide')];
  if (slides.length < 2) return;
  slides[slideIndex].classList.remove('on');
  for (let i = 0; i < slides.length; i += 1) {
    slideIndex = (slideIndex + 1) % slides.length;
    if (!slides[slideIndex].dataset.broken) break;
  }
  slides[slideIndex].classList.add('on');
}

// ------------------------------------------------------------------ marquee
function renderMarquee() {
  const m = $('marquee');
  m.hidden = !settings.marquee_enabled || !settings.marquee_text;
  if (m.hidden) return;
  const track = $('marqueeTrack');
  track.textContent = settings.marquee_text;
  const px = Math.round(settings.marquee_font_size * (window.innerHeight / 1080));
  track.style.fontSize = `${Math.max(14, px)}px`;
  m.style.minHeight = `${Math.max(14, px) * 1.8}px`;
  requestAnimationFrame(() => {
    const distance = track.scrollWidth; // includes 100% padding-left
    const pps = 30 + settings.marquee_speed * 30; // speed 1..10 → 60..330 px/s
    track.style.animationDuration = `${Math.max(4, distance / pps)}s`;
  });
}
window.addEventListener('resize', () => renderMarquee());

// ------------------------------------------------------------------ sound unlock
function checkSound() {
  $('soundOverlay').hidden = !settings.sound_enabled || audioUnlocked();
}
$('soundOverlay').onclick = () => { unlockAudio(); setTimeout(checkSound, 300); };
document.addEventListener('pointerdown', () => { if (!audioUnlocked()) { unlockAudio(); setTimeout(checkSound, 300); } });
$('testSoundBtn').onclick = (e) => { e.stopPropagation(); unlockAudio(); announce(board.groups[0]?.called[0]?.queue_number || 'A001', { ...settings, sound_enabled: true }); };

// ------------------------------------------------------------------ chrome
let cursorTimer = null;
document.addEventListener('pointermove', () => {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 3000);
});
$('fsBtn').onclick = (e) => {
  e.stopPropagation();
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
};
document.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
});

function tick() {
  $('clock').textContent = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: settings.timezone || undefined }).format(new Date());
}
setInterval(tick, 5000);

async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => setTimeout(keepAwake, 1000));
    }
  } catch { /* not allowed until visible */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

function setConn(ok) { $('connDot').className = `dot ${ok ? 'ok' : 'danger'}`; }

// ------------------------------------------------------------------ boot
async function heartbeat() {
  try {
    await authed('/api/display/heartbeat', { method: 'POST' });
    return true;
  } catch (e) {
    if (e.status === 401) unpaired();
    return e.status !== 401;
  }
}

async function init() {
  if (!token) return;
  fontsReady();
  try {
    const s = await authed('/api/display/state');
    board = s.board;
    applyConfig(s);
  } catch (e) {
    if (e.status === 401) return unpaired();
    $('storeName').textContent = 'กำลังเชื่อมต่อเซิร์ฟเวอร์…';
    setTimeout(init, 3000);
    return;
  }
  tick();
  keepAwake();
  es = stream(`/api/stream/display?token=${encodeURIComponent(token)}`, {
    board: (b) => { board = b; renderBoard(); },
    config: (c) => applyConfig(c),
    call: (c) => onCall(c),
    revoked: () => unpaired(),
  }, { onStatus: setConn, onError: heartbeat });
  setInterval(heartbeat, 20000);
}
init();
