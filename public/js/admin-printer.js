// Printer settings page: connection type, device discovery/connection, test connection & test print, print job queue.
import { api, esc, toast, fmtDateTime, relTime } from './common.js';
import { state, printer, adminJobs } from './admin.js';
import { support, TRANSPORT_LABEL } from './printer-client.js';
import { renderTestPage } from './ticket.js';

const $ = (id) => document.getElementById(id);

const TYPES = [
  { id: 'usb', label: 'USB', sub: 'WebUSB', supported: () => support.usb },
  { id: 'lan', label: 'LAN', sub: 'IP + Port 9100' },
  { id: 'bluetooth', label: 'Bluetooth', sub: 'BLE · Web Bluetooth', supported: () => support.bluetooth },
  { id: 'wifi', label: 'Wi-Fi', sub: 'IP + Port 9100' },
  { id: 'printer_number', label: 'Printer Number', sub: 'Print Agent / Printer ID' },
  { id: 'serial', label: 'Serial / BT SPP', sub: 'Web Serial', supported: () => support.serial },
  { id: 'browser', label: 'System Print', sub: 'ไดรเวอร์เครื่อง / AirPrint' },
];

let draft = null;
let lastTest = null; // { connected, message }
let dirty = false; // unsaved local edits on this page

export function render(el) {
  draft = { ...state.printer };
  lastTest = null;
  dirty = false;
  el.innerHTML = `<div class="grid grid-2">
    <div class="panel">
      <h2>Connection Type</h2><span class="hint">เลือกวิธีเชื่อมต่อเครื่องพิมพ์ความร้อน (58mm / 80mm, ESC/POS Compatible)</span>
      <div class="conn-types" id="types"></div>
      <div id="statusBox"></div>
      <div id="typePanel"></div>
      <div class="form-row">
        <div class="field"><label>ขนาดกระดาษ</label><select class="input" id="paperWidth"><option value="58">58 mm (384 dots)</option><option value="80">80 mm (576 dots)</option></select></div>
        <div class="field"><label>จำนวนสำเนา</label><select class="input" id="copies"><option>1</option><option>2</option><option>3</option></select></div>
      </div>
      <div class="switch-row"><div><b>พิมพ์บัตรคิวอัตโนมัติ</b><span class="hint">พิมพ์ทันทีเมื่อลูกค้ารับคิวที่ Kiosk</span></div><label class="switch"><input type="checkbox" id="autoPrint"><span class="track"></span></label></div>
      <div class="switch-row"><div><b>ตัดกระดาษอัตโนมัติ</b><span class="hint">สำหรับเครื่องที่มีใบมีดตัด (Auto Cutter)</span></div><label class="switch"><input type="checkbox" id="cutPaper"><span class="track"></span></label></div>
      <div class="form-actions">
        <button class="btn" id="testPrintBtn" type="button">🖨 Test Print (ทดสอบพิมพ์)</button>
        <button class="btn btn-primary" id="saveBtn" type="button">บันทึกการตั้งค่า</button>
      </div>
    </div>
    <div class="panel">
      <h2>ตัวอย่างหน้าทดสอบ</h2><span class="hint">ใบคิวถูกเรนเดอร์ด้วย Noto Sans Thai เป็นภาพ (Raster) แล้วส่งเป็นคำสั่ง ESC/POS — ภาษาไทยพิมพ์ได้ถูกต้องแม้เครื่องพิมพ์ไม่มีฟอนต์ไทย</span>
      <div class="preview-ticket" id="preview"></div>
    </div>
    <div class="panel" style="grid-column:1/-1">
      <div class="panel-head"><h2>Print Job Queue</h2><span class="hint">งานพิมพ์ล่าสุดจากทุกเครื่อง · หากพิมพ์ไม่สำเร็จ คิวยังคงอยู่ สามารถพิมพ์ซ้ำได้</span></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>เวลา</th><th>งาน</th><th>ช่องทาง</th><th>สถานะ</th><th>รายละเอียด</th><th></th></tr></thead><tbody id="jobs"></tbody></table></div>
    </div>
  </div>`;
  $('paperWidth').value = String(draft.paper_width);
  $('copies').value = String(draft.copies);
  $('autoPrint').checked = draft.auto_print;
  $('cutPaper').checked = draft.cut_paper;
  $('paperWidth').onchange = () => { draft.paper_width = Number($('paperWidth').value); drawPreview(); };
  $('saveBtn').onclick = save;
  $('testPrintBtn').onclick = testPrint;
  $('jobs').onclick = onJobClick;
  el.addEventListener('input', (e) => { if (!e.target.closest('#jobs')) dirty = true; });
  drawTypes();
  drawJobs();
  drawPreview();
}

