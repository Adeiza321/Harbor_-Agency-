// Bundles the recruiter dashboard with Preact (same API as React, ~120 KB smaller) so the app
// downloads and starts faster, especially on mobile data. Run with bun.
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
  entrypoints: ["build/main.jsx"], outdir: "build", naming: "app.js", minify: true, target: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "preact", setup(b) { b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (a) => (map[a.path] ? { path: map[a.path] } : undefined)); } }],
});
if (!r.success) { console.error(r.logs); process.exit(1); }
console.log("app.js (preact)", r.outputs[0].size, "bytes");
