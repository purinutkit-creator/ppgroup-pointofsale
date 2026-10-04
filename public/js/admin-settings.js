// Admin settings views: store, queue groups, display & promotions, sound, SMS, staff.
import { api, esc, toast, modal, confirmDialog, relTime, fmtDateTime } from './common.js';
import { state, reloadConfig } from './admin.js';
import { announce, unlockAudio } from './voice.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- generic settings form
function fieldHtml(f) {
  const v = state.config.settings[f.key];
  const hint = f.hint ? `<span class="hint">${f.hint}</span>` : '';
  switch (f.type) {
    case 'switch':
      return `<div class="switch-row"><div><b>${f.label}</b>${hint}</div>
        <label class="switch"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''}><span class="track"></span></label></div>`;
    case 'select':
      return `<div class="field"><label>${f.label}</label><select class="input" data-key="${f.key}" data-type="${f.num ? 'int' : 'str'}">
        ${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>${hint}</div>`;
    case 'textarea':
      return `<div class="field"><label>${f.label}</label><textarea class="input" data-key="${f.key}" rows="${f.rows || 3}">${esc(v)}</textarea>${hint}</div>`;
    case 'range':
      return `<div class="field"><label>${f.label}: <b data-out="${f.key}" data-unit="${f.unit || ''}">${v}${f.unit || ''}</b></label>
        <input type="range" data-key="${f.key}" data-type="int" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${v}" style="accent-color:var(--primary)">${hint}</div>`;
    default:
      return `<div class="field"><label>${f.label}</label><input class="input" data-key="${f.key}" data-type="${f.type === 'number' ? 'int' : 'str'}"
        type="${f.type || 'text'}" value="${esc(v)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>${hint}</div>`;
  }
}

function collect(root) {
  const out = {};
  root.querySelectorAll('[data-key]').forEach((el) => {
    if (el.type === 'checkbox') out[el.dataset.key] = el.checked;
    else if (el.dataset.type === 'int') out[el.dataset.key] = Number(el.value);
    else out[el.dataset.key] = el.value;
  });
  return out;
}

function settingsPanel({ id, title, hint, fields, extra = '', saveLabel = 'บันทึก' }) {
  return `<form class="panel" data-settings="${id}">
    <h2>${title}</h2>${hint ? `<span class="hint">${hint}</span>` : ''}
    ${fields.map((f) => (Array.isArray(f) ? `<div class="form-row">${f.map(fieldHtml).join('')}</div>` : fieldHtml(f))).join('')}
    ${extra}
    <div class="form-actions"><button class="btn btn-primary" type="submit">${saveLabel}</button></div>
  </form>`;
}

function bindSettingsForms(root, after) {
  root.querySelectorAll('input[type=range]').forEach((r) => {
    r.addEventListener('input', () => {
      const out = root.querySelector(`[data-out="${r.dataset.key}"]`);
      if (out) out.textContent = r.value + out.dataset.unit;
    });
  });
  root.querySelectorAll('form[data-settings]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        state.config = await api('/api/admin/settings', { method: 'PUT', body: collect(form) });
        toast('บันทึกแล้ว — อุปกรณ์ทุกเครื่องอัปเดตทันที', 'ok');
        after && after(form);
      } catch (ex) { toast(ex.message, 'error'); } finally { btn.disabled = false; }
    });
  });
}

// ====================================================================== store
const THEME_PRESETS = ['#E4572E', '#D62839', '#F2A541', '#1F9D55', '#0E7C7B', '#2563EB', '#6D28D9', '#DB2777', '#1C1B19', '#8B5E34'];

