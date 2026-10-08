// Tailwind is built ahead of time (scripts/build-app.mjs) instead of in the browser.
module.exports = {
  content: ["./app.jsx", "./scripts/build-job-pages.mjs"],
  theme: { extend: {} },
  plugins: [],
};
