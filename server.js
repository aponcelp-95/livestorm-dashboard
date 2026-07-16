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

// Run async fn over items with bounded concurrency (keeps us well under rate limits).
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

const DAY = 24 * 60 * 60 * 1000;

// Start-of-week (Monday, local server tz) in ms, for week-over-week bucketing.
function weekStartMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return d.getTime() - day * DAY;
}

function aggregateByWeek(sessions) {
  const map = new Map();
  for (const s of sessions) {
    if (s.date == null) continue;
    const wk = weekStartMs(s.date);
    const cur = map.get(wk) || { week: wk, registrants: 0, attendees: 0, sessions: 0 };
    cur.registrants += s.registrants;
    cur.attendees += s.attendees;
    cur.sessions += 1;
    map.set(wk, cur);
  }
  return [...map.values()].sort((a, b) => a.week - b.week);
}

// Resolve the requested window into {start, end} in ms.
function resolveWindow({ weeks, from, to }) {
  const now = Date.now();
  const fromMs = from != null && from !== "" ? toMs(from) : null;
  const toMsVal = to != null && to !== "" ? toMs(to) : null;
  if (fromMs != null || toMsVal != null) {
    // Custom range; include the whole "to" day.
    return { start: fromMs ?? 0, end: (toMsVal != null ? toMsVal + DAY - 1 : now) };
  }
  if (weeks > 0) return { start: now - weeks * 7 * DAY, end: now };
  return { start: 0, end: now };
}

// A "webinar" = a Livestorm event. We fetch the event list light, then enrich each
// event with its SESSIONS separately (bounded pages + concurrency + sparse fields) —
// avoiding the single giant include=sessions call that timed out. From the sessions
// we get the real latest-session date (for windowing) and week-over-week counts.
async function getWebinarList({ weeks = 12, from = null, to = null } = {}) {
  const { start, end } = resolveWindow({ weeks, from, to });
  const { data: events } = await livestormAll("/events", { pageSize: 50, maxPages: 12 });

  const MAX_EVENTS = 150;
  const capped = events.slice(0, MAX_EVENTS);
  // Sparse fieldset: only the session fields we need, so payloads stay small.
  const SPARSE = "fields[sessions]=estimated_started_at,started_at,ended_at,registrants_count,attendees_count,status";

  const enriched = await mapPool(capped, 6, async (ev) => {
    const a = ev.attributes || {};
    let sessions = [];
    try {
      const r = await livestormAll(`/events/${ev.id}/sessions?${SPARSE}`, {
        pageSize: 100,
        maxPages: 6,
      });
      sessions = r.data.map((s) => {
        const sa = s.attributes || {};
        return {
          date: toMs(sa.started_at || sa.estimated_started_at),
          registrants: num(sa.registrants_count),
          attendees: num(sa.attendees_count),
        };
      });
    } catch (e) {
      console.error(`[livestorm] sessions for event ${ev.id} failed: ${e.message}`);
    }
    return { id: ev.id, title: a.title || "(untitled)", slug: a.slug, sessions };
  });

  const webinars = [];
  const windowSessions = [];
  for (const w of enriched) {
    const inWin = w.sessions.filter((s) => s.date != null && s.date >= start && s.date <= end);
    if (!inWin.length) continue;
    const latest = inWin.reduce((m, s) => (s.date > m ? s.date : m), 0);
    webinars.push({
      id: w.id,
      title: w.title,
      slug: w.slug,
      date: latest, // latest session date within the window
      sessionCount: inWin.length,
      registrants: inWin.reduce((t, s) => t + s.registrants, 0),
      attendees: inWin.reduce((t, s) => t + s.attendees, 0),
    });
    for (const s of inWin) windowSessions.push(s);
  }
  webinars.sort((a, b) => (b.date || 0) - (a.date || 0));

  return {
    window: { start, end, weeks },
    count: webinars.length,
    totalEvents: events.length,
    truncated: events.length > MAX_EVENTS,
    webinars,
    weekly: aggregateByWeek(windowSessions),
  };
}