export const store = {
  render(el) {
    const s = state.config.store;
    el.innerHTML = `<div class="grid grid-2">
      <form class="panel" id="storeForm">
        <h2>ข้อมูลร้าน</h2><span class="hint">แสดงบน Kiosk, หน้าจอบอกคิว, บัตรคิว และหน้าติดตามคิว</span>
        <div class="field"><label>ชื่อร้าน</label><input class="input" name="name" value="${esc(s.name)}" required maxlength="120"></div>
        <div class="field"><label>ข้อความต้อนรับ</label><input class="input" name="welcome_text" value="${esc(s.welcome_text)}" maxlength="300"></div>
        <div class="field"><label>โลโก้ร้าน (Image URL)</label>
          <div class="row" style="align-items:flex-start;flex-wrap:nowrap">
            <img class="logo-preview" id="logoPreview" alt="" ${s.logo_url ? `src="${esc(s.logo_url)}"` : ''}>
            <div class="grow"><input class="input" name="logo_url" id="logoUrl" value="${esc(s.logo_url)}" placeholder="https://example.com/logo.png">
            <span class="hint">ใส่ลิงก์รูปภาพ (PNG/JPG/SVG) — เว้นว่างหากไม่ใช้โลโก้</span></div>
          </div>
        </div>
        <div class="field"><label>สี Theme</label>
          <div class="color-row">
            <input type="color" name="theme_color" id="themeColor" value="${esc(s.theme_color)}">
            <input class="input mono" id="themeHex" value="${esc(s.theme_color)}" style="width:120px">
            ${THEME_PRESETS.map((c) => `<span class="swatch" data-color="${c}" style="background:${c}" title="${c}"></span>`).join('')}
          </div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">บันทึกข้อมูลร้าน</button></div>
      </form>
      ${settingsPanel({
        id: 'kiosk', title: 'ตู้กดบัตรคิว (Kiosk)', hint: 'การทำงานของหน้ารับบัตรคิว',
        fields: [
          { key: 'kiosk_button_label', label: 'ข้อความปุ่มหน้าแรก' },
          { key: 'kiosk_require_name', type: 'switch', label: 'บังคับกรอกชื่อลูกค้า', hint: 'ปิดไว้ = ไม่บังคับใส่ชื่อ' },
          { key: 'kiosk_ask_phone', type: 'switch', label: 'แสดงช่องเบอร์โทรศัพท์ (ไม่บังคับ)' },
          { key: 'kiosk_return_seconds', type: 'number', min: 3, max: 120, label: 'กลับหน้าแรกอัตโนมัติหลังรับคิว (วินาที)' },
        ],
      })}
      ${settingsPanel({
        id: 'ticket', title: 'บัตรคิว', hint: 'ข้อความบนใบคิว (พิมพ์ด้วยฟอนต์ Noto Sans Thai)',
        fields: [
          { key: 'ticket_note', label: 'ข้อความใต้จำนวนคิว' },
          { key: 'ticket_footer', label: 'ข้อความท้ายบัตร' },
          { key: 'ticket_show_logo', type: 'switch', label: 'พิมพ์โลโก้ร้าน' },
          { key: 'ticket_show_qr', type: 'switch', label: 'พิมพ์ QR Code ติดตามคิว' },
        ],
      })}
      ${settingsPanel({
        id: 'policy', title: 'นโยบายคิว & รีเซ็ตคิว',
        fields: [
          [{ key: 'queue_digits', type: 'select', num: true, label: 'จำนวนหลักของเลขคิว', options: [[2, '2 หลัก (A01)'], [3, '3 หลัก (A001)'], [4, '4 หลัก (A0001)']] },
            { key: 'ahead_policy', type: 'select', label: 'การนับ “คิวก่อนหน้า”', options: [['group', 'นับเฉพาะประเภทเดียวกัน (A/B/C/D)'], ['all', 'นับทุกประเภทตามลำดับเวลา']] }],
          { key: 'auto_reset_enabled', type: 'switch', label: 'รีเซ็ตเลขคิวอัตโนมัติทุกวัน', hint: 'คิวที่ค้างอยู่จะถูกยกเลิกเมื่อขึ้นวันใหม่' },
          [{ key: 'auto_reset_time', type: 'time', label: 'เวลารีเซ็ตอัตโนมัติ' },
            { key: 'timezone', type: 'select', label: 'เขตเวลา', options: [['Asia/Bangkok', 'Asia/Bangkok (GMT+7)'], ['Asia/Singapore', 'Asia/Singapore'], ['Asia/Tokyo', 'Asia/Tokyo'], ['UTC', 'UTC']] }],
          { key: 'public_base_url', label: 'Public URL ของระบบ (สำหรับ QR Code / SMS)', placeholder: state.config.detected_base_url, hint: `เว้นว่าง = ใช้ที่อยู่ที่ Kiosk เปิดอยู่ (${esc(state.config.detected_base_url)}) — ควรตั้งเป็นโดเมนที่ลูกค้าเข้าถึงได้จากอินเทอร์เน็ต` },
        ],
        extra: `<div class="switch-row"><div><b>รีเซ็ตเลขคิวตอนนี้</b><span class="hint">เริ่มนับเลขคิวใหม่ทุกประเภท</span></div>
          <button class="btn btn-danger btn-sm" type="button" id="resetBtn">Reset Queue Number</button></div>`,
      })}
    </div>`;
    const form = $('storeForm');
    const preview = () => { const u = $('logoUrl').value.trim(); $('logoPreview').src = u || ''; };
    $('logoUrl').addEventListener('change', preview);
    const setColor = (c) => { $('themeColor').value = c; $('themeHex').value = c; };
    $('themeColor').addEventListener('input', () => { $('themeHex').value = $('themeColor').value; });
    $('themeHex').addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test($('themeHex').value)) $('themeColor').value = $('themeHex').value; });
    el.querySelectorAll('.swatch').forEach((sw) => { sw.onclick = () => setColor(sw.dataset.color); });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      try {
        state.config = await api('/api/admin/store', { method: 'PUT', body: fd });
        await reloadConfig();
        toast('บันทึกข้อมูลร้านแล้ว', 'ok');
      } catch (ex) { toast(ex.message, 'error'); }
    };
    $('resetBtn').onclick = () => {
      modal({
        title: 'Reset Queue Number',
        body: `<p>เลขคิวทุกประเภทจะเริ่มนับใหม่จากเลขเริ่มต้น และหน้าจอบอกคิวจะถูกล้าง</p>
          <label class="check"><input type="checkbox" id="cancelActive" checked> ยกเลิกคิวที่ยังรออยู่ทั้งหมด (แนะนำ เพื่อป้องกันเลขคิวซ้ำกันหน้าร้าน)</label>`,
        actions: [
          { label: 'ยกเลิก' },
          {
            label: 'รีเซ็ต', class: 'btn-danger',
            onClick: async (b) => {
              await api('/api/admin/queue/reset', { method: 'POST', body: { cancel_active: b.querySelector('#cancelActive').checked } });
              toast('รีเซ็ตเลขคิวแล้ว', 'ok');
            },
          },
        ],
      });
    };
    bindSettingsForms(el);
  },
};

