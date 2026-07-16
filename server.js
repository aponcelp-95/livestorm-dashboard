import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Minimal .env loader (no dependency) --------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const API_KEY = process.env.LIVESTORM_API_KEY || "";
const PORT = process.env.PORT || 3000;
const LIVESTORM_BASE = "https://api.livestorm.co/v1";
// A viewer counts as "stayed to end" at/above this attendance_rate (percent, 0–100).
const STAYED_TO_END_THRESHOLD = Number(process.env.STAYED_TO_END_THRESHOLD) || 75;

// --- Livestorm API helper -----------------------------------------------
// Livestorm auth: the raw token goes in the Authorization header (no "Bearer").
async function livestorm(endpoint, { retries = 3 } = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${LIVESTORM_BASE}${endpoint}`;
  console.log(`[livestorm] GET ${url}`);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: API_KEY,
          Accept: "application/vnd.api+json",
        },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const reason = e.name === "AbortError" ? "timed out after 15s" : e.message;
      console.error(`[livestorm] request failed (${url}): ${reason}`);
      const err = new Error(`Could not reach Livestorm API (${reason}). Check outbound network/egress from the container.`);
      err.status = 502;
      throw err;
    }
    clearTimeout(timer);
    if (res.status === 429) {
      // Rate limited — back off and retry.
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(
        `Livestorm ${res.status}: ${JSON.stringify(body).slice(0, 300)}`
      );
      err.status = res.status;
      throw err;
    }
    return body;
  }
  const err = new Error("Livestorm rate limit exceeded after retries");
  err.status = 429;
  throw err;
}

// Fetch every page of a paginated JSON:API list endpoint.
async function livestormAll(endpoint, { pageSize = 50, maxPages = 40 } = {}) {
  const sep = endpoint.includes("?") ? "&" : "?";
  const data = [];
  const included = [];
  let page = 0;
  let pageCount = 1;
  while (page < pageCount && page < maxPages) {
    const body = await livestorm(
      `${endpoint}${sep}page[number]=${page}&page[size]=${pageSize}`
    );
    if (Array.isArray(body.data)) data.push(...body.data);
    if (Array.isArray(body.included)) included.push(...body.included);
    pageCount = body.meta?.page_count ?? 1;
    page++;
  }
  return { data, included, truncated: pageCount > maxPages };
}

// --- Aggregation --------------------------------------------------------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Livestorm returns timestamps as Unix epoch seconds. Normalize any of
// {seconds, milliseconds, ISO string} to milliseconds (or null).
function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const p = Date.parse(s);
  return Number.isNaN(p) ? null : p;
}

// Build the overview: one entry per event, with per-session detail.
async function getEventsOverview() {
  const { data: events, included, truncated } = await livestormAll(
    "/events?include=sessions",
    { pageSize: 50 }
  );

  const sessionsById = new Map();
  for (const inc of included) {
    if (inc.type === "sessions") sessionsById.set(inc.id, inc);
  }

  const result = events.map((ev) => {
    const a = ev.attributes || {};
    const rels = ev.relationships?.sessions?.data || [];
    const sessions = rels
      .map((ref) => sessionsById.get(ref.id))
      .filter(Boolean)
      .map((s) => {
        const sa = s.attributes || {};
        const registrants = num(sa.registrants_count);
        const attendees = num(sa.attendees_count);
        return {
          id: s.id,
          status: sa.status,
          started_at: toMs(sa.started_at || sa.estimated_started_at),
          ended_at: toMs(sa.ended_at),
          duration: num(sa.duration),
          registrants,
          attendees,
          attendance_rate: registrants > 0 ? attendees / registrants : 0,
        };
      });

    const registrants = sessions.reduce((t, s) => t + s.registrants, 0);
    const attendees = sessions.reduce((t, s) => t + s.attendees, 0);
    const dates = sessions
      .map((s) => s.started_at)
      .filter((v) => v != null)
      .sort((a, b) => a - b);

    return {
      id: ev.id,
      title: a.title || "(untitled)",
      slug: a.slug,
      sessionCount: sessions.length,
      registrants,
      attendees,
      attendance_rate: registrants > 0 ? attendees / registrants : 0,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      sessions,
    };
  });

  // Newest first by most recent session date.
  result.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
  return { events: result, truncated };
}

// Engagement + funnel for one event: aggregate per-person data across its sessions.
async function getEventEngagement(eventId) {
  const ev = await livestorm(`/events/${eventId}?include=sessions`);
  const included = ev.included || [];
  const sessionIds = included
    .filter((i) => i.type === "sessions")
    .map((i) => i.id);

  const agg = {
    participants: 0,
    attended: 0,
    stayedToEnd: 0, // attendance_rate >= STAYED_TO_END_THRESHOLD
    engaged: 0, // posted a message, asked a question, or voted
    totalWatchSeconds: 0,
    messages: 0,
    questions: 0,
    votes: 0,
    upVotes: 0,
    registrants: 0,
  };

  for (const sid of sessionIds) {
    const { data: people } = await livestormAll(
      `/sessions/${sid}/people?filter[role]=participant`,
      { pageSize: 100 }
    );
    for (const p of people) {
      const pa = p.attributes || {};
      agg.participants++;
      const attended = pa.attended === true || num(pa.attendance_duration) > 0;
      if (attended) {
        agg.attended++;
        agg.totalWatchSeconds += num(pa.attendance_duration);
        if (num(pa.attendance_rate) >= STAYED_TO_END_THRESHOLD) agg.stayedToEnd++;
      }
      const msgs = num(pa.messages_count);
      const qs = num(pa.questions_count);
      const vts = num(pa.votes_count);
      agg.messages += msgs;
      agg.questions += qs;
      agg.votes += vts;
      agg.upVotes += num(pa.up_votes_count);
      if (msgs + qs + vts > 0) agg.engaged++;
    }
  }

  const avgWatchSeconds = agg.attended > 0 ? agg.totalWatchSeconds / agg.attended : 0;
  return {
    eventId,
    ...agg,
    // registrants come from session counts (people list = registrants); use participants as the base.
    registrants: agg.participants,
    avgWatchSeconds,
    funnel: [
      { stage: "Registered", value: agg.participants },
      { stage: "Attended", value: agg.attended },
      { stage: "Engaged", value: agg.engaged },
      { stage: "Stayed to end", value: agg.stayedToEnd },
    ],
  };
}

// --- HTTP server --------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(__dirname, "public", path.normalize(rel));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/health") {
      return sendJSON(res, 200, { keyConfigured: Boolean(API_KEY) });
    }

    if (!API_KEY && pathname.startsWith("/api/")) {
      return sendJSON(res, 503, {
        error: "LIVESTORM_API_KEY is not set. Add it to .env (local) or the deploybay environment.",
      });
    }

    if (pathname === "/api/events") {
      console.log("[api] /api/events requested");
      const data = await getEventsOverview();
      console.log(`[api] /api/events -> ${data.events.length} events`);
      return sendJSON(res, 200, data);
    }

    const engMatch = pathname.match(/^\/api\/event\/([^/]+)\/engagement$/);
    if (engMatch) {
      const data = await getEventEngagement(decodeURIComponent(engMatch[1]));
      return sendJSON(res, 200, data);
    }

    if (pathname.startsWith("/api/")) {
      return sendJSON(res, 404, { error: "Unknown API route" });
    }

    return serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    return sendJSON(res, err.status || 500, { error: err.message || "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Livestorm dashboard listening on 0.0.0.0:${PORT}`);
  if (!API_KEY) console.warn("⚠  LIVESTORM_API_KEY not set — API routes will return 503.");
});
