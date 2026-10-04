// Printer transports used from the browser.
//
//  usb        WebUSB  — Chrome/Edge (desktop, Android). On Windows the printer must use the
//             WinUSB driver (e.g. via Zadig); otherwise use LAN, Print Agent or System Print.
//  bluetooth  Web Bluetooth (BLE thermal printers) — Chrome/Edge desktop & Android.
//  serial     Web Serial — USB-to-serial printers and Bluetooth Classic (SPP/RFCOMM) printers.
//  lan / wifi Network Print Service — the server sends raw ESC/POS to IP:9100.
//  printer_number  Local Print Agent — agent/print-agent.js prints jobs for that printer ID.
//  browser    System print dialog (OS printer driver), e.g. iPad AirPrint or a driver-installed printer.
//
// Every print goes through the server's Print Job Queue so status is tracked
// (pending → printing → printed / failed) and visible in the admin.
import { encodeCanvas, toBase64 } from './escpos.js';

const LS_KEY = 'qms.printer.device';
export const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
];
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

export const TRANSPORT_LABEL = {
  usb: 'USB', lan: 'LAN', wifi: 'Wi-Fi', bluetooth: 'Bluetooth', serial: 'Serial / Bluetooth SPP',
  printer_number: 'Printer Number (Print Agent)', browser: 'System Print (ไดรเวอร์เครื่อง)',
};

export const support = {
  usb: typeof navigator !== 'undefined' && 'usb' in navigator,
  bluetooth: typeof navigator !== 'undefined' && 'bluetooth' in navigator,
  serial: typeof navigator !== 'undefined' && 'serial' in navigator,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function save(info) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(info)); } catch { /* ignore */ }
}

export class PrintError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- USB
class UsbTransport {
  constructor() { this.device = null; this.endpoint = null; this.iface = null; }

  get connected() { return !!(this.device && this.device.opened); }
  get label() { return this.device ? (this.device.productName || `USB ${this.device.vendorId.toString(16)}:${this.device.productId.toString(16)}`) : ''; }

  async list() { return support.usb ? navigator.usb.getDevices() : []; }

  async request() {
    if (!support.usb) throw new PrintError('เบราว์เซอร์นี้ไม่รองรับ WebUSB (ใช้ Chrome หรือ Edge)', 'UNSUPPORTED');
    const device = await navigator.usb.requestDevice({ filters: [] });
    await this.open(device);
    return device;
  }

  async autoConnect() {
    if (this.connected) return true;
    if (!support.usb) return false;
    const s = saved();
    const devices = await navigator.usb.getDevices();
    const d = devices.find((x) => s && s.type === 'usb' && x.vendorId === s.vendorId && x.productId === s.productId
      && (!s.serialNumber || x.serialNumber === s.serialNumber)) || (devices.length === 1 ? devices[0] : null);
    if (!d) return false;
    try { await this.open(d); return true; } catch { return false; }
  }

  async open(device) {
    if (!device.opened) await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    let pick = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (!ep) continue;
        const score = alt.interfaceClass === 7 ? 2 : alt.interfaceClass === 255 ? 1 : 0;
        if (!pick || score > pick.score) pick = { iface: iface.interfaceNumber, alt: alt.alternateSetting, ep: ep.endpointNumber, score };
      }
    }
    if (!pick) throw new PrintError('อุปกรณ์นี้ไม่ใช่เครื่องพิมพ์ที่รองรับ (ไม่พบ Bulk OUT endpoint)', 'NO_ENDPOINT');
    try {
      await device.claimInterface(pick.iface);
    } catch (e) {
      throw new PrintError('ไม่สามารถเข้าถึงเครื่องพิมพ์ USB ได้ (ระบบปฏิบัติการอาจใช้งานไดรเวอร์อยู่ — บน Windows ให้ติดตั้ง WinUSB ด้วย Zadig หรือใช้โหมด Print Agent)', 'CLAIM');
    }
    if (pick.alt) await device.selectAlternateInterface(pick.iface, pick.alt).catch(() => {});
    this.device = device; this.endpoint = pick.ep; this.iface = pick.iface;
    save({ type: 'usb', vendorId: device.vendorId, productId: device.productId, serialNumber: device.serialNumber || '', name: this.label });
    navigator.usb.addEventListener('disconnect', (e) => { if (e.device === this.device) this.device = null; });
  }

  async write(bytes) {
    if (!this.connected && !(await this.autoConnect())) throw new PrintError('ไม่พบเครื่องพิมพ์ USB', 'NOT_CONNECTED');
    for (let i = 0; i < bytes.length; i += 16384) {
      const r = await this.device.transferOut(this.endpoint, bytes.subarray(i, i + 16384));
      if (r.status !== 'ok') throw new PrintError(`ส่งข้อมูลไปเครื่องพิมพ์ไม่สำเร็จ (${r.status})`, 'WRITE');
    }
  }

  async disconnect() {
    if (this.device) { try { await this.device.close(); } catch { /* ignore */ } }
    this.device = null;
  }
}