// ====================================================================== groups
export const groups = {
  render(el) {
    let rows = state.config.groups.filter((g) => !g.prefix.startsWith('~')).map((g) => ({ ...g }));
    el.innerHTML = `<div class="panel">
        <div class="panel-head"><h2>ประเภทคิวตามจำนวนลูกค้า</h2><div class="spacer"></div>
          <button class="btn" id="addGroup" type="button">＋ เพิ่มประเภท</button></div>
        <p class="hint" style="margin-top:-6px">ระบบเลือกประเภทคิวให้อัตโนมัติตามจำนวนคนที่ลูกค้ากด — แต่ละประเภทนับเลขแยกกัน (เช่น A001, B001) ช่วงจำนวนคนต้องไม่ทับซ้อนกัน</p>
        <div class="table-wrap"><table class="tbl groups-table"><thead><tr>
          <th style="width:90px">ตัวอักษร</th><th>ชื่อ/คำอธิบาย</th><th style="width:110px">จำนวนคน (ต่ำสุด)</th><th style="width:110px">จำนวนคน (สูงสุด)</th>
          <th style="width:110px">เลขเริ่มต้น</th><th style="width:110px">เลขล่าสุด</th><th style="width:90px">เปิดใช้</th><th style="width:150px"></th>
        </tr></thead><tbody id="gBody"></tbody></table></div>
        <div class="form-actions"><button class="btn btn-primary" id="saveGroups" type="button">บันทึกประเภทคิว</button></div>
      </div>
      <div class="grid grid-2" style="margin-top:16px">
      ${settingsPanel({
        id: 'over', title: 'กรณีลูกค้าเกินจำนวนสูงสุด',
        hint: 'เช่น เกิน 12 คน — หรือเพิ่มประเภทใหม่ (เช่น E: 13–20 คน) ในตารางด้านบน',
        fields: [
          { key: 'over_limit_policy', type: 'select', label: 'เมื่อเลือกจำนวนคนเกินที่รองรับ', options: [['contact_staff', 'ให้ติดต่อพนักงาน'], ['deny', 'ไม่อนุญาตให้กดคิว']] },
          { key: 'over_limit_message', label: 'ข้อความที่แสดง', hint: '{max} = จำนวนสูงสุดที่รองรับ' },
        ],
      })}</div>`;
    const draw = () => {
      $('gBody').innerHTML = rows.map((g, i) => `<tr data-i="${i}">
        <td><input class="input mono" data-f="prefix" value="${esc(g.prefix)}" maxlength="2" style="text-transform:uppercase;font-weight:800"></td>
        <td><input class="input" data-f="name" value="${esc(g.name)}"></td>
        <td><input class="input" type="number" min="1" data-f="min_pax" value="${g.min_pax}"></td>
        <td><input class="input" type="number" min="1" data-f="max_pax" value="${g.max_pax}"></td>
        <td><input class="input" type="number" min="0" data-f="start_number" value="${g.start_number ?? 1}"></td>
        <td class="muted">${g.last_seq ?? 0}</td>
        <td><label class="switch"><input type="checkbox" data-f="active" ${g.active ? 'checked' : ''}><span class="track"></span></label></td>
        <td><div class="row" style="gap:4px;flex-wrap:nowrap">
          <button class="btn btn-sm btn-ghost" data-move="-1" type="button" title="ขึ้น">↑</button>
          <button class="btn btn-sm btn-ghost" data-move="1" type="button" title="ลง">↓</button>
          <button class="btn btn-sm btn-ghost" data-del type="button" title="ลบ">✕</button></div></td>
      </tr>`).join('');
    };
    const read = () => {
      $('gBody').querySelectorAll('tr').forEach((tr) => {
        const g = rows[tr.dataset.i];
        tr.querySelectorAll('[data-f]').forEach((inp) => {
          const f = inp.dataset.f;
          if (inp.type === 'checkbox') g[f] = inp.checked;
          else if (inp.type === 'number') g[f] = Number(inp.value);
          else if (f === 'prefix') g[f] = inp.value.trim().toUpperCase();
          else g[f] = inp.value;
        });
      });
    };
    draw();
    $('gBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      read();
      const i = Number(tr.dataset.i);
      if (e.target.closest('[data-del]')) rows.splice(i, 1);
      const mv = e.target.closest('[data-move]');
      if (mv) {
        const j = i + Number(mv.dataset.move);
        if (j >= 0 && j < rows.length) [rows[i], rows[j]] = [rows[j], rows[i]];
      }
      if (e.target.closest('button')) draw();
    });
    $('addGroup').onclick = () => {
      read();
      const used = new Set(rows.map((r) => r.prefix));
      const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((c) => !used.has(c)) || '';
      const max = Math.max(0, ...rows.map((r) => r.max_pax));
      rows.push({ prefix: letter, name: `${max + 1}+ ท่าน`, min_pax: max + 1, max_pax: max + 8, start_number: 1, active: true });
      draw();
    };
    $('saveGroups').onclick = async () => {
      read();
      try {
        state.config = await api('/api/admin/groups', { method: 'PUT', body: { groups: rows } });
        rows = state.config.groups.filter((g) => !g.prefix.startsWith('~')).map((g) => ({ ...g }));
        draw();
        toast('บันทึกประเภทคิวแล้ว', 'ok');
      } catch (ex) { toast(ex.message, 'error'); }
    };
    bindSettingsForms(el);
  },
};

