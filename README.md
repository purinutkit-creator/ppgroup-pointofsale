# ระบบตู้กดบัตรคิวร้านอาหาร (Queue Kiosk System)

ระบบบัตรคิวร้านอาหารแบบ Full Stack ใช้งานได้จริงบนคอมพิวเตอร์, Tablet, จอ Touch Screen, TV และโทรศัพท์มือถือ
ทุกหน้าเชื่อมกับฐานข้อมูลเดียวกันและอัปเดตแบบ Real-time (Server-Sent Events) โดยไม่ต้องรีเฟรช

| หน้า | URL | ใช้กับ |
|---|---|---|
| ตู้กดบัตรคิว (Kiosk) | `/kiosk` | Tablet / Touch Screen / Kiosk |
| Admin / Staff | `/admin` | คอมพิวเตอร์ / Tablet / มือถือ ของพนักงาน |
| Queue Display | `/display` (จับคู่ที่ `/display/pair`) | TV / Monitor / Smart Display |
| Customer Tracking | `/queue/track/{secure-token}` | โทรศัพท์ลูกค้า (สแกน QR บนบัตรคิว) |

ฟอนต์หลักทั้งระบบคือ **Noto Sans Thai** (โหลดจากเซิร์ฟเวอร์เอง ไม่ต้องพึ่ง Google Fonts — ใช้ได้แม้ร้านไม่มีอินเทอร์เน็ตภายนอก)

---

## เริ่มใช้งาน

ต้องการ Node.js 18.17 ขึ้นไป (แนะนำ 22 LTS)

```bash
npm install
npm start            # http://localhost:3000
```

1. เปิด `http://<เซิร์ฟเวอร์>:3000/admin` → สร้างบัญชีผู้ดูแลระบบครั้งแรก (ไม่มีรหัสผ่านเริ่มต้นแบบ Hard-code)
2. **ตั้งค่าร้าน** → ชื่อร้าน, โลโก้ (Image URL), ข้อความต้อนรับ, สี Theme, Public URL
3. **เครื่องพิมพ์** → เลือกวิธีเชื่อมต่อ → Test Connection / Test Print
4. **หน้าจอบอกคิว** → กด “เชื่อมต่อหน้าจอบอกคิว” → นำรหัส 6 หลักไปกรอกบน TV ที่ `/display/pair`
5. เปิด `/kiosk` บนเครื่องตู้กดบัตรคิว

### Docker

```bash
docker build -t queue-kiosk .
docker run -d -p 3000:3000 -v queue-data:/data --name queue-kiosk queue-kiosk
```

## ติดตั้งขึ้นเว็บไซต์จริง

### วิธีที่ 1: Render (แนะนำ — ไม่ต้องดูแลเซิร์ฟเวอร์, ได้ HTTPS อัตโนมัติ)

ไฟล์ `render.yaml` ตั้งค่าไว้ครบแล้ว (Docker, ภูมิภาค Singapore, Disk ถาวร 1 GB สำหรับฐานข้อมูล, Health check)

1. สมัคร/เข้าสู่ระบบ https://dashboard.render.com แล้วเชื่อมบัญชี GitHub
2. กด **New → Blueprint** → เลือก repo `ppgroup-queqemanagement` → เลือก branch ที่มีโค้ด → **Apply**
3. รอ build ประมาณ 3–5 นาที จะได้ URL เช่น `https://queue-kiosk.onrender.com`
4. เปิด `https://<URL>/admin` → สร้างบัญชีผู้ดูแลระบบ → เริ่มตั้งค่าร้าน

> ใช้แพ็กเกจ **Starter** ขึ้นไป (ประมาณ $7/เดือน) เพราะต้องมี Disk ถาวร — แพ็กเกจฟรีจะลบฐานข้อมูลทุกครั้งที่รีสตาร์ท
> QR Code และลิงก์ใน SMS ใช้ URL ของ Render อัตโนมัติ หากผูกโดเมนของร้านเอง (Settings → Custom Domains) ให้ใส่โดเมนนั้นใน Admin → ตั้งค่าร้าน → Public URL

