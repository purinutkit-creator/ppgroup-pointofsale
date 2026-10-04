'use strict';
const { db } = require('./db');

/**
 * Every configurable option lives here with its default and a validator.
 * Values are stored as JSON in the `settings` table, one row per key.
 */
const str = (max = 500) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const bool = () => (v) => (typeof v === 'boolean' ? v : undefined);
const int = (min, max) => (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};
const oneOf = (...opts) => (v) => (opts.includes(v) ? v : undefined);
const time = () => (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);
const tz = () => (v) => {
  if (typeof v !== 'string') return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return v; } catch { return undefined; }
};
const url = () => (v) => {
  if (v === '') return '';
  if (typeof v !== 'string') return undefined;
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? v.replace(/\/+$/, '') : undefined; } catch { return undefined; }
};

const DEFINITIONS = {
  // ----- general / queue policy -----
  timezone:               ['Asia/Bangkok', tz()],
  public_base_url:        ['', url()],
  queue_digits:           [3, int(2, 5)],
  ahead_policy:           ['group', oneOf('group', 'all')],
  auto_reset_enabled:     [true, bool()],
  auto_reset_time:        ['05:00', time()],
  over_limit_policy:      ['contact_staff', oneOf('contact_staff', 'deny')],
  over_limit_message:     ['สำหรับลูกค้ามากกว่า {max} ท่าน กรุณาติดต่อพนักงาน', str(300)],

  // ----- kiosk -----
  kiosk_require_name:     [false, bool()],
  kiosk_ask_phone:        [true, bool()],
  kiosk_return_seconds:   [10, int(3, 120)],
  kiosk_button_label:     ['รับบัตรคิว', str(60)],

  // ----- ticket -----
  ticket_footer:          ['ขอบคุณที่ใช้บริการ', str(200)],
  ticket_note:            ['กรุณารอเรียกคิว', str(200)],
  ticket_show_logo:       [true, bool()],
  ticket_show_qr:         [true, bool()],

  // ----- display -----
  display_count:          [3, oneOf(1, 3, 5)],
  display_show_waiting:   [true, bool()],
  display_flash_seconds:  [8, int(2, 60)],
  display_popup:          [true, bool()],
  slide_interval:         [10, oneOf(5, 10, 15, 30, 60)],
  image_fit:              ['contain', oneOf('contain', 'cover')],
  marquee_enabled:        [true, bool()],
  marquee_text:           ['ขณะนี้ร้านมีคิวจำนวนมาก กรุณารอเรียกหมายเลขคิว ขอบคุณค่ะ', str(1000)],
  marquee_speed:          [5, int(1, 10)],
  marquee_font_size:      [36, int(16, 120)],

  // ----- sound -----
  sound_enabled:          [true, bool()],
  sound_voice:            ['th', oneOf('th', 'en', 'th_en')],
  sound_chime:            [true, bool()],
  sound_volume:           [90, int(0, 100)],
  sound_rate:             [9, int(5, 15)],
  sound_repeat:           [2, int(1, 3)],
  sound_template_th:      ['ขอเชิญหมายเลข {queue} กรุณาติดต่อพนักงานค่ะ', str(300)],
  sound_template_en:      ['Queue number {queue}, please proceed to the counter.', str(300)],
  sound_on_admin:         [false, bool()],

  // ----- sms -----
  sms_enabled:            [false, bool()],
  sms_provider:           ['thaibulksms', oneOf('thaibulksms', 'twilio', 'webhook')],
  sms_template_called:    ['{store}: ถึงคิว {queue} ของคุณแล้ว กรุณาติดต่อพนักงาน {url}', str(500)],
  sms_template_near:      ['{store}: อีก {ahead} คิวจะถึงคิว {queue} ของคุณ กรุณาเตรียมตัว {url}', str(500)],
  sms_near_threshold:     [0, int(0, 20)],
  sms_resend_on_recall:   [false, bool()],
  sms_country_code:       ['66', (v) => (typeof v === 'string' && /^\d{1,4}$/.test(v) ? v : undefined)],
  sms_tbs_key:            ['', str(200)],
  sms_tbs_secret:         ['', str(200)],
  sms_tbs_sender:         ['', str(30)],
  sms_twilio_sid:         ['', str(200)],
  sms_twilio_token:       ['', str(200)],
  sms_twilio_from:        ['', str(40)],
  sms_webhook_url:        ['', url()],
  sms_webhook_auth:       ['', str(500)],
};

const SECRET_KEYS = new Set(['sms_tbs_secret', 'sms_twilio_token', 'sms_webhook_auth']);
const SECRET_MASK = '••••••••';

const getRows = db.prepare('SELECT key, value FROM settings WHERE store_id = ?');
const upsert = db.prepare(`INSERT INTO settings (store_id, key, value) VALUES (?, ?, ?)
                           ON CONFLICT(store_id, key) DO UPDATE SET value = excluded.value`);

function getSettings(storeId) {
  const out = {};
  for (const [k, [def]] of Object.entries(DEFINITIONS)) out[k] = def;
  for (const row of getRows.all(storeId)) {
    if (!(row.key in DEFINITIONS)) continue;
    try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
  }
  return out;
}

/** Validate & persist a partial settings object. Returns { saved, errors }. */
function updateSettings(storeId, patch) {
  const errors = {};
  const saved = {};
  const tx = db.transaction(() => {
    for (const [k, raw] of Object.entries(patch || {})) {
      const def = DEFINITIONS[k];
      if (!def) continue;
      if (SECRET_KEYS.has(k) && raw === SECRET_MASK) continue;
      const v = def[1](raw);
      if (v === undefined) { errors[k] = 'invalid'; continue; }
      upsert.run(storeId, k, JSON.stringify(v));
      saved[k] = v;
    }
  });
  tx();
  return { saved, errors };
}

function maskSecrets(settings) {
  const out = { ...settings };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = SECRET_MASK;
  return out;
}

/** Subset safe for kiosk / display / tracking (no secrets, no admin-only data). */
const PUBLIC_KEYS = [
  'timezone', 'queue_digits', 'over_limit_policy', 'over_limit_message',
  'kiosk_require_name', 'kiosk_ask_phone', 'kiosk_return_seconds', 'kiosk_button_label',
  'ticket_footer', 'ticket_note', 'ticket_show_logo', 'ticket_show_qr',
  'display_count', 'display_show_waiting', 'display_flash_seconds', 'display_popup',
  'slide_interval', 'image_fit', 'marquee_enabled', 'marquee_text', 'marquee_speed', 'marquee_font_size',
  'sound_enabled', 'sound_voice', 'sound_chime', 'sound_volume', 'sound_rate', 'sound_repeat',
  'sound_template_th', 'sound_template_en', 'sms_enabled',
];
function publicSettings(storeId) {
  const s = getSettings(storeId);
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = s[k];
  return out;
}

module.exports = { getSettings, updateSettings, maskSecrets, publicSettings, SECRET_MASK };