// Full stats for ONE webinar (event): registration/attendance from its sessions,
// engagement + funnel from per-person data. Bounded to a single event, so fast.
async function getWebinarDetail(eventId) {
  const ev = await livestorm(`/events/${eventId}?include=sessions`);
  const a = ev.data?.attributes || {};
  const included = ev.included || [];
  const sessions = included
    .filter((i) => i.type === "sessions")
    .map((s) => {
      const sa = s.attributes || {};
      return {
        id: s.id,
        status: sa.status,
        started_at: toMs(sa.started_at || sa.estimated_started_at),
        duration: num(sa.duration),
        registrants: num(sa.registrants_count),
        attendees: num(sa.attendees_count),
      };
    });

  const registrants = sessions.reduce((t, s) => t + s.registrants, 0);
  const attendees = sessions.reduce((t, s) => t + s.attendees, 0);
  const dates = sessions.map((s) => s.started_at).filter((v) => v != null).sort((x, y) => x - y);

  // Per-person aggregation for engagement + funnel.
  const agg = {
    participants: 0, attended: 0, stayedToEnd: 0, engaged: 0,
    totalWatchSeconds: 0, messages: 0, questions: 0, votes: 0, upVotes: 0,
  };
  for (const s of sessions) {
    const { data: people } = await livestormAll(
      `/sessions/${s.id}/people?filter[role]=participant`,
      { pageSize: 100, maxPages: 20 }
    );
    for (const p of people) {
      const pa = p.attributes || {};
      agg.participants++;
      const didAttend = pa.attended === true || num(pa.attendance_duration) > 0;
      if (didAttend) {
        agg.attended++;
        agg.totalWatchSeconds += num(pa.attendance_duration);
        if (num(pa.attendance_rate) >= STAYED_TO_END_THRESHOLD) agg.stayedToEnd++;
      }
      const msgs = num(pa.messages_count), qs = num(pa.questions_count), vts = num(pa.votes_count);
      agg.messages += msgs; agg.questions += qs; agg.votes += vts; agg.upVotes += num(pa.up_votes_count);
      if (msgs + qs + vts > 0) agg.engaged++;
    }
  }

  // Headline counts prefer authoritative session counts, falling back to people.
  const registeredBase = registrants || agg.participants;
  const attendedBase = attendees || agg.attended;
  // Keep the funnel monotonic: later stages can't exceed the attended base.
  const engaged = Math.min(agg.engaged, attendedBase);
  const stayed = Math.min(agg.stayedToEnd, attendedBase);
  const avgWatchSeconds = agg.attended > 0 ? agg.totalWatchSeconds / agg.attended : 0;

  return {
    id: eventId,
    title: a.title || "(untitled)",
    date: dates[dates.length - 1] || null,
    sessionCount: sessions.length,
    registrants: registeredBase,
    attendees: attendedBase,
    attendance_rate: registeredBase > 0 ? attendedBase / registeredBase : 0,
    avgWatchSeconds,
    messages: agg.messages,
    questions: agg.questions,
    votes: agg.votes,
    upVotes: agg.upVotes,
    funnel: [
      { stage: "Registered", value: registeredBase },
      { stage: "Attended", value: attendedBase },
      { stage: "Engaged", value: engaged },
      { stage: "Stayed to end", value: stayed },
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

    if (pathname === "/api/webinars") {
      const weeksParam = Number(url.searchParams.get("weeks"));
      const w = Number.isFinite(weeksParam) ? weeksParam : 12;
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      console.log(`[api] /api/webinars requested (weeks=${w}, from=${from}, to=${to})`);
      const data = await getWebinarList({ weeks: w, from, to });
      console.log(`[api] /api/webinars -> ${data.count} webinars in window / ${data.totalEvents} events`);
      return sendJSON(res, 200, data);
    }

    const detailMatch = pathname.match(/^\/api\/webinar\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      console.log(`[api] /api/webinar/${id} requested`);
      const data = await getWebinarDetail(id);
      console.log(`[api] /api/webinar/${id} -> ${data.registrants} reg / ${data.attendees} att`);
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
