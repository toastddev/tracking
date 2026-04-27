# API Reference

Base URL: `http://<host>:<port>` (default port `3000`).

All non-redirect responses are `application/json`. All log output is
structured JSON lines.

| Endpoint                       | Method    | Purpose                                                |
| ------------------------------ | --------- | ------------------------------------------------------ |
| `/health`                      | GET       | Liveness probe.                                        |
| `/click/:offer_id`             | GET       | Register a click and 302-redirect to affiliate.        |
| `/postback/:network_id`        | GET, POST | Receive a conversion from a specific affiliate network.|
| `/api/integrations/google-ads/...` | various | Google Ads OAuth / connections / accounts / routes / uploads. See **Google Ads integration** below. |
| `/api/settings/reset-data`     | POST      | Wipe clicks + conversions + Google Ads upload audit (keeps offers/networks/connections/routes). Body must include `{ "confirm": "RESET" }`. |

---

## `GET /health`

Lightweight readiness/liveness probe. Does not touch Firestore.

### Response `200 OK`

```json
{ "status": "ok", "ts": "2026-04-23T10:15:30.123Z" }
```

---

## `GET /click/:offer_id`

Core tracking endpoint. The flow is:

1. Validate required params (`offer_id`, `aff_id`).
2. Fetch the offer from Firestore (cached in-process for 60 s).
3. Generate a **UUID v7** `click_id` (time-ordered, 128-bit).
4. Collect sub-params (`s1`, `s2`, …), ad-click ids (`gclid`, `gbraid`,
   `wbraid`, `fbclid`, `ttclid`, `msclkid`), IP, UA, referrer, country.
5. Render `offer.base_url` by substituting `{tokens}` with URL-encoded values.
6. **Return a 302 immediately.**
7. Persist the click document to Firestore **asynchronously** — the redirect
   never blocks on the write. Failures log `click_persist_failed` and are
   otherwise swallowed.

### Path params

| Name       | Type   | Required | Description                  |
| ---------- | ------ | -------- | ---------------------------- |
| `offer_id` | string | yes      | Document id in `offers/`.    |

### Query params

