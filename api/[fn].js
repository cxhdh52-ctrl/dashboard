// Vercel adapter.
//
// The backend lives in netlify/functions/*.js and uses the Netlify / AWS Lambda
// proxy signature: `exports.handler = async (event) => ({ statusCode, headers, body })`.
// Vercel Serverless Functions use `(req, res)` instead and only serve routes
// under /api. This single catch-all bridges the two WITHOUT touching any
// function body; vercel.json rewrites `/.netlify/functions/<fn>` -> `/api/<fn>`
// so the frontend's existing calls are unchanged.
//
// Netlify keeps working natively (netlify.toml), so the repo stays dual-platform.
//
// NOTE: the requires below are STATIC string literals so Vercel's bundler traces
// each function + its ./_shared/* dependencies. Do not switch to require(<var>).

const HANDLERS = {
  "glitchy-stats": () => require("../netlify/functions/glitchy-stats.js"),
  "mabac-stats": () => require("../netlify/functions/mabac-stats.js"),
  "daily-totals": () => require("../netlify/functions/daily-totals.js"),
  "tiktok-connections": () => require("../netlify/functions/tiktok-connections.js"),
  "tiktok-campaigns": () => require("../netlify/functions/tiktok-campaigns.js"),
  "tiktok-auth-start": () => require("../netlify/functions/tiktok-auth-start.js"),
  "tiktok-auth-callback": () => require("../netlify/functions/tiktok-auth-callback.js"),
  "wh-warmup": () => require("../netlify/functions/wh-warmup.js"),
  "cleanup": () => require("../netlify/functions/cleanup.js"),
  "comment-templates": () => require("../netlify/functions/comment-templates.js"),
  "campaign-creator": () => require("../netlify/functions/campaign-creator.js"),
  "campaign-creator-templates": () => require("../netlify/functions/campaign-creator-templates.js"),
  "campaign-creator-run": () => require("../netlify/functions/campaign-creator-run.js"),
  "tracker": () => require("../netlify/functions/tracker.js"),
  "tracker-run": () => require("../netlify/functions/tracker-run.js"),
  "creative-library": () => require("../netlify/functions/creative-library.js"),
};

module.exports = async (req, res) => {
  const fn = String((req.query && req.query.fn) || "").replace(/[^a-z0-9-]/gi, "");
  const load = HANDLERS[fn];
  if (!load) {
    res.status(404).json({ error: `Unknown function: ${fn || "(none)"}` });
    return;
  }

  let handler;
  try {
    ({ handler } = load());
    if (typeof handler !== "function") throw new Error("no exported handler");
  } catch (err) {
    res.status(500).json({ error: "Function failed to load", details: err.message });
    return;
  }

  // ---- Vercel request -> Netlify-style event ----
  const query = { ...(req.query || {}) };
  delete query.fn; // our routing param, not part of the real query string

  let rawBody = "";
  const b = req.body;
  if (b !== undefined && b !== null && b !== "") {
    rawBody = typeof b === "string" ? b : Buffer.isBuffer(b) ? b.toString("utf8") : JSON.stringify(b);
  }

  const event = {
    httpMethod: req.method || "GET",
    headers: req.headers || {},
    queryStringParameters: query,
    body: rawBody,
    path: String(req.url || "").split("?")[0],
    isBase64Encoded: false,
  };

  let result;
  try {
    result = await handler(event, {});
  } catch (err) {
    res.status(500).json({ error: "Function crashed", message: err.message });
    return;
  }

  // ---- Netlify-style result -> Vercel response ----
  const { statusCode = 200, headers = {}, body = "" } = result || {};
  const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  // The bare-return functions (glitchy-stats / daily-totals / mabac-stats) send a
  // JSON string with no Content-Type — label it so it is unambiguous.
  if (!lower.has("content-type") && !lower.has("location")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.status(statusCode).send(body);
};
