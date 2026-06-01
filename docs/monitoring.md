# Monitoring & Alerting Runbook

How to know when tracking-backend is broken before a user does.

## Architecture (one-pager)

```
tracking-backend (Cloud Run)
   │  structured JSON  →  stdout
   │                        │
   │                        ▼
   │             ┌──────────────────────┐
   │             │ Cloud Logging        │  auto-ingest, no agent needed
   │             │                      │
   │             │  ├─ Log-based alerts │──► Notification channels
   │             │  └─ Log-based metric │       │
   │             │     scheduler_heart… │       ├─► Email   (CRITICAL only)
   │             └──────────────────────┘       │
   │                                            └─► Webhook ──► Cloudflare
   │                                                            Worker ──► Telegram
```

The backend itself contains **no** SMTP or Telegram code. It only writes good
logs. All routing happens in the GCP console (and the Cloudflare Worker, which
is a separate deployment — see `tracking-alerts-worker/README.md`).

## Severity contract

| Severity | When | Notified via |
|----------|------|--------------|
| `DEBUG` | Local development noise | Cloud Logging only |
| `INFO` | Normal operation, heartbeats, completed runs | Cloud Logging only |
| `WARNING` | Self-healing transient (single failed page, force-unblock fired) | Telegram |
| `ERROR` | One-shot failure that affects this request/run but not the system | Telegram |
| `CRITICAL` | Data is being lost, job is dead, OAuth blown, repeated failure | Email + Telegram |

What gets promoted to `CRITICAL` in code:

- `uncaught_exception` / `unhandled_rejection` (process-level, `src/index.ts`)
- `firestore_init_failed` — app cannot persist anything
- `aff_api_scheduled_run_threw` after 3 consecutive failures for the same API
- `offer_reports_recon_fast_failed` / `_slow_failed` after 3 consecutive failures
- `gads_upload_failed` / `gads_batch_failed` with `auth_error=true` (OAuth dead,
  uploads silently lost until re-auth)

## Setup checklist

### 0. Prerequisites

- Cloud Run service deployed and writing logs (Cloud Logging works out of the
  box on Cloud Run — no agent install).
- `tracking-alerts-worker` deployed; you have its URL and `WEBHOOK_SHARED_SECRET`.
- Telegram bot created (`@BotFather`) and chat id known.

### 1. Notification channels

Console: **Monitoring → Alerting → Edit notification channels**.

1. **Email**
   - Type: Email
   - Display name: `tracking-backend email`
   - Address: your email
   - Verify via the email link.
2. **Webhook (Telegram)**
   - Type: Webhook
   - Display name: `tracking-backend telegram`
   - Endpoint URL: the Cloudflare Worker URL
   - Use basic auth: **Yes**. Username `gcp` (anything). Password = value of
     `WEBHOOK_SHARED_SECRET`.

### 2. Log-based metric for heartbeats

Console: **Logging → Logs-based Metrics → Create metric**.

- Name: `scheduler_heartbeat`
- Type: Counter
- Filter:
  ```
  resource.type="cloud_run_revision"
  resource.labels.service_name="tracking-backend"
  jsonPayload.msg="scheduler_heartbeat"
  ```
- Labels:
  - Name: `scheduler`
  - Field: `jsonPayload.scheduler`
  - Type: STRING

This produces one time-series per scheduler (`aff_api`,
`offer_reports_recon_fast`, `offer_reports_recon_slow`).

### 3. Alert policies

All policies are scoped with:

```
resource.type="cloud_run_revision"
resource.labels.service_name="tracking-backend"
```

Console: **Monitoring → Alerting → Create policy → Log-based or Metric-based**.