| Name                                             | Required | Description                                                              |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `aff_id`                                         | yes      | Affiliate / publisher identifier.                                        |
| `s1`, `s2`, `s3`, … `sN`                         | no       | Arbitrary sub-parameters — any query key matching `/^s\d+$/`.            |
| `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `msclkid` | no | Ad-platform click ids — stored on the click and available in the template. |
| any other                                        | ignored  | Not persisted; not fed into the template.                                |

### Headers used

| Header                                           | Purpose                                  |
| ------------------------------------------------ | ---------------------------------------- |
| `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` | Client IP detection.                 |
| `cf-ipcountry`                                   | Country tagging (Cloudflare).            |
| `user-agent`                                     | Stored on the click.                     |
| `referer`                                        | Stored on the click.                     |

### Template substitution

The offer's `base_url` is a template. Available keys:

- `{click_id}` — generated per request (UUID v7).
- `{offer_id}`, `{aff_id}` — from the request.
- `{s1}`, `{s2}`, … — whichever sub-params were provided.
- `{gclid}`, `{gbraid}`, `{wbraid}`, `{fbclid}`, `{ttclid}`, `{msclkid}` — ad ids.
- Any key under the offer's `default_params` map.

Precedence (later overrides earlier): `click_id`/`offer_id`/`aff_id` < `default_params` < `sub_params` < `ad_ids`. Unknown tokens render as empty strings.

### Example

Offer:

```json
{
  "offer_id": "summer_deal",
  "base_url": "https://network.example/r/abc?cid={click_id}&s1={s1}&gclid={gclid}",
  "status": "active"
}
```

Request:

```
GET /click/summer_deal?aff_id=A42&s1=fb_camp&s2=ad_group_7&gclid=Cj0KCQ
```

Response:

```
HTTP/1.1 302 Found
Location: https://network.example/r/abc?cid=018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d&s1=fb_camp&gclid=Cj0KCQ
```

### Error responses

| Status | Body                                                     | When                                                      |
| ------ | -------------------------------------------------------- | --------------------------------------------------------- |
| 400    | `{ "error": "missing_params", "missing": ["aff_id"] }`   | `offer_id` missing (unlikely due to routing) or `aff_id` missing/empty.  |
| 404    | `{ "error": "offer_not_found" }`                         | No document at `offers/{offer_id}`.                       |
| 410    | `{ "error": "offer_inactive" }`                          | Offer exists but `status != "active"`.                    |
| 500    | `{ "error": "internal" }`                                | Unhandled exception (Firestore read failure, etc.).       |

> Note: if the Firestore **write** fails after the redirect has been sent, the
> user still receives their 302. The failure shows up as a `click_persist_failed`
> log line with `click_id` and `offer_id` for later recovery.

---

## `GET /postback/:network_id` and `POST /postback/:network_id`

Conversion ingestion. Each affiliate network has its own URL with its
`network_id` in the path. The handler loads the network document, applies its
configured parameter mapping to extract canonical fields, verifies the
`click_id` against the `clicks/` collection, and persists a conversion
document with an explicit `verified` flag.

GET (pixel-style postbacks) and POST (JSON or form-encoded) share the same
logic.

### Path params

| Name         | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `network_id` | string | yes      | Document id in `networks/`.          |

### How parameter mapping works

There are **no hardcoded aliases**. The `networks/{network_id}` document tells
the service which incoming parameter name carries which canonical field:

| Network doc field    | Maps to              | Required |
| -------------------- | -------------------- | -------- |
| `mapping_click_id`   | internal `click_id`  | yes      |
| `mapping_payout`     | `payout` (number)    | no       |
| `mapping_currency`   | `currency`           | no       |
| `mapping_status`     | `status`             | no       |
| `mapping_txn_id`     | `txn_id`             | no       |
| `mapping_timestamp`  | `network_timestamp`  | no       |

Mapping fields are case-insensitive on lookup. Anything in the incoming payload
that isn't mapped is preserved verbatim under `raw_payload` on the conversion
doc.

`status` falls back to `network.default_status` and finally to `"approved"` if
nothing is mapped or sent.

### Verification

After mapping, the service looks `mapped.click_id` up in `clicks/`:

- **Match**: `verified = true`, `verification_reason = "click_found"`,
  `offer_id` denormalised onto the conversion.
- **No match**: `verified = false`, `verification_reason = "unknown_click_id"`.
  The conversion is **still saved** for audit/debug — important for catching
  test traffic, mis-fired networks, or stale click ids.
- **Click_id missing entirely**: rejected with 400 (nothing to verify against,
  nothing useful to save).

### Supported content types (POST)

- `application/x-www-form-urlencoded`
- `multipart/form-data`
- `application/json`

### Response

```json
{
  "status": "ok",
  "conversion_id": "018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d",
  "verified": true,
  "verification_reason": "click_found"
}
```

When the click_id is unknown:

```json
{
  "status": "ok",
  "conversion_id": "018f4a3b-7a5d-7e22-b1a3-aa9f1234abcd",
  "verified": false,
  "verification_reason": "unknown_click_id"
}
```

The full incoming payload is stored on the conversion document as
`raw_payload` for auditing.

### Error responses

| Status | Body                                                              | When                                                      |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 400    | `{ "status": "error", "reason": "missing_network_id" }`           | Path segment empty (shouldn't happen with routing).       |
| 404    | `{ "status": "error", "reason": "unknown_network" }`              | No document at `networks/{network_id}`.                   |
| 400    | `{ "status": "error", "reason": "network_inactive" }`             | Network exists but `status != "active"`.                  |
| 400    | `{ "status": "error", "reason": "missing_click_id" }`             | Mapped click-id parameter is absent or empty.             |
| 400    | `{ "status": "error", "reason": "persist_failed" }`               | Firestore write rejected (rare — also logged).            |
| 401    | `{ "status": "error", "reason": "unauthorized" }`                 | Reserved for postback verification (HMAC/IP allowlist) once enabled. |
| 500    | `{ "error": "internal" }`                                         | Unhandled exception.                                      |

### Examples

Assume the following network doc:

```json
{
  "network_id": "kelkoo",
  "name": "Kelkoo",
  "status": "active",
  "mapping_click_id": "cid",
  "mapping_payout": "revenue",
  "mapping_currency": "currency",
  "mapping_status": "goal",
  "mapping_txn_id": "tx",
  "mapping_timestamp": "ts",
  "default_status": "approved"
}
```

GET:

```
GET /postback/kelkoo?cid=018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d&revenue=12.50&currency=USD&goal=approved&tx=TX-001&ts=2026-04-23T10:00:00Z
```

POST (JSON):

```http
POST /postback/kelkoo
Content-Type: application/json

{
  "cid": "018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d",
  "revenue": "12.50",
  "currency": "USD",
  "goal": "approved",
  "tx": "TX-001"
}
```

POST (form-encoded):

```http
POST /postback/kelkoo
Content-Type: application/x-www-form-urlencoded