// ====================================================================== display & promotions
let pairTimer = null;
export const display = {
  render(el) {
    el.innerHTML = `<div class="grid grid-2">
      <div class="panel">
        <div class="panel-head"><h2>หน้าจอที่เชื่อมต่อ</h2><div class="spacer"></div>
          <button class="btn btn-primary" id="pairBtn" type="button">เชื่อมต่อหน้าจอบอกคิว</button></div>
        <div id="pairBox" hidden></div>
        <div id="devices"></div>
        <p class="hint">บน TV/จอที่จะใช้ ให้เปิด <b>${esc(location.origin)}/display/pair</b> แล้วกรอกรหัส — ใช้ได้ข้ามเครื่อง ข้ามเบราว์เซอร์ และข้ามเครือข่าย</p>
      </div>
      ${settingsPanel({
        id: 'display', title: 'การแสดงผล',
        fields: [
          [{ key: 'display_count', type: 'select', num: true, label: 'จำนวนคิวที่แสดงในแต่ละช่อง', options: [[1, 'เฉพาะคิวล่าสุด'], [3, '3 คิวล่าสุด'], [5, '5 คิวล่าสุด']] },
            { key: 'display_flash_seconds', type: 'number', min: 2, max: 60, label: 'ระยะเวลา Highlight (วินาที)' }],
          { key: 'display_show_waiting', type: 'switch', label: 'แสดงจำนวนคิวที่รอในแต่ละช่อง' },
          { key: 'display_popup', type: 'switch', label: 'แสดงหมายเลขขนาดใหญ่กลางจอเมื่อเรียกคิว' },
          [{ key: 'slide_interval', type: 'select', num: true, label: 'เปลี่ยนรูปโปรโมชั่นทุก', options: [[5, '5 วินาที'], [10, '10 วินาที'], [15, '15 วินาที'], [30, '30 วินาที'], [60, '60 วินาที']] },
            { key: 'image_fit', type: 'select', label: 'การแสดงรูป', options: [['contain', 'แสดงทั้งรูป (contain)'], ['cover', 'เต็มกรอบ (cover)']] }],
        ],
      })}
      <div class="panel">
        <h2>รูปภาพโปรโมชั่น</h2><span class="hint">แสดงด้านขวาของหน้าจอบอกคิว — หลายรูปจะเป็น Slideshow อัตโนมัติ (แนะนำอัตราส่วน 16:10 หรือ 4:3)</span>
        <form class="row" id="promoForm" style="margin-bottom:14px;flex-wrap:nowrap">
          <input class="input grow" id="promoUrl" placeholder="https://example.com/promotion.jpg" required>
          <button class="btn btn-primary" type="submit">เพิ่มรูป</button>
        </form>
        <div class="promo-list" id="promos"></div>
      </div>
      ${settingsPanel({
        id: 'marquee', title: 'ข้อความวิ่งด้านล่าง',
        fields: [
          { key: 'marquee_enabled', type: 'switch', label: 'แสดงข้อความวิ่ง' },
          { key: 'marquee_text', type: 'textarea', label: 'ข้อความ', rows: 2 },
          { key: 'marquee_speed', type: 'range', min: 1, max: 10, label: 'ความเร็ว' },
          { key: 'marquee_font_size', type: 'range', min: 16, max: 120, step: 2, label: 'ขนาดตัวอักษร (ที่ 1080p)', unit: 'px' },
        ],
      })}
    </div>`;
    $('pairBtn').onclick = generateCode;
    $('promoForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        state.config = await api('/api/admin/promotions', { method: 'POST', body: { url: $('promoUrl').value.trim() } });
        $('promoUrl').value = '';
        drawPromos();
      } catch (ex) { toast(ex.message, 'error'); }
    };
    $('promos').addEventListener('click', onPromoClick);
    bindSettingsForms(el);
    drawPromos();
    drawDevices();
    api('/api/admin/displays').then((d) => { state.displays = d.devices; drawDevices(); }).catch(() => {});
  },
  on: {
    displays: () => drawDevices(),
    paired: () => { clearInterval(pairTimer); const b = $('pairBox'); if (b) { b.innerHTML = '<div class="status-box"><span class="dot ok"></span>เชื่อมต่อหน้าจอสำเร็จ</div>'; } },
    config: () => drawPromos(),
  },
};

