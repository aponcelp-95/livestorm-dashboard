# Livestorm Webinar Dashboard

A small dashboard for your Livestorm webinar stats — registration & attendance,
engagement, and the conversion funnel. Zero runtime dependencies: a plain Node
HTTP server proxies the Livestorm API (keeping your API key server-side) and
serves a static dashboard.

## What it shows

Pick a webinar first (fast, light list), then load its full stats on demand — this
keeps every API call small and bounded so the dashboard never hangs on large
workspaces.

- **Webinar picker** — recent webinars within a selectable window (12 / 26 / 52
  weeks, or all time), searchable.
- **Per-webinar KPIs** — registrants, attendees, attendance rate, avg watch time.
- **Conversion funnel** — Registered → Attended → Engaged → Stayed to end.
- **Engagement** — chat messages, questions, poll votes, upvotes.

## Run locally

Requires Node 18+.

```bash
cp .env.example .env      # then put your real Livestorm token in .env
npm start                 # -> http://localhost:3000
```

Get your token in Livestorm under **Settings → Account → Integrations → API**.

## Deploy (deploybay)

1. Push this repo to GitHub.
2. Deploy the Node app on deploybay.
3. Set the environment variable `LIVESTORM_API_KEY` in the deploybay environment
   (do **not** commit `.env`). `PORT` is provided automatically.

## Data model / API mapping

Data comes from the Livestorm REST API (`https://api.livestorm.co/v1`). Timestamps
are returned as Unix epoch **seconds** and normalized to ms server-side.

Server routes:

- `GET /api/webinars?weeks=N` — light list (no `include=sessions`, so it's fast),
  windowed to the last N weeks (0 = all). Built from `GET /events`.
- `GET /api/webinar/:id` — full stats for one webinar, built from
  `GET /events/{id}?include=sessions` (`registrants_count`, `attendees_count`,
  `duration`, `status`, `started_at`) plus
  `GET /sessions/{id}/people?filter[role]=participant` for per-attendee fields:
  `attended`, `attendance_rate`, `attendance_duration`, `messages_count`,
  `questions_count`, `votes_count`, `up_votes_count`.

Funnel definitions: **Registered** = participants on the session; **Attended** =
`attended` or watch time > 0; **Engaged** = posted a message, question, or vote;
**Stayed to end** = `attendance_rate` ≥ 75% (override with `STAYED_TO_END_THRESHOLD`).

## Notes

- The webinar list fetches up to 12 event pages (600 webinars) then windows them
  by date. The window date uses the event's own date (`estimated_started_at` →
  `published_at` → `updated_at` → `created_at`), since the list call intentionally
  skips per-session data for speed.
- Every outbound Livestorm request has a 15s timeout; failures surface as an error
  in the UI instead of hanging. On rate-limit (HTTP 429) the server backs off and
  retries.
- Server logs (`[api]` / `[livestorm]` lines) are visible in deploybay's Live logs
  for debugging.