cid=018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d&revenue=12.50&currency=USD&goal=approved&tx=TX-001
```

A second network with different param names needs **only** a new doc — no
code change:

```json
{
  "network_id": "admedia",
  "mapping_click_id": "sub_id",
  "mapping_payout": "amount",
  "mapping_currency": "cur",
  "mapping_status": "status",
  "mapping_txn_id": "transaction_id",
  "status": "active"
}
```

```
GET /postback/admedia?sub_id=...&amount=9.99&cur=EUR&status=approved&transaction_id=AM-77
```

---

## Data written to Firestore

### `clicks/{click_id}` — id is **UUID v7**

```json
{
  "click_id": "018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d",
  "offer_id": "summer_deal",
  "aff_id": "A42",
  "sub_params": { "s1": "fb_camp", "s2": "ad_group_7" },
  "ad_ids": { "gclid": "Cj0KCQ" },
  "ip": "203.0.113.10",
  "user_agent": "Mozilla/5.0 ...",
  "referrer": "https://example.com/",
  "country": "IN",
  "redirect_url": "https://network.example/r/abc?cid=018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d&s1=fb_camp&gclid=Cj0KCQ",
  "created_at": "<server timestamp>"
}
```

### `networks/{network_id}` — postback mapping config

```json
{
  "network_id": "kelkoo",
  "name": "Kelkoo",
  "status": "active",
  "mapping_click_id": "cid",
  "mapping_payout": "revenue",
  "mapping_currency": "currency",
  "mapping_status": "goal",
  "mapping_txn_id": "tx",
  "mapping_timestamp": "ts",
  "default_status": "approved",
  "created_at": "<server timestamp>",
  "updated_at": "<server timestamp>"
}
```

### `conversions/{conversion_id}` — id is **UUID v7**

```json
{
  "conversion_id": "018f4a3b-7a5d-7e22-b1a3-aa9f1234abcd",
  "network_id": "kelkoo",
  "click_id": "018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d",
  "offer_id": "summer_deal",
  "payout": 12.5,
  "currency": "USD",
  "status": "approved",
  "txn_id": "TX-001",
  "network_timestamp": "2026-04-23T10:00:00Z",
  "raw_payload": {
    "cid": "018f4a3b-6f8e-7a5b-9c2d-1e2f3a4b5c6d",
    "revenue": "12.50",
    "currency": "USD",
    "goal": "approved",
    "tx": "TX-001",
    "ts": "2026-04-23T10:00:00Z"
  },
  "source_ip": "198.51.100.23",
  "method": "GET",
  "verified": true,
  "verification_reason": "click_found",
  "created_at": "<server timestamp>"
}
```

---

## Observability

Every interesting event emits a single JSON line on stdout:

| Event                        | Level | Fields                                                          |
| ---------------------------- | ----- | --------------------------------------------------------------- |
| `server_started`             | info  | `port`                                                          |
| `firestore_ready`            | info  | —                                                               |
| `firestore_init_skipped`     | warn  | `error`                                                         |
| `click_redirect`             | info  | `click_id`, `offer_id`, `aff_id`                                |
| `click_persist_failed`       | error | `click_id`, `offer_id`, `error`                                 |
| `postback_accepted`          | info  | `network_id`, `conversion_id`, `verified`, `verification_reason`|
| `postback_rejected`          | warn  | `network_id`, `reason`, `raw`                                   |
| `conversion_persist_failed`  | error | `network_id`, `click_id`, `error`                               |
| `unhandled_error`            | error | `error`, `stack`, `path`                                        |
| `shutdown_signal`            | info  | `signal`                                                        |

Useful operational queries (run in BigQuery if you sink Firestore there, or
use the Firestore console):

- **Unverified postbacks per network in the last hour** — composite index
  `(network_id ASC, verified ASC, created_at DESC)` is provisioned for this.
- **All conversions for an offer** — `(offer_id ASC, created_at DESC)`.
- **Pending-status queue** — `(status ASC, created_at DESC)`.

---

## Google Ads integration

All endpoints sit under `/api/integrations/google-ads` and require the same
admin Bearer token as the other `/api/*` endpoints.

### Three-step connect

```
POST /api/integrations/google-ads/oauth/start
  body:  { "type": "mcc" | "child" }
  reply: { "auth_url": "<google consent URL>", "state": "<signed JWT>" }
```

Browser is sent to `auth_url`. Google calls back the dashboard at
`/oauth/google-ads/callback?code=...&state=...`, which POSTs:

```
POST /api/integrations/google-ads/oauth/exchange
  body:  { "code": "<auth code>", "state": "<state JWT>" }
  reply: {
    "grant_token": "<short-lived signed JWT carrying the encrypted refresh token>",
    "type":        "mcc" | "child",
    "google_user_email": "user@example.com",
    "candidates": [
      { "customer_id": "1234567890", "descriptive_name": "Acme MCC", "currency_code": "USD", "time_zone": "America/New_York", "is_manager": true,  "level": 0 },
      { "customer_id": "9876543210", "manager_customer_id": "1234567890", "descriptive_name": "Acme EU", "currency_code": "EUR", "time_zone": "Europe/Madrid", "is_manager": false, "level": 1 },
      ...
    ]
  }
```

Nothing is persisted yet. The user picks accounts from the candidate list and
finalizes:

```
POST /api/integrations/google-ads/finalize
  body: {
    "grant_token": "...",
    "picks": [ { "customer_id": "...", "manager_customer_id": "...", "descriptive_name": "...", "currency_code": "...", "time_zone": "...", "is_manager": false } ],
    "mcc_children": [ { "customer_id": "...", "descriptive_name": "...", "currency_code": "...", "time_zone": "..." } ]   // only for type='mcc'
  }
  reply: { "items": [ GoogleAdsConnection ] }
```

For `type='mcc'`: typically picks the manager itself (1 connection); the
`mcc_children` array is a display-only snapshot of the children covered by
cross-account tracking.

For `type='child'`: each pick becomes its own `child` connection (so picking
3 children → 3 connection rows). The MCC's CID lands on each child row as
`manager_customer_id` so we can pass it as the login-customer-id header.

### Connections

```
GET    /api/integrations/google-ads/connections                            → { items: GoogleAdsConnection[] }
GET    /api/integrations/google-ads/connections/:id                        → { connection, mcc_children? }
PATCH  /api/integrations/google-ads/connections/:id                        → updated connection
       body: { sale_conversion_action_resource?, sale_conversion_action_name?, click_conversion_action_resource?, click_conversion_action_name? }
DELETE /api/integrations/google-ads/connections/:id                        → { ok: true }
GET    /api/integrations/google-ads/connections/:id/conversion-actions[?refresh=true]
       → { items: [ { resource_name, id, name, status, type } ] }
```

### Routes (per-offer / per-network mapping for **child** connections only)

```
GET    /api/integrations/google-ads/routes?scope_type=offer&scope_id=summer_deal  → { route | null }
GET    /api/integrations/google-ads/routes/all                                    → { items: GoogleAdsRoute[] }
POST   /api/integrations/google-ads/routes                                        → GoogleAdsRoute
       body: {
         "scope_type": "offer"|"network", "scope_id": "...",
         "target_connection_id": "<child connection_id>",
         "sale_conversion_action_resource":  "customers/.../conversionActions/...",
         "sale_conversion_action_name":      "Lead",
         "click_conversion_action_resource": "customers/.../conversionActions/...",
         "click_conversion_action_name":     "Outbound click",
         "enabled": true
       }
       (No `status_filter`. The conversion's `verified` flag — true iff the
       postback's click_id resolves to one of our tracked clicks — is the only
       gate. The network's own status string is ignored as a filter.)
DELETE /api/integrations/google-ads/routes/:route_id
```

### Upload audit

```
GET    /api/integrations/google-ads/uploads?source_id=<conversion_id|click_id>   → { items: GoogleAdsUpload[] }
POST   /api/integrations/google-ads/uploads/:conversion_id/retry                 → { ok: true }
```

### Forwarding behaviour

#### On every accepted postback (conversion):
1. If `verified === false` or no `gclid`/`gbraid`/`wbraid` on the click → record one `skipped` upload and stop.
2. **Fan out to every active MCC connection** that has `sale_conversion_action_resource` set. Each fires `uploadClickConversions` with `customer_id = MCC.customer_id` (Google attributes back to the right child via the gclid).
3. **Resolve the child route** for the (offer, network) pair (offer overrides network). If a route exists with a sale action set, fire to the route's `target_connection_id`. The `verified` check at step 1 is the only gate — there is no separate status filter.
4. Each attempt persists one row in `google_ads_uploads`.

#### On every `/click/:offer_id` redirect:
1. Persist the click as today.
2. **Only if** the click carries `gclid`/`gbraid`/`wbraid`:
   - Fan out to every active MCC connection with `click_conversion_action_resource` set.
   - Resolve the offer-level route — if it has `click_conversion_action_resource` set, fire to that child too.
3. Non-Google clicks are completely ignored — no DB write, no log line.

Authentication failures (`UNAUTHENTICATED`, `invalid_grant`, `PERMISSION_DENIED`)
mark the connection `status='error'` so subsequent dispatches short-circuit
until the user reconnects.

`order_id` on every uploaded ClickConversion equals the source's id
(`conversion_id` for sales, `click_<click_id>` for clicks) so retries are
idempotent against Google.

---

## Security roadmap

`verifyPostback()` in `src/services/postbackService.ts` is a pluggable hook
that currently returns `{ ok: true }`. Replace it with any of:

- Per-network shared secret checked against a query-string `token` / HMAC.
  The network doc is a natural place to store the secret (add a `secret`
  field).
- IP allowlist per network (add `allowed_ips` to the network doc).
- Signed payloads (HMAC-SHA256 over canonicalised params + shared secret).

When it returns `{ ok: false, reason: 'unauthorized' }` the controller already
responds `401` — no other changes needed.