### วิธีที่ 2: VPS ของตัวเอง (Docker + Caddy HTTPS อัตโนมัติ)

ชี้โดเมน (A record) มาที่ IP ของเครื่อง แล้วรันบนเครื่อง:

```bash
git clone https://github.com/purinutkit-creator/ppgroup-queqemanagement.git
cd ppgroup-queqemanagement/deploy
DOMAIN=queue.example.com docker compose up -d --build
```

ฐานข้อมูลอยู่ใน Docker volume `queue-data` — Backup ด้วย
`docker compose cp app:/data ./backup`

### ตัวแปรแวดล้อม (Environment)

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตของเซิร์ฟเวอร์ |
| `DATA_DIR` | `./data` | โฟลเดอร์เก็บฐานข้อมูล SQLite (`queue.db`) — **ต้อง Backup** |
| `PUBLIC_BASE_URL` | – | URL สาธารณะสำหรับ QR/SMS (ตั้งใน Admin ได้เช่นกัน) |
| `TRUST_PROXY` | – | ตั้งเป็น `true` หรือ `1` เมื่ออยู่หลัง Nginx / Cloudflare / Load balancer |
| `COOKIE_SECURE` | อัตโนมัติ | `true` บังคับ cookie แบบ Secure (เมื่อใช้ HTTPS) |
| `KIOSK_RATE_LIMIT` | `60` | จำนวนการออกบัตรคิวสูงสุดต่อนาทีต่อ IP |

> **Production:** ให้รันหลัง HTTPS (เช่น Nginx/Caddy/Cloudflare) — WebUSB, Web Bluetooth, Web Serial, Wake Lock และการแจ้งเตือนในเบราว์เซอร์ต้องใช้ HTTPS (ยกเว้น `localhost`)
> หากใช้ Nginx ให้ปิด buffering สำหรับ `/api/stream/` (`proxy_buffering off;`) เพื่อให้ Real-time ทำงานทันที

---

## สถาปัตยกรรม

```
Kiosk ─┐                         ┌─> Admin Dashboard (SSE)
Staff ─┼─> Express API ─> SQLite ┼─> Queue Display   (SSE + Device Token)
Agent ─┘   (atomic tx)           └─> Customer Tracking (SSE, ต่อคิว)
```

- **Backend:** Node.js + Express, ฐานข้อมูล **SQLite (better-sqlite3, WAL)** — ไฟล์เดียว Backup ง่าย
- **Real-time:** Server-Sent Events — แต่ละ client ได้ข้อมูลเฉพาะที่ตัวเองมีสิทธิ์เห็น และ reconnect อัตโนมัติ
- **Front-end:** HTML/CSS/JS (ES Modules) ไม่ต้อง build
- **ออกเลขคิวแบบ Atomic:** จองเลขใน Transaction เดียว + UNIQUE index `(store, session, queue_number)` — หลาย Kiosk กดพร้อมกันไม่ได้เลขซ้ำ
- **กันกดซ้ำ (Double click):** ปุ่มถูก lock + ทุกคำขอมี `request_id` ฝั่งเซิร์ฟเวอร์คืนคิวเดิมถ้าส่งซ้ำ
- ทุกคิวมี **UUID** ภายใน และ **tracking token** แบบสุ่ม 192-bit สำหรับ QR (ไม่มี ID เรียงลำดับใน URL)

### ตารางฐานข้อมูล
`stores`, `settings`, `queue_groups`, `queues`, `customers`, `queue_events`, `staff`, `sessions`,
`display_devices`, `pairing_codes`, `printer_settings`, `print_jobs`, `print_agents`, `promotion_images`, `sms_logs`
(ดู `server/db.js`)

---

## ประเภทคิว (A/B/C/D)

