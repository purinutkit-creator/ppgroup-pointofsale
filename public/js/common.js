// Shared helpers for every page.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (method !== 'GET') init.headers['X-QMS'] = '1';
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError(0, { error: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสอบอินเทอร์เน็ต' });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/**
 * EventSource wrapper with automatic reconnect + connection status callback.
 * handlers: { eventName: fn(data) }, onStatus(connected:boolean),
 * onError(): may return false to stop reconnecting (e.g. credentials revoked)
 */
export function stream(url, handlers, { onStatus, onError } = {}) {
  let es = null;
  let closed = false;
  let retry = 1000;
  let timer = null;
  const connect = () => {
    if (closed) return;
    es = new EventSource(url, { withCredentials: true });
    es.onopen = () => { retry = 1000; onStatus && onStatus(true); };
    es.onerror = async () => {
      onStatus && onStatus(false);
      es.close();
      if (closed) return;
      if (onError && (await onError()) === false) return;
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
    for (const [ev, fn] of Object.entries(handlers)) {
      es.addEventListener(ev, (e) => {
        let data = null;
        try { data = JSON.parse(e.data); } catch { /* ignore */ }
        fn(data);
      });
    }
  };
  connect();
  return {
    close() { closed = true; clearTimeout(timer); es && es.close(); },
    reconnect() { es && es.close(); clearTimeout(timer); retry = 1000; connect(); },
  };
}

// ---------- theme ----------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function applyTheme(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return;
  const root = document.documentElement.style;
  root.setProperty('--primary', color);
  root.setProperty('--primary-ink', luminance(rgb) > 0.45 ? '#1C1B19' : '#ffffff');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
}

// ---------- formatting ----------
export function fmtTime(ts, tz) {
  if (!ts) return '–';
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined }).format(new Date(ts));
}
export function fmtDateTime(ts, tz) {
  if (!ts) return '–';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined,
  }).format(new Date(ts));
}
export function fmtDuration(ms) {
  if (ms == null || ms < 0) return '–';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'ไม่ถึง 1 นาที';
  if (m < 60) return `${m} นาที`;
  return `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}
export function relTime(ts, now = Date.now()) {
  if (!ts) return 'ไม่เคย';
  const s = Math.round((now - ts) / 1000);
  if (s < 30) return 'เมื่อสักครู่';
  if (s < 60) return `${s} วินาทีที่แล้ว`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  return `${Math.round(h / 24)} วันที่แล้ว`;
}

export const STATUS_TH = {
  waiting: 'กำลังรอคิว', called: 'เรียกแล้ว', seated: 'กำลังให้บริการ',
  completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก', no_show: 'ไม่พบลูกค้า',
};
export const STATUS_CLASS = {
  waiting: 'warn', called: 'info', seated: 'primary', completed: 'ok', cancelled: 'danger', no_show: 'danger',
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- UI ----------
let toastWrap;
export function toast(msg, type = '') {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastWrap.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 3000);
}

export function modal({ title, body, actions = [], onClose, wide = false }) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${wide ? 'style="width:min(820px,100%)"' : ''}>
      <header></header><div class="modal-body"></div><footer></footer></div>`;
  back.querySelector('header').textContent = title || '';
  const bodyEl = back.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = back.querySelector('footer');
  const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(v); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.class || ''}`;
    b.textContent = a.label;
    b.onclick = async () => {
      if (!a.onClick) return close(a.value);
      b.disabled = true;
      try {
        const r = await a.onClick(bodyEl);
        if (r !== false) close(a.value);
      } catch (e) {
        toast(e.message, 'error');
      } finally { b.disabled = false; }
    };
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  return { el: back, body: bodyEl, close };
}

export function confirmDialog(title, message, { okLabel = 'ยืนยัน', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title, body: `<p style="margin:0">${esc(message)}</p>`,
      actions: [
        { label: 'ยกเลิก', value: false },
        { label: okLabel, class: danger ? 'btn-danger' : 'btn-primary', value: true },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function connectionBanner() {
  let el = null;
  let t = null;
  return (connected) => {
    clearTimeout(t);
    if (connected) { if (el) { el.remove(); el = null; } return; }
    // Short blips are normal (reconnects); only show after 3s.
    t = setTimeout(() => {
      if (el) return;
      el = document.createElement('div');
      el.className = 'conn-banner';
      el.textContent = 'การเชื่อมต่อกับเซิร์ฟเวอร์ขาดหาย กำลังเชื่อมต่อใหม่…';
      document.body.appendChild(el);
    }, 3000);
  };
}

export function fontsReady(weights = [400, 700, 800]) {
  if (!document.fonts) return Promise.resolve();
  return Promise.all(weights.map((w) => document.fonts.load(`${w} 40px "Noto Sans Thai"`, 'กขค ABC 123'))).catch(() => {});
}
