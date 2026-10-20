// Blind resume maker, loaded on demand (assets/redact/redact.js) only when a recruiter creates a
// blind resume. It runs in the recruiter's browser: the candidate's own CV is drawn page by page
// (an ES module: load it with <script type="module">). (PDF as is; Word laid out like the document; photos/scans read with OCR), then every word or
// phrase to hide is covered with a solid black box. The result is a set of page IMAGES: no text
// layer, so nothing can be copied or un-redacted from them.
//   const doc = await PNRedact.prepare(fileBlob, fileName)   -> { kind, text, pages }
//   const out = await doc.render(terms, onProgress)          -> { pages: [Blob], boxes }
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderAsync } from "docx-preview";
import html2canvas from "html2canvas-pro";
import { createWorker } from "tesseract.js";

const BASE = "/assets/redact/";
pdfjs.GlobalWorkerOptions.workerSrc = BASE + "pdf.worker.min.mjs";
const SCALE = 2;
const mctx = (typeof document !== "undefined" ? document.createElement("canvas") : null)?.getContext("2d");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Always hidden, whatever the CV says: emails, links and handles, phone numbers, street addresses, postcodes.
const GENERIC = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\b(?:linkedin|github|gitlab|behance|dribbble|twitter|x|facebook|instagram|medium)\.com\/\S*/gi,
  /\b\d{1,5}\s+(?:[A-Za-z0-9'.-]+\s){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Close|Crescent|Place|Pl|Terrace|Highway|Hwy|Parkway|Pkwy)\b\.?/gi,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/g,
];
const PHONE = /\+?\(?\d[\d\s().\-–]{7,}\d/g;

function patterns(terms) {
  const out = [];
  for (const t of terms || []) {
    const s = String(t || "").trim();
    if (s.length < 2) continue;
    const words = s.split(/\s+/).map(esc);
    const edgeA = /^\w/.test(s) ? "\\b" : "", edgeB = /\w$/.test(s) ? "\\b" : "";
    out.push(new RegExp(edgeA + words.join("[\\s,.-]*") + edgeB, "gi"));
  }
  return out;
}
// Character ranges [start, end) in text to cover.
function ranges(text, pats) {
  const r = [];
  for (const p of [...GENERIC, ...pats]) { p.lastIndex = 0; let m; while ((m = p.exec(text))) { if (m[0].length) r.push([m.index, m.index + m[0].length]); if (!p.global) break; } }
  PHONE.lastIndex = 0; let m;
  while ((m = PHONE.exec(text))) { if ((m[0].match(/\d/g) || []).length >= 9) r.push([m.index, m.index + m[0].length]); }
  r.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const x of r) { const last = merged[merged.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else merged.push([...x]); }
  return merged;
}
const toBlob = (canvas) => new Promise((ok) => canvas.toBlob((b) => ok(b), "image/webp", 0.86));
const box = (ctx, x0, y0, x1, y1, pad = 3) => { ctx.fillStyle = "#000"; ctx.fillRect(Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.abs(x1 - x0) + pad * 2, Math.abs(y1 - y0) + pad * 2); };

// ---- OCR (scans, photos, PDFs without text)
let ocr = null;
async function ocrWords(canvas) {
  if (!ocr) ocr = await createWorker("eng", 1, { workerPath: BASE + "worker.min.js", corePath: BASE, langPath: BASE, gzip: true, workerBlobURL: false });
  const { data } = await ocr.recognize(canvas, {}, { blocks: true, text: true });
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push({ text: w.text, bbox: w.bbox });
  if (!words.length && Array.isArray(data.words)) for (const w of data.words) words.push({ text: w.text, bbox: w.bbox });
  return words;
}
function wordsText(words) {
  let text = ""; const spans = [];
  for (const w of words) { const s = text.length; text += w.text + " "; spans.push([s, s + w.text.length]); }
  return { text, spans };
}
function boxWords(ctx, words, spans, rs) {
  let n = 0;
  for (const [a, b] of rs) words.forEach((w, i) => { const [s, e] = spans[i]; if (e > a && s < b) { box(ctx, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1); n++; } });
  return n;
}

// ---- PDF
async function preparePdf(data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  let all = "";
  for (let i = 1; i <= Math.min(doc.numPages, 12); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => typeof it.str === "string");
    let text = ""; const spans = [];
    for (const it of items) { const s = text.length; text += it.str; spans.push([s, text.length]); text += it.hasEOL ? "\n" : " "; }
    const scanned = text.replace(/\s/g, "").length < 25;
    pages.push({ page, items, text, spans, scanned, styles: tc.styles || {} });
    all += text + "\n";
  }
  return { kind: "pdf", pages, text: all, numPages: doc.numPages };
}
async function renderPdfPage(p, pats, extraWords) {
  const viewport = p.page.getViewport({ scale: SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.page.render({ canvasContext: ctx, viewport }).promise;
  let boxes = 0;
  if (p.scanned) {
    const words = p.ocr || (p.ocr = await ocrWords(canvas));
    const { text, spans } = wordsText(words);
    boxes += boxWords(ctx, words, spans, ranges(text, pats));
  } else {
    for (const [a, b] of ranges(p.text, pats)) {
      p.items.forEach((it, i) => {
        const [s, e] = p.spans[i]; if (!(e > a && s < b) || !it.str.length) return;
        const tx = pdfjs.Util.transform(viewport.transform, it.transform);
        const h = Math.hypot(tx[2], tx[3]) || 10 * SCALE;
        const w = (it.width || 0) * SCALE;
        // Where the words sit inside the line: measured in the line's own font, not counted by letters.
        const fam = (p.styles[it.fontName] || {}).fontFamily || "sans-serif";
        mctx.font = h + "px " + fam;
        const full = mctx.measureText(it.str).width || 1;
        const from = mctx.measureText(it.str.slice(0, Math.max(0, a - s))).width / full;
        const to = mctx.measureText(it.str.slice(0, Math.min(it.str.length, b - s))).width / full;
        box(ctx, tx[4] + w * from - h * 0.12, tx[5] - h, tx[4] + w * to + h * 0.12, tx[5] + h * 0.28);
        boxes++;
      });
    }
  }
  // Pictures on the page (a photo, a company logo): covered too, unless one fills most of the page (a background).
  try {
    const ops = await p.page.getOperatorList();
    const O = pdfjs.OPS; let ctm = viewport.transform.slice(); const stack = [];
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k], args = ops.argsArray[k];
      if (fn === O.save) stack.push(ctm.slice());
      else if (fn === O.restore) ctm = stack.pop() || ctm;
      else if (fn === O.transform) ctm = pdfjs.Util.transform(ctm, args);
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const area = ((x1 - x0) * (y1 - y0)) / (canvas.width * canvas.height);
        if (area > 0.0008 && area < 0.35) { box(ctx, x0, y0, x1, y1, 0); boxes++; }
      }
    }
  } catch (e) { /* drawing still covers the text */ }
  return { blob: await toBlob(canvas), boxes };
}

