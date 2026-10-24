/* Mewanagar Voter Slip — Excel/CSV reader and column detection.
   Pure browser code, no external library: .xlsx is a zip of XML files,
   unpacked here with the browser's built-in DecompressionStream. */
"use strict";
const byTagNS = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));
async function inflateRaw(u8){
  if (typeof DecompressionStream === "undefined")
    throw new Error("This browser is too old to read Excel files. Please use Google Chrome or Microsoft Edge.");
  const ds = new DecompressionStream("deflate-raw");
  const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}
function readZipIndex(buf){
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--){
    if (dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if (eocd < 0) throw new Error("NOTZIP");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++){
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    files[name.replace(/\\/g,"/").replace(/^\//,"")] = {method, csize, loff};
    p += 46 + nlen + xlen + clen;
  }
  return {
    has: name => !!files[name],
    names: () => Object.keys(files),
    async text(name){
      const f = files[name]; if (!f) return null;
      const ln = dv.getUint16(f.loff + 26, true), lx = dv.getUint16(f.loff + 28, true);
      const start = f.loff + 30 + ln + lx;
      const raw = u8.subarray(start, start + f.csize);
      let out;
      if (f.method === 0) out = raw;
      else if (f.method === 8) out = await inflateRaw(raw);
      else throw new Error("Unsupported compression in Excel file.");
      return new TextDecoder("utf-8").decode(out);
    }
  };
}
const xmlParse = s => new DOMParser().parseFromString(s, "application/xml");
function colIndex(ref){
  const m = /^([A-Z]+)/i.exec(ref || ""); if (!m) return -1;
  let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function numText(s){
  const n = Number(s);
  if (!isFinite(n)) return s;
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(12)));
}
function siText(si){
  // concatenate all <t> except phonetic runs
  let out = "";
  for (const t of byTagNS(si, "t")){
    let p = t.parentNode, skip = false;
    while (p && p !== si){ if (p.localName === "rPh") { skip = true; break; } p = p.parentNode; }
    if (!skip) out += t.textContent;
  }
  return out;
}
function resolveTarget(target){
  if (target.startsWith("/")) return target.slice(1);
  const parts = ("xl/" + target).split("/"), out = [];
  for (const p of parts){ if (p === "..") out.pop(); else if (p !== ".") out.push(p); }
  return out.join("/");
}
async function readXlsx(buf){
  const zip = readZipIndex(buf);
  const wbXml = await zip.text("xl/workbook.xml");
  if (!wbXml) throw new Error("NOTXLSX");
  const wb = xmlParse(wbXml);
  const relsXml = await zip.text("xl/_rels/workbook.xml.rels");
  const rels = {};
  if (relsXml) for (const r of byTagNS(xmlParse(relsXml), "Relationship")) rels[r.getAttribute("Id")] = r.getAttribute("Target");
  let shared = [];
  const ssPath = zip.has("xl/sharedStrings.xml") ? "xl/sharedStrings.xml" : zip.names().find(n => /sharedstrings\.xml$/i.test(n));
  if (ssPath){ shared = byTagNS(xmlParse(await zip.text(ssPath)), "si").map(siText); }
  const sheets = [];
  const sheetEls = byTagNS(wb, "sheet");
  for (let i = 0; i < sheetEls.length; i++){
    const s = sheetEls[i];
    const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships","id");
    let path = rels[rid] ? resolveTarget(rels[rid]) : "xl/worksheets/sheet" + (i+1) + ".xml";
    if (!zip.has(path)) continue;
    const doc = xmlParse(await zip.text(path));
    const rows = [];
    let rAuto = 0;
    for (const rEl of byTagNS(doc, "row")){
      const rn = parseInt(rEl.getAttribute("r"), 10) || (rAuto + 1);
      rAuto = rn;
      const cells = [];
      let cAuto = -1;
      for (const c of Array.from(rEl.children).filter(e => e.localName === "c")){
        const ref = c.getAttribute("r");
        const ci = ref ? colIndex(ref) : cAuto + 1;
        cAuto = ci;
        const t = c.getAttribute("t") || "n";
        const vEl = Array.from(c.children).find(e => e.localName === "v");
        let val = "";
        if (t === "s") val = vEl ? (shared[parseInt(vEl.textContent, 10)] ?? "") : "";
        else if (t === "inlineStr"){ const is = Array.from(c.children).find(e => e.localName === "is"); val = is ? siText(is) : ""; }
        else if (t === "b") val = vEl ? (vEl.textContent === "1" ? "TRUE" : "FALSE") : "";
        else if (t === "e") val = "";
        else if (t === "str") val = vEl ? vEl.textContent : "";
        else val = vEl ? numText(vEl.textContent) : "";
        cells[ci] = val;
      }
      rows.push({rn, cells});
    }
    sheets.push({name: s.getAttribute("name") || ("Sheet" + (i+1)), rows});
  }
  return sheets;
}
function readCsv(text){
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], f = "", q = false, rn = 1;
  const delim = (text.split("\n")[0].split(";").length > text.split("\n")[0].split(",").length) ? ";" : ",";
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (q){ if (ch === '"'){ if (text[i+1] === '"'){ f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim){ row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r"){ if (ch === "\r" && text[i+1] === "\n") i++; row.push(f); rows.push({rn: rn++, cells: row}); row = []; f = ""; }
    else f += ch;
  }
  if (f !== "" || row.length){ row.push(f); rows.push({rn: rn++, cells: row}); }
  return [{name: "CSV", rows}];
}


/* ---------- column detection ---------- */
function normHead(s){ return String(s || "").toLowerCase().replace(/[\s_\-.:/\\()\[\]#]+/g, ""); }
const MATCH = {
  father: h => /father|husband|guardian|relative|relation|पिता|पति|संबंधी|सम्बन्धी|अभिभावक/.test(h),
  epic:   h => /epic|voterid|votercard|idcardno|पहचानपत्र|मतदाताकार्ड/.test(h),
  ward:   h => /ward|वार्ड|वॉर्ड/.test(h),
  sn:     h => /serial|क्रम|क्रसं|^sno|^srno|^slno|^sn$|^sn\d*$|sn$|^partsn/.test(h),
  caste:  h => /caste|^cast|cast$|जाति|जाती|category|वर्ग/.test(h),
  booth:  h => /booth|बूथ|मतदानकेंद्र|मतदानकेन्द्र|pollingstation|psno/.test(h),
  name:   h => /name|नाम/.test(h),
  age:    h => /^age|age$|आयु|उम्र/.test(h),
  house:  h => /house|मकान|गृह/.test(h),
  gender: h => /gender|^sex|लिंग/.test(h)
};
const ORDER = ["father","epic","booth","ward","sn","caste","age","house","gender","name"];
function detectColumns(headerCells){
  const heads = headerCells.map(normHead);
  const cols = {}; const used = new Set();
  for (const key of ORDER){
    for (let i = 0; i < heads.length; i++){
      if (used.has(i) || !heads[i]) continue;
      if (MATCH[key](heads[i])){ cols[key] = i; used.add(i); break; }
    }
  }
  return cols;
}
function pickSheet(sheets){
  let best = null;
  for (const sh of sheets){
    for (let k = 0; k < Math.min(15, sh.rows.length); k++){
      const cells = sh.rows[k].cells;
      const cols = detectColumns(Array.from(cells, c => c ?? ""));
      const score = FIELDS.filter(f => cols[f] !== undefined).length;
      if (cols.name === undefined) continue;
      const dataRows = sh.rows.length - k - 1;
      if (!best || score > best.score || (score === best.score && dataRows > best.dataRows))
        best = {sheet: sh, headerIdx: k, cols, score, dataRows};
    }
  }
  return best;
}
const clean = v => (v === undefined || v === null) ? "" : String(v).replace(/\s+/g, " ").trim();

function buildDataset(sheet, headerIdx, cols, fileName){
  const headRow = sheet.rows[headerIdx].cells;
  const headSig = Array.from(headRow, clean).join("|");
  const rows = [], invalid = [];
  for (let k = headerIdx + 1; k < sheet.rows.length; k++){
    const r = sheet.rows[k];
    const get = key => cols[key] === undefined ? "" : clean(r.cells[cols[key]]);
    const rec = {ward:get("ward"), sn:get("sn"), name:get("name"), father:get("father"), epic:get("epic"),
                 caste:get("caste"), booth:get("booth"), age:get("age"), house:get("house"), gender:get("gender"), row:r.rn};
    if (!FIELDS.some(f => rec[f])) continue;                         // completely empty row
    if (Array.from(r.cells, clean).join("|") === headSig) continue; // repeated header line
    if (!rec.name){ invalid.push(r.rn); continue; }                  // has data but no voter name
    rows.push(rec);
  }
  const warnings = [];
  for (const f of FIELDS) if (cols[f] === undefined) warnings.push(`No column chosen for “${LABEL[f]}” — it will print blank. Use Column mapping below if your sheet has it.`);
  const blanks = {};
  for (const f of FIELDS) if (cols[f] !== undefined){ const n = rows.filter(r => !r[f]).length; if (n) blanks[f] = n; }
  const colNames = {};
  for (const k in cols) colNames[k] = clean(headRow[cols[k]]);
  return {fileName, sheet: sheet.name, headerRow: sheet.rows[headerIdx].rn, importedAt: new Date().toISOString(),
          colNames, warnings, blanks, invalid, rows};
}

/* ---------- phonetic key: English typing finds Hindi names ---------- */
const DV = {
  "अ":"a","आ":"a","इ":"i","ई":"i","उ":"u","ऊ":"u","ऋ":"ri","ए":"e","ऐ":"e","ओ":"o","औ":"o","ऑ":"o","ऍ":"e",
  "ा":"a","ि":"i","ी":"i","ु":"u","ू":"u","ृ":"ri","े":"e","ै":"e","ो":"o","ौ":"o","ॉ":"o","ॅ":"e",
  "क":"k","ख":"kh","ग":"g","घ":"gh","ङ":"n","च":"c","छ":"ch","ज":"j","झ":"jh","ञ":"n",
  "ट":"t","ठ":"th","ड":"d","ढ":"dh","ण":"n","त":"t","थ":"th","द":"d","ध":"dh","न":"n",
  "प":"p","फ":"ph","ब":"b","भ":"bh","म":"m","य":"y","र":"r","ल":"l","ळ":"l","व":"v",
  "श":"s","ष":"s","स":"s","ह":"h","क़":"k","ख़":"kh","ग़":"g","ज़":"j","ड़":"r","ढ़":"rh","फ़":"f","य़":"y",
  "ं":"n","ँ":"n","ः":"h","्":"","़":"","ॐ":"om"
};
function devToLatin(s){
  let out = "";
  for (const ch of s.normalize("NFC")){
    if (ch === "़"){ // nukta after ड/ढ
      if (out.endsWith("dh")) out = out.slice(0,-2) + "rh"; else if (out.endsWith("d")) out = out.slice(0,-1) + "r";
      continue;
    }
    if (DV[ch] !== undefined) out += DV[ch];
    else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
    else out += " ";
  }
  return out;
}
function phon(s){
  let t = devToLatin(String(s)).toLowerCase().replace(/[^a-z ]/g, " ");
  t = t.replace(/ee|ii/g,"i").replace(/oo|uu/g,"u").replace(/ai|ei|ey/g,"e").replace(/au|ou|ow/g,"o")
       .replace(/w/g,"v").replace(/z/g,"j").replace(/q/g,"k").replace(/f/g,"p").replace(/x/g,"ks").replace(/ck/g,"k");
  t = t.replace(/([bcdfgjklmnpqrstvwxyz])h/g, "$1");
  t = t.replace(/ng/g,"n").replace(/a/g,"").replace(/([a-z])\1+/g,"$1");
  return t.replace(/\s+/g," ").trim();
}
