// Bundles the public pages with Preact (a 10 KB stand-in for React with the same API) instead of
// React, so the jobs board, job pages and candidate page download far less. Run with bun.
import { resolve } from "node:path";
const nm = (p) => resolve("node_modules", p);
const map = {
  "react": nm("preact/compat/dist/compat.module.js"),
  "react-dom": nm("preact/compat/dist/compat.module.js"),
  "react-dom/client": nm("preact/compat/client.mjs"),
  "react/jsx-runtime": nm("preact/jsx-runtime/dist/jsxRuntime.module.js"),
  "react/jsx-dev-runtime": nm("preact/jsx-runtime/dist/jsxRuntime.module.js"),
};
const r = await Bun.build({
  entrypoints: ["build/public.jsx"], outdir: "build", naming: "public.js", minify: true, target: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "preact", setup(b) { b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (a) => (map[a.path] ? { path: map[a.path] } : undefined)); } }],
});
if (!r.success) { console.error(r.logs); process.exit(1); }
console.log("public.js (preact)", r.outputs[0].size, "bytes");
