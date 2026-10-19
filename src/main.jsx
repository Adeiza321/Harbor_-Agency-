import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app.jsx";
// The app is bundled with Preact, which writes `autofocus` as an attribute instead of focusing the
// field like React does. Browsers only honour that attribute on page load, so focus newly added
// autofocus fields here (search boxes, dialogs, the quick-search palette).
new MutationObserver((list) => {
  for (const m of list) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    const el = n.hasAttribute("autofocus") ? n : n.querySelector("[autofocus]");
    if (el && document.activeElement !== el) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } return; }
  }
}).observe(document.getElementById("root"), { childList: true, subtree: true });
createRoot(document.getElementById("root")).render(<App />);
