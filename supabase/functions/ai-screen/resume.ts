// Turns a stored resume file into something the AI can read.
//
//   PDF              -> sent as a document (the AI reads layout and text)
//   JPG/PNG/WEBP/HEIC -> sent as an image (photos and scans of a resume)
//   DOCX, ODT        -> text pulled from the document XML
//   DOC (old Word)   -> best-effort text recovery from the binary file
//   RTF, TXT, MD     -> plain text
//
// No external packages: .docx/.odt are zip files, unpacked with the runtime's
// built-in DecompressionStream.

export type ResumeInput =
  | { kind: "pdf"; data: string }                  // base64
  | { kind: "image"; data: string; mime: string }  // base64
  | { kind: "text"; text: string };

export const RESUME_EXTENSIONS = ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "jpg", "jpeg", "png", "webp", "heic", "heif"];

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
};

const MAX_TEXT = 60000;

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// Work out the real format from the file's first bytes, falling back to its extension.
export function detectFormat(bytes: Uint8Array, name: string): string {
  const b = bytes;
  const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] || "").toLowerCase();
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "pdf";                                   // %PDF
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return ext === "heif" ? "heif" : "heic"; // ....ftyp
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "doc";           // old Office binary
  if (starts(0x7b, 0x5c, 0x72, 0x74, 0x66)) return "rtf";                             // {\rtf
  if (starts(0x50, 0x4b, 0x03, 0x04)) return ext === "odt" ? "odt" : "docx";          // zip
  return ext || "txt";
}

// ---- zip (for .docx / .odt) ----
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(zip: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Find the end-of-central-directory record.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = zip.subarray(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXmlEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

const tidy = (s: string) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

async function docxText(bytes: Uint8Array): Promise<string> {
  const parts: string[] = [];
  for (const entry of ["word/document.xml", "word/header1.xml", "word/header2.xml", "word/footer1.xml"]) {
    const xml = await readZipEntry(bytes, entry);
    if (!xml) continue;
    const s = new TextDecoder().decode(xml)
      .replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, "");
    parts.push(decodeXmlEntities(s));
  }
  return tidy(parts.join("\n"));
}

async function odtText(bytes: Uint8Array): Promise<string> {
  const xml = await readZipEntry(bytes, "content.xml");
  if (!xml) return "";
  const s = new TextDecoder().decode(xml)
    .replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, c) => " ".repeat(Number(c) || 1))
    .replace(/<\/text:(p|h)>/g, "\n").replace(/<[^>]+>/g, "");
  return tidy(decodeXmlEntities(s));
}

// RTF: walk the groups, skipping destinations that aren't body text.
const RTF_SKIP = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "listtable", "listoverridetable", "rsidtbl",
  "generator", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "mmathPr", "pgdsctbl", "header",
  "footer", "headerl", "headerr", "footerl", "footerr", "object", "objdata", "fldinst", "bkmkstart", "bkmkend", "revtbl", "filetbl", "shppict", "nonshppict"]);

function rtfText(raw: string): string {
  let out = "";
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false, uc = 1, pendingSkipChars = 0, groupStart = false;
  let i = 0;
  const emit = (t: string) => {
    if (pendingSkipChars > 0) { const n = Math.min(pendingSkipChars, t.length); pendingSkipChars -= n; t = t.slice(n); }
    if (!skip) out += t;
  };
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "{") { stack.push({ skip, uc }); groupStart = true; i++; continue; }
    if (ch === "}") { const st = stack.pop(); if (st) { skip = st.skip; uc = st.uc; } groupStart = false; i++; continue; }
    if (ch === "\\") {
      const nx = raw[i + 1];
      if (nx === "*") { if (groupStart) skip = true; i += 2; continue; }
      if (nx === "'") { emit(String.fromCharCode(parseInt(raw.substr(i + 2, 2), 16))); i += 4; groupStart = false; continue; }
      if (nx === "\\" || nx === "{" || nx === "}") { emit(nx); i += 2; groupStart = false; continue; }
      if (nx === "\n" || nx === "\r") { emit("\n"); i += 2; continue; }
      if (nx === "~") { emit(" "); i += 2; continue; }
      if (nx === "-" || nx === "_") { emit(nx === "_" ? "-" : ""); i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(raw.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      const word = m[1], arg = m[2];
      i += m[0].length;
      if (groupStart && RTF_SKIP.has(word)) skip = true;
      groupStart = false;
      if (word === "par" || word === "line" || word === "row" || word === "sect" || word === "page") emit("\n");
      else if (word === "tab" || word === "cell") emit("\t");
      else if (word === "uc") uc = Number(arg) || 0;
      else if (word === "u") { const n = Number(arg); emit(String.fromCharCode(n < 0 ? n + 65536 : n)); pendingSkipChars = uc; }
      else if (word === "emdash") emit("—"); else if (word === "endash") emit("–"); else if (word === "bullet") emit("•");
      else if (word === "lquote" || word === "rquote") emit("'"); else if (word === "ldblquote" || word === "rdblquote") emit('"');
      continue;
    }
    groupStart = false;
    if (ch !== "\r" && ch !== "\n") emit(ch);
    i++;
  }
  return tidy(out);
}