ค่าเริ่มต้น: **A** = 1 ท่าน, **B** = 2–4, **C** = 5–6, **D** = 7–12 — แก้ได้ที่ Admin → ประเภทคิว
(เปลี่ยนตัวอักษร, ช่วงจำนวนคน, เลขเริ่มต้น, เพิ่มกลุ่มใหม่ เช่น E = 13–20, ปิดใช้งาน)

กรณีเกินจำนวนสูงสุด ตั้งได้ว่า “ให้ติดต่อพนักงาน” หรือ “ไม่อนุญาตให้กดคิว” — หรือเพิ่มกลุ่มใหม่

**คิวก่อนหน้า** = จำนวนคิวที่ยัง *รอ (Waiting)* และออกบัตรก่อน (นับเฉพาะประเภทเดียวกัน หรือทุกประเภท — ตั้งค่าได้)
เมื่อพนักงานเรียก/รับลูกค้า/ยกเลิก/ไม่พบลูกค้า คิวก่อนหน้า จำนวนจะลดลงบนมือถือลูกค้าทันที

**รีเซ็ตคิว:** อัตโนมัติทุกวันตามเวลาที่ตั้ง (ค่าเริ่มต้น 05:00) หรือกด “Reset Queue Number” เอง

---

## เครื่องพิมพ์ความร้อน (58mm / 80mm ESC/POS)

ใบคิวถูก **เรนเดอร์ด้วย Noto Sans Thai บน Canvas แล้วแปลงเป็นภาพ Raster (`GS v 0`)** ก่อนส่งเข้าเครื่องพิมพ์ —
ภาษาไทยพิมพ์ถูกต้องแม้เครื่องพิมพ์ไม่มีฟอนต์ไทย / ไม่รองรับ TrueType

| Connection Type | วิธีทำงาน | เหมาะกับ |
|---|---|---|
| **USB** | WebUSB จากเบราว์เซอร์ Kiosk | Android / ChromeOS / Linux / macOS (Windows ต้องเปลี่ยนไดรเวอร์เป็น WinUSB ด้วย Zadig) |
| **LAN / Wi-Fi** | เซิร์ฟเวอร์ส่ง RAW ไป `IP:9100` | เซิร์ฟเวอร์อยู่ในเครือข่ายเดียวกับเครื่องพิมพ์ |
| **Bluetooth** | Web Bluetooth (BLE) | Tablet Android + เครื่องพิมพ์ BLE |
| **Serial / BT SPP** | Web Serial | USB-Serial หรือ Bluetooth Classic ที่จับคู่กับคอมพิวเตอร์แล้ว |
| **Printer Number** | Local Print Agent ในร้านรับงานผ่าน SSE | เซิร์ฟเวอร์บน Cloud + เครื่องพิมพ์ในร้าน |
| **System Print** | หน้าต่างพิมพ์ของ OS / AirPrint | iPad หรือเครื่องที่ติดตั้งไดรเวอร์แล้ว (ใช้ Chrome `--kiosk-printing` เพื่อพิมพ์ทันที) |

ทุกงานพิมพ์อยู่ใน **Print Job Queue** (Pending → Printing → Printed / Failed) ดูและสั่งพิมพ์ซ้ำได้ที่ Admin →
หากพิมพ์ไม่สำเร็จ **คิวยังอยู่** และ Kiosk แสดง “สร้างคิวเรียบร้อย แต่ไม่สามารถพิมพ์บัตรคิวได้” พร้อมปุ่ม
“เชื่อมต่อเครื่องพิมพ์” และ “พิมพ์อีกครั้ง” (และ QR บนหน้าจอให้ลูกค้าสแกนได้ทันที)

### Local Print Agent (โหมด Printer Number)

รันบนคอมพิวเตอร์ในร้าน (Node.js 18+ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม):

