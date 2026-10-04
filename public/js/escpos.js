// ESC/POS encoding: converts a canvas (ticket rendered with Noto Sans Thai)
// into raster bit-image commands (GS v 0), so Thai text prints correctly on
// any ESC/POS printer, even ones without a Thai code page or TrueType support.

export const DOTS = { 58: 384, 80: 576 };

const ESC = 0x1b;
const GS = 0x1d;

/** Converts canvas pixels to 1-bit rows. Pixel is black when luminance < threshold. */
function toMono(canvas, threshold = 165) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const bytesPerRow = Math.ceil(width / 8);
  const bits = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      // composite over white
      const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a);
      if (lum < threshold) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bits, bytesPerRow, height };
}

/**
 * Build a complete print job: init, raster image in bands, feed, optional cut.
 * Bands keep each GS v 0 block small — some printers choke on tall images.
 */
export function encodeCanvas(canvas, { cut = true, feedLines = 4, copies = 1, band = 120 } = {}) {
  const { bits, bytesPerRow, height } = toMono(canvas);
  const parts = [];
  for (let c = 0; c < copies; c += 1) {
    parts.push(Uint8Array.of(ESC, 0x40)); // ESC @  initialize
    parts.push(Uint8Array.of(ESC, 0x61, 0x00)); // left align (image is already full width)
    for (let y = 0; y < height; y += band) {
      const rows = Math.min(band, height - y);
      parts.push(Uint8Array.of(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff));
      parts.push(bits.subarray(y * bytesPerRow, (y + rows) * bytesPerRow));
    }
    parts.push(Uint8Array.of(ESC, 0x64, feedLines)); // ESC d n  feed
    if (cut) parts.push(Uint8Array.of(GS, 0x56, 0x42, 0x00)); // GS V B 0  feed & partial cut
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
