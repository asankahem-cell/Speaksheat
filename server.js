// Speaksheet server: serves the page and asks Claude for motion prep and themes.
// Two ways to pay for Claude:
//  - ANTHROPIC_API_KEY set: the site owner's key pays, guarded by ACCESS_CODE.
//  - ANTHROPIC_API_KEY blank: each visitor pastes their own key in the page and pays
//    for their own requests. Their key is used for that one request and never stored or logged.
import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT) || 30; // Claude requests per visitor per hour
const MAX_MOTION = 600;
// Effort and server-side fallbacks only exist on newer models; skip them otherwise.
const HAS_EFFORT = !/haiku|sonnet-4-5/.test(MODEL);
const HAS_FALLBACK = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"].includes(MODEL);

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const PAGE = await readFile(new URL("./public/index.html", import.meta.url));

/* Same formats and themes as the page. The prompts are built here, so the
   server only ever asks Claude about debate motions, never arbitrary text. */
const FORMATS = {
  ap: { name: "Asian Parliamentary, 3 on 3", sides: ["Government", "Opposition"] },
  wsdc: { name: "World Schools, 3 on 3", sides: ["Proposition", "Opposition"] },
  bp: { name: "British Parliamentary, 2 on 2", sides: ["Opening Gov", "Opening Opp", "Closing Gov", "Closing Opp"] },
  other: { name: "Other format", sides: ["Government", "Opposition"] },
};
const TAGS = ["Economics", "International relations", "Politics", "Law and justice", "Gender", "Education", "Environment",
  "Science and technology", "Media", "Development", "Health", "Religion", "Philosophy", "Social movements",
  "War and conflict", "Arts and culture", "Sport", "Family", "Criminal justice", "Free speech"];
const THEME_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { theme: { type: "string", enum: TAGS } },
    required: ["theme"],
    additionalProperties: false,
  },
};

function prepPrompt(motion, fmtKey) {
  const f = FORMATS[fmtKey] || FORMATS.ap;
  return "You are coaching a school debater preparing for a round.\n"
    + "Format: " + f.name + ". Sides: " + f.sides.join(" and ") + ".\n"
    + "Motion: " + motion + "\n\n"
    + "Write a tight prep brief under these headings and nothing else:\n"
    + "SETUP - how to define the motion and set the context, two lines.\n"
    + "BURDENS - what each side has to prove, one line each.\n"
    + "CLASHES - the three arguments the round will turn on.\n"
    + "CASE FOR " + f.sides[0].toUpperCase() + " - three arguments, each a claim line and a mechanism line.\n"
    + "CASE FOR " + f.sides[1].toUpperCase() + " - three arguments, same shape.\n"
    + "POIs - two sharp questions each side can ask.\n"
    + "Be concrete and specific to this motion. No preamble, no conclusion, under 400 words.";
}

/* ---------- guards: access code and a per-visitor hourly cap ---------- */
function codeOk(req) {
  if (!ACCESS_CODE) return true;
  const given = String(req.headers["x-access-code"] || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ACCESS_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}
const hits = new Map();
function visitor(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}
function underLimit(req) {
  const ip = visitor(req), now = Date.now(), hour = 3600e3;
  const list = (hits.get(ip) || []).filter((t) => now - t < hour);
  if (list.length >= HOURLY_LIMIT) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list);
  return true;
}
setInterval(() => { // forget visitors who have gone quiet
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 3600e3)) hits.delete(ip);
}, 600e3).unref();

/* ---------- helpers ---------- */
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 8192) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}
function errCode(e, own) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return own ? "bad_key" : "server_key";
  if (e instanceof Anthropic.RateLimitError) return "rate_limited";
  if (e instanceof Anthropic.BadRequestError) return own ? "key_problem" : "error"; // e.g. no credit left on that key
  if (e instanceof Anthropic.APIError) return "busy";
  return "error";
}
/* Shared checks for both Claude routes. Returns the motion and the client to use, or null after replying. */
async function gate(req, res) {
  let ai = client;
  if (ai) {
    if (!codeOk(req)) { sendJson(res, 401, { code: req.headers["x-access-code"] ? "bad_code" : "need_code" }); return null; }
  } else {
    const key = String(req.headers["x-user-key"] || "").trim();
    if (!key) { sendJson(res, 401, { code: "need_key" }); return null; }
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) { sendJson(res, 401, { code: "bad_key" }); return null; }
    ai = new Anthropic({ apiKey: key, maxRetries: 1 });
  }
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { code: "error" }); return null; }
  const motion = typeof body.motion === "string" ? body.motion.trim() : "";
  if (!motion) { sendJson(res, 400, { code: "empty_motion" }); return null; }
  if (motion.length > MAX_MOTION) { sendJson(res, 400, { code: "prompt_too_large" }); return null; }
  if (!underLimit(req)) { sendJson(res, 429, { code: "too_many" }); return null; }
  return { motion, body, ai, own: !client };
}

/* ---------- routes ---------- */
async function prep(req, res) {
  const g = await gate(req, res); if (!g) return;
  const fmtKey = FORMATS[g.body.format] ? g.body.format : "ap";
  // Newline-delimited JSON: {"d":"text"} as it arrives, then {"done":true} or {"error":"code"}.
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const params = {
    model: MODEL,
    max_tokens: 16000,
    messages: [{ role: "user", content: prepPrompt(g.motion, fmtKey) }],
  };
  if (HAS_EFFORT) params.output_config = { effort: "medium" };
  if (HAS_FALLBACK) { // if Claude declines, the API retries on a suitable fallback model
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const stream = g.ai.beta.messages.stream(params);
  res.on("close", () => { if (!res.writableEnded) stream.abort(); }); // the Stop button
  stream.on("text", (delta) => { res.write(JSON.stringify({ d: delta }) + "\n"); });
  try {
    const msg = await stream.finalMessage();
    res.end(JSON.stringify({ done: true, truncated: msg.stop_reason === "max_tokens", refused: msg.stop_reason === "refusal" }) + "\n");
  } catch (e) {
    if (res.destroyed) return; // visitor stopped it
    console.error("prep failed:", e && e.message);
    res.end(JSON.stringify({ error: errCode(e, g.own) }) + "\n");
  }
}

async function theme(req, res) {
  const g = await gate(req, res); if (!g) return;
  try {
    const r = await g.ai.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: HAS_EFFORT ? { effort: "low", format: THEME_FORMAT } : { format: THEME_FORMAT },
      messages: [{ role: "user", content: "Pick the single best theme for this debate motion.\nMotion: " + g.motion }],
    });
    const block = r.content.find((b) => b.type === "text");
    let picked = "";
    if (r.stop_reason !== "refusal" && block) {
      try { picked = JSON.parse(block.text).theme || ""; } catch { picked = ""; }
    }
    sendJson(res, 200, { theme: TAGS.includes(picked) ? picked : "" });
  } catch (e) {
    console.error("theme failed:", e && e.message);
    sendJson(res, e instanceof Anthropic.RateLimitError ? 429 : 502, { code: errCode(e, g.own) });
  }
}

http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(PAGE);
  }
  if (req.method === "GET" && path === "/api/health") return sendJson(res, 200, { claude: true, code: !!client && !!ACCESS_CODE, byok: !client });
  if (req.method === "POST" && path === "/api/prep") return prep(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, { code: "error" }); });
  if (req.method === "POST" && path === "/api/theme") return theme(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, { code: "error" }); });
  sendJson(res, 404, { code: "not_found" });
}).listen(PORT, () => {
  console.log("Speaksheet on port " + PORT + (client ? " (Prep paid by the site key)" : " (Prep uses each visitor's own key)"));
});
