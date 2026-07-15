# Livestorm Webinar Dashboard

A small dashboard for your Livestorm webinar stats — registration & attendance,
engagement, and the conversion funnel. Zero runtime dependencies: a plain Node
HTTP server proxies the Livestorm API (keeping your API key server-side) and
serves a static dashboard.

## What it shows

- **KPI row** — total webinars, registrants, attendees, and average attendance rate.
- **Registration vs. attendance over time** — grouped bars per webinar (hover for detail).
- **Per-webinar table** — every webinar ranked by date, with an attendance-rate bar.
- **Conversion funnel** (per webinar) — Registered → Attended → Engaged → Stayed to end.
- **Engagement tiles** (per webinar) — avg watch time, chat messages, questions, poll votes.

Click any webinar (row or bar) to load its funnel and engagement.

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

Data comes from the Livestorm REST API (`https://api.livestorm.co/v1`):

- `GET /events?include=sessions` — webinars + their sessions
  (`registrants_count`, `attendees_count`, `duration`, `status`, `started_at`).
- `GET /sessions/{id}/people?filter[role]=participant` — per-attendee fields used
  for engagement/funnel: `attended`, `attendance_rate`, `attendance_duration`,
  `messages_count`, `questions_count`, `votes_count`, `up_votes_count`.

Funnel definitions: **Registered** = participants on the session; **Attended** =
`attended` or watch time > 0; **Engaged** = posted a message, question, or vote;
**Stayed to end** = `attendance_rate` ≥ 75% (override with `STAYED_TO_END_THRESHOLD`).

## Notes

- The event list pages through up to 40 pages (2,000 webinars); beyond that the UI
  shows a "truncated" note rather than silently dropping data.
- On rate-limit (HTTP 429) the server backs off and retries.