```bash
SERVER_URL=https://queue.example.com \
AGENT_KEY=<คัดลอกจาก Admin → เครื่องพิมพ์ → Printer Number> \
PRINTER_NUMBER=01 \
PRINTER_TARGET=tcp://192.168.1.100:9100 \
node agent/print-agent.js
```

`PRINTER_TARGET`: `tcp://IP:PORT` (LAN/Wi-Fi), `file:///dev/usb/lp0` (USB บน Linux), `file://\\localhost\POS80` (Shared printer บน Windows)

---

## Queue Display (TV)

- Layout 16:9: ชื่อร้านด้านบน · ช่อง A/B/C/D ด้านซ้าย (~38%) · รูปโปรโมชั่น Slideshow ด้านขวา (~62%) · ข้อความวิ่งด้านล่าง
- เมื่อเรียกคิว: ช่องของประเภทนั้นกระพริบ + ตัวเลขใหญ่กลางจอ + เสียงเรียก (ติ๊ง-ต่อง + เสียงพูดไทย/อังกฤษ เช่น “ขอเชิญหมายเลข บี ศูนย์ สอง หก…”)
- **ไม่แสดงชื่อหรือเบอร์โทรลูกค้า** — API ของ Display คืนเฉพาะหมายเลขคิว
- จับคู่ด้วย **One-Time Code 6 หลัก** (สุ่มจากเซิร์ฟเวอร์, หมดอายุ 5 นาที, ใช้ได้ครั้งเดียว, จำกัดการเดารหัส) — ใช้ได้ข้ามเครื่อง/เบราว์เซอร์/เครือข่าย
- หลังจับคู่ TV เก็บ Secure Device Token ไว้ ไม่ต้องกรอกใหม่ · Admin เห็นสถานะ Online/Offline (Heartbeat), Rename, Disconnect
- แนะนำเปิด Chrome บน TV/Mini PC: `chrome --kiosk --autoplay-policy=no-user-gesture-required https://<server>/display`

## SMS แจ้งเตือน

ลูกค้าที่กรอกเบอร์โทรและติ๊ก “ส่ง SMS แจ้งเตือนเมื่อถึงคิวของฉัน” ที่ Kiosk จะได้รับ SMS เมื่อพนักงานกด **เรียกคิว**
(และเลือกส่งแจ้งเตือนล่วงหน้าเมื่อเหลือ N คิวได้) รองรับ **ThaiBulkSMS**, **Twilio** หรือ **Webhook** (ต่อกับผู้ให้บริการอื่น) —
ตั้งค่าและทดสอบส่งได้ที่ Admin → SMS แจ้งเตือน

## ความปลอดภัย

- Admin/Staff ต้อง Login (รหัสผ่าน scrypt, Session cookie HttpOnly/SameSite, จำกัดการลอง Login) · สิทธิ์ `admin` / `staff`
- API ที่เปลี่ยนข้อมูลต้องมี header `X-QMS` (ป้องกัน CSRF)
- Customer Tracking ไม่ต้อง Login และคืนข้อมูล **เฉพาะคิวของ Token นั้น** — ไม่มีเบอร์โทร/ข้อมูลลูกค้าคนอื่น/ข้อมูลหลังบ้าน
- Display ใช้ Device Token (เก็บแบบ hash ในฐานข้อมูล) · Print Agent ใช้ Agent Key
- Secret ของ SMS ถูกปิดบังเมื่อแสดงใน Admin · CSV export ป้องกัน Formula injection

## ทดสอบ

```bash
npm test
```

ครอบคลุม: การออกเลขพร้อมกัน 40 คำขอไม่ซ้ำ, Idempotency, การนับคิวก่อนหน้า, สถานะคิว, การจับคู่จอแบบใช้ครั้งเดียว + Rate limit,
ความเป็นส่วนตัวของ Display/Tracking, พิมพ์ผ่าน LAN (TCP) และ Print Agent, การแก้ไขประเภทคิว, ประวัติ/CSV, สิทธิ์ Staff และ SMS
