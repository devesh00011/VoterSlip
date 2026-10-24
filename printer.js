/* Mewanagar Voter Slip — Bluetooth thermal printing.
   Connects to Bluetooth Low Energy (BLE) thermal printers through Web Bluetooth (Chrome on Android),
   draws the slip as a black-and-white image (so Hindi always prints correctly, even on printers
   with no Devanagari font) and sends it with standard ESC/POS commands. */
"use strict";

/* BLE services used by common portable thermal printers (Chinese generic, Xprinter, GOOJPRT,
   MTP/PT series, Rongta, HPRT, Zjiang, Bixolon, etc.). Web Bluetooth only lets the page use
   services listed here. */
const PRINTER_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000ae30-0000-1000-8000-00805f9b34fb",
  "0000ae3a-0000-1000-8000-00805f9b34fb",
  "0000ffb0-0000-1000-8000-00805f9b34fb",
  "0000fee7-0000-1000-8000-00805f9b34fb",
  "0000ff12-0000-1000-8000-00805f9b34fb",
  "0000af30-0000-1000-8000-00805f9b34fb",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  "0000180a-0000-1000-8000-00805f9b34fb"
];
/* Characteristics known to accept print data, tried first */
const PREFERRED_WRITE = [
  "00002af1-0000-1000-8000-00805f9b34fb",
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
  "49535343-8841-43f4-a8d4-ecbe34729bb3",
  "0000ff02-0000-1000-8000-00805f9b34fb",
  "0000fff2-0000-1000-8000-00805f9b34fb",
  "0000ffe1-0000-1000-8000-00805f9b34fb",
  "0000ae01-0000-1000-8000-00805f9b34fb",
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

class BlePrinter extends EventTarget {
  constructor(){
    super();
    this.device = null; this.char = null; this.notifyChar = null;
    this.state = "none";          // none | connecting | connected | disconnected
    this.lastStatus = null;
    this.chunk = 180;
    this._onDisc = () => { this.char = null; this.notifyChar = null; this._set("disconnected"); };
  }
  get supported(){ return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
  get name(){ return this.device ? (this.device.name || "Unnamed printer") : (lsGet("printerName") || ""); }
  _set(st, msg){ this.state = st; this.dispatchEvent(new CustomEvent("change", {detail: {state: st, msg}})); }

  /* First-time connect: shows Chrome's device chooser (needs a tap) */
  async choose(){
    if (!this.supported) throw new Error("NOBT");
    const dev = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: PRINTER_SERVICES});
    await this._use(dev);
  }
  /* Reconnect to the printer used before, without the chooser if Chrome allows it */
  async reconnect(){
    if (this.device){ await this._use(this.device); return true; }
    if (navigator.bluetooth && navigator.bluetooth.getDevices){
      const id = lsGet("printerId");
      const list = await navigator.bluetooth.getDevices();
      const dev = list.find(d => d.id === id) || list.find(d => d.name && d.name === lsGet("printerName"));
      if (dev){ await this._use(dev); return true; }
    }
    return false;
  }
  async _use(dev){
    if (this.device && this.device !== dev) this.device.removeEventListener("gattserverdisconnected", this._onDisc);
    this.device = dev;
    dev.removeEventListener("gattserverdisconnected", this._onDisc);
    dev.addEventListener("gattserverdisconnected", this._onDisc);
    this._set("connecting");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++){
      try{
        const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect();
        await this._findChars(server);
        lsSet("printerId", dev.id); lsSet("printerName", dev.name || "Unnamed printer");
        this._set("connected");
        return;
      } catch(e){ lastErr = e; await sleep(600); }
    }
    this._set("disconnected", lastErr && lastErr.message);
    throw lastErr;
  }
  async _findChars(server){
    const services = await server.getPrimaryServices();
    const writable = [], notifiable = [];
    for (const s of services){
      let chars = [];
      try{ chars = await s.getCharacteristics(); }catch(e){ continue; }
      for (const c of chars){
        if (c.properties.write || c.properties.writeWithoutResponse) writable.push(c);
        if (c.properties.notify) notifiable.push(c);
      }
    }
    if (!writable.length) throw new Error("NOWRITE");
    writable.sort((a, b) => rank(a) - rank(b));
    this.char = writable[0];
    this.notifyChar = notifiable.find(n => n.service.uuid === this.char.service.uuid) || null;
    function rank(c){ const i = PREFERRED_WRITE.indexOf(c.uuid); return i < 0 ? 99 : i; }
  }
  disconnect(){ if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }
  forget(){
    this.disconnect();
    if (this.device && this.device.forget) this.device.forget().catch(() => {});
    this.device = null; lsDel("printerId"); lsDel("printerName"); this._set("none");
  }

  async ensure(){
    if (this.char && this.device && this.device.gatt.connected) return;
    if (!(await this.reconnect())) throw new Error("NOTCONNECTED");
  }

  /* Best-effort paper check using ESC/POS real-time status (DLE EOT 4). Many printers do not
     answer over BLE; then we simply print. Returns "paper-out" | "ok" | "unknown". */
  async paperStatus(){
    if (!this.notifyChar) return "unknown";
    let got = null;
    const h = e => { const v = e.target.value; if (v && v.byteLength) got = v.getUint8(0); };
    try{
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener("characteristicvaluechanged", h);
      await this._write(new Uint8Array([0x10, 0x04, 0x04]), 0);
      for (let i = 0; i < 6 && got === null; i++) await sleep(50);
    } catch(e){ return "unknown"; }
    finally{
      this.notifyChar.removeEventListener("characteristicvaluechanged", h);
      try{ await this.notifyChar.stopNotifications(); }catch(e){}
    }
    if (got === null || (got & 0x93) !== 0x12) return "unknown";   // not a valid status byte
    return (got & 0x60) ? "paper-out" : "ok";
  }

  async _write(bytes, delay){
    const c = this.char;
    const noResp = c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === "function";
    let size = this.chunk;
    for (let i = 0; i < bytes.length; ){
      const part = bytes.subarray(i, i + size);
      try{
        if (noResp) await c.writeValueWithoutResponse(part);
        else if (typeof c.writeValueWithResponse === "function") await c.writeValueWithResponse(part);
        else await c.writeValue(part);
      } catch(e){
        // chunk too large for this printer's link: drop to the BLE minimum and retry
        if (size > 20 && /length|size|large|mtu|invalid/i.test(e.message || "")){ size = 20; this.chunk = 20; continue; }
        throw e;
      }
      i += part.length;
      if (delay) await sleep(delay);
    }
  }
  async send(bytes, speed){
    await this.ensure();
    const delay = {fast: 3, normal: 12, slow: 30}[speed] ?? 12;
    if (speed === "slow") this.chunk = Math.min(this.chunk, 100);
    try{ await this._write(bytes, delay); }
    catch(e){ if (!this.device.gatt.connected) this._onDisc(); throw e; }
  }
}

