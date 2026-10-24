/* Mewanagar Voter Slip — app logic (search, storage, screens, printing flow).
   All data stays in this browser on the phone. Nothing is sent to any server. */
"use strict";
const APP_VERSION = "1.0.0";

const FIELDS = ["ward","sn","name","father","epic","caste","booth"];
const LABEL = {ward:"Ward",sn:"SN",name:"Name",father:"Father/Husband Name",epic:"EPIC",caste:"Caste",booth:"Booth No."};
const FLAG_RE = /^\s*(death|dead|shifted|repetition|repeat|deleted|expired|duplicate|मृत|स्थानांतरित)/i;
const MAX_SHOW = 100;
const voters = n => `${n.toLocaleString("en-IN")} voter${n === 1 ? "" : "s"}`;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k, v){ try{ localStorage.setItem(k, v); return true; }catch(e){ return false; } }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

/* ---------------- IndexedDB (the phone's local database) ---------------- */
const idb = {
  _db: null,
  open(){
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("mewanagar-voter-slip", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k){ const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v){ const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
  async del(k){ const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
};

/* ---------------- state ---------------- */
let DATA = null;             // {fileName, sheet, importedAt, colNames, rows:[...]}
let results = [];
let currentId = null;        // record shown in slip preview
let settings = {paper:"80", dots:"576", size:"n", mode:"gsv0", speed:"normal", feed:"3", cut:"off"};
const printer = new BlePrinter();

/* ---------------- small UI helpers ---------------- */
function toast(msg, ms){ const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms || 2600); }
function busy(on, text){ $("busy").hidden = !on; if (text) $("busyText").textContent = text; }
function modal(title, html, buttons){
  return new Promise(res => {
    $("mTitle").textContent = title; $("mText").innerHTML = html;
    const box = $("mBtns"); box.innerHTML = "";
    for (const b of buttons){
      const el = document.createElement("button");
      el.className = "btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "");
      el.textContent = b.label;
      el.onclick = () => { $("modalBg").classList.remove("show"); res(b.value); };
      box.appendChild(el);
    }
    $("modalBg").classList.add("show");
    const inp = $("mText").querySelector("input"); if (inp) setTimeout(() => inp.focus(), 50);
  });
}

/* ---------------- screens (Android back button works) ---------------- */
function show(view, push){
  for (const v of ["vHome","vSlip","vSettings"]) $(v).hidden = v !== view;
  if (push) history.pushState({view}, "", "#" + view.slice(1).toLowerCase());
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", e => {
  const v = (e.state && e.state.view) || "vHome";
  for (const id of ["vHome","vSlip","vSettings"]) $(id).hidden = id !== v;
  if (v === "vHome") focusSearch(false);
});
function goHome(){ if (!$("vHome").hidden) return; if (history.state && history.state.view !== "vHome") history.back(); else show("vHome", false); setTimeout(() => focusSearch(true), 60); }
function focusSearch(select){ const q = $("q"); if (select) q.select(); }

/* =====================================================================
   Search
   ===================================================================== */
function indexData(){
  DATA.rows.forEach((r, i) => {
    r.id = i;
    r._raw = [r.name, r.father, r.epic, r.caste].join(" | ").toLowerCase();
    r._rawNs = r._raw.replace(/\s+/g, "");
    r._ph = phon(r.name + " | " + r.father);
    r._phNs = r._ph.replace(/\s+/g, "");
    r._nameL = r.name.toLowerCase();
    r._nameNs = r._nameL.replace(/\s+/g, "");
    r._flag = FLAG_RE.test(r.caste) || FLAG_RE.test(r.name);
  });
  const nameCount = {};
  for (const r of DATA.rows) nameCount[r.name] = (nameCount[r.name] || 0) + 1;
  for (const r of DATA.rows) r._dupe = nameCount[r.name] > 1;
}
function search(qRaw, ward, booth){
  if (!DATA) return [];
  let q = qRaw.toLowerCase().replace(/\s+/g, " ").trim();
  const take = re => { const m = re.exec(q); if (!m) return null; q = (q.slice(0, m.index) + " " + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); return m[1]; };
  const wq = take(/(?:^|\s)(?:ward|वार्ड|w)\s*[-:.]?\s*(\d+)(?=\s|$)/i); if (wq) ward = wq;
  const bq = take(/(?:^|\s)(?:booth|बूथ|b)\s*[-:.]?\s*(\d+)(?=\s|$)/i); if (bq) booth = bq;
  let pool = DATA.rows;
  if (ward) pool = pool.filter(r => r.ward === ward);
  if (booth) pool = pool.filter(r => r.booth === booth);
  if (!q) return (ward || booth) ? pool.slice().sort((a, b) => (Number(a.ward) - Number(b.ward)) || (Number(a.sn) - Number(b.sn)) || a.id - b.id) : [];
  const tokens = q.split(" ");
  const qNs = q.replace(/\s+/g, "");
  const out = [];
  for (const r of pool){
    let ok = true, score = 0;
    for (const tk of tokens){
      if (/^\d+$/.test(tk)){
        if (r.sn === tk){ score += 40; continue; }
        if (tk.length >= 4 && r.epic.toLowerCase().includes(tk)){ score += 10; continue; }
        ok = false; break;
      }
      if (r._raw.includes(tk) || r._rawNs.includes(tk)){ score += 10; continue; }
      if (/^[a-z]+$/.test(tk)){
        const pk = phon(tk).replace(/\s+/g, "");
        if (pk && (r._ph.includes(pk) || r._phNs.includes(pk))){ score += 4; continue; }
      }
      ok = false; break;
    }
    if (!ok) continue;
    if (r.epic.toLowerCase() === qNs) score += 100;
    if (r._nameL === q || r._nameNs === qNs) score += 60;
    else if (r._nameL.startsWith(tokens[0]) || r._nameNs.startsWith(qNs)) score += 30;
    else if (r._nameL.includes(tokens[0])) score += 15;
    else if (/^[a-z]+$/.test(tokens[0]) && r._ph.split(" | ")[0].replace(/\s+/g, "").startsWith(phon(tokens[0]).replace(/\s+/g, ""))) score += 20;
    out.push({r, score});
  }
  out.sort((a, b) => b.score - a.score || (Number(a.r.ward) - Number(b.r.ward)) || (Number(a.r.sn) - Number(b.r.sn)) || a.r.id - b.r.id);
  return out.map(x => x.r);
}
function doSearch(){
  results = search($("q").value, $("fWard").value, $("fBooth").value);
  renderResults();
}
function renderResults(){
  const q = $("q").value.trim(), anyFilter = q || $("fWard").value || $("fBooth").value;
  $("btnClear").hidden = !anyFilter;
  $("emptyData").hidden = !!DATA;
  $("recentBox").hidden = !DATA || !!anyFilter || !recentList().length;
  renderRecent();
  if (!DATA || !anyFilter){ $("results").innerHTML = ""; $("resCount").textContent = DATA ? "" : ""; $("moreHint").textContent = ""; return; }
  const list = results.slice(0, MAX_SHOW);
  $("resCount").textContent = results.length ? `${results.length.toLocaleString("en-IN")} matching voter${results.length === 1 ? "" : "s"}` : "No matching voter found";
  $("moreHint").textContent = results.length > MAX_SHOW ? `Showing first ${MAX_SHOW}. Type more letters to narrow.` : (!results.length ? "Check the spelling, or try fewer letters." : "");
  const kv = (k, v, cls) => `<span class="${cls || ""}"><b>${k}</b>${esc(v) || "—"}</span>`;
  $("results").innerHTML = list.map(r => `<div class="vcard" data-id="${r.id}">
    <div class="nm">${esc(r.name)}${r._flag ? `<span class="flag">${esc(r.caste.toUpperCase())}</span>` : ""}${r._dupe ? `<span class="dupe">same name</span>` : ""}</div>
    <div class="fa">${esc(r.father)}</div>
    <div class="kv">${kv("EPIC", r.epic, "epic")}${kv("SN", r.sn)}${kv("WARD", r.ward)}${kv("BOOTH", r.booth)}${r._flag ? "" : kv("CASTE", r.caste)}</div>
    <div class="acts"><button class="btn" data-view="${r.id}">VIEW SLIP</button><button class="btn primary" data-print="${r.id}">PRINT</button></div>
  </div>`).join("");
}

/* recent searches */
function recentList(){ try{ return JSON.parse(lsGet("recent") || "[]"); }catch(e){ return []; } }
function addRecent(){
  const q = $("q").value.trim(); if (!q) return;
  const list = [q, ...recentList().filter(x => x !== q)].slice(0, 8);
  lsSet("recent", JSON.stringify(list));
}
function renderRecent(){
  $("recent").innerHTML = recentList().map(q => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("");
}

/* =====================================================================
   Slip preview & printing
   ===================================================================== */
const slipOpt = extra => ({paper: settings.paper, dots: Number(settings.dots), size: settings.size, ...extra});
function openSlip(id){
  const r = DATA.rows[id]; if (!r) return;
  currentId = id; addRecent();
  const im = renderSlip(r, slipOpt());
  const paper = $("slipPaper"); paper.innerHTML = "";
  paper.style.width = Math.min(window.innerWidth - 56, settings.paper === "80" ? 340 : 270) + "px";
  paper.appendChild(im.canvas);
  $("slipMeta").textContent = `Printer: ${printer.state === "connected" ? printer.name : "not connected"} · Paper: ${settings.paper} mm`;
  $("slipSrc").textContent = `From the Excel list: sheet “${DATA.sheet}”, row ${r.row}` + (r.age ? ` · Age ${r.age}` : "") + (r.gender ? ` · ${r.gender}` : "") + (r.house ? ` · House ${r.house}` : "");
  const w = $("slipWarn");
  if (r._flag){ w.hidden = false; w.textContent = `This voter is marked “${r.caste}” in the Excel list. Please check before printing.`; }
  else if (r._dupe){ w.hidden = false; w.textContent = "Another voter has the same name. Check the father/husband name, ward and SN."; }
  else w.hidden = true;
  show("vSlip", true);
}
async function printRecords(recs, fromSlip){
  if (!printer.supported){ showBtHelp(); return; }
  const flagged = recs.filter(r => r._flag);
  if (flagged.length){
    const ok = await modal("Check this record", `<b>${esc(flagged[0].name)}</b> (Ward ${esc(flagged[0].ward)}, SN ${esc(flagged[0].sn)}) is marked “${esc(flagged[0].caste)}” in the Excel list. Print anyway?`,
      [{label:"Cancel", value:false}, {label:"Print anyway", value:true, primary:true}]);
    if (!ok) return;
  }
  busy(true, "Connecting to printer…");
  try{
    try{ await printer.ensure(); }
    catch(e){
      busy(false);
      if (e.message === "NOTCONNECTED"){
        const go = await modal("Connect the printer", "The printer is not connected. Switch it on, then tap <b>Connect</b> and choose it from the list.", [{label:"Cancel", value:false}, {label:"Connect", value:true, primary:true}]);
        if (!go) return;
        await connectFlow(); if (printer.state !== "connected") return;
        busy(true);
      } else throw e;
    }
    busy(true, "Checking paper…");
    const st = await printer.paperStatus();
    if (st === "paper-out"){ busy(false); await modal("Paper finished", "The printer reports that the paper roll is empty. Load paper and try again.", [{label:"OK", value:true, primary:true}]); return; }
    busy(true, recs.length > 1 ? `Printing ${recs.length} slips…` : "Printing…");
    const images = recs.map(r => renderSlip(r, slipOpt()));
    const job = escposJob(images, {mode: settings.mode, feed: Number(settings.feed), cut: settings.cut === "on"});
    await printer.send(job, settings.speed);
    busy(false);
    toast(recs.length === 1 ? `Printed: ${recs[0].name}` : `${recs.length} slips printed`);
    lsSet("lastPrinted", JSON.stringify({name: recs[0].name, at: Date.now()}));
    if (fromSlip) goHome(); else focusSearch(true);
  } catch(e){
    busy(false);
    console.error(e);
    const msg = printErrorText(e);
    const again = await modal("Could not print", msg, [{label:"Close", value:false}, {label:"Reconnect & retry", value:true, primary:true}]);
    if (again){ try{ await printer.reconnect() || await printer.choose(); printRecords(recs, fromSlip); } catch(e2){ toast(printErrorText(e2), 4000); } }
  }
}
function printErrorText(e){
  const m = (e && (e.message || e.name)) || String(e);
  if (m === "NOBT") return "Bluetooth printing needs Google Chrome on Android.";
  if (m === "NOWRITE") return "This device does not accept print data over Bluetooth Low Energy. It may be a Classic-Bluetooth-only printer — see the guide.";
  if (m === "NOTCONNECTED") return "The printer is not connected.";
  if (/NotFoundError|cancel/i.test(m) || (e && e.name === "NotFoundError")) return "No printer was chosen.";
  if (/disconnected|GATT|network/i.test(m)) return "The printer disconnected. Check that it is switched on, close by, and not connected to another phone.";
  if (/Bluetooth adapter not available|adapter/i.test(m)) return "Bluetooth is off. Turn on Bluetooth (and Location, if Android asks) and try again.";
  return "Printing failed: " + esc(m) + ". Check the printer is on and has paper, then try again.";
}

/* ---------------- printer connection ---------------- */
async function connectFlow(){
  if (!printer.supported){ showBtHelp(); return; }
  try{
    busy(true, "Connecting…");
    const ok = await printer.reconnect().catch(() => false);
    if (!ok){ busy(false); await printer.choose(); }
    busy(false);
    toast(`Connected: ${printer.name}`);
  } catch(e){
    busy(false);
    if (e && e.name === "NotFoundError") return;            // user closed the chooser
    await modal("Could not connect", printErrorText(e), [{label:"OK", value:true, primary:true}]);
  }
}
function showBtHelp(){
  modal("Bluetooth not available here", "Open this app in <b>Google Chrome</b> on your Android phone (not Samsung Internet, Firefox or a file viewer), with Bluetooth switched on. The page must be opened from its https:// web address.", [{label:"OK", value:true, primary:true}]);
}
function paintPrinter(){
  const st = printer.state;
  const name = printer.name;
  for (const [dot, nm] of [["pDot","pName"],["pDot2","pName2"]]){
    $(dot).className = "dot " + st;
    $(nm).textContent = st === "connected" ? `${name} · connected` :
      st === "connecting" ? `Connecting to ${name || "printer"}…` :
      st === "disconnected" ? `${name || "Printer"} · disconnected` :
      (name ? `${name} · tap Connect` : "Printer not connected");
  }
  $("btnConnect").textContent = st === "connected" ? "Connected ✓" : (st === "disconnected" || name ? "Reconnect" : "Connect Printer");
}
printer.addEventListener("change", e => { paintPrinter(); if (e.detail.state === "disconnected") toast("Printer disconnected — tap Reconnect"); });

/* =====================================================================
   Import, column mapping, backup
   ===================================================================== */
let SHEETS = null, FILE_NAME = "", MAP = null;
async function importFile(file){
  if (!file) return;
  const name = file.name || "file";
  busy(true, "Reading voter list…");
  try{
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    let sheets;
    if (head[0] === 0xD0 && head[1] === 0xCF) throw new Error("OLDXLS");
    if (/\.csv$/i.test(name) || (head[0] !== 0x50 || head[1] !== 0x4B)) {
      if (/\.xlsx?$/i.test(name)) throw new Error("NOTZIP");
      sheets = readCsv(new TextDecoder("utf-8").decode(buf));
    } else sheets = await readXlsx(buf);
    sheets = sheets.filter(s => s.rows.length);
    if (!sheets.length) throw new Error("NOROWS");
    SHEETS = sheets; FILE_NAME = name;
    const pick = pickSheet(sheets);
    if (pick) MAP = {sheetIdx: sheets.indexOf(pick.sheet), headerIdx: pick.headerIdx, cols: {...pick.cols}};
    else { const big = sheets.reduce((a, b) => b.rows.length > a.rows.length ? b : a); MAP = {sheetIdx: sheets.indexOf(big), headerIdx: 0, cols: {}}; }
    busy(false);
    const missing = FIELDS.filter(f => MAP.cols[f] === undefined);
    if (MAP.cols.name === undefined || missing.length){
      openSettings(); renderMap(); $("mapCard").hidden = false;
      await modal(MAP.cols.name === undefined ? "Choose the columns" : "Some columns not found",
        MAP.cols.name === undefined
          ? "The Name column could not be identified from the headings. Choose the right column for each field under <b>Column mapping</b>, then tap <b>Apply</b>."
          : `These fields were not found: <b>${missing.map(f => LABEL[f]).join(", ")}</b>. If your sheet has them, choose them under <b>Column mapping</b>. Otherwise tap <b>Apply</b> — they will print blank.`,
        [{label:"OK", value:true, primary:true}]);
      $("mapCard").scrollIntoView({behavior:"smooth"});
      return;
    }
    await commit();
  } catch(e){
    busy(false); console.error(e);
    const why = {
      OLDXLS: "This is an old .xls file. Open it in Excel (or Google Sheets) and save it as <b>.xlsx</b> or <b>.csv</b>, then import that file.",
      NOTZIP: "This file could not be opened as an Excel workbook. It may be damaged or password-protected.",
      NOTXLSX: "This file is not an Excel workbook (.xlsx).",
      NOROWS: "No voter records were found in this file."
    }[e.message] || ("The file could not be read: " + esc(e.message || e));
    await modal("Import failed", why + (DATA ? "<br><br>Your previous voter list is still in use." : ""), [{label:"OK", value:true, primary:true}]);
  }
}
async function commit(){
  const ds = buildDataset(SHEETS[MAP.sheetIdx], MAP.headerIdx, MAP.cols, FILE_NAME);
  if (!ds.rows.length){ await modal("No voters found", "No valid voter records were found with this column mapping.", [{label:"OK", value:true, primary:true}]); return; }
  const store = {...ds, rows: ds.rows.map(stripRow)};
  busy(true, "Saving on this phone…");
  try{ await idb.set("dataset", store); }
  catch(e){ busy(false); await modal("Could not save", "The list could not be saved on this phone (storage full?). It will work until you close the app.", [{label:"OK", value:true}]); }
  busy(false);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  DATA = store; indexData(); afterLoad();
  $("mapCard").hidden = true;
  const blanks = Object.entries(ds.blanks).map(([k, n]) => `${n} blank ${LABEL[k].replace(/\.$/, "")}`).join(", ");
  const inv = ds.invalid.length ? `<br><br><b>${ds.invalid.length} invalid record${ds.invalid.length > 1 ? "s" : ""} skipped</b> (no voter name) — Excel row${ds.invalid.length > 1 ? "s" : ""} ${ds.invalid.slice(0, 15).join(", ")}${ds.invalid.length > 15 ? " …" : ""}.` : "";
  await modal("Voter list imported",
    `<b>${voters(ds.rows.length)}</b> imported from sheet “${esc(ds.sheet)}”.` +
    (blanks ? `<br><br>Blank in the Excel (left blank on slips): ${esc(blanks)}.` : "") + inv +
    (ds.warnings.length ? `<br><br>No column for: <b>${FIELDS.filter(f => MAP.cols[f] === undefined).map(f => LABEL[f]).join(", ")}</b> — these will print blank.` : ""),
    [{label:"Start searching", value:true, primary:true}]);
  goHome();
}
const stripRow = r => ({ward:r.ward, sn:r.sn, name:r.name, father:r.father, epic:r.epic, caste:r.caste, booth:r.booth, age:r.age, house:r.house, gender:r.gender, row:r.row});
function afterLoad(){
  $("countLine").textContent = `${voters(DATA.rows.length)} loaded`;
  const uniq = (key) => [...new Set(DATA.rows.map(r => r[key]).filter(Boolean))].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  $("fWard").innerHTML = `<option value="">All wards</option>` + uniq("ward").map(w => `<option value="${esc(w)}">Ward ${esc(w)}</option>`).join("");
  const booths = uniq("booth");
  $("fBooth").innerHTML = `<option value="">All booths</option>` + booths.map(b => `<option value="${esc(b)}">Booth ${esc(b)}</option>`).join("");
  $("fBooth").hidden = !booths.length;
  const when = new Date(DATA.importedAt).toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"});
  $("dataInfo").innerHTML = `<b>${voters(DATA.rows.length)}</b> · ${esc(DATA.fileName)} · imported ${esc(when)}`;
  $("q").value = ""; doSearch();
}
function colLetter(i){ let s = ""; i++; while (i > 0){ const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function renderMap(){
  const sheet = SHEETS[MAP.sheetIdx];
  const head = sheet.rows[MAP.headerIdx] ? sheet.rows[MAP.headerIdx].cells : [];
  const width = Math.max(head.length, ...sheet.rows.slice(MAP.headerIdx, MAP.headerIdx + 20).map(r => r.cells.length));
  const opts = sel => `<option value="">— not in my sheet —</option>` + Array.from({length: width}, (_, i) =>
    `<option value="${i}" ${sel === i ? "selected" : ""}>${colLetter(i)}: ${esc(clean(head[i]) || "(no heading)")}</option>`).join("");
  $("mapBody").innerHTML = `<div class="mapgrid">
      <label>Sheet<select id="mapSheet">${SHEETS.map((s, i) => `<option value="${i}" ${i === MAP.sheetIdx ? "selected" : ""}>${esc(s.name)} (${s.rows.length} rows)</option>`).join("")}</select></label>
      <label>Heading row<select id="mapHead">${sheet.rows.slice(0, 15).map((r, k) => `<option value="${k}" ${k === MAP.headerIdx ? "selected" : ""}>Row ${r.rn}: ${esc(Array.from(r.cells, clean).filter(Boolean).slice(0, 3).join(" | ").slice(0, 40))}</option>`).join("")}</select></label>
      ${FIELDS.map(f => `<label>${LABEL[f]}<select data-f="${f}" class="${MAP.cols[f] === undefined ? "miss" : ""}">${opts(MAP.cols[f])}</select></label>`).join("")}
    </div>
    <div class="btnrow"><button class="btn primary" id="mapApply">Apply</button><button class="btn" id="mapCancel">Cancel</button></div>`;
  for (const sel of $("mapBody").querySelectorAll("select[data-f]")) sel.onchange = () => sel.classList.toggle("miss", sel.value === "");
  $("mapSheet").onchange = e => { const i = Number(e.target.value); MAP = {sheetIdx: i, headerIdx: 0, cols: detectColumns(Array.from(SHEETS[i].rows[0].cells, x => x ?? ""))}; renderMap(); };
  $("mapHead").onchange = e => { const k = Number(e.target.value); MAP = {...MAP, headerIdx: k, cols: detectColumns(Array.from(sheet.rows[k].cells, x => x ?? ""))}; renderMap(); };
  $("mapCancel").onclick = () => { $("mapCard").hidden = true; };
  $("mapApply").onclick = async () => {
    const cols = {}, seen = {};
    for (const sel of $("mapBody").querySelectorAll("select[data-f]")){
      if (sel.value === "") continue;
      if (seen[sel.value]){ toast(`Same column chosen for ${LABEL[seen[sel.value]]} and ${LABEL[sel.dataset.f]}`, 3500); return; }
      seen[sel.value] = sel.dataset.f; cols[sel.dataset.f] = Number(sel.value);
    }
    if (cols.name === undefined){ toast("Choose the column with the voter Name", 3000); return; }
    MAP.cols = cols;
    await commit();
  };
}
function downloadBlob(blob, name){
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function backup(){
  if (!DATA){ toast("No voter list to back up"); return; }
  const ok = await modal("Backup voter list", "This saves a copy of the voter list as a file in your phone's <b>Downloads</b>. Keep it private — it contains voter details.", [{label:"Cancel", value:false}, {label:"Save backup", value:true, primary:true}]);
  if (!ok) return;
  const data = {app: "mewanagar-voter-slip", version: 1, savedAt: new Date().toISOString(), dataset: {...DATA, rows: DATA.rows.map(stripRow)}};
  downloadBlob(new Blob([JSON.stringify(data)], {type: "application/json"}), `mewanagar-voters-backup-${new Date().toISOString().slice(0, 10)}.json`);
}
async function restore(file){
  if (!file) return;
  try{
    const data = JSON.parse(await file.text());
    if (data.app !== "mewanagar-voter-slip" || !data.dataset || !Array.isArray(data.dataset.rows)) throw new Error("bad");
    const ds = data.dataset;
    const ok = await modal("Restore backup", `Replace the current list with the backup of <b>${ds.rows.length.toLocaleString("en-IN")} voters</b> (${esc(ds.fileName)})?`, [{label:"Cancel", value:false}, {label:"Restore", value:true, primary:true}]);
    if (!ok) return;
    await idb.set("dataset", ds);
    DATA = ds; indexData(); afterLoad(); toast("Backup restored"); goHome();
  } catch(e){ await modal("Restore failed", "This is not a Mewanagar Voter Slip backup file.", [{label:"OK", value:true}]); }
}
async function deleteData(){
  const ok = await modal("Delete voter list?", "The voter list will be removed from this phone. You can import the Excel file again later.", [{label:"Cancel", value:false}, {label:"Delete", value:true, danger:true}]);
  if (!ok) return;
  await idb.del("dataset"); DATA = null; results = []; lsDel("recent");
  $("countLine").textContent = "No voter list yet"; $("dataInfo").textContent = "No voter list on this phone.";
  $("fWard").innerHTML = `<option value="">All wards</option>`; $("fBooth").innerHTML = `<option value="">All booths</option>`;
  renderResults(); toast("Voter list deleted");
}

/* =====================================================================
   PIN lock
   ===================================================================== */
async function sha(s){ const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mewanagar:" + s)); return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join(""); }
function paintPin(){
  const on = !!lsGet("pinHash");
  $("pinState").textContent = on ? "A PIN is set. The app asks for it each time it opens." : "No PIN. Set one to stop others opening the voter list on this phone.";
  $("sPin").textContent = on ? "Change PIN" : "Set PIN"; $("sPinOff").hidden = !on;
}
async function setPin(){
  const v = await new Promise(res => {
    modal("Set PIN", `Choose a 4–8 digit PIN.<input id="newPin" type="password" inputmode="numeric" maxlength="8">`, [{label:"Cancel", value:null}, {label:"Save", value:"ok", primary:true}])
      .then(r => res(r ? ($("newPin") ? $("newPin").value : "") : null));
    // modal removes nothing from DOM before resolve, value read synchronously above
  });
  if (v === null) return;
  if (!/^\d{4,8}$/.test(v)){ toast("PIN must be 4 to 8 digits", 3000); return; }
  lsSet("pinHash", await sha(v)); paintPin(); toast("PIN set");
}
async function unlockFlow(){
  if (!lsGet("pinHash")) return true;
  $("lock").hidden = false;
  return new Promise(res => {
    const go = async () => {
      if (await sha($("pinIn").value) === lsGet("pinHash")){ $("lock").hidden = true; $("pinIn").value = ""; res(true); }
      else { $("pinErr").textContent = "Wrong PIN"; $("pinIn").select(); }
    };
    $("pinGo").onclick = go;
    $("pinIn").onkeydown = e => { if (e.key === "Enter") go(); };
    $("pinForgot").onclick = async () => {
      $("lock").hidden = true;
      const ok = await modal("Forgot PIN", "To protect the voter data, the only way to reset the PIN is to delete the voter list from this phone. You can import the Excel file again afterwards.", [{label:"Cancel", value:false}, {label:"Delete list & reset", value:true, danger:true}]);
      if (ok){ await idb.del("dataset"); lsDel("pinHash"); lsDel("recent"); res(true); location.reload(); }
      else $("lock").hidden = false;
    };
    setTimeout(() => $("pinIn").focus(), 100);
  });
}

/* =====================================================================
   Settings
   ===================================================================== */
function openSettings(){ paintPin(); show("vSettings", true); }
function bindSeg(id, key, after){
  const seg = $(id);
  const paint = () => { for (const b of seg.children) b.classList.toggle("on", b.dataset.v === String(settings[key])); };
  seg.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    settings[key] = b.dataset.v;
    if (key === "paper") settings.dots = settings.paper === "80" ? "576" : "384";
    lsSet("settings", JSON.stringify(settings));
    for (const s of document.querySelectorAll(".seg")) s.dispatchEvent(new Event("repaint"));
    if (after) after();
  });
  seg.addEventListener("repaint", paint);
  paint();
}

/* =====================================================================
   Start-up
   ===================================================================== */
async function init(){
  try{ Object.assign(settings, JSON.parse(lsGet("settings") || "{}")); }catch(e){}
  $("verLine").textContent = `Version ${APP_VERSION}`;
  bindSeg("segPaper","paper"); bindSeg("segDots","dots"); bindSeg("segSize","size"); bindSeg("segMode","mode");
  bindSeg("segSpeed","speed"); bindSeg("segFeed","feed"); bindSeg("segCut","cut");
  history.replaceState({view: "vHome"}, "", location.pathname + location.search);

  if (!printer.supported){
    const w = $("btWarn"); w.hidden = false;
    w.innerHTML = window.isSecureContext
      ? "Bluetooth printing is not available in this browser. Open the app in <b>Google Chrome</b> on Android."
      : "Bluetooth printing needs the app to be opened from its <b>https://</b> address in Google Chrome.";
  }
  paintPrinter();

  await unlockFlow();
  try{
    const ds = await idb.get("dataset");
    if (ds && ds.rows && ds.rows.length){ DATA = ds; indexData(); afterLoad(); }
  } catch(e){ console.error(e); }
  if (!DATA) $("dataInfo").textContent = "No voter list on this phone.";
  renderResults();
  // try to re-attach to the last printer silently (works when Chrome remembers permission)
  if (printer.supported && lsGet("printerId")) printer.reconnect().catch(() => {});

  /* events */
  let t;
  $("q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(doSearch, 80); });
  $("q").addEventListener("keydown", e => { if (e.key === "Enter"){ $("q").blur(); addRecent(); } });
  $("fWard").onchange = doSearch; $("fBooth").onchange = doSearch;
  $("btnClear").onclick = () => { $("q").value = ""; $("fWard").value = ""; $("fBooth").value = ""; doSearch(); $("q").focus(); };
  $("recent").onclick = e => { const c = e.target.closest("[data-q]"); if (c){ $("q").value = c.dataset.q; doSearch(); } };
  $("results").onclick = e => {
    const v = e.target.closest("[data-view]"); if (v){ openSlip(Number(v.dataset.view)); return; }
    const p = e.target.closest("[data-print]"); if (p){ addRecent(); printRecords([DATA.rows[Number(p.dataset.print)]], false); }
  };
  $("btnPrintSlip").onclick = () => { if (currentId !== null) printRecords([DATA.rows[currentId]], true); };
  $("btnBackSearch").onclick = goHome; $("slipBack").onclick = goHome; $("setBack").onclick = goHome;
  $("openSettings").onclick = openSettings;
  $("btnConnect").onclick = () => { if (printer.state !== "connected") connectFlow(); else openSettings(); };
  $("sConnect").onclick = async () => { if (!printer.supported) return showBtHelp(); try{ await printer.choose(); toast(`Connected: ${printer.name}`); }catch(e){ if (e.name !== "NotFoundError") modal("Could not connect", printErrorText(e), [{label:"OK", value:true}]); } };
  $("sReconnect").onclick = connectFlow;
  $("sForget").onclick = () => { printer.forget(); toast("Printer forgotten"); };
  $("btnTest").onclick = async () => {
    if (!printer.supported) return showBtHelp();
    busy(true, "Printing test…");
    try{
      await printer.ensure().catch(async e => { busy(false); await connectFlow(); if (printer.state !== "connected") throw new Error("NOTCONNECTED"); busy(true); });
      const im = renderSlip({}, slipOpt({test: true}));
      await printer.send(escposJob([im], {mode: settings.mode, feed: Number(settings.feed), cut: settings.cut === "on"}), settings.speed);
      busy(false); toast("Test print sent");
    } catch(e){ busy(false); if (e.message !== "NOTCONNECTED") modal("Test print failed", printErrorText(e), [{label:"OK", value:true}]); }
  };
  for (const b of ["btnImport1","btnImport2","sImport"]) $(b).onclick = () => $("fileIn").click();
  $("fileIn").onchange = e => { importFile(e.target.files[0]); e.target.value = ""; };
  $("sBackup").onclick = backup;
  $("sRestore").onclick = () => $("restoreIn").click();
  $("restoreIn").onchange = e => { restore(e.target.files[0]); e.target.value = ""; };
  $("sDelete").onclick = deleteData;
  $("sPin").onclick = setPin;
  $("sPinOff").onclick = async () => { const ok = await modal("Remove PIN?", "Anyone with this phone will be able to open the voter list.", [{label:"Cancel", value:false}, {label:"Remove", value:true, danger:true}]); if (ok){ lsDel("pinHash"); paintPin(); } };

  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