// ---------------------------------------------------------------- Bluetooth (BLE)
class BleTransport {
  constructor() { this.device = null; this.char = null; }

  get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected && this.char); }
  get label() { return this.device ? (this.device.name || this.device.id) : ''; }

  async list() {
    if (!support.bluetooth || !navigator.bluetooth.getDevices) return [];
    try { return await navigator.bluetooth.getDevices(); } catch { return []; }
  }

  async request() {
    if (!support.bluetooth) throw new PrintError('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth (ใช้ Chrome หรือ Edge บน Android / Windows / macOS)', 'UNSUPPORTED');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    await this.open(device);
    return device;
  }

  async autoConnect() {
    if (this.connected) return true;
    if (this.device) { try { await this.open(this.device); return true; } catch { return false; } }
    const s = saved();
    const devices = await this.list();
    const d = devices.find((x) => s && s.type === 'bluetooth' && x.id === s.id);
    if (!d) return false;
    try { await this.open(d); return true; } catch { return false; }
  }

  async open(device) {
    const server = await device.gatt.connect();
    let found = null;
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch { continue; }
      const c = chars.find((x) => x.properties.writeWithoutResponse) || chars.find((x) => x.properties.write);
      if (c) { found = c; break; }
    }
    if (!found) {
      device.gatt.disconnect();
      throw new PrintError('ไม่พบช่องสำหรับส่งข้อมูลพิมพ์ในอุปกรณ์นี้ (อาจเป็นเครื่องพิมพ์ Bluetooth Classic — ให้ใช้โหมด Serial / Bluetooth SPP)', 'NO_CHAR');
    }
    this.device = device; this.char = found;
    device.addEventListener('gattserverdisconnected', () => { this.char = null; });
    save({ type: 'bluetooth', id: device.id, name: device.name || '' });
  }

  async write(bytes) {
    if (!this.connected && !(await this.autoConnect())) throw new PrintError('ไม่ได้เชื่อมต่อเครื่องพิมพ์ Bluetooth', 'NOT_CONNECTED');
    const noResp = this.char.properties.writeWithoutResponse;
    const size = 180;
    for (let i = 0; i < bytes.length; i += size) {
      const chunk = bytes.slice(i, i + size);
      if (noResp && this.char.writeValueWithoutResponse) {
        await this.char.writeValueWithoutResponse(chunk);
        await sleep(12);
      } else {
        await (this.char.writeValueWithResponse ? this.char.writeValueWithResponse(chunk) : this.char.writeValue(chunk));
      }
    }
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.device = null; this.char = null;
  }
}

// ---------------------------------------------------------------- Serial (USB-serial / BT SPP)
class SerialTransport {
  constructor() { this.port = null; this.baudRate = 9600; }

  get connected() { return !!(this.port && this.port.writable); }
  get label() {
    if (!this.port) return '';
    const i = this.port.getInfo();
    if (i.bluetoothServiceClassId) return 'Bluetooth SPP';
    return i.usbVendorId ? `Serial ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}` : 'Serial port';
  }

  async list() { return support.serial ? navigator.serial.getPorts() : []; }

  async request(baudRate = 9600) {
    if (!support.serial) throw new PrintError('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome หรือ Edge บนคอมพิวเตอร์)', 'UNSUPPORTED');
    let port;
    try {
      port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
    } catch (e) {
      if (e.name === 'NotFoundError') throw e;
      port = await navigator.serial.requestPort();
    }
    await this.open(port, baudRate);
    return port;
  }

  async autoConnect() {
    if (this.connected) return true;
    if (!support.serial) return false;
    const s = saved();
    const ports = await navigator.serial.getPorts();
    const p = ports.find((x) => {
      const i = x.getInfo();
      return s && s.type === 'serial' && i.usbVendorId === s.usbVendorId && i.usbProductId === s.usbProductId
        && (i.bluetoothServiceClassId || '') === (s.bt || '');
    }) || (ports.length === 1 ? ports[0] : null);
    if (!p) return false;
    try { await this.open(p, (s && s.baudRate) || this.baudRate); return true; } catch { return false; }
  }

  async open(port, baudRate = 9600) {
    if (!port.writable) await port.open({ baudRate });
    this.port = port; this.baudRate = baudRate;
    const i = port.getInfo();
    save({ type: 'serial', usbVendorId: i.usbVendorId, usbProductId: i.usbProductId, bt: i.bluetoothServiceClassId || '', baudRate, name: this.label });
  }

  async write(bytes) {
    if (!this.connected && !(await this.autoConnect())) throw new PrintError('ไม่ได้เชื่อมต่อเครื่องพิมพ์ Serial', 'NOT_CONNECTED');
    const writer = this.port.writable.getWriter();
    try {
      for (let i = 0; i < bytes.length; i += 4096) await writer.write(bytes.subarray(i, i + 4096));
    } finally { writer.releaseLock(); }
  }