// ---- Word (.docx): laid out like the document, covered in place, then drawn to images.
async function prepareDocx(data) {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:1000px;background:#fff;z-index:-1";
  document.body.appendChild(host);
  await renderAsync(data, host, host, { inWrapper: false, breakPages: true, renderHeaders: true, renderFooters: true, useBase64URL: true, ignoreLastRenderedPageBreak: false });
  const text = host.innerText || host.textContent || "";
  return { kind: "docx", host, text };
}
function coverDomText(root, pats) {
  const nodes = []; const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "", n, lastBlock = null;
  const blockOf = (el) => (el && el.closest ? el.closest("p,li,td,th,h1,h2,h3,h4,h5,h6,div,section,tr,header,footer") : null);
  while ((n = walk.nextNode())) {
    if (!n.nodeValue || (n.parentElement && /^(STYLE|SCRIPT)$/.test(n.parentElement.tagName))) continue;
    // A line break between paragraphs, so a word at the end of one and the start of the next don't run together.
    const blk = blockOf(n.parentElement); if (lastBlock && blk !== lastBlock) text += "\n"; lastBlock = blk;
    nodes.push({ n, s: text.length }); text += n.nodeValue;
  }
  let count = 0;
  const rs = ranges(text, pats);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { n: node, s } = nodes[i]; const e = s + node.nodeValue.length;
    const hits = rs.filter(([a, b]) => b > s && a < e).map(([a, b]) => [Math.max(a, s) - s, Math.min(b, e) - s]).sort((x, y) => y[0] - x[0]);
    for (const [a, b] of hits) {
      const after = node.splitText(b); const mid = node.splitText(a);
      const span = document.createElement("span");
      span.style.cssText = "background:#000;color:#000;border-radius:1px;box-decoration-break:clone;-webkit-box-decoration-break:clone";
      span.textContent = mid.nodeValue; mid.replaceWith(span); count++;
      void after;
    }
  }
  return count;
}
async function renderDocx(d, pats, onProgress) {
  const clone = d.host.cloneNode(true);
  clone.style.cssText = d.host.style.cssText;
  document.body.appendChild(clone);
  let boxes = coverDomText(clone, pats);
  for (const img of clone.querySelectorAll("img, svg, canvas")) {
    const r = img.getBoundingClientRect();
    const blk = document.createElement("div");
    blk.style.cssText = `display:inline-block;width:${r.width || img.width || 80}px;height:${r.height || img.height || 80}px;background:#000`;
    img.replaceWith(blk); boxes++;
  }
  const sections = clone.querySelectorAll("section.docx");
  const list = sections.length ? [...sections] : [clone];
  const out = [];
  for (let i = 0; i < Math.min(list.length, 12); i++) {
    onProgress && onProgress(i + 1, list.length);
    const canvas = await html2canvas(list[i], { scale: SCALE, backgroundColor: "#ffffff", logging: false });
    out.push(await toBlob(canvas));
  }
  clone.remove();
  return { pages: out, boxes };
}

