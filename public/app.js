"use strict";

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDuration(sec) {
  if (!sec) return "0m";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------- tooltip ----------
const tip = $("#tooltip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  let left = x + pad, top = y + pad;
  const rect = tip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight) top = y - rect.height - pad;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideTip() { tip.hidden = true; }

// ---------- state ----------
let STATE = { events: [], selected: null };

// ---------- data ----------
async function fetchJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function init() {
  try {
    const health = await fetchJSON("/api/health");
    if (!health.keyConfigured) {
      $("#status").textContent = "";
      renderError("No Livestorm API key configured on the server. Add LIVESTORM_API_KEY and restart.");
      return;
    }
    $("#status").textContent = "Loading…";
    const { events, truncated } = await fetchJSON("/api/events");
    STATE.events = events;
    $("#status").textContent = truncated
      ? `${events.length}+ webinars (list truncated)`
      : `${events.length} webinars`;
    renderAll();
  } catch (err) {
    $("#status").textContent = "";
    renderError(err.message);
  }
}

function renderError(msg) {
  $("#kpis").innerHTML = "";
  $("#trend-chart").innerHTML = `<div class="error">${msg}</div>`;
  $("#funnel-chart").innerHTML = "";
  $("#webinar-table tbody").innerHTML = `<tr><td colspan="6" class="error">${msg}</td></tr>`;
}

// ---------- render: KPIs ----------
function renderKPIs() {
  const ev = STATE.events;
  const withData = ev.filter((e) => e.registrants > 0 || e.attendees > 0);
  const totReg = ev.reduce((t, e) => t + e.registrants, 0);
  const totAtt = ev.reduce((t, e) => t + e.attendees, 0);
  const rate = totReg > 0 ? totAtt / totReg : 0;
  const kpis = [
    { label: "Webinars", value: fmt(ev.length) },
    { label: "Total registrants", value: fmt(totReg) },
    { label: "Total attendees", value: fmt(totAtt) },
    { label: "Avg attendance rate", value: pct(rate) },
  ];
  $("#kpis").innerHTML = kpis
    .map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`)
    .join("");
}

// ---------- render: trend (grouped bars registrants vs attendees) ----------
function renderTrend() {
  const el = $("#trend-chart");
  const data = STATE.events
    .filter((e) => e.registrants > 0 || e.attendees > 0)
    .slice(0, 12)
    .reverse(); // oldest -> newest left to right

  if (!data.length) {
    el.innerHTML = `<div class="empty">No attendance data yet.</div>`;
    $("#trend-sub").textContent = "";
    return;
  }
  $("#trend-sub").textContent = `${data.length} most recent`;

  const W = 640, H = 280, padL = 44, padR = 12, padT = 14, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...data.map((d) => Math.max(d.registrants, d.attendees)), 1);
  const ticks = niceTicks(max, 4);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  const groupW = plotW / data.length;
  const barW = Math.min(18, (groupW - 8) / 2);
  const s1 = cssVar("--series-1"), s2 = cssVar("--series-2");

  let bars = "", labels = "", grid = "";
  for (const t of ticks) {
    grid += `<line x1="${padL}" y1="${y(t)}" x2="${W - padR}" y2="${y(t)}" stroke="${cssVar("--gridline")}" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" fill="${cssVar("--muted")}" font-size="11">${fmt(t)}</text>`;
  }
  data.forEach((d, i) => {
    const gx = padL + i * groupW + groupW / 2;
    const x1 = gx - barW - 1, x2 = gx + 1;
    const rTip = `<b>${escapeHtml(d.title)}</b><div class="t-row"><span>Registrants</span><span>${fmt(d.registrants)}</span></div><div class="t-row"><span>Attendees</span><span>${fmt(d.attendees)}</span></div><div class="t-row"><span>Rate</span><span>${pct(d.attendance_rate)}</span></div>`;
    bars += bar(x1, y(d.registrants), barW, padT + plotH - y(d.registrants), s1, rTip, d.id);
    bars += bar(x2, y(d.attendees), barW, padT + plotH - y(d.attendees), s2, rTip, d.id);
    labels += `<text x="${gx}" y="${H - padB + 16}" text-anchor="middle" fill="${cssVar("--muted")}" font-size="10">${fmtDateShort(d.lastDate)}</text>`;
  });

  el.innerHTML = `
    <div class="legend">
      <span><i style="background:${s1}"></i>Registrants</span>
      <span><i style="background:${s2}"></i>Attendees</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Registrants vs attendees by webinar">
      ${grid}
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${cssVar("--baseline")}" stroke-width="1"/>
      ${bars}
      ${labels}
    </svg>`;
  attachBarHovers(el);
}

function bar(x, yTop, w, h, fill, tipHtml, id) {
  const r = Math.min(4, w / 2);
  const hh = Math.max(h, 0.5);
  // rounded top corners only
  const yb = yTop + hh;
  const d = `M${x},${yb} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yb} Z`;
  return `<path d="${d}" fill="${fill}" data-tip="${encodeURIComponent(tipHtml)}" data-id="${id}" class="hbar"/>`;
}

function attachBarHovers(root) {
  root.querySelectorAll(".hbar").forEach((p) => {
    p.style.cursor = "pointer";
    p.addEventListener("mousemove", (e) => showTip(decodeURIComponent(p.dataset.tip), e.clientX, e.clientY));
    p.addEventListener("mouseleave", hideTip);
    p.addEventListener("click", () => selectEvent(p.dataset.id));
  });
}