/* =====================================================================
   Slip image: draws the slip on a canvas at the printer's dot width
   (8 dots per mm, the usual 203 dpi), then makes it pure black & white.
   ===================================================================== */
const SLIP_FONT = '"Noto Sans Devanagari","Nirmala UI","Mangal",Roboto,Arial,sans-serif';
const graphemes = s => (typeof Intl !== "undefined" && Intl.Segmenter)
  ? Array.from(new Intl.Segmenter("hi", {granularity: "grapheme"}).segment(s), x => x.segment)
  : Array.from(s);

function wrapText(ctx, text, maxW){
  text = String(text || "");
  if (!text) return [""];
  const words = text.split(/(\s+|\/)/).filter(w => w !== "");
  const lines = []; let cur = "";
  const fit = s => ctx.measureText(s).width <= maxW;
  for (const w of words){
    const trial = cur + w;
    if (fit(trial)){ cur = trial; continue; }
    if (cur.trim()) { lines.push(cur.trimEnd()); cur = ""; }
    const piece = w.trimStart();
    if (fit(piece)){ cur = piece; continue; }
    for (const g of graphemes(piece)){           // a single very long word: break between letters
      if (fit(cur + g)) cur += g; else { if (cur) lines.push(cur); cur = g; }
    }
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  return lines;
}

/* Returns {canvas, width, height, bits: Uint8Array (1 = black), widthBytes} */
function renderSlip(rec, opt){
  const W = opt.dots;                     // printable dots per line, e.g. 384 (58 mm) / 576 (80 mm)
  const mm = W / (opt.paper === "80" ? 72 : 48);   // dots per mm of printable width
  const k = (opt.size === "l" ? 1.15 : 1);
  const pt = v => Math.round(v * 0.3528 * mm * k);  // points -> dots
  const wide = opt.paper === "80";
  const F = {
    name: pt(wide ? 13 : 11.5), val: pt(wide ? 11 : 10), lbl: pt(wide ? 9 : 7.5),
    vm: pt(wide ? 9.5 : 8.5), gp: pt(wide ? 7.5 : 7), ty: pt(wide ? 9 : 8)
  };
  const padX = Math.round(mm * 0.5);
  const lblW = Math.round(mm * (wide ? 31 : 21));
  const gap = Math.round(mm * 1.2);
  const valX = padX + lblW + gap, valW = W - valX - padX;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = 2000;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = "#000"; ctx.textBaseline = "alphabetic";

  let y = Math.round(mm * 1);
  const rows = opt.test ? [
    ["NAME:", "TEST PRINT परीक्षण", "name"],
    ["FATHER/HUSBAND NAME:", "हिंदी अक्षर: क्ष त्र ज्ञ श्र ऋ ॐ ड़ ढ़"],
    ["EPIC:", "ABC1234567"],
    ["SN:", "123"], ["WARD:", "4"], ["CASTE:", "जाति"], ["BOOTH NO.:", "74"]
  ] : [
    ["NAME:", rec.name, "name"],
    ["FATHER/HUSBAND NAME:", rec.father],
    ["EPIC:", rec.epic], ["SN:", rec.sn], ["WARD:", rec.ward],
    ["CASTE:", rec.caste], ["BOOTH NO.:", rec.booth]
  ];
  for (const [label, value, kind] of rows){
    const vSize = kind === "name" ? F.name : F.val;
    ctx.font = `700 ${F.lbl}px ${SLIP_FONT}`;
    const lLines = wrapText(ctx, label, lblW);
    ctx.font = `${kind === "name" ? 800 : 400} ${vSize}px ${SLIP_FONT}`;
    const vLines = wrapText(ctx, value, valW);
    const vLH = Math.round(vSize * 1.32), lLH = Math.round(F.lbl * 1.25);
    const base = y + Math.round(vSize * 1.02);   // room for Hindi vowel signs above the line
    vLines.forEach((t, i) => ctx.fillText(t, valX, base + i * vLH));
    ctx.font = `700 ${F.lbl}px ${SLIP_FONT}`;
    lLines.forEach((t, i) => ctx.fillText(t, padX, base + i * lLH));
    const h = Math.max(vLines.length * vLH, (lLines.length - 1) * lLH + vLH);
    y += h + Math.round(mm * 0.5);
  }
  // thin separator
  y += Math.round(mm * 0.6);
  ctx.fillRect(padX, y, W - 2 * padX, Math.max(2, Math.round(mm * 0.3)));
  y += Math.round(mm * 1.2);
  const center = (txt, size, weight, spacing) => {
    ctx.font = `${weight} ${size}px ${SLIP_FONT}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = spacing || "0px";
    const w = ctx.measureText(txt).width;
    y += Math.round(size * 1.05);
    ctx.fillText(txt, Math.round((W - w) / 2), y);
    y += Math.round(size * 0.3);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  };
  center("वन्दे मातरम्", F.vm, 700);
  center("ग्राम पंचायत मेवानगर", F.gp, 700);
  center("THANK YOU", F.ty, 700, Math.round(mm * 0.3) + "px");
  if (opt.test){
    y += Math.round(mm * 1.5);
    ctx.fillRect(0, y, W, 2); ctx.fillRect(0, y, 2, mm * 4); ctx.fillRect(W - 2, y, 2, mm * 4);
    for (let x = 0; x < W; x += Math.round(mm * 10)) ctx.fillRect(x, y, 2, mm * 2);
    y += Math.round(mm * 4);
    ctx.font = `400 ${F.lbl}px ${SLIP_FONT}`;
    const t = `${W} dots · ${opt.paper} mm · edge marks must both print`;
    y += F.lbl; ctx.fillText(t, Math.max(0, (W - ctx.measureText(t).width) / 2), y);
  }
  const H = Math.ceil(y + mm * 1.5);

  // to 1-bit
  const img = ctx.getImageData(0, 0, W, H).data;
  const widthBytes = Math.ceil(W / 8);
  const bits = new Uint8Array(widthBytes * H);
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const octx = out.getContext("2d"); const od = octx.createImageData(W, H);
  for (let yy = 0; yy < H; yy++){
    for (let x = 0; x < W; x++){
      const i = (yy * W + x) * 4;
      const lum = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
      const black = lum < 150;
      if (black) bits[yy * widthBytes + (x >> 3)] |= (0x80 >> (x & 7));
      const v = black ? 0 : 255; od.data[i] = od.data[i + 1] = od.data[i + 2] = v; od.data[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return {canvas: out, width: W, height: H, bits, widthBytes};
}

/* ESC/POS job for one or more slips */
function escposJob(images, opt){
  const parts = [];
  const push = a => parts.push(a instanceof Uint8Array ? a : new Uint8Array(a));
  push([0x1B, 0x40]);                        // initialise
  for (const im of images){
    if (opt.mode === "escstar") pushEscStar(im, push);
    else pushGSv0(im, push);
    push([0x1B, 0x64, Math.max(0, Math.min(10, opt.feed ?? 3))]);   // feed n lines
    if (opt.cut) push([0x1D, 0x56, 0x42, 0x00]);
  }
  let len = 0; for (const p of parts) len += p.length;
  const all = new Uint8Array(len); let o = 0;
  for (const p of parts){ all.set(p, o); o += p.length; }
  return all;
}
function pushGSv0(im, push){
  const band = 128;
  for (let y0 = 0; y0 < im.height; y0 += band){
    const h = Math.min(band, im.height - y0);
    push([0x1D, 0x76, 0x30, 0x00, im.widthBytes & 0xFF, im.widthBytes >> 8, h & 0xFF, h >> 8]);
    push(im.bits.subarray(y0 * im.widthBytes, (y0 + h) * im.widthBytes));
  }
}
function pushEscStar(im, push){
  push([0x1B, 0x33, 24]);                    // line spacing = 24 dots
  const W = im.width;
  for (let y0 = 0; y0 < im.height; y0 += 24){
    const row = new Uint8Array(5 + W * 3 + 1);
    row.set([0x1B, 0x2A, 33, W & 0xFF, W >> 8]);
    for (let x = 0; x < W; x++){
      for (let b = 0; b < 3; b++){
        let byte = 0;
        for (let bit = 0; bit < 8; bit++){
          const yy = y0 + b * 8 + bit;
          if (yy < im.height && (im.bits[yy * im.widthBytes + (x >> 3)] & (0x80 >> (x & 7)))) byte |= (0x80 >> bit);
        }
        row[5 + x * 3 + b] = byte;
      }
    }
    row[row.length - 1] = 0x0A;
    push(row);
  }
  push([0x1B, 0x32]);                        // default line spacing
}
