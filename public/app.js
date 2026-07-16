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

// ---------- state ----------
let STATE = { webinars: [], selectedId: null, weeks: 12, search: "" };

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

async function loadList() {
  $("#status").textContent = "Loading…";
  $("#webinar-list").innerHTML = `<li class="skeleton">Loading webinars…</li>`;
  try {
    const data = await fetchJSON(`/api/webinars?weeks=${STATE.weeks}`);
    STATE.webinars = data.webinars || [];
    $("#status").textContent = "";
    $("#list-count").textContent = STATE.weeks
      ? `${data.count} in window`
      : `${data.count} total`;
    renderList();
  } catch (err) {
    $("#status").textContent = "";
    renderListError(err.message);
  }
}

function renderListError(msg) {
  $("#webinar-list").innerHTML = `<li class="error">${escapeHtml(msg)}</li>`;
}

// ---------- list ----------
function renderList() {
  const ul = $("#webinar-list");
  const q = STATE.search.trim().toLowerCase();
  const items = q
    ? STATE.webinars.filter((w) => w.title.toLowerCase().includes(q))
    : STATE.webinars;

  if (!items.length) {
    ul.innerHTML = `<li class="empty">${STATE.webinars.length ? "No matches." : "No webinars in this window."}</li>`;
    return;
  }
  ul.innerHTML = items
    .map((w) => {
      const sel = w.id === STATE.selectedId ? " selected" : "";
      return `<li class="witem${sel}" data-id="${w.id}" tabindex="0" role="button">
        <span class="wt">${escapeHtml(w.title)}</span>
        <span class="wd">${fmtDate(w.date)}</span>
      </li>`;
    })
    .join("");
  ul.querySelectorAll(".witem").forEach((li) => {
    li.addEventListener("click", () => selectWebinar(li.dataset.id));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectWebinar(li.dataset.id); }
    });
  });
}

// ---------- selection / detail ----------
async function selectWebinar(id) {
  STATE.selectedId = id;
  renderList();
  const w = STATE.webinars.find((x) => x.id === id);
  $("#detail-empty").hidden = true;
  const el = $("#detail-content");
  el.hidden = false;
  el.innerHTML = `<div class="card"><div class="card-head"><h2>${escapeHtml(w ? w.title : "Webinar")}</h2></div><div class="skeleton">Loading stats…</div></div>`;
  try {
    const d = await fetchJSON(`/api/webinar/${encodeURIComponent(id)}`);
    renderDetail(d);
  } catch (err) {
    el.innerHTML = `<div class="card"><div class="card-head"><h2>${escapeHtml(w ? w.title : "Webinar")}</h2></div><div class="error">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderDetail(d) {
  const kpis = [
    { label: "Registrants", value: fmt(d.registrants) },
    { label: "Attendees", value: fmt(d.attendees) },
    { label: "Attendance rate", value: pct(d.attendance_rate) },
    { label: "Avg watch time", value: fmtDuration(d.avgWatchSeconds) },
  ];
  const engagement = [
    { label: "Chat messages", value: fmt(d.messages) },
    { label: "Questions", value: fmt(d.questions) },
    { label: "Poll votes", value: fmt(d.votes) },
    { label: "Upvotes", value: fmt(d.upVotes) },
  ];

  $("#detail-content").innerHTML = `
    <div class="detail-head">
      <div>
        <h2 class="detail-title">${escapeHtml(d.title)}</h2>
        <div class="detail-meta">${fmtDate(d.date)} · ${d.sessionCount} session${d.sessionCount === 1 ? "" : "s"}</div>
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

  renderFunnel(d.funnel);
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
  el.querySelectorAll(".hbar").forEach((p) => {
    p.addEventListener("mousemove", (e) => showTip(decodeURIComponent(p.dataset.tip), e.clientX, e.clientY));
    p.addEventListener("mouseleave", hideTip);
  });
}

// ---------- controls ----------
$("#range").addEventListener("change", (e) => {
  STATE.weeks = Number(e.target.value);
  STATE.selectedId = null;
  $("#detail-content").hidden = true;
  $("#detail-empty").hidden = false;
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
  // re-render funnel so SVG colors pick up new theme vars
  if (STATE.selectedId) selectWebinar(STATE.selectedId);
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