| # | Name | Type | Filter / Condition | Channels | Notes |
|---|------|------|--------------------|----------|-------|
| 1 | tracking-backend CRITICAL | Log-based | `severity=CRITICAL` + service scope | Email + Webhook | Min 1 match in 1 min |
| 2 | tracking-backend ERROR | Log-based | `severity=ERROR` + service scope | Webhook | Rate-limit: 1 notification / 5 min |
| 3 | tracking-backend WARNING | Log-based | `severity=WARNING` + service scope | Webhook | Rate-limit: 1 notification / 15 min |
| 4 | aff_api scheduler absent | Metric absence on `scheduler_heartbeat` filtered by `scheduler="aff_api"` | Duration: 3 min | Email + Webhook | Tick is 60s by default |
| 5 | offer_reports_recon_fast absent | Metric absence, `scheduler="offer_reports_recon_fast"` | Duration: 3h | Email + Webhook | Tick is 1h by default |
| 6 | offer_reports_recon_slow absent | Metric absence, `scheduler="offer_reports_recon_slow"` | Duration: 36h | Email + Webhook | Tick is 12h by default |
| 7 | Cloud Run 5xx rate >5% | Metric threshold on `run.googleapis.com/request_count` filtered `response_code_class="5xx"` | Webhook | 5-min window, threshold 5% |
| 8 | Uptime check on /health | Uptime check | Email + Webhook | 1-min frequency from 3 regions |
| 9 | Container instance restarts | Metric threshold on `run.googleapis.com/container/instance_count` delta | Webhook | Optional, can be noisy on autoscale |

**Heartbeat absence thresholds** are sized to `~3 × tick interval`. If you
change `AFF_API_TICK_MS` etc., update policy #4–#6 to match.

### 4. Error Reporting (free, complementary)

Because the logger now emits `severity=ERROR|CRITICAL` plus the `serviceContext`
block, Cloud Error Reporting will automatically group exceptions by stack
trace. Subscribe Error Reporting to email on new error groups
(**Error Reporting → Notifications**) — this is a second free email path that
fires on novel errors regardless of severity routing in alert policies.

## Smoke tests

After all of the above is wired up:

1. **CRITICAL → email + Telegram.** Add a temporary endpoint or use
   `gcloud run services proxy` to hit an arbitrary route that throws. The
   `unhandled_error` log fires at ERROR — to test CRITICAL specifically, the
   easiest path is `gcloud logging write` with a hand-crafted entry:
   ```bash
   gcloud logging write tracking-backend-smoke \
     '{"severity":"CRITICAL","msg":"smoke_test","service":"tracking-backend"}' \
     --payload-type=json \
     --severity=CRITICAL
   ```
   Expect: Telegram message within seconds, email within 1–2 minutes.

2. **WARNING → Telegram only.** Same as above with `severity=WARNING`. Email
   should *not* arrive; Telegram should.

3. **Heartbeat absence.** Set `AFF_API_SCHEDULER_DISABLED=1`, redeploy, wait
   3 minutes. Expect: heartbeat-absent alert (#4) fires CRITICAL → email +
   Telegram. Re-enable and redeploy to clear.

4. **Uptime.** Pause the Cloud Run service or revert to a revision that 503s
   on `/health`. Expect: uptime alert (#8).

5. **Dedupe.** Trigger the same alert rapidly. The Worker dedupes by
   `incident_id + state` over `DEDUPE_WINDOW_SECONDS` (default 300). Expect:
   one Telegram message per OPEN, one per CLOSED.

6. **OAuth fail.** Revoke the Google Ads refresh token. Trigger an upload.
   Expect: `gads_upload_failed` at CRITICAL → email + Telegram, with
   `auth_error=true`.

## Day-to-day ops

- **Silence noisy alerts.** Edit the policy and set a longer rate-limit or
  add an exclusion filter (e.g. exclude a specific `msg` string that's
  expected to flap).
- **Snooze during deploys.** Use **Monitoring → Alerting → Snooze** to mute
  a policy for a chosen window — cleaner than disabling.
- **See what fired.** **Monitoring → Alerting → Incidents** has the open and
  recently-closed incidents with payloads. Cross-reference with the
  Cloudflare Worker logs (`wrangler tail`) if a Telegram message didn't
  arrive.
- **Add a new alert.** Pick a stable `msg` from the JSON logs, write a
  log-based alert with `jsonPayload.msg="your_event"`, attach a channel.

## When you change scheduler tick rates

Update the **Heartbeat absence** policies (#4–#6) at the same time. The rule
of thumb is `3 × tick_ms`. Under-sizing causes false alarms during normal
slow ticks; over-sizing means a dead scheduler goes unnoticed for hours.

## Out of scope (deferred)

- Frontend instrumentation (Error Boundary, `window.onerror`,
  `lib/api.ts` 5xx hook). Revisit after this pipeline is proven.
- OpenTelemetry tracing.
- Terraform-ising the GCP policies. The clicks-now approach is fine to
  start; codify once stable.