async function generateCode() {
  try {
    const r = await api('/api/admin/displays/pairing-code', { method: 'POST' });
    const box = $('pairBox');
    box.hidden = false;
    clearInterval(pairTimer);
    const draw = () => {
      const left = Math.max(0, Math.round((r.expires_at - Date.now()) / 1000));
      box.innerHTML = `<div class="panel" style="text-align:center;background:var(--surface-2);margin-bottom:14px">
        <b>รหัสเชื่อมต่อ (One-Time Code)</b>
        <div class="pair-code">${r.code.split('').map((c) => `<span>${c}</span>`).join('')}</div>
        <div class="muted">${left > 0 ? `หมดอายุใน ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} นาที · ใช้ได้ครั้งเดียว` : 'รหัสหมดอายุแล้ว'}</div>
        <button class="btn btn-sm" style="margin-top:8px" id="newCode" type="button">Generate New Pairing Code</button></div>`;
      $('newCode').onclick = generateCode;
      if (left <= 0) clearInterval(pairTimer);
    };
    draw();
    pairTimer = setInterval(() => { if ($('pairBox')) draw(); else clearInterval(pairTimer); }, 1000);
  } catch (e) { toast(e.message, 'error'); }
}

function drawDevices() {
  const box = $('devices');
  if (!box) return;
  const list = state.displays || [];
  box.innerHTML = list.length ? list.map((d) => `<div class="device" data-id="${d.id}">
      <div class="device-ico">📺</div>
      <div class="grow"><b>${esc(d.name)}</b>
        <div class="muted" style="font-size:.88rem">${d.online ? '<span class="dot ok"></span> Online' : '<span class="dot danger"></span> Offline'} · Last Seen: ${relTime(d.last_seen_at)}</div></div>
      <button class="btn btn-sm" data-rename type="button">Rename</button>
      <button class="btn btn-sm btn-danger" data-disconnect type="button">Disconnect</button>
    </div>`).join('') : '<div class="empty">ยังไม่มีหน้าจอที่เชื่อมต่อ</div>';
  box.onclick = async (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const dev = list.find((d) => d.id === row.dataset.id);
    if (e.target.closest('[data-rename]')) {
      modal({
        title: 'เปลี่ยนชื่อหน้าจอ',
        body: `<input class="input" id="devName" value="${esc(dev.name)}" maxlength="60">`,
        actions: [{ label: 'ยกเลิก' }, {
          label: 'บันทึก', class: 'btn-primary',
          onClick: async (b) => { state.displays = (await api(`/api/admin/displays/${dev.id}`, { method: 'PATCH', body: { name: b.querySelector('#devName').value } })).devices; drawDevices(); },
        }],
      });
    }
    if (e.target.closest('[data-disconnect]')) {
      if (!(await confirmDialog('Disconnect', `ยกเลิกการเชื่อมต่อ ${dev.name}? หน้าจอนี้จะต้องกรอกรหัสใหม่`, { danger: true, okLabel: 'Disconnect' }))) return;
      try { state.displays = (await api(`/api/admin/displays/${dev.id}`, { method: 'DELETE' })).devices; drawDevices(); } catch (ex) { toast(ex.message, 'error'); }
    }
  };
}

function drawPromos() {
  const box = $('promos');
  if (!box) return;
  const list = state.config.promotions;
  box.innerHTML = list.length ? list.map((p, i) => `<div class="promo-item ${p.active ? '' : 'off'}" data-id="${p.id}">
      <img src="${esc(p.url)}" alt="" loading="lazy" onerror="this.style.opacity=.3">
      <div style="min-width:0"><b>รูปที่ ${i + 1}</b>${p.active ? '' : ' <span class="pill">ปิดอยู่</span>'}<div class="url">${esc(p.url)}</div></div>
      <div class="row" style="gap:4px;flex-wrap:nowrap">
        <button class="btn btn-sm btn-ghost" data-pm="up" ${i === 0 ? 'disabled' : ''} type="button">↑</button>
        <button class="btn btn-sm btn-ghost" data-pm="down" ${i === list.length - 1 ? 'disabled' : ''} type="button">↓</button>
        <button class="btn btn-sm" data-pm="toggle" type="button">${p.active ? 'ซ่อน' : 'แสดง'}</button>
        <button class="btn btn-sm btn-ghost" data-pm="del" type="button">ลบ</button>
      </div></div>`).join('') : '<div class="empty">ยังไม่มีรูปโปรโมชั่น — หน้าจอจะแสดงโลโก้และชื่อร้านแทน</div>';
}

