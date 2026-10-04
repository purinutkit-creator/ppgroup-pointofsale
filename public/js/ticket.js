// Renders queue tickets / test pages to a canvas using Noto Sans Thai.
// The same canvas is used for every transport (ESC/POS raster or OS print).
import { DOTS } from './escpos.js';
import { fontsReady } from './common.js';

const FONT = '"Noto Sans Thai", sans-serif';

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Simple layout engine: stacks blocks vertically on a tall scratch canvas, then crops. */
class Paper {
  constructor(width) {
    this.w = width;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = 3000;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, width, this.canvas.height);
    this.ctx.fillStyle = '#000';
    this.ctx.textBaseline = 'alphabetic';
    this.y = 0;
    this.pad = Math.round(width * 0.04);
  }

  space(px) { this.y += px; }

  wrap(text, maxWidth) {
    const ctx = this.ctx;
    const lines = [];
    for (const para of String(text).split('\n')) {
      // Thai has no spaces between words; break per character cluster when needed.
      const segs = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter('th', { granularity: 'word' }).segment(para)].map((s) => s.segment)
        : para.split(/(\s+)/);
      let line = '';
      for (const seg of segs) {
        const test = line + seg;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line.trimEnd());
          line = seg.trimStart();
        } else line = test;
      }
      lines.push(line);
    }
    return lines;
  }

  text(text, { size = 24, weight = 400, align = 'center', gap = 0.35, maxWidth } = {}) {
    if (text === undefined || text === null || text === '') return;
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    const x = align === 'center' ? this.w / 2 : align === 'right' ? this.w - this.pad : this.pad;
    const lines = this.wrap(text, maxWidth || this.w - this.pad * 2);
    for (const l of lines) {
      this.y += Math.round(size * 1.05);
      ctx.fillText(l, x, this.y);
      this.y += Math.round(size * gap);
    }
  }

  /** Fit a single line by shrinking the font until it fits the width. */
  bigText(text, { size, weight = 800, minSize = 40 }) {
    const ctx = this.ctx;
    let s = size;
    ctx.font = `${weight} ${s}px ${FONT}`;
    while (ctx.measureText(text).width > this.w - this.pad * 2 && s > minSize) {
      s -= 4;
      ctx.font = `${weight} ${s}px ${FONT}`;
    }
    ctx.textAlign = 'center';
    const m = ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent || s * 0.75;
    const descent = m.actualBoundingBoxDescent || s * 0.05;
    this.y += Math.round(ascent);
    ctx.fillText(text, this.w / 2, this.y);
    this.y += Math.round(descent + s * 0.12);
  }

  rule({ dashed = false, weight = 2 } = {}) {
    const ctx = this.ctx;
    this.y += 10;
    ctx.save();
    ctx.lineWidth = weight;
    ctx.strokeStyle = '#000';
    if (dashed) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(this.pad, this.y);
    ctx.lineTo(this.w - this.pad, this.y);
    ctx.stroke();
    ctx.restore();
    this.y += 12;
  }

  image(img, { width, maxHeight = 200, smooth = true }) {
    if (!img) return;
    const ratio = img.naturalHeight / img.naturalWidth;
    let w = width;
    let h = Math.round(w * ratio);
    if (h > maxHeight) { h = maxHeight; w = Math.round(h / ratio); }
    this.ctx.imageSmoothingEnabled = smooth;
    this.y += 4;
    this.ctx.drawImage(img, Math.round((this.w - w) / 2), this.y, w, h);
    this.y += h + 4;
  }

  result() {
    const out = document.createElement('canvas');
    out.width = this.w;
    out.height = Math.ceil(this.y + 16);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(this.canvas, 0, 0);
    return out;
  }
}

export async function renderTicket(t, { paperWidth = 80 } = {}) {
  await fontsReady([400, 600, 800]);
  const W = DOTS[paperWidth] || 576;
  const k = W / 576; // scale relative to 80mm
  const p = new Paper(W);
  const [logo, qr] = await Promise.all([
    t.logo_url ? loadImage('/api/kiosk/logo') : null,
    t.qr_data_url ? loadImage(t.qr_data_url) : null,
  ]);
  const time = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: t.timezone || undefined })
    .format(new Date(t.created_at));
  const date = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: t.timezone || undefined })
    .format(new Date(t.created_at));

  p.space(8 * k);
  if (logo) { p.image(logo, { width: Math.round(W * 0.42), maxHeight: Math.round(150 * k) }); p.space(4 * k); }
  p.text(t.store_name, { size: Math.round(34 * k), weight: 700 });
  p.rule({ dashed: true });
  p.text('หมายเลขคิว', { size: Math.round(28 * k), weight: 600, gap: 0.1 });
  p.space(10 * k);
  p.bigText(t.queue_number, { size: Math.round(190 * k), weight: 800 });
  p.text(`จำนวน ${t.pax} ท่าน`, { size: Math.round(34 * k), weight: 700 });
  if (t.customer_name) p.text(`ชื่อ: ${t.customer_name}`, { size: Math.round(28 * k), weight: 500 });
  p.space(6 * k);
  p.text('เวลาออกบัตร', { size: Math.round(22 * k), weight: 400, gap: 0.05 });
  p.text(`${time} น.  (${date})`, { size: Math.round(28 * k), weight: 600 });
  p.space(4 * k);
  p.text('มีคิวก่อนหน้าคุณ', { size: Math.round(22 * k), weight: 400, gap: 0.05 });
  p.text(`${t.ahead} คิว`, { size: Math.round(44 * k), weight: 800 });
  if (t.note) p.text(t.note, { size: Math.round(26 * k), weight: 600 });
  if (qr) {
    p.rule();
    p.text('สแกนเพื่อติดตามคิว', { size: Math.round(28 * k), weight: 700 });
    p.image(qr, { width: Math.round(W * 0.56), maxHeight: 1000, smooth: false });
    p.text('ติดตามสถานะคิวของคุณแบบ Real-time', { size: Math.round(22 * k), weight: 500 });
  }
  p.rule();
  if (t.footer) p.text(t.footer, { size: Math.round(28 * k), weight: 700 });
  p.space(10 * k);
  return p.result();
}

export async function renderTestPage({ paperWidth = 80, transportLabel = '', timeZone } = {}) {
  await fontsReady([400, 600, 800]);
  const W = DOTS[paperWidth] || 576;
  const k = W / 576;
  const p = new Paper(W);
  p.space(8 * k);
  p.text('PRINTER TEST', { size: Math.round(48 * k), weight: 800 });
  p.text('ทดสอบเครื่องพิมพ์', { size: Math.round(38 * k), weight: 700 });
  p.rule({ dashed: true });
  p.text('ภาษาไทย: ก ข ค ง จ', { size: Math.round(34 * k), weight: 600 });
  p.text('Noto Sans Thai', { size: Math.round(30 * k), weight: 500 });
  p.text('1234567890', { size: Math.round(40 * k), weight: 700 });
  p.rule({ dashed: true });
  p.text('Printer Connected Successfully', { size: Math.round(28 * k), weight: 700 });
  p.text(`${paperWidth}mm · ${W} dots${transportLabel ? ` · ${transportLabel}` : ''}`, { size: Math.round(20 * k), weight: 400 });
  p.text(new Date().toLocaleString('th-TH', { timeZone }), { size: Math.round(20 * k), weight: 400 });
  p.space(10 * k);
  return p.result();
}
