// Blind-resume maker (src/redact.js): its own bundle, loaded only when a recruiter makes a blind
// resume, plus the files it needs at run time (PDF reader worker, OCR worker, OCR engine and the
// English OCR data). All served from this site (the page's security policy allows nothing else).
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const r = await Bun.build({ entrypoints: ["src/redact.js"], outdir: "build", naming: "redact.js", minify: true, target: "browser", format: "esm",
  define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { console.error(r.logs); process.exit(1); }
mkdirSync("assets/redact", { recursive: true });
const js = readFileSync("build/redact.js");
writeFileSync("assets/redact/redact.js", js);
const nm = "node_modules/";
const copies = [
  [nm + "pdfjs-dist/legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  [nm + "tesseract.js/dist/worker.min.js", "worker.min.js"],
  [nm + "tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"],
  [nm + "tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm.js"],
  [nm + "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "eng.traineddata.gz"],
];
for (const [from, to] of copies) copyFileSync(from, "assets/redact/" + to);
const ver = createHash("sha256").update(js).digest("hex").slice(0, 10);
writeFileSync("build/redact-ver.txt", ver);
console.log("redact.js", js.length, "bytes, v" + ver);