async function onPromoClick(e) {
  const btn = e.target.closest('[data-pm]');
  if (!btn) return;
  const id = Number(btn.closest('[data-id]').dataset.id);
  const list = state.config.promotions;
  const i = list.findIndex((p) => p.id === id);
  try {
    if (btn.dataset.pm === 'del') {
      if (!(await confirmDialog('ลบรูปโปรโมชั่น', 'ต้องการลบรูปนี้?', { danger: true, okLabel: 'ลบ' }))) return;
      state.config = await api(`/api/admin/promotions/${id}`, { method: 'DELETE' });
    } else if (btn.dataset.pm === 'toggle') {
      state.config = await api(`/api/admin/promotions/${id}`, { method: 'PUT', body: { active: !list[i].active } });
    } else {
      const ids = list.map((p) => p.id);
      const j = i + (btn.dataset.pm === 'up' ? -1 : 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      state.config = await api('/api/admin/promotions/order', { method: 'PUT', body: { ids } });
    }
    drawPromos();
  } catch (ex) { toast(ex.message, 'error'); }
}

// ====================================================================== sound
export const sound = {
  render(el) {
    el.innerHTML = `<div class="grid grid-2">
      ${settingsPanel({
        id: 'sound', title: 'เสียงเรียกคิว', hint: 'เล่นบนหน้าจอบอกคิว (Queue Display) เมื่อพนักงานกดเรียกคิว',
        fields: [
          { key: 'sound_enabled', type: 'switch', label: 'เปิดเสียงเรียกคิว' },
          { key: 'sound_chime', type: 'switch', label: 'เสียง Sound Effect (ติ๊ง-ต่อง) ก่อนประกาศ' },
          [{ key: 'sound_voice', type: 'select', label: 'ภาษาเสียงประกาศ', options: [['th', 'Thai Voice'], ['en', 'English Voice'], ['th_en', 'ไทย + English']] },
            { key: 'sound_repeat', type: 'select', num: true, label: 'จำนวนรอบที่ประกาศ', options: [[1, '1 รอบ'], [2, '2 รอบ'], [3, '3 รอบ']] }],
          { key: 'sound_volume', type: 'range', min: 0, max: 100, step: 5, label: 'Volume', unit: '%' },
          { key: 'sound_rate', type: 'range', min: 5, max: 15, label: 'ความเร็วเสียงพูด (10 = ปกติ)' },
          { key: 'sound_template_th', label: 'ข้อความประกาศ (ไทย)', hint: '{queue} จะถูกอ่านทีละตัว เช่น B026 → “บี ศูนย์ สอง หก”' },
          { key: 'sound_template_en', label: 'ข้อความประกาศ (English)' },
          { key: 'sound_on_admin', type: 'switch', label: 'เล่นเสียงบนหน้า Admin นี้ด้วย' },
        ],
        extra: '<div class="row" style="margin-top:10px"><input class="input" id="testQueue" value="B026" style="width:120px"><button class="btn" id="testSound" type="button">▶ ทดสอบเสียงบนเครื่องนี้</button></div>',
      })}
      <div class="panel"><h2>หมายเหตุการใช้งานเสียง</h2>
        <ul class="hint" style="padding-left:18px;line-height:1.8">
          <li>เบราว์เซอร์ต้องมีการแตะหน้าจอ 1 ครั้งก่อนจึงจะเล่นเสียงได้ หน้าจอบอกคิวจะแสดงปุ่ม “แตะเพื่อเปิดเสียง” ให้อัตโนมัติ</li>
          <li>สำหรับ TV/Mini PC ที่ไม่มีคนแตะ ให้เปิด Chrome ด้วย <code>--autoplay-policy=no-user-gesture-required --kiosk</code></li>
          <li>เสียงภาษาไทยใช้ Text-to-Speech ของเครื่อง (Windows/Android/ChromeOS/macOS มีเสียงภาษาไทยในตัว)</li>
        </ul>
      </div>
    </div>`;
    bindSettingsForms(el);
    $('testSound').onclick = () => {
      unlockAudio();
      const form = el.querySelector('[data-settings="sound"]');
      announce($('testQueue').value.trim().toUpperCase() || 'A001', { ...state.config.settings, ...collect(form), sound_enabled: true });
    };
  },
};

// ====================================================================== sms
export const sms = {
  render(el) {
    el.innerHTML = `<div class="grid grid-2">
      ${settingsPanel({
        id: 'sms', title: 'SMS แจ้งเตือนลูกค้า',
        hint: 'ลูกค้าที่กรอกเบอร์โทรและเลือก “ส่ง SMS แจ้งเตือน” ที่ Kiosk จะได้รับ SMS เมื่อพนักงานกดเรียกคิว',
        fields: [
          { key: 'sms_enabled', type: 'switch', label: 'เปิดใช้งาน SMS', hint: 'เมื่อเปิด Kiosk จะแสดงตัวเลือกให้ลูกค้ารับ SMS' },
          [{ key: 'sms_provider', type: 'select', label: 'ผู้ให้บริการ SMS', options: [['thaibulksms', 'ThaiBulkSMS'], ['twilio', 'Twilio'], ['webhook', 'Webhook (ผู้ให้บริการอื่น)']] },
            { key: 'sms_country_code', label: 'รหัสประเทศ', hint: 'ใช้แปลง 08x → +668x' }],
          { key: 'sms_template_called', type: 'textarea', rows: 2, label: 'ข้อความเมื่อถึงคิว', hint: '{store} ชื่อร้าน · {queue} เลขคิว · {name} ชื่อ · {pax} จำนวนคน · {url} ลิงก์ติดตามคิว' },
          { key: 'sms_resend_on_recall', type: 'switch', label: 'ส่ง SMS ซ้ำเมื่อกด “เรียกซ้ำ”' },
          { key: 'sms_near_threshold', type: 'number', min: 0, max: 20, label: 'แจ้งเตือนล่วงหน้าเมื่อเหลือคิวก่อนหน้า (คิว)', hint: '0 = ไม่ส่ง' },
          { key: 'sms_template_near', type: 'textarea', rows: 2, label: 'ข้อความแจ้งเตือนล่วงหน้า', hint: '{ahead} = จำนวนคิวก่อนหน้า' },
        ],
        extra: `<div data-provider="thaibulksms"><b>ThaiBulkSMS</b>
            <div class="form-row">${fieldHtml({ key: 'sms_tbs_key', label: 'API Key' })}${fieldHtml({ key: 'sms_tbs_secret', label: 'API Secret', type: 'password' })}</div>
            ${fieldHtml({ key: 'sms_tbs_sender', label: 'Sender Name', hint: 'ชื่อผู้ส่งที่ลงทะเบียนไว้กับ ThaiBulkSMS' })}</div>
          <div data-provider="twilio"><b>Twilio</b>
            <div class="form-row">${fieldHtml({ key: 'sms_twilio_sid', label: 'Account SID' })}${fieldHtml({ key: 'sms_twilio_token', label: 'Auth Token', type: 'password' })}</div>
            ${fieldHtml({ key: 'sms_twilio_from', label: 'From (เบอร์ผู้ส่ง เช่น +1xxxx)' })}</div>
          <div data-provider="webhook"><b>Webhook</b>
            ${fieldHtml({ key: 'sms_webhook_url', label: 'Webhook URL', hint: 'ระบบจะ POST JSON: {"to","to_e164","message"}' })}
            ${fieldHtml({ key: 'sms_webhook_auth', label: 'Authorization Header (ถ้ามี)', type: 'password', placeholder: 'Bearer xxxxx' })}</div>`,
      })}
      <div class="panel">
        <h2>ทดสอบการส่ง SMS</h2><span class="hint">บันทึกการตั้งค่าก่อนทดสอบ</span>
        <form class="row" id="smsTest" style="flex-wrap:nowrap"><input class="input grow" id="smsPhone" inputmode="tel" placeholder="08xxxxxxxx" required><button class="btn btn-primary" type="submit">ส่ง SMS ทดสอบ</button></form>
        <h2 style="margin-top:20px">ประวัติการส่งล่าสุด</h2>
        <div class="table-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>เวลา</th><th>เบอร์</th><th>ประเภท</th><th>สถานะ</th></tr></thead><tbody id="smsLogs"></tbody></table></div>
      </div>
    </div>`;
    const sel = el.querySelector('[data-key="sms_provider"]');
    const showProvider = () => el.querySelectorAll('[data-provider]').forEach((d) => { d.hidden = d.dataset.provider !== sel.value; });
    sel.addEventListener('change', showProvider);
    showProvider();
    bindSettingsForms(el);
    $('smsTest').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try { await api('/api/admin/sms/test', { method: 'POST', body: { phone: $('smsPhone').value } }); toast('ส่ง SMS แล้ว', 'ok'); } catch (ex) { toast(ex.message, 'error'); } finally { btn.disabled = false; }
    };
    api('/api/admin/sms/logs').then((d) => { state.sms = d.logs; drawSmsLogs(); }).catch(() => {});
  },
  on: { sms: () => drawSmsLogs() },
};

