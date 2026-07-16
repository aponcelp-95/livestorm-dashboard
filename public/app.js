"use strict";

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateShort(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDuration(sec) {
  if (!sec) return "0m";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
function attachHovers(root) {
  root.querySelectorAll(".hbar").forEach((p) => {
    p.addEventListener("mousemove", (e) => showTip(decodeURIComponent(p.dataset.tip), e.clientX, e.clientY));
    p.addEventListener("mouseleave", hideTip);
  });
}

// ---------- state ----------
let STATE = {
  webinars: [],
  weekly: [],
  selected: new Set(),
  weeks: 12,
  from: "",
  to: "",
  search: "",
  details: new Map(), // id -> detail (cache)
};

async function fetchJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- init ----------
async function init() {
  try {
    const health = await fetchJSON("/api/health");
    if (!health.keyConfigured) {
      renderListError("No Livestorm API key configured on the server.");
      return;
    }
    await loadList();
  } catch (err) {
    renderListError(err.message);
  }
}

function listUrl() {
  if (STATE.weeks === "custom") {
    const p = new URLSearchParams();
    if (STATE.from) p.set("from", STATE.from);
    if (STATE.to) p.set("to", STATE.to);
    return `/api/webinars?${p.toString()}`;
  }
  return `/api/webinars?weeks=${STATE.weeks}`;
}

async function loadList() {
  $("#status").textContent = "Loading…";
  $("#webinar-list").innerHTML = `<li class="skeleton">Loading webinars…</li>`;
  $("#trend-chart").innerHTML = `<div class="skeleton">Loading…</div>`;
  try {
    const data = await fetchJSON(listUrl());
    STATE.webinars = data.webinars || [];
    STATE.weekly = data.weekly || [];
    STATE.details.clear();
    // Drop selections no longer in the window.
    const ids = new Set(STATE.webinars.map((w) => w.id));
    STATE.selected = new Set([...STATE.selected].filter((id) => ids.has(id)));
    $("#status").textContent = "";
    $("#list-count").textContent = `${data.count} webinar${data.count === 1 ? "" : "s"}`;
    renderList();
    renderTrend();
    renderSelection();
  } catch (err) {
    $("#status").textContent = "";
    renderListError(err.message);
    $("#trend-chart").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function renderListError(msg) {
  $("#webinar-list").innerHTML = `<li class="error">${escapeHtml(msg)}</li>`;
}

// ---------- list (multi-select) ----------
function renderList() {
  const ul = $("#webinar-list");
  const q = STATE.search.trim().toLowerCase();
  const items = q
    ? STATE.webinars.filter((w) => w.title.toLowerCase().includes(q))
    : STATE.webinars;

  if (!items.length) {
    ul.innerHTML = `<li class="empty">${STATE.webinars.length ? "No matches." : "No webinars in this window."}</li>`;
    updateSelbar();
    return;
  }
  ul.innerHTML = items
    .map((w) => {
      const on = STATE.selected.has(w.id);
      return `<li class="witem${on ? " selected" : ""}" data-id="${w.id}" tabindex="0" role="button" aria-pressed="${on}">
        <span class="check" aria-hidden="true">${on ? "✓" : ""}</span>
        <span class="wmeta">
          <span class="wt">${escapeHtml(w.title)}</span>
          <span class="wd">${fmtDate(w.date)} · ${fmt(w.registrants)} reg · ${fmt(w.attendees)} att</span>
        </span>
      </li>`;
    })
    .join("");
  ul.querySelectorAll(".witem").forEach((li) => {
    li.addEventListener("click", () => toggleSelect(li.dataset.id));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSelect(li.dataset.id); }
    });
  });
  updateSelbar();
}

function updateSelbar() {
  const n = STATE.selected.size;
  const bar = $("#selbar");
  bar.hidden = n === 0;
  if (n) $("#selcount").textContent = `${n} selected`;
}

function toggleSelect(id) {
  if (STATE.selected.has(id)) STATE.selected.delete(id);
  else STATE.selected.add(id);
  renderList();
  renderSelection();
}

$("#clearsel").addEventListener("click", () => {
  STATE.selected.clear();
  renderList();
  renderSelection();
});

// ---------- week-over-week trend ----------
function renderTrend() {
  const el = $("#trend-chart");
  const data = STATE.weekly;
  if (!data || !data.length) {
    el.innerHTML = `<div class="empty">No session data in this window.</div>`;
    $("#trend-sub").textContent = "";
    return;
  }
  $("#trend-sub").textContent = `${data.length} week${data.length === 1 ? "" : "s"}`;

  const W = 660, H = 300, padL = 46, padR = 12, padT = 14, padB = 48;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...data.map((d) => Math.max(d.registrants, d.attendees)), 1);
  const ticks = niceTicks(max, 4);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const groupW = plotW / data.length;
  const barW = Math.min(16, (groupW - 8) / 2);
  const s1 = cssVar("--series-1"), s2 = cssVar("--series-2");

  let grid = "", bars = "", labels = "";
  for (const t of ticks) {
    grid += `<line x1="${padL}" y1="${y(t)}" x2="${W - padR}" y2="${y(t)}" stroke="${cssVar("--gridline")}" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" fill="${cssVar("--muted")}" font-size="11">${fmt(t)}</text>`;
  }
  const everyN = Math.ceil(data.length / 14); // avoid label crowding
  data.forEach((d, i) => {
    const gx = padL + i * groupW + groupW / 2;
    const t = `<b>Week of ${fmtDate(d.week)}</b><div class="t-row"><span>Registrants</span><span>${fmt(d.registrants)}</span></div><div class="t-row"><span>Attendees</span><span>${fmt(d.attendees)}</span></div><div class="t-row"><span>Sessions</span><span>${fmt(d.sessions)}</span></div>`;
    bars += bar(gx - barW - 1, y(d.registrants), barW, padT + plotH - y(d.registrants), s1, t);
    bars += bar(gx + 1, y(d.attendees), barW, padT + plotH - y(d.attendees), s2, t);
    if (i % everyN === 0) {
      labels += `<text x="${gx}" y="${H - padB + 16}" text-anchor="middle" fill="${cssVar("--muted")}" font-size="10">${fmtDateShort(d.week)}</text>`;
    }
  });

  el.innerHTML = `
    <div class="legend">
      <span><i style="background:${s1}"></i>Registrants</span>
      <span><i style="background:${s2}"></i>Attendees</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Registrants vs attendees by week">
      ${grid}
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${cssVar("--baseline")}" stroke-width="1"/>
      ${bars}${labels}
    </svg>`;
  attachHovers(el);
}