// ---------- render: funnel + engagement ----------
function renderDetail() {
  const funnelEl = $("#funnel-chart");
  const tilesEl = $("#engagement-tiles");
  const sel = STATE.selected;
  if (!sel) {
    $("#detail-title").textContent = "Conversion funnel";
    $("#detail-sub").textContent = "Select a webinar below";
    funnelEl.innerHTML = `<div class="empty">Pick a webinar from the table or a bar above.</div>`;
    tilesEl.innerHTML = "";
    return;
  }
  $("#detail-title").textContent = "Conversion funnel";
  $("#detail-sub").textContent = sel.title;

  if (sel.loading) {
    funnelEl.innerHTML = `<div class="skeleton">Loading engagement…</div>`;
    tilesEl.innerHTML = "";
    return;
  }
  if (sel.error) {
    funnelEl.innerHTML = `<div class="error">${sel.error}</div>`;
    tilesEl.innerHTML = "";
    return;
  }

  const eng = sel.engagement;
  const stages = eng.funnel;
  const base = Math.max(stages[0].value, 1);
  const W = 560, rowH = 46, padL = 4, padR = 4, gap = 8;
  const H = stages.length * rowH;
  const barMaxW = W - padL - padR;
  const funnelColors = ["--funnel-4", "--funnel-3", "--funnel-2", "--funnel-1"].map(cssVar);

  let rows = "";
  stages.forEach((s, i) => {
    const w = Math.max((s.value / base) * barMaxW, 2);
    const yTop = i * rowH + 6;
    const bh = rowH - gap - 6;
    const color = funnelColors[i % funnelColors.length];
    const share = base > 0 ? s.value / base : 0;
    const tipHtml = `<b>${s.stage}</b><div class="t-row"><span>Count</span><span>${fmt(s.value)}</span></div><div class="t-row"><span>of registered</span><span>${pct(share)}</span></div>`;
    rows += `<rect x="${padL}" y="${yTop}" width="${w}" height="${bh}" rx="4" fill="${color}" class="hbar" data-tip="${encodeURIComponent(tipHtml)}"/>`;
    rows += `<text x="${padL + 10}" y="${yTop + bh / 2 + 4}" fill="#fff" font-size="12.5" font-weight="600">${s.stage}</text>`;
    rows += `<text x="${W - padR}" y="${yTop + bh / 2 + 4}" text-anchor="end" fill="${cssVar("--text-secondary")}" font-size="12.5" font-weight="600">${fmt(s.value)} · ${pct(share)}</text>`;
  });

  funnelEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Conversion funnel">${rows}</svg>`;
  attachBarHovers(funnelEl);

  const tiles = [
    { label: "Avg watch time", value: fmtDuration(eng.avgWatchSeconds) },
    { label: "Chat messages", value: fmt(eng.messages) },
    { label: "Questions", value: fmt(eng.questions) },
    { label: "Poll votes", value: fmt(eng.votes) },
  ];
  tilesEl.innerHTML = tiles
    .map((t) => `<div class="mini"><div class="m-label">${t.label}</div><div class="m-value">${t.value}</div></div>`)
    .join("");
}

// ---------- render: table ----------
function renderTable() {
  const tbody = $("#webinar-table tbody");
  if (!STATE.events.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No webinars found.</td></tr>`;
    return;
  }
  tbody.innerHTML = STATE.events
    .map((e) => {
      const selected = STATE.selected && STATE.selected.id === e.id ? " selected" : "";
      const rateW = Math.min(e.attendance_rate * 100, 100);
      return `<tr data-id="${e.id}" class="${selected.trim()}">
        <td class="wtitle">${escapeHtml(e.title)}</td>
        <td>${fmtDate(e.lastDate)}</td>
        <td class="num">${fmt(e.registrants)}</td>
        <td class="num">${fmt(e.attendees)}</td>
        <td class="num">${e.sessionCount}×</td>
        <td><div class="rate-cell"><div class="rate-bar"><i style="width:${rateW}%"></i></div><span>${pct(e.attendance_rate)}</span></div></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => selectEvent(tr.dataset.id));
  });
}

// ---------- selection / drill-down ----------
async function selectEvent(id) {
  const ev = STATE.events.find((e) => e.id === id);
  if (!ev) return;
  STATE.selected = { id: ev.id, title: ev.title, loading: true };
  renderTable();
  renderDetail();
  try {
    const engagement = await fetchJSON(`/api/event/${encodeURIComponent(id)}/engagement`);
    STATE.selected = { id: ev.id, title: ev.title, engagement };
  } catch (err) {
    STATE.selected = { id: ev.id, title: ev.title, error: err.message };
  }
  renderDetail();
}

function renderAll() {
  renderKPIs();
  renderTrend();
  renderDetail();
  renderTable();
}

// ---------- misc ----------
function niceTicks(max, count) {
  const step = niceNum(max / count, true);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice;
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("ls-theme", theme); } catch {}
  if (STATE.events.length) renderAll();
}
(function initTheme() {
  let saved;
  try { saved = localStorage.getItem("ls-theme"); } catch {}
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyThemeSilent(saved || (prefersDark ? "dark" : "light"));
})();
function applyThemeSilent(theme) { document.documentElement.setAttribute("data-theme", theme); }
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
});

init();