// ---- Pictures (photo or scan of a CV)
async function prepareImage(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const words = await ocrWords(canvas);
  return { kind: "image", canvas, words, text: words.map((w) => w.text).join(" ") };
}
async function renderImage(d, pats) {
  const canvas = document.createElement("canvas");
  canvas.width = d.canvas.width; canvas.height = d.canvas.height;
  const ctx = canvas.getContext("2d"); ctx.drawImage(d.canvas, 0, 0);
  const { text, spans } = wordsText(d.words);
  const boxes = boxWords(ctx, d.words, spans, ranges(text, pats));
  return { pages: [await toBlob(canvas)], boxes };
}

async function prepare(blob, name) {
  const type = (blob.type || "").toLowerCase(), ext = String(name || "").toLowerCase().split(".").pop();
  const data = new Uint8Array(await blob.arrayBuffer());
  let d;
  if (type.includes("pdf") || ext === "pdf") d = await preparePdf(data);
  else if (type.includes("wordprocessingml") || ext === "docx") d = await prepareDocx(blob);
  else if (type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) d = await prepareImage(blob);
  else throw new Error("This CV is a ." + (ext || "unknown") + " file. Blind resumes work from PDF, Word (.docx) or a picture of the CV.");
  // Scanned PDF pages: read them now so the text (for spotting employers) includes them.
  if (d.kind === "pdf") for (const p of d.pages) if (p.scanned) {
    const vp = p.page.getViewport({ scale: SCALE }); const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    await p.page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    p.ocr = await ocrWords(c); d.text += p.ocr.map((w) => w.text).join(" ") + "\n";
  }
  // Safety net for the name: most CVs open with it as the biggest line (or the first line).
  const looksLikeName = (t) => /^[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){1,3}$/u.test(String(t || "").trim()) && String(t).trim().length <= 48;
  let nameGuess = "";
  if (d.kind === "pdf" && d.pages[0] && !d.pages[0].scanned) {
    const its = d.pages[0].items.filter((it) => it.str.trim()).slice(0, 12);
    const big = its.slice().sort((a, b) => Math.hypot(b.transform[2], b.transform[3]) - Math.hypot(a.transform[2], a.transform[3]))[0];
    if (big && looksLikeName(big.str)) nameGuess = big.str.trim();
  }
  if (!nameGuess) { const firstLine = String(d.text || "").split(/\n/).map((x) => x.trim()).find(Boolean); if (looksLikeName(firstLine)) nameGuess = firstLine; }
  return {
    nameGuess,
    kind: d.kind, text: d.text, ocr: d.kind === "image" || (d.kind === "pdf" && d.pages.some((p) => p.scanned)),
    async render(terms, onProgress) {
      const pats = patterns(terms);
      if (d.kind === "pdf") {
        const pages = []; let boxes = 0;
        for (let i = 0; i < d.pages.length; i++) { onProgress && onProgress(i + 1, d.pages.length); const r = await renderPdfPage(d.pages[i], pats); pages.push(r.blob); boxes += r.boxes; }
        return { pages, boxes };
      }
      if (d.kind === "docx") return renderDocx(d, pats, onProgress);
      return renderImage(d, pats);
    },
    dispose() { if (d.host) d.host.remove(); },
  };
}

window.PNRedact = { prepare };
