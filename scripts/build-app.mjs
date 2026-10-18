// Builds the app for GitHub Pages:
//   assets/style-<hash>.css   Tailwind, generated from the classes used in app.jsx (no in-browser builder)
//   assets/app-<hash>.js      the recruiter dashboard
//   assets/public-<hash>.js   the public pages only (jobs board, job page, apply/refer, candidate page,
//                             outreach and client links), on Preact - much smaller, for people arriving from email or Google
//   index.html / 404.html     a small page that loads the CSS and the right bundle for the address
// File names change whenever their content does, so browsers can keep them and never get a stale copy.
// Run from the repo root: node scripts/build-app.mjs   (needs bun and the dev dependencies)
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, copyFileSync } from "node:fs";

const sh = (c) => execSync(c, { stdio: "inherit" });
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

mkdirSync("build", { recursive: true });
mkdirSync("assets", { recursive: true });
// app.jsx imports icons as "lucide-react"; they come from react-icons through a small shim.
writeFileSync("build/app.jsx", readFileSync("app.jsx", "utf8").replace('from "lucide-react";', 'from "./lucide-shim.js";'));
for (const f of ["main.jsx", "public.jsx", "lucide-shim.js"]) copyFileSync("src/" + f, "build/" + f);

sh("npx tailwindcss -c tailwind.config.cjs -i src/styles.css -o build/style.css --minify");
const bun = (entry, out) => sh(`bun build build/${entry} --minify --target=browser --format=iife --define 'process.env.NODE_ENV="production"' --outfile=build/${out}`);
bun("main.jsx", "app.js");
// Public pages: Preact instead of React (see bundle-public.mjs).
sh("bun scripts/bundle-public.mjs");

// Fresh hashed copies; old ones removed so the folder doesn't grow.
for (const f of readdirSync("assets")) if (/^(style|app|public)-[0-9a-f]{10}\.(css|js)$/.test(f)) rmSync("assets/" + f);
const out = {};
for (const [name, ext] of [["style", "css"], ["app", "js"], ["public", "js"]]) {
  const buf = readFileSync(`build/${name === "style" ? "style.css" : name + ".js"}`);
  out[name] = `/assets/${name}-${hash(buf)}.${ext}`;
  writeFileSync("." + out[name], buf);
}

// The page itself: styles first, then whichever bundle this address needs (decided before anything downloads).
const pick = `(function(){var l=location,q=new URLSearchParams(l.search),p=/^\\/(jobs|careers)(\\/|$)/.test(l.pathname)||["apply","jobs","careers","u","t","c"].some(function(k){return q.has(k)});var s=document.createElement("script");s.src=p?"${out.public}":"${out.app}";document.head.appendChild(s)})();`;
// Content-Security-Policy: the browser only runs this site's own scripts (plus the one-line
// loader above, allowed by its hash) and only talks to this site and Supabase. If someone ever
// slipped a script into a page, it couldn't run or send a signed-in session anywhere.
const SB = "https://acjmsihvvupqiikxckho.supabase.co";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${createHash("sha256").update(pick).digest("base64")}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // open.er-api.com: today's exchange rates for the Team audit's currency conversion.
  `connect-src 'self' ${SB} ${SB.replace("https://", "wss://")} https://open.er-api.com`,
  `frame-src 'self' blob: ${SB}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
// Until the scripts arrive, the page shows only the ProNext mark on the app's background (inline, so
// it needs nothing else to load). Job pages also carry a plain copy of the job for search engines
// (.pnx-seo, added by build-job-pages.mjs): hidden here, shown only when JavaScript is off.
const boot = "body{background:#F3EFE7}.pnx-boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#F3EFE7}.pnx-boot img{animation:pnx-boot 1s ease-in-out infinite alternate}@keyframes pnx-boot{from{opacity:.3;transform:scale(.92)}to{opacity:1;transform:scale(1)}}@media (prefers-reduced-motion:reduce){.pnx-boot img{animation:none}}.pnx-seo{display:none}";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>ProNext</title>
<link rel="icon" type="image/png" href="/assets/icon.png">
<link rel="preload" as="image" href="/assets/logo.png">
<link rel="preconnect" href="https://acjmsihvvupqiikxckho.supabase.co" crossorigin>
<link rel="stylesheet" href="${out.style}">
<style>${boot}</style>
<noscript><style>.pnx-boot{display:none}.pnx-seo{display:block}</style></noscript>
<script>${pick}</script>
</head>
<body><div id="root"><div class="pnx-boot" aria-hidden="true"><img src="/assets/mark.png" alt="" width="40" height="40"></div></div></body></html>
`;
writeFileSync("index.html", html);
writeFileSync("404.html", html);
console.log("built", out, "index.html", html.length, "bytes");