// ---- old binary Word (.doc): OLE compound file + Word piece table ----
function cfbStreams(b: Uint8Array): ((name: string) => Uint8Array | null) | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const secSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const cutoff = dv.getUint32(0x38, true);
  const sec = (n: number) => b.subarray((n + 1) * secSize, (n + 2) * secSize);
  const fatSecs: number[] = [];
  for (let i = 0; i < 109; i++) { const v = dv.getUint32(0x4c + i * 4, true); if (v < 0xfffffffa) fatSecs.push(v); }
  let difat = dv.getUint32(0x44, true), guard = 0;
  while (difat < 0xfffffffa && guard++ < 1000) {
    const s = sec(difat); const d = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < secSize / 4 - 1; i++) { const v = d.getUint32(i * 4, true); if (v < 0xfffffffa) fatSecs.push(v); }
    difat = d.getUint32(secSize - 4, true);
  }
  const fat: number[] = [];
  for (const f of fatSecs) { const s = sec(f); const d = new DataView(s.buffer, s.byteOffset, s.byteLength); for (let i = 0; i + 4 <= s.length; i += 4) fat.push(d.getUint32(i, true)); }
  const chain = (start: number, table: number[]) => { const out: number[] = []; let c = start; while (c < 0xfffffffa && c < table.length && out.length < 1e6) { out.push(c); c = table[c]; } return out; };
  const readBig = (start: number, size: number) => {
    const cs = chain(start, fat); const out = new Uint8Array(cs.length * secSize);
    cs.forEach((c, i) => out.set(sec(c), i * secSize)); return out.subarray(0, Math.min(size, out.length));
  };
  const dirBytes = readBig(dv.getUint32(0x30, true), Infinity);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries: { name: string; start: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = ddv.getUint16(o + 0x40, true);
    let name = ""; for (let k = 0; k < Math.max(0, nameLen - 2); k += 2) name += String.fromCharCode(ddv.getUint16(o + k, true));
    entries.push({ name, start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true) });
  }
  const root = entries[0];
  if (!root) return null;
  const miniStream = readBig(root.start, root.size);
  const miniFat: number[] = [];
  const mfStart = dv.getUint32(0x3c, true);
  if (mfStart < 0xfffffffa) { const mf = readBig(mfStart, Infinity); const d = new DataView(mf.buffer, mf.byteOffset, mf.byteLength); for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(d.getUint32(i, true)); }
  return (name: string) => {
    const e = entries.find((x) => x.name === name);
    if (!e) return null;
    if (e.size >= cutoff) return readBig(e.start, e.size);
    const c = chain(e.start, miniFat); const out = new Uint8Array(c.length * miniSize);
    c.forEach((m, i) => out.set(miniStream.subarray(m * miniSize, (m + 1) * miniSize), i * miniSize));
    return out.subarray(0, e.size);
  };
}

function docPieceText(bytes: Uint8Array): string {
  const get = cfbStreams(bytes);
  if (!get) return "";
  const wd = get("WordDocument");
  if (!wd || wd.length < 0x1aa) return "";
  const w = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  if (w.getUint16(0, true) !== 0xa5ec) return "";
  const table = get((w.getUint16(0x0a, true) & 0x0200) ? "1Table" : "0Table");
  if (!table) return "";
  const fcClx = w.getUint32(0x1a2, true), lcbClx = w.getUint32(0x1a6, true);
  const clx = table.subarray(fcClx, fcClx + lcbClx);
  const c = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);
  let p = 0;
  while (p < clx.length && clx[p] === 0x01) p += 3 + c.getInt16(p + 1, true);
  if (clx[p] !== 0x02) return "";
  const lcb = c.getUint32(p + 1, true); p += 5;
  const n = (lcb - 4) / 12;
  let text = "";
  for (let k = 0; k < n; k++) {
    const cpStart = c.getUint32(p + k * 4, true), cpEnd = c.getUint32(p + (k + 1) * 4, true);
    let fc = c.getUint32(p + (n + 1) * 4 + k * 8 + 2, true);
    const len = cpEnd - cpStart;
    if (fc & 0x40000000) { fc = (fc & ~0x40000000) / 2; for (let j = 0; j < len; j++) text += CP1252[wd[fc + j]] ?? String.fromCharCode(wd[fc + j]); }
    else { for (let j = 0; j < len; j++) text += String.fromCharCode(wd[fc + j * 2] | (wd[fc + j * 2 + 1] << 8)); }
  }
  // Keep field results, drop field codes; turn Word's control characters into whitespace.
  text = text.replace(/\x13[^\x13\x14\x15]*\x14/g, "").replace(/\x13[^\x13\x14\x15]*\x15/g, "").replace(/[\x14\x15]/g, "");
  return tidy(text.replace(/\r|\x0b|\x0c/g, "\n").replace(/\x07/g, "\t").replace(/[\x00-\x08\x0e-\x1f]/g, ""));
}