  async disconnect() {
    if (this.port) { try { await this.port.close(); } catch { /* ignore */ } }
    this.port = null;
  }
}

// ---------------------------------------------------------------- System print
function systemPrint(canvas, paperWidth) {
  return new Promise((resolve, reject) => {
    const url = canvas.toDataURL('image/png');
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><style>
      @page { size: ${paperWidth}mm auto; margin: 0; }
      html,body{margin:0;padding:0;background:#fff}
      img{width:${paperWidth - 4}mm;display:block;margin:0 auto}
    </style></head><body><img src="${url}"></body></html>`);
    doc.close();
    const img = doc.querySelector('img');
    const go = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => { iframe.remove(); resolve(); }, 1500);
      } catch (e) { iframe.remove(); reject(new PrintError('เปิดหน้าต่างพิมพ์ไม่สำเร็จ', 'PRINT')); }
    };
    if (img.complete) go(); else img.onload = go;
  });
}

// ---------------------------------------------------------------- Facade
/**
 * jobs: { create({transport, payload}), update(id, status, error), get(id) } — talks to the server job queue.
 */
export class PrinterClient {
  constructor() {
    this.config = { connection_type: 'browser', paper_width: 80, copies: 1, cut_paper: true };
    this.transports = { usb: new UsbTransport(), bluetooth: new BleTransport(), serial: new SerialTransport() };
    this.listeners = new Set();
  }

  setConfig(cfg) {
    const changed = cfg.connection_type !== this.config.connection_type;
    this.config = { ...this.config, ...cfg };
    if (changed) this.emit();
  }

  get type() { return this.config.connection_type; }
  get direct() { return this.transports[this.type] || null; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.status()); }

  /** Local status. For server/agent transports the admin/test-connection API is authoritative. */
  status() {
    const t = this.direct;
    if (t) return { connected: t.connected, label: t.label || (saved()?.name ?? ''), type: this.type };
    if (this.type === 'printer_number') return { connected: this.config.agent_online !== false, label: `Printer #${this.config.printer_number || '-'}`, type: this.type };
    return { connected: true, label: TRANSPORT_LABEL[this.type], type: this.type };
  }

  async autoConnect() {
    const t = this.direct;
    if (!t) return true;
    const ok = await t.autoConnect().catch(() => false);
    this.emit();
    return ok;
  }

  /** Must be called from a user gesture (click) — opens the browser's device chooser. */
  async connectInteractive(opts = {}) {
    const t = this.direct;
    if (!t) return true;
    await t.request(opts.baudRate);
    this.emit();
    return true;
  }

  async disconnect() {
    const t = this.direct;
    if (t) await t.disconnect();
    this.emit();
  }

  /**
   * Print a rendered canvas through the configured transport and the server job queue.
   * Throws PrintError on failure. Never creates a new queue — only print jobs.
   */
  async printCanvas(canvas, jobs) {
    const type = this.type;
    const bytes = encodeCanvas(canvas, { cut: this.config.cut_paper, copies: this.config.copies || 1 });
    if (this.direct) {
      const { job } = await jobs.create({ transport: type });
      try {
        await this.direct.write(bytes);
        await jobs.update(job.id, 'printed').catch(() => {});
        this.emit();
        return job;
      } catch (e) {
        await jobs.update(job.id, 'failed', e.message || String(e)).catch(() => {});
        this.emit();
        throw e instanceof PrintError ? e : new PrintError(e.message || 'พิมพ์ไม่สำเร็จ', 'WRITE');
      }
    }
    if (type === 'browser') {
      const { job } = await jobs.create({ transport: 'browser' });
      try {
        for (let i = 0; i < (this.config.copies || 1); i += 1) await systemPrint(canvas, this.config.paper_width);
        await jobs.update(job.id, 'printed').catch(() => {});
        return job;
      } catch (e) {
        await jobs.update(job.id, 'failed', e.message).catch(() => {});
        throw e;
      }
    }
    // lan / wifi / printer_number: payload goes to the server
    const { job } = await jobs.create({ transport: type, payload: toBase64(bytes) });
    if (type === 'printer_number') return this.waitAgent(job, jobs);
    if (job.status !== 'printed') throw new PrintError(job.error || 'เครื่องพิมพ์ไม่ตอบสนอง', 'NETWORK');
    return job;
  }

  async waitAgent(job, jobs, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    let j = job;
    while (Date.now() < until) {
      if (j.status === 'printed') return j;
      if (j.status === 'failed') throw new PrintError(j.error || 'Print Agent พิมพ์ไม่สำเร็จ', 'AGENT');
      await sleep(800);
      j = (await jobs.get(j.id)).job;
    }
    throw new PrintError('Print Agent ไม่ตอบสนอง (งานพิมพ์ยังอยู่ในคิวและจะพิมพ์เมื่อ Agent กลับมาออนไลน์)', 'AGENT_TIMEOUT');
  }
}

export function savedDevice() { return saved(); }