function drawSmsLogs() {
  const body = $('smsLogs');
  if (!body) return;
  const kind = { called: 'ถึงคิว', near: 'ใกล้ถึงคิว', test: 'ทดสอบ', manual: 'อื่นๆ' };
  body.innerHTML = state.sms.length ? state.sms.map((l) => `<tr title="${esc(l.error || l.message)}"><td>${fmtDateTime(l.created_at)}</td><td>${esc(l.phone)}</td><td>${kind[l.kind] || l.kind}</td>
    <td>${l.status === 'sent' ? '<span class="pill ok">ส่งแล้ว</span>' : `<span class="pill danger">ไม่สำเร็จ</span> <span class="muted" style="font-size:.8rem">${esc(l.error.slice(0, 60))}</span>`}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">ยังไม่มีการส่ง</td></tr>';
}

// ====================================================================== staff
export const staff = {
  async render(el) {
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><h2>พนักงานและผู้ดูแลระบบ</h2><div class="spacer"></div><button class="btn btn-primary" id="addStaff" type="button">＋ เพิ่มพนักงาน</button></div>
      <p class="hint" style="margin-top:-6px"><b>ผู้ดูแลระบบ</b> ตั้งค่าได้ทุกอย่าง · <b>พนักงาน</b> จัดการ/เรียกคิว และดูประวัติได้</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อที่แสดง</th><th>สิทธิ์</th><th>สถานะ</th><th>เข้าสู่ระบบล่าสุด</th><th></th></tr></thead><tbody id="staffBody"></tbody></table></div></div>`;
    let list = (await api('/api/admin/staff')).staff;
    const draw = () => {
      $('staffBody').innerHTML = list.map((s) => `<tr data-id="${s.id}">
        <td><b>${esc(s.username)}</b>${s.id === state.me.id ? ' <span class="pill">คุณ</span>' : ''}</td><td>${esc(s.display_name)}</td>
        <td>${s.role === 'admin' ? '<span class="pill primary">ผู้ดูแลระบบ</span>' : '<span class="pill">พนักงาน</span>'}</td>
        <td>${s.active ? '<span class="pill ok">ใช้งาน</span>' : '<span class="pill danger">ปิดใช้งาน</span>'}</td>
        <td>${s.last_login_at ? fmtDateTime(s.last_login_at) : '–'}</td>
        <td><button class="btn btn-sm" data-edit type="button">แก้ไข</button> ${s.id !== state.me.id ? '<button class="btn btn-sm btn-ghost" data-del type="button">ลบ</button>' : ''}</td></tr>`).join('');
    };
    draw();
    const form = (s = {}) => `
      ${s.id ? '' : '<div class="field"><label>ชื่อผู้ใช้ (a-z, 0-9)</label><input class="input" id="sfUser" autocomplete="off"></div>'}
      <div class="field"><label>ชื่อที่แสดง</label><input class="input" id="sfName" value="${esc(s.display_name || '')}"></div>
      <div class="field"><label>สิทธิ์</label><select class="input" id="sfRole"><option value="staff">พนักงาน</option><option value="admin" ${s.role === 'admin' ? 'selected' : ''}>ผู้ดูแลระบบ</option></select></div>
      <div class="field"><label>${s.id ? 'รหัสผ่านใหม่ (เว้นว่างหากไม่เปลี่ยน)' : 'รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)'}</label><input class="input" type="password" id="sfPass" autocomplete="new-password"></div>
      ${s.id ? `<label class="check"><input type="checkbox" id="sfActive" ${s.active ? 'checked' : ''}> เปิดใช้งานบัญชี</label>` : ''}`;
    $('addStaff').onclick = () => modal({
      title: 'เพิ่มพนักงาน', body: form(),
      actions: [{ label: 'ยกเลิก' }, {
        label: 'เพิ่ม', class: 'btn-primary',
        onClick: async (b) => {
          list = (await api('/api/admin/staff', { method: 'POST', body: { username: b.querySelector('#sfUser').value.trim(), display_name: b.querySelector('#sfName').value, role: b.querySelector('#sfRole').value, password: b.querySelector('#sfPass').value } })).staff;
          draw();
          toast('เพิ่มพนักงานแล้ว', 'ok');
        },
      }],
    });
    $('staffBody').onclick = async (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const s = list.find((x) => x.id === Number(tr.dataset.id));
      if (e.target.closest('[data-edit]')) {
        modal({
          title: `แก้ไข ${s.username}`, body: form(s),
          actions: [{ label: 'ยกเลิก' }, {
            label: 'บันทึก', class: 'btn-primary',
            onClick: async (b) => {
              const body = { display_name: b.querySelector('#sfName').value, role: b.querySelector('#sfRole').value, active: b.querySelector('#sfActive').checked };
              const pw = b.querySelector('#sfPass').value;
              if (pw) body.password = pw;
              list = (await api(`/api/admin/staff/${s.id}`, { method: 'PUT', body })).staff;
              draw();
              toast('บันทึกแล้ว', 'ok');
            },
          }],
        });
      }
      if (e.target.closest('[data-del]')) {
        if (!(await confirmDialog('ลบพนักงาน', `ลบบัญชี ${s.username}?`, { danger: true, okLabel: 'ลบ' }))) return;
        try { list = (await api(`/api/admin/staff/${s.id}`, { method: 'DELETE' })).staff; draw(); } catch (ex) { toast(ex.message, 'error'); }
      }
    };
  },
};