// Windows-1252 characters that differ from Latin-1 (smart quotes, dashes, bullets).
const CP1252: Record<number, string> = { 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x85: "…", 0x80: "€" };

// Fallback for .doc files the piece-table reader can't handle.
function docRuns(bytes: Uint8Array): string {
  const ok = (c: number) => (c >= 0x20 && c < 0x7f) || c === 0x0d || c === 0x09 || (c >= 0xa0 && c <= 0xff);
  const runs: string[] = [];
  let cur = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (ok(c) || (c >= 0x2013 && c <= 0x2022)) cur += String.fromCharCode(c); else { if (cur.length >= 20) runs.push(cur); cur = ""; }
  }
  return tidy(runs.filter((r) => (r.match(/ /g) || []).length >= 3).join("\n").replace(/\r/g, "\n"));
}

function docText(bytes: Uint8Array): string {
  let t = "";
  try { t = docPieceText(bytes); } catch { t = ""; }
  return t.replace(/\s/g, "").length >= 80 ? t : docRuns(bytes);
}

// Returns what to send to the AI, or a plain-English reason it can't be read.
// A LinkedIn profile URL in the file itself. A resume often shows just the word "LinkedIn" with
// the address hidden in the link, which the AI can't see, so the raw file is searched too:
// PDF link annotations, and the hyperlink list inside a .docx/.odt.
export function normalizeLinkedIn(v: unknown): string {
  const m = String(v ?? "").match(/linkedin\.com\/in\/([A-Za-z0-9\-_%.]{2,100})/i);
  return m ? "https://www.linkedin.com/in/" + m[1].replace(/[.\/]+$/, "") : "";
}
export async function findLinkedIn(bytes: Uint8Array, name: string): Promise<string> {
  try {
    const fmt = detectFormat(bytes, name);
    let hay = "";
    if (fmt === "docx" || fmt === "odt") {
      for (const e of ["word/_rels/document.xml.rels", "word/document.xml", "content.xml"]) {
        const x = await readZipEntry(bytes, e); if (x) hay += new TextDecoder().decode(x) + "\n";
      }
    } else hay = new TextDecoder("latin1").decode(bytes.length > 4_000_000 ? bytes.subarray(0, 4_000_000) : bytes);
    return normalizeLinkedIn(hay);
  } catch { return ""; }
}

export async function prepareResume(bytes: Uint8Array, name: string): Promise<{ input?: ResumeInput; why?: string }> {
  const fmt = detectFormat(bytes, name);
  if (fmt === "pdf") return { input: { kind: "pdf", data: bytesToBase64(bytes) } };
  if (IMAGE_MIME[fmt]) return { input: { kind: "image", data: bytesToBase64(bytes), mime: IMAGE_MIME[fmt] } };

  let text = "";
  try {
    if (fmt === "docx") text = await docxText(bytes);
    else if (fmt === "odt") text = await odtText(bytes);
    else if (fmt === "rtf") text = rtfText(new TextDecoder("latin1").decode(bytes));
    else if (fmt === "doc") text = docText(bytes);
    else if (fmt === "txt" || fmt === "md" || fmt === "text") text = tidy(new TextDecoder().decode(bytes));
    else return { why: "Couldn't open this resume file. Try saving it as PDF or DOCX and uploading again." };
  } catch {
    return { why: "Couldn't open this resume file. Try saving it as PDF or DOCX and uploading again." };
  }
  if (text.replace(/\s/g, "").length < 80)
    return { why: "Couldn't find readable text in this resume" + (fmt === "doc" ? " (old .doc format)" : "") + ". Save it as PDF or DOCX and upload again." };
  return { input: { kind: "text", text: text.slice(0, MAX_TEXT) } };
}