export const on = {
  printjobs: () => drawJobs(),
  // Settings changed elsewhere (another admin / tab): refresh the form unless the user is mid-edit.
  printer: () => {
    if (!dirty && ['connection_type', 'ip', 'port', 'printer_number', 'paper_width', 'copies', 'cut_paper', 'auto_print']
      .some((k) => String(draft[k]) !== String(state.printer[k]))) render($('content'));
    else drawStatus();
  },
};

function readForm() {
  draft.paper_width = Number($('paperWidth').value);
  draft.copies = Number($('copies').value);
  draft.auto_print = $('autoPrint').checked;
  draft.cut_paper = $('cutPaper').checked;
  const ip = $('ip'); if (ip) draft.ip = ip.value.trim();
  const port = $('port'); if (port) draft.port = Number(port.value) || 9100;
  const num = $('printerNumber'); if (num) draft.printer_number = num.value.trim();
  return draft;
}

async function save() {
  readForm();
  try {
    const r = await api('/api/admin/printer', { method: 'PUT', body: draft });
    state.printer = r.printer;
    printer.setConfig(r.printer);
    dirty = false;
    toast('บันทึกการตั้งค่าเครื่องพิมพ์แล้ว — Kiosk ทุกเครื่องใช้ค่าใหม่ทันที', 'ok');
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}

function drawTypes() {
  $('types').innerHTML = TYPES.map((t) => {
    const ok = !t.supported || t.supported();
    return `<button type="button" class="conn-type ${draft.connection_type === t.id ? 'on' : ''} ${ok ? '' : 'unsupported'}" data-type="${t.id}">
      ${t.label}<small>${t.sub}${ok ? '' : ' · เบราว์เซอร์นี้ไม่รองรับ'}</small></button>`;
  }).join('');
  $('types').onclick = (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    readForm();
    dirty = true;
    draft.connection_type = b.dataset.type;
    lastTest = null;
    printer.setConfig({ ...draft });
    drawTypes();
  };
  drawTypePanel();
  drawStatus();
}

function statusOf() {
  const t = draft.connection_type;
  if (['usb', 'bluetooth', 'serial'].includes(t)) {
    printer.setConfig({ ...draft });
    const s = printer.status();
    return { connected: s.connected, text: s.connected ? `เชื่อมต่อกับ ${s.label || 'เครื่องพิมพ์'} บนเบราว์เซอร์นี้` : 'ยังไม่ได้เชื่อมต่อเครื่องพิมพ์บนเบราว์เซอร์นี้' };
  }
  if (t === 'lan' || t === 'wifi') {
    if (lastTest) return { connected: lastTest.connected, text: lastTest.message };
    const known = state.printer.connection_type === t && state.printer.last_checked_at;
    if (known) return { connected: state.printer.last_status === 'connected', text: `สถานะล่าสุด (${relTime(state.printer.last_checked_at)})` };
    return { connected: null, text: 'กด Test Connection เพื่อตรวจสอบ' };
  }
  if (t === 'printer_number') {
    if (lastTest) return { connected: lastTest.connected, text: lastTest.message };
    const online = state.printer.agent_online && state.printer.printer_number === draft.printer_number;
    return { connected: online, text: online ? `Print Agent ของ ${draft.printer_number} ออนไลน์` : 'ยังไม่พบ Print Agent ที่ออนไลน์สำหรับ Printer Number นี้' };
  }
  return { connected: true, text: 'ใช้หน้าต่างพิมพ์ของระบบปฏิบัติการ (ต้องติดตั้งไดรเวอร์เครื่องพิมพ์ในเครื่อง)' };
}

function drawStatus() {
  const box = $('statusBox');
  if (!box) return;
  const s = statusOf();
  const label = s.connected === null ? '⚪ Unknown' : s.connected ? '🟢 Connected' : '🔴 Disconnected';
  box.innerHTML = `<div class="status-box"><span style="white-space:nowrap">${label}</span><span class="muted" style="font-weight:500">${esc(s.text)}</span></div>`;
}

async function drawTypePanel() {
  const t = draft.connection_type;
  const p = $('typePanel');
  const localNote = '<p class="hint">⚠️ การเชื่อมต่อนี้ผูกกับเบราว์เซอร์ของเครื่องที่ต่อเครื่องพิมพ์ — ให้เปิดหน้านี้บน <b>เครื่อง Kiosk</b> แล้วเชื่อมต่อ ระบบจะจำอุปกรณ์และเชื่อมต่อให้อัตโนมัติครั้งถัดไป</p>';
  if (t === 'lan' || t === 'wifi') {
    p.innerHTML = `<div class="form-row">
        <div class="field"><label>Printer IP</label><input class="input mono" id="ip" value="${esc(draft.ip)}" placeholder="192.168.1.100"></div>
        <div class="field"><label>Port</label><input class="input mono" id="port" type="number" value="${draft.port || 9100}"></div>
      </div>
      <div class="row" style="margin-bottom:14px"><button class="btn" id="testConn" type="button">Test Connection</button></div>
      <p class="hint">เซิร์ฟเวอร์จะส่งข้อมูลพิมพ์ไปยัง IP:Port โดยตรง (Network Print Service) — เซิร์ฟเวอร์ต้องอยู่ในเครือข่ายเดียวกับเครื่องพิมพ์ หากเซิร์ฟเวอร์อยู่บน Cloud ให้ใช้โหมด <b>Printer Number</b> ร่วมกับ Print Agent ที่ร้าน</p>`;
    $('testConn').onclick = testConnection;
  } else if (t === 'bluetooth') {
    p.innerHTML = `<div class="row" style="margin-bottom:6px">
        <button class="btn btn-primary" id="scanBt" type="button" ${support.bluetooth ? '' : 'disabled'}>🔍 Scan Printer</button>
        <button class="btn" id="disconnectBt" type="button">ตัดการเชื่อมต่อ</button></div>
      <b>รายการอุปกรณ์ที่ค้นพบ / เคยอนุญาต</b><div class="dev-list" id="devList"></div>
      <p class="hint">รองรับเครื่องพิมพ์ Bluetooth Low Energy (BLE) ผ่าน Web Bluetooth บน Chrome/Edge (Android, Windows, macOS, ChromeOS). เครื่องพิมพ์ Bluetooth Classic (SPP) ให้จับคู่ใน OS แล้วใช้โหมด <b>Serial / BT SPP</b></p>${localNote}`;
    $('scanBt').onclick = () => connectDirect();
    $('disconnectBt').onclick = async () => { await printer.disconnect(); drawStatus(); listDevices(); };
    listDevices();
  } else if (t === 'usb') {
    p.innerHTML = `<div class="row" style="margin-bottom:6px">
        <button class="btn" id="detectUsb" type="button" ${support.usb ? '' : 'disabled'}>Detect USB Printer</button>
        <button class="btn btn-primary" id="addUsb" type="button" ${support.usb ? '' : 'disabled'}>＋ เลือกเครื่องพิมพ์ USB</button></div>
      <b>เครื่องพิมพ์ USB ที่อนุญาตแล้ว</b><div class="dev-list" id="devList"></div>
      <p class="hint">ใช้ WebUSB (Chrome/Edge). บน Windows เครื่องพิมพ์ที่ติดตั้งไดรเวอร์ปกติจะถูก OS ใช้งานอยู่ ให้เปลี่ยนไดรเวอร์เป็น WinUSB (ใช้โปรแกรม Zadig) หรือใช้โหมด System Print / Printer Number แทน — บน Android/ChromeOS/Linux/macOS ใช้งานได้ทันที</p>${localNote}`;
    $('detectUsb').onclick = listDevices;
    $('addUsb').onclick = () => connectDirect();
    listDevices();
  } else if (t === 'serial') {
    p.innerHTML = `<div class="form-row"><div class="field"><label>Baud rate</label><select class="input" id="baud">
        ${[9600, 19200, 38400, 57600, 115200].map((b) => `<option ${b === 9600 ? 'selected' : ''}>${b}</option>`).join('')}</select></div></div>
      <div class="row" style="margin-bottom:6px"><button class="btn btn-primary" id="addSerial" type="button" ${support.serial ? '' : 'disabled'}>＋ เลือกพอร์ตเครื่องพิมพ์</button>
        <button class="btn" id="disconnectSerial" type="button">ตัดการเชื่อมต่อ</button></div>
      <b>พอร์ตที่อนุญาตแล้ว</b><div class="dev-list" id="devList"></div>
      <p class="hint">สำหรับเครื่องพิมพ์ USB-Serial และ Bluetooth Classic (SPP) ที่จับคู่กับคอมพิวเตอร์แล้ว (Chrome/Edge บน Windows/macOS/Linux/ChromeOS)</p>${localNote}`;
    $('addSerial').onclick = () => connectDirect({ baudRate: Number($('baud').value) });
    $('disconnectSerial').onclick = async () => { await printer.disconnect(); drawStatus(); listDevices(); };
    listDevices();
  } else if (t === 'printer_number') {
    const agentCmd = `SERVER_URL=${location.origin} AGENT_KEY=${state.printer.agent_key || '<agent-key>'} PRINTER_NUMBER=${draft.printer_number || '01'} PRINTER_TARGET=tcp://192.168.1.100:9100 node agent/print-agent.js`;
    p.innerHTML = `<div class="field"><label>Printer ID / Printer Number</label><input class="input mono" id="printerNumber" value="${esc(draft.printer_number)}" placeholder="เช่น 01 หรือ KITCHEN-1"></div>
      <div class="row" style="margin-bottom:14px"><button class="btn" id="testConn" type="button">Test Connection</button></div>
      <b>Print Agent ที่ออนไลน์</b><div class="dev-list">${(state.printer.agents || []).map((a) => `<div class="dev-item"><span class="dot ${a.online ? 'ok' : 'danger'}"></span><b>${esc(a.printer_number)}</b><span class="muted grow">${esc(a.info)}</span><span class="muted">${relTime(a.last_seen_at)}</span></div>`).join('') || '<div class="muted">ยังไม่มี Agent เชื่อมต่อ</div>'}</div>
      <p class="hint">Local Print Agent คือโปรแกรมเล็กๆ ที่รันบนคอมพิวเตอร์ในร้าน รับงานพิมพ์จากเซิร์ฟเวอร์ (แม้เซิร์ฟเวอร์อยู่บน Cloud) แล้วส่งไปยังเครื่องพิมพ์ LAN/USB ในร้าน</p>
      <div class="field"><label>คำสั่งติดตั้ง Agent (คัดลอกไปรันในเครื่องที่ร้าน)</label><div class="code" id="agentCmd">${esc(agentCmd)}</div></div>
      <div class="row" style="margin-bottom:14px"><button class="btn btn-sm" id="copyCmd" type="button">คัดลอกคำสั่ง</button><button class="btn btn-sm btn-ghost" id="regenKey" type="button">สร้าง Agent Key ใหม่</button></div>`;
    $('testConn').onclick = testConnection;
    $('copyCmd').onclick = () => navigator.clipboard?.writeText($('agentCmd').textContent).then(() => toast('คัดลอกแล้ว', 'ok'));
    $('regenKey').onclick = async () => {
      const r = await api('/api/admin/printer/agent-key', { method: 'POST' });
      state.printer = r.printer;
      toast('สร้าง Agent Key ใหม่แล้ว — Agent เดิมจะต้องใช้ Key ใหม่', 'ok');
      drawTypePanel();
    };
  } else {
    p.innerHTML = `<p class="hint">ใช้ไดรเวอร์เครื่องพิมพ์ที่ติดตั้งในระบบปฏิบัติการ (Windows/macOS) หรือ AirPrint บน iPad — ระบบจะเปิดหน้าต่างพิมพ์ของเบราว์เซอร์พร้อมใบคิวขนาด ${draft.paper_width}mm.
      สำหรับตู้ Kiosk แนะนำเปิด Chrome ด้วย <code>--kiosk-printing</code> เพื่อพิมพ์ทันทีโดยไม่ต้องกดยืนยัน</p>`;
  }
}

async function listDevices() {
  const box = $('devList');
  if (!box) return;
  const t = printer.transports[draft.connection_type];
  if (!t) return;
  const list = await t.list().catch(() => []);
  const cur = printer.status();
  const name = (d) => {
    if (draft.connection_type === 'usb') return d.productName || `USB ${d.vendorId.toString(16)}:${d.productId.toString(16)}`;
    if (draft.connection_type === 'bluetooth') return d.name || d.id;
    const i = d.getInfo();
    return i.bluetoothServiceClassId ? 'Bluetooth SPP' : i.usbVendorId ? `Serial ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}` : 'Serial port';
  };
  box.innerHTML = list.length ? list.map((d, i) => `<div class="dev-item"><span class="dot ${cur.connected && cur.label === name(d) ? 'ok' : ''}"></span>
      <b class="grow">${esc(name(d))}</b><button class="btn btn-sm" data-dev="${i}" type="button">Connect</button></div>`).join('')
    : '<div class="muted">ยังไม่มีอุปกรณ์ — กดปุ่มด้านบนเพื่อค้นหา</div>';
  box.onclick = async (e) => {
    const b = e.target.closest('[data-dev]');
    if (!b) return;
    b.disabled = true;
    try {
      const d = list[Number(b.dataset.dev)];
      if (draft.connection_type === 'serial') await t.open(d, Number($('baud')?.value) || 9600);
      else await t.open(d);
      printer.emit();
      toast('เชื่อมต่อเครื่องพิมพ์แล้ว', 'ok');
    } catch (ex) { toast(ex.message, 'error'); } finally { b.disabled = false; drawStatus(); listDevices(); }
  };
}

async function connectDirect(opts) {
  printer.setConfig({ ...draft });
  try {
    await printer.connectInteractive(opts);
    toast('เชื่อมต่อเครื่องพิมพ์แล้ว', 'ok');
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(e.message, 'error');
  }
  drawStatus();
  listDevices();
}

async function testConnection() {
  readForm();
  const btn = $('testConn');
  btn.disabled = true;
  btn.textContent = 'กำลังทดสอบ…';
  try {
    lastTest = await api('/api/admin/printer/test-connection', { method: 'POST', body: draft });
  } catch (e) {
    lastTest = { connected: false, message: e.message };
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
    drawStatus();
  }
}

async function drawPreview() {
  const c = await renderTestPage({ paperWidth: draft.paper_width, transportLabel: TRANSPORT_LABEL[draft.connection_type], timeZone: state.config?.settings.timezone });
  const box = $('preview');
  if (box) { box.innerHTML = ''; box.appendChild(c); }
}

async function testPrint() {
  readForm();
  // Server-side transports use the saved settings, so save first if the user changed them.
  const changed = dirty && ['connection_type', 'ip', 'port', 'printer_number', 'paper_width', 'copies', 'cut_paper', 'auto_print']
    .some((k) => String(draft[k]) !== String(state.printer[k]));
  if (changed && !(await save())) return;
  const btn = $('testPrintBtn');
  btn.disabled = true;
  try {
    printer.setConfig({ ...draft });
    if (printer.direct && !printer.status().connected) await printer.connectInteractive();
    const canvas = await renderTestPage({ paperWidth: draft.paper_width, transportLabel: TRANSPORT_LABEL[draft.connection_type], timeZone: state.config?.settings.timezone });
    await printer.printCanvas(canvas, adminJobs(null, 'test'));
    toast('ส่งหน้าทดสอบไปยังเครื่องพิมพ์แล้ว', 'ok');
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(`พิมพ์ไม่สำเร็จ: ${e.message}`, 'error');
  } finally { btn.disabled = false; drawStatus(); }
}

const JOB_STATUS = { pending: ['warn', 'Pending'], printing: ['info', 'Printing'], printed: ['ok', 'Printed'], failed: ['danger', 'Failed'] };

function drawJobs() {
  const body = $('jobs');
  if (!body) return;
  body.innerHTML = state.printjobs.length ? state.printjobs.map((j) => `<tr data-id="${j.id}">
      <td>${fmtDateTime(j.created_at)}</td><td>${j.kind === 'test' ? 'ทดสอบพิมพ์' : `บัตรคิว ${esc(j.queue_number || '')}`}</td>
      <td>${esc(TRANSPORT_LABEL[j.transport] || j.transport)}${j.printer_number ? ` #${esc(j.printer_number)}` : ''}</td>
      <td><span class="pill ${JOB_STATUS[j.status][0]}">${JOB_STATUS[j.status][1]}</span></td>
      <td class="muted" style="white-space:normal;max-width:320px">${esc(j.error || '')}</td>
      <td>${j.status === 'failed' && j.has_payload ? '<button class="btn btn-sm" data-retry type="button">พิมพ์อีกครั้ง</button>' : ''}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">ยังไม่มีงานพิมพ์</td></tr>';
}

async function onJobClick(e) {
  const b = e.target.closest('[data-retry]');
  if (!b) return;
  b.disabled = true;
  try {
    const { job } = await api(`/api/admin/print-jobs/${b.closest('tr').dataset.id}/retry`, { method: 'POST' });
    toast(job.status === 'failed' ? `ยังพิมพ์ไม่สำเร็จ: ${job.error}` : 'ส่งงานพิมพ์อีกครั้งแล้ว', job.status === 'failed' ? 'error' : 'ok');
  } catch (ex) { toast(ex.message, 'error'); } finally { b.disabled = false; }
}