function bar(x, yTop, w, h, fill, tipHtml) {
  const r = Math.min(4, w / 2);
  const yb = yTop + Math.max(h, 0.5);
  const d = `M${x},${yb} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yb} Z`;
  return `<path d="${d}" fill="${fill}" data-tip="${encodeURIComponent(tipHtml)}" class="hbar"/>`;
}

// ---------- selection panel (aggregate of selected webinars) ----------
async function renderSelection() {
  const panel = $("#selection-panel");
  const ids = [...STATE.selected];
  if (!ids.length) {
    panel.innerHTML = `<div class="hint">Select one or more webinars on the left to see combined registration, attendance, engagement, and the conversion funnel.</div>`;
    return;
  }
  panel.innerHTML = `<div class="card"><div class="skeleton">Loading stats for ${ids.length} webinar${ids.length === 1 ? "" : "s"}…</div></div>`;

  try {
    // Fetch details (cached) with light concurrency.
    const need = ids.filter((id) => !STATE.details.has(id));
    await mapPool(need, 4, async (id) => {
      const d = await fetchJSON(`/api/webinar/${encodeURIComponent(id)}`);
      STATE.details.set(id, d);
    });
    // Selection may have changed while loading.
    const current = [...STATE.selected];
    if (current.length !== ids.length || current.some((id) => !STATE.selected.has(id))) return;
    renderAggregate(current.map((id) => STATE.details.get(id)).filter(Boolean));
  } catch (err) {
    panel.innerHTML = `<div class="card"><div class="error">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderAggregate(details) {
  const panel = $("#selection-panel");
  if (!details.length) { panel.innerHTML = ""; return; }

  const sum = (f) => details.reduce((t, d) => t + (d[f] || 0), 0);
  const registrants = sum("registrants");
  const attendees = sum("attendees");
  const attendanceRate = registrants > 0 ? attendees / registrants : 0;
  // Weighted average watch time by attendees.
  const watchWeighted = details.reduce((t, d) => t + (d.avgWatchSeconds || 0) * (d.attendees || 0), 0);
  const avgWatch = attendees > 0 ? watchWeighted / attendees : 0;

  // Combined funnel: sum matching stages.
  const stageNames = details[0].funnel.map((s) => s.stage);
  const funnel = stageNames.map((name, i) => ({
    stage: name,
    value: details.reduce((t, d) => t + (d.funnel[i]?.value || 0), 0),
  }));

  const heading = details.length === 1
    ? escapeHtml(details[0].title)
    : `${details.length} webinars combined`;
  const meta = details.length === 1
    ? `${fmtDate(details[0].date)} · ${details[0].sessionCount} session${details[0].sessionCount === 1 ? "" : "s"}`
    : `${fmt(registrants)} registrants across ${details.length} webinars`;

  const kpis = [
    { label: "Registrants", value: fmt(registrants) },
    { label: "Attendees", value: fmt(attendees) },
    { label: "Attendance rate", value: pct(attendanceRate) },
    { label: "Avg watch time", value: fmtDuration(avgWatch) },
  ];
  const engagement = [
    { label: "Chat messages", value: fmt(sum("messages")) },
    { label: "Questions", value: fmt(sum("questions")) },
    { label: "Poll votes", value: fmt(sum("votes")) },
    { label: "Upvotes", value: fmt(sum("upVotes")) },
  ];

  panel.innerHTML = `
    <div class="detail-head">
      <div>
        <h2 class="detail-title">${heading}</h2>
        <div class="detail-meta">${meta}</div>
      </div>
    </div>
    <section class="kpi-row">
      ${kpis.map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`).join("")}
    </section>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Conversion funnel</h2><span class="card-sub">of registered</span></div>
        <div id="funnel-chart" class="chart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Engagement</h2></div>
        <div class="mini-kpis">
          ${engagement.map((t) => `<div class="mini"><div class="m-label">${t.label}</div><div class="m-value">${t.value}</div></div>`).join("")}
        </div>
      </div>
    </div>`;
  renderFunnel(funnel);
}

function renderFunnel(stages) {
  const el = $("#funnel-chart");
  const base = Math.max(stages[0].value, 1);
  const W = 560, rowH = 52, padL = 4, padR = 4, gap = 10;
  const H = stages.length * rowH;
  const barMaxW = W - padL - padR;
  const colors = ["--funnel-4", "--funnel-3", "--funnel-2", "--funnel-1"].map(cssVar);

  let rows = "";
  stages.forEach((s, i) => {
    const w = Math.max((s.value / base) * barMaxW, 2);
    const yTop = i * rowH + 6;
    const bh = rowH - gap - 6;
    const color = colors[i % colors.length];
    const share = base > 0 ? s.value / base : 0;
    const tipHtml = `<b>${s.stage}</b><div class="t-row"><span>Count</span><span>${fmt(s.value)}</span></div><div class="t-row"><span>of registered</span><span>${pct(share)}</span></div>`;
    rows += `<rect x="${padL}" y="${yTop}" width="${w}" height="${bh}" rx="4" fill="${color}" class="hbar" data-tip="${encodeURIComponent(tipHtml)}"/>`;
    rows += `<text x="${padL + 12}" y="${yTop + bh / 2 + 4}" fill="#fff" font-size="13" font-weight="600">${s.stage}</text>`;
    rows += `<text x="${W - padR}" y="${yTop + bh / 2 + 4}" text-anchor="end" fill="${cssVar("--text-secondary")}" font-size="13" font-weight="600">${fmt(s.value)} · ${pct(share)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Conversion funnel">${rows}</svg>`;
  attachHovers(el);
}

// ---------- utilities ----------
async function mapPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}
function niceTicks(max, count) {
  const step = niceNum(max / count, true);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = (range || 1) / Math.pow(10, exp);
  let nice;
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

// ---------- controls: window / custom range ----------
$("#range").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "custom") {
    STATE.weeks = "custom";
    $("#custom-range").hidden = false;
    return; // wait for Apply
  }
  $("#custom-range").hidden = true;
  STATE.weeks = Number(v);
  loadList();
});
$("#apply-range").addEventListener("click", () => {
  STATE.from = $("#from").value;
  STATE.to = $("#to").value;
  if (!STATE.from && !STATE.to) return;
  loadList();
});
$("#search").addEventListener("input", (e) => {
  STATE.search = e.target.value;
  renderList();
});

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("ls-theme", theme); } catch {}
  renderTrend();
  if (STATE.selected.size) renderSelection();
}
(function initTheme() {
  let saved;
  try { saved = localStorage.getItem("ls-theme"); } catch {}
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", saved || (prefersDark ? "dark" : "light"));
})();
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
});

init();
