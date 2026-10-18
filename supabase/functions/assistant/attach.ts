import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import * as XLSX from "npm:xlsx@0.18.5";

// Files and voice notes for the assistant, turned into text ONCE when they're added, so the chat
// keeps the text and the assistant can keep referring to it on later turns without re-reading the file.
//   voice notes / audio  -> Gemini transcribes (the page sends 16 kHz mono WAV, see AssistantPanel)
//   PDF, images          -> Claude reads them (Haiku: full text, tables as markdown; images also described)
//   Word (.docx)         -> text from the document itself (paragraphs, tables)
//   Excel / CSV          -> each sheet as CSV
//   text, markdown, JSON -> as is
// Returns { kind, text, truncated }. Logs AI cost to ai_usage (feature 'assistant_files').

export const MAX_FILE_BYTES = 9 * 1024 * 1024;
const MAX_TEXT = 120000;
const READ_MODEL = Deno.env.get("ASSISTANT_FILE_MODEL") || "claude-haiku-5-5";
const GEMINI_MODELS = [...new Set([Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Attached = { kind: "voice" | "pdf" | "image" | "word" | "sheet" | "text"; text: string; truncated: boolean; costUsd: number; model?: string };

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const cut = (t: string) => ({ text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t, truncated: t.length > MAX_TEXT });

function kindOf(name: string, mime: string): Attached["kind"] | "" {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  if (mime.startsWith("audio/") || ["wav", "mp3", "m4a", "ogg", "opus", "aac", "flac", "webm"].includes(ext)) return "voice";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (/^image\/(png|jpe?g|gif|webp)$/.test(mime) || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (ext === "docx") return "word";
  if (["xlsx", "xls", "csv", "tsv", "ods"].includes(ext)) return "sheet";
  if (mime.startsWith("text/") || ["txt", "md", "json", "html", "htm", "rtf", "xml"].includes(ext)) return "text";
  return "";
}

async function claudeRead(key: string, block: any, ask: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: READ_MODEL, max_tokens: 16000, messages: [{ role: "user", content: [block, { type: "text", text: ask }] }] }),
    });
    if (res.ok) {
      const j = await res.json();
      const text = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      const it = Number(j.usage?.input_tokens) || 0, ot = Number(j.usage?.output_tokens) || 0;
      const [pi, po] = it > 100000 ? [0.5, 2.5] : [0.1, 0.5];
      return { text, costUsd: (it * pi + ot * po) / 1e6, model: READ_MODEL };
    }
    const t = (await res.text()).slice(0, 300);
    if (![429, 500, 502, 503, 529].includes(res.status)) throw new Error(/credit balance/i.test(t) ? "The Claude account is out of credit." : "Couldn't read the file (" + res.status + "): " + t.slice(0, 160));
    await sleep(attempt ? 5000 : 2000);
  }
  throw new Error("Claude is busy right now. Try the file again in a minute.");
}

async function transcribe(key: string, b64: string, mime: string) {
  const payload = JSON.stringify({
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: b64 } },
      { text: "Transcribe this voice note word for word, in the language it is spoken in. Add punctuation and paragraph breaks. Output only the transcript, nothing else. If nothing is said, output: (no speech)" }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 16000 },
  });
  let last = "";
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: payload });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = (j.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("").trim();
        if (text) {
          const it = Number(j.usageMetadata?.promptTokenCount) || 0, ot = Number(j.usageMetadata?.candidatesTokenCount) || 0;
          return { text, costUsd: (it * 0.5 + ot * 2.5) / 1e6, model };
        }
        last = "No transcript came back"; break;
      }
      last = "Transcription failed (" + res.status + "): " + String(j?.error?.message || "").slice(0, 200);
      if (res.status === 404) break;
      if (res.status === 429 && /quota/i.test(String(j?.error?.message || ""))) throw new Error("Gemini's quota is used up, so voice notes can't be transcribed right now.");
      if (![429, 500, 503].includes(res.status)) throw new Error(last);
      await sleep(attempt ? 3000 : 1500);
    }
  }
  throw new Error(last || "Couldn't transcribe the voice note. Try again.");
}

// Word: the document's own XML, paragraphs on their own lines and table cells separated by " | ".
function docxText(bytes: Uint8Array) {
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : "";
  if (!xml) throw new Error("This doesn't look like a Word document (.docx).");
  const t = xml
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, " | ").replace(/<\/w:tr>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return t.split("\n").map((l) => l.replace(/\s*\|\s*$/, "").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sheetText(bytes: Uint8Array, name: string) {
  const wb = XLSX.read(bytes, { type: "array", raw: false, codepage: 65001 });
  return wb.SheetNames.map((sn: string) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false }).trim();
    return wb.SheetNames.length > 1 || !/\.(csv|tsv)$/i.test(name) ? `Sheet "${sn}":\n${csv}` : csv;
  }).join("\n\n");
}

export async function readAttachment(o: { name: string; mime: string; data: string; anthropicKey: string }): Promise<Attached> {
  const name = String(o.name || "file").slice(0, 200), mime = String(o.mime || "").toLowerCase();
  const kind = kindOf(name, mime);
  if (!kind) throw new Error("ProNext can read PDFs, Word (.docx), Excel and CSV files, text files, images and voice notes. Older .doc files: save as .docx first.");
  const bytes = b64ToBytes(o.data);
  if (!bytes.length) throw new Error("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("That file is too big (the limit is 9 MB).");
  if (kind === "voice") {
    const g = Deno.env.get("GEMINI_API_KEY");
    if (!g) throw new Error("Voice notes need Gemini (GEMINI_API_KEY isn't set).");
    const r = await transcribe(g, o.data, mime.startsWith("audio/") ? mime.split(";")[0] : "audio/wav");
    return { kind, ...cut(r.text), costUsd: r.costUsd, model: r.model };
  }
  if (kind === "pdf") {
    const r = await claudeRead(o.anthropicKey, { type: "document", source: { type: "base64", media_type: "application/pdf", data: o.data } },
      "Write out the full text of this document faithfully, in reading order. Keep headings, bullet lists and numbering; write tables as markdown tables. Don't summarise, comment or add anything. If a page is a scan, transcribe what's on it.");
    return { kind, ...cut(r.text), costUsd: r.costUsd, model: r.model };
  }
  if (kind === "image") {
    const media = /png/.test(mime) || /\.png$/i.test(name) ? "image/png" : /gif/.test(mime) ? "image/gif" : /webp/.test(mime) ? "image/webp" : "image/jpeg";
    const r = await claudeRead(o.anthropicKey, { type: "image", source: { type: "base64", media_type: media, data: o.data } },
      "First write out all the text in this image exactly as it appears (tables as markdown). Then, under 'What the image shows:', describe in a few lines anything else that matters (what kind of screen or document it is, charts, logos, people's roles). No other commentary.");
    return { kind, ...cut(r.text), costUsd: r.costUsd, model: r.model };
  }
  if (kind === "word") return { kind, ...cut(docxText(bytes)), costUsd: 0 };
  if (kind === "sheet") return { kind, ...cut(sheetText(bytes, name)), costUsd: 0 };
  return { kind, ...cut(new TextDecoder("utf-8").decode(bytes)), costUsd: 0 };
}
