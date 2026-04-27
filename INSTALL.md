# Installation & Deployment

Node.js-only affiliate tracking backend. The runtime is Node 20+ so that Google
client libraries (firebase-admin today, Google Ads / Analytics / BigQuery later)
stay on the natively supported platform.

---

## 1. Prerequisites

| Tool     | Version   | Notes                                                   |
| -------- | --------- | ------------------------------------------------------- |
| Node.js  | `>= 20.0` | Uses built-in `fetch`, WHATWG streams, native ESM.      |
| npm      | `>= 10`   | Any `npm`, `pnpm`, or `yarn` works. Examples use `npm`. |
| Firebase | project   | A GCP project with Firestore in **Native** mode.        |
| Docker   | optional  | Required only for container builds.                     |

---

## 2. Clone & install

```bash
git clone <your-repo-url> tracking
cd tracking
npm install
```

> `tsx` and `uuidv7` are production dependencies — the server runs TypeScript
> directly at runtime and generates time-ordered IDs. No `tsc` build step is
> required.

---

## 3. Environment variables

Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable                          | Required  | Purpose                                                   |
| --------------------------------- | --------- | --------------------------------------------------------- |
| `PORT`                            | no (3000) | HTTP port.                                                |
| `GOOGLE_APPLICATION_CREDENTIALS`  | *         | Absolute path to the service-account JSON file.           |
| `FIREBASE_SERVICE_ACCOUNT`        | *         | Inline JSON of the service account (alternative to above).|
| `GOOGLE_CLOUD_PROJECT`            | no        | Project id, only if it can't be inferred.                 |
| `JWT_SECRET`                      | yes       | Admin session JWT signing key (>= 16 chars).              |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`  | yes       | Single-admin login credentials.                           |
| `ADMIN_CORS_ORIGINS`              | no        | Comma-separated origins allowed on `/api/*`. Default: `http://localhost:5173`. |
| `PUBLIC_TRACKING_BASE_URL`        | no        | External URL of this server (used to render tracking + postback URLs in admin). |
| **Google Ads integration (optional)** |       | Required only if you'll use the Connections → Google Ads feature. |
| `GOOGLE_OAUTH_CLIENT_ID`          | †         | OAuth Web client ID from Google Cloud Console.            |
| `GOOGLE_OAUTH_CLIENT_SECRET`      | †         | OAuth Web client secret.                                  |
| `GOOGLE_OAUTH_REDIRECT_URI`       | †         | Must equal the URL of the dashboard's `/oauth/google-ads/callback` page (Google enforces an exact match against the value registered on the OAuth client). |
| `GOOGLE_ADS_DEVELOPER_TOKEN`      | †         | From Google Ads MCC → Tools → API Center.                 |
| `GOOGLE_OAUTH_STATE_SECRET`       | †         | HS256 secret for the OAuth `state` JWT (>= 16 chars).     |
| `GOOGLE_ADS_TOKEN_ENC_KEY`        | †         | 32 raw bytes, base64-encoded — AES-256-GCM key for encrypting Google refresh tokens at rest. Generate with `openssl rand -base64 32`. |

\* Either `GOOGLE_APPLICATION_CREDENTIALS` **or** `FIREBASE_SERVICE_ACCOUNT`
must be set. On GCP (Cloud Run, GKE, GCE), attached workload identity works
automatically — both can be omitted.

† All `GOOGLE_OAUTH_*` and `GOOGLE_ADS_*` vars are mandatory **only if** you
intend to enable the Google Ads integration. Without them the rest of the
tracker runs fine; the Connections page just refuses to start an OAuth flow.

Loading the `.env`: Node 20 supports it natively.

```bash
node --env-file=.env --import tsx src/index.ts
# or, for hot reload in dev:
node --env-file=.env --import tsx --watch src/index.ts
```

If you prefer the scripts in `package.json`, export the vars in your shell
first, or wrap them:

```bash
set -a && source .env && set +a
npm run dev
```

---

## 4. Firebase / Firestore setup

1. Create a Firebase project (or reuse an existing GCP project).
2. Enable **Cloud Firestore** in Native mode.
3. Create a service account with the role **Cloud Datastore User** (or
   **Firebase Admin SDK Administrator** for broader access).
4. Download the key as `serviceAccount.json` and point
   `GOOGLE_APPLICATION_CREDENTIALS` at it.
5. Seed at least one **offer** and one **network** document — see examples
   below.
6. Deploy the composite indexes — see **Indexes** below.

### Collections

Full layout in `src/firestore/schema.ts`. Four collections are used:

- `offers/{offer_id}` — offer configuration and the templated `base_url`.
- `networks/{network_id}` — postback parameter mapping per network. **Editable
  from the admin UI** — adding a new network requires no code change.
- `clicks/{click_id}` — one document per redirected user. ID is **UUID v7**.
- `conversions/{conversion_id}` — one document per accepted postback. ID is
  **UUID v7**. Carries an explicit `verified: bool` flag.

### Seeding an offer

```js
db.collection('offers').doc('summer_deal').set({
  name: 'Summer Deal',
  base_url:
    'https://network.example/r/abc?cid={click_id}&s1={s1}&gclid={gclid}',
  status: 'active',
  default_params: { utm_source: 'internal' },
  created_at: FieldValue.serverTimestamp(),
  updated_at: FieldValue.serverTimestamp(),
});
```

`base_url` is a template — any `{token}` whose key matches `click_id`,
`offer_id`, `aff_id`, `s1..sN`, any ad-id (`gclid`, `gbraid`, `wbraid`,
`fbclid`, `ttclid`, `msclkid`), or a key under `default_params` will be
substituted at redirect time with its URL-encoded value.

### Seeding a network (postback mapping)

Each `mapping_*` field is the **parameter name the network actually sends**.
The backend looks the network up by `network_id` (taken from the postback URL
path) and uses these mappings to extract the canonical fields.

```js
// Kelkoo example: posts back with `cid`, `revenue`, `currency`, `goal`, `tx`
db.collection('networks').doc('kelkoo').set({
  name: 'Kelkoo',
  status: 'active',
  mapping_click_id: 'cid',
  mapping_payout: 'revenue',
  mapping_currency: 'currency',
  mapping_status: 'goal',
  mapping_txn_id: 'tx',
  mapping_timestamp: 'ts',
  default_status: 'approved',
  created_at: FieldValue.serverTimestamp(),
  updated_at: FieldValue.serverTimestamp(),
});

// Admedia example: uses different param names
db.collection('networks').doc('admedia').set({
  name: 'Admedia',
  status: 'active',
  mapping_click_id: 'sub_id',
  mapping_payout: 'amount',
  mapping_currency: 'cur',
  mapping_status: 'status',
  mapping_txn_id: 'transaction_id',
  default_status: 'approved',
  created_at: FieldValue.serverTimestamp(),
  updated_at: FieldValue.serverTimestamp(),
});
```

The postback URL you give each network embeds the `network_id`:

```
https://your.tracker/postback/kelkoo?cid=...&revenue=...&goal=...
https://your.tracker/postback/admedia?sub_id=...&amount=...&status=...
```

Edits to a network doc propagate within **60 seconds** (in-memory cache TTL).

### Indexes

Required composite indexes are documented in `src/firestore/indexes.ts`.
Create a `firestore.indexes.json` like this and deploy with the Firebase CLI:

```json
{
  "indexes": [
    { "collectionGroup": "clicks", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "offer_id",   "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "clicks", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "aff_id",     "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "clicks", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "offer_id",   "order": "ASCENDING"  },
      { "fieldPath": "aff_id",     "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "conversions", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "click_id",   "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "conversions", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "offer_id",   "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "conversions", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "status",     "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "conversions", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "network_id", "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "conversions", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "verified",   "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "conversions", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "network_id", "order": "ASCENDING"  },
      { "fieldPath": "verified",   "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "networks", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "status",     "order": "ASCENDING"  },
      { "fieldPath": "updated_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "offers",  "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "status",     "order": "ASCENDING"  },
      { "fieldPath": "updated_at", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "google_ads_accounts", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "connection_id", "order": "ASCENDING"  },
      { "fieldPath": "enabled",       "order": "ASCENDING"  }
    ]},
    { "collectionGroup": "google_ads_routes", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "scope_type", "order": "ASCENDING" },
      { "fieldPath": "scope_id",   "order": "ASCENDING" }
    ]},
    { "collectionGroup": "google_ads_uploads", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "ga_account_id", "order": "ASCENDING"  },
      { "fieldPath": "created_at",    "order": "DESCENDING" }
    ]},
    { "collectionGroup": "google_ads_uploads", "queryScope": "COLLECTION", "fields": [
      { "fieldPath": "status",     "order": "ASCENDING"  },
      { "fieldPath": "created_at", "order": "DESCENDING" }
    ]}
  ],
  "fieldOverrides": []
}
```

Deploy:

```bash
firebase deploy --only firestore:indexes
```

### About UUID v7

`clicks` and `conversions` use UUID v7 doc ids — a 48-bit unix-ms timestamp
followed by 74 random bits. This gives:

- **Time ordering**: docs created later sort lexicographically after earlier
  ones, so range queries by id are cheap and scans are roughly chronological.
- **Bounded hot-spotting**: bursts within the same millisecond share the
  timestamp prefix; the random suffix splits load and Firestore auto-splits
  hot ranges within seconds.

If your write QPS pushes Firestore split warnings, switch the id generator in
`src/utils/idGenerator.ts` to a fully random scheme — only that file needs to
change.

---

## 5. Local development

The repo is two packages: `tracking-backend/` (this one — Node + Hono) and
`tracking-frontend/` (Vite + React). For Google Ads to work end-to-end you need
both running.

### 5.1 Backend

```bash
cd tracking-backend
npm install
cp .env.example .env             # then fill it in (sections 3 + 9.2)
npm run dev                      # hot-reload via tsx watch on :3000
npm run typecheck                # tsc --noEmit
```

### 5.2 Frontend

```bash
cd tracking-frontend
npm install
echo 'VITE_API_BASE_URL=http://localhost:3000' > .env.local
npm run dev                      # Vite on :5173
npm run typecheck                # tsc -b --noEmit
```

Open http://localhost:5173, log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`,
go to **Connections** → connect a Google Ads test account.

### 5.3 Smoke test the tracking pipeline

Assumes `summer_deal` offer and `kelkoo` network seeded:

```bash
# health
curl -i http://localhost:3000/health

# tracking redirect — gclid fires the outbound-click pipeline if a click action is configured
curl -i "http://localhost:3000/click/summer_deal?aff_id=A42&s1=fb_camp&gclid=abc123"

# postback (kelkoo's param names) — fires the conversion pipeline
curl -i "http://localhost:3000/postback/kelkoo?cid=<click_id>&revenue=12.50&currency=USD&goal=approved&tx=TX1"
```

The response body shows `"verified": true|false`. The conversion is persisted
either way; the flag is the audit signal. Inspect `google_ads_uploads/...` in
Firestore to see what was forwarded.

---

## 6. Docker

### Build

```bash
docker build -t tracking-backend:latest .
```

### Run

Mount a service-account file at runtime:

```bash
docker run --rm -p 3000:3000 \
  -v "$PWD/serviceAccount.json:/secrets/serviceAccount.json:ro" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/serviceAccount.json \
  -e PORT=3000 \
  tracking-backend:latest
```

Or inline the credentials (useful for secret managers / CI):

```bash
docker run --rm -p 3000:3000 \
  -e FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccount.json)" \
  tracking-backend:latest
```

The image:
- Uses `node:20-alpine` for a small footprint.
- Runs as non-root `app` user.
- Exposes port 3000 and ships with a `HEALTHCHECK` hitting `/health`.
- Is a two-stage build; only the runtime stage is published.

### docker compose (optional)

```yaml
services:
  tracking:
    build: .
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      GOOGLE_APPLICATION_CREDENTIALS: /secrets/serviceAccount.json
    volumes:
      - ./serviceAccount.json:/secrets/serviceAccount.json:ro
    restart: unless-stopped
```

---

## 7. Production deployment

### 7.1 Backend on Cloud Run (recommended)

```bash
gcloud run deploy tracking-backend \
  --source . \
  --region <region> \
  --allow-unauthenticated \
  --port 3000 \
  --min-instances 1 \
  --set-env-vars "NODE_ENV=production,ADMIN_CORS_ORIGINS=https://app.example.com,PUBLIC_TRACKING_BASE_URL=https://track.example.com" \
  --set-secrets "JWT_SECRET=jwt-secret:latest,ADMIN_PASSWORD=admin-password:latest,GOOGLE_OAUTH_CLIENT_SECRET=gads-oauth-secret:latest,GOOGLE_ADS_DEVELOPER_TOKEN=gads-developer-token:latest,GOOGLE_OAUTH_STATE_SECRET=gads-state-secret:latest,GOOGLE_ADS_TOKEN_ENC_KEY=gads-token-enc-key:latest"
```

On Cloud Run, Firestore auth works via the attached service account — no key
file or `GOOGLE_APPLICATION_CREDENTIALS` env var needed.

Map a custom domain (`track.example.com`) to the service. That domain must
match `PUBLIC_TRACKING_BASE_URL` and the network-side postback URLs you
hand to affiliates.

### 7.2 Frontend (static SPA)

Build once, serve from any static host. `VITE_API_BASE_URL` is baked in at
build time and points at the backend's public URL.

```bash
cd tracking-frontend
VITE_API_BASE_URL=https://api.example.com npm run build
# dist/ is the deployable static bundle
```

Hosting options:
- **Firebase Hosting** (same project as Firestore):
  ```bash
  firebase init hosting   # public dir = dist, single-page app = yes
  firebase deploy --only hosting
  ```
- **Cloudflare Pages / Netlify / Vercel**: point at the repo, set the build
  command to `npm run build` (working dir `tracking-frontend`), publish
  directory `dist/`. Add `VITE_API_BASE_URL` as a build-time env var.
- **Cloud Run + nginx**: a tiny container serving `dist/` works too; the
  example Dockerfile in this repo is for the backend only.

> **Critical:** the OAuth client's authorized redirect URI must EXACTLY
> equal `${frontend host}/oauth/google-ads/callback` and `GOOGLE_OAUTH_REDIRECT_URI`
> on the backend must equal the same string. Add a redirect URI for every
> environment (`localhost:5173`, `staging.example.com`, `app.example.com`).

### 7.3 Behind a CDN / edge

Put the backend behind Cloudflare or Google Cloud Load Balancer. The code
already reads `cf-connecting-ip`, `x-real-ip`, and the leading entry of
`x-forwarded-for` for correct client IP capture, and `cf-ipcountry` for
country tagging.

### 7.4 Horizontal scale

The process is stateless apart from short in-memory caches (offers, networks,
Google Ads connections, Google Ads conversion-action lists). Scale by adding
instances; no sticky sessions required. Cache TTL (30–300 s depending on the
collection) bounds the staleness of admin edits.

---

## 8. Project layout

```
.
├── Dockerfile
├── .dockerignore
├── .env.example
├── package.json
├── tsconfig.json
├── INSTALL.md                ← you are here
├── API.md                    ← endpoint reference
└── src/
    ├── index.ts              app bootstrap + graceful shutdown
    ├── routes/               HTTP routing only
    ├── controllers/          request parsing, response shaping
    ├── services/             business logic
    ├── utils/                id gen (UUID v7), templating, logging, validation
    ├── firestore/            ISOLATED data layer (schema, indexes, repos)
    │   └── repositories/     offer / network / click / conversion
    └── types/                shared interfaces
```

The `firestore/` module is the only place that imports `firebase-admin`.
Business code depends on the repositories, not the SDK — swap or mock freely.

---

## 9. Google Ads integration setup

The "Connections" tab in the dashboard ships disabled until you provide the
Google credentials below. Conversions and outbound clicks won't be forwarded
to Google Ads without it.

### 9.1 One-time Google-side setup

1. **Google Cloud project** (existing one used for Firestore is fine).
   - APIs & Services → **Enable** the **Google Ads API**.
2. **OAuth consent screen** (APIs & Services → OAuth consent screen).
   - User type: **External**. Add your app name + support email.
   - Scopes to add: `https://www.googleapis.com/auth/adwords`, `openid`, `email`.
   - While developing, leave it in **Testing** mode and add your tester emails.
   - For real users, **Publish** to production.
3. **OAuth client** (APIs & Services → Credentials → **Create credentials** → OAuth client ID).
   - Application type: **Web application**.
   - **Authorized redirect URIs**: must EXACTLY match `${PUBLIC_DASHBOARD_BASE_URL}/oauth/google-ads/callback`.
     - Local dev: `http://localhost:5173/oauth/google-ads/callback`
     - Prod: `https://app.example.com/oauth/google-ads/callback`
   - Save the **Client ID** and **Client secret** — these become `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
4. **Google Ads developer token** (Google Ads → **Tools** → API Center).
   - You need to log in with a Google Ads **Manager (MCC)** account (an MCC is required to obtain a developer token, even if you ultimately only connect a single child account).
   - Apply for **Basic Access**. *Test Account* tokens work against test CIDs immediately; production CIDs require approval.
   - Save the token as `GOOGLE_ADS_DEVELOPER_TOKEN`.
5. **Conversion actions** must already exist in Google Ads with the import method **"Conversions from clicks"** (`UPLOAD_CLICKS` in the API). Create one for "Sale" and (optionally) one for "Outbound click". The integration only picks from existing actions; it never creates them.

### 9.2 Server-side env vars

Add these to `tracking-backend/.env`:

```bash
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:5173/oauth/google-ads/callback
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_OAUTH_STATE_SECRET=$(openssl rand -base64 32)   # signs the OAuth state JWT
GOOGLE_ADS_TOKEN_ENC_KEY=$(openssl rand -base64 32)    # 32 raw bytes, base64
```

Generate the two secrets with:
```bash
openssl rand -base64 32   # use the output for GOOGLE_OAUTH_STATE_SECRET
openssl rand -base64 32   # use the output for GOOGLE_ADS_TOKEN_ENC_KEY
```

`GOOGLE_ADS_TOKEN_ENC_KEY` must decode to **exactly 32 bytes** — the AES-256
key used to encrypt every Google refresh token at rest. **Do not rotate this
key without re-OAuthing every connection** — old refresh tokens become
unreadable.

### 9.3 In-app flow — what each connection mode does

#### Google Ads — Manager (MCC)
- **What it is**: cross-account conversion tracking. The MCC owns the
  conversion action; every conversion (and every outbound click) you forward
  is uploaded to the MCC and Google Ads attributes it back to whichever child
  account ran the ad.
- **When to use**: you sign in as the MCC owner / manager user, AND you don't
  need different offers / networks to land in different child accounts.
- **Setup**:
  1. Connections → "Google Ads — Manager (MCC)" → **Connect**.
  2. Sign in with the Google account that has MCC access.
  3. Pick the manager account(s) — usually one. We auto-discover and
     snapshot the children covered by cross-account tracking (display only).
  4. On the connection card, pick the **Sale conversion action** (used for
     postback conversions) and the **Click conversion action** (used for
     outbound clicks). **Save**.
  5. That's it. **No per-offer or per-network mapping is required** — the
     routing card on Offer / Postback pages tells you so.

#### Google Ads — Single child accounts
- **What it is**: one connection per Google Ads sub-account, individually
  authenticated and stored. Per-offer / per-network mapping in the dashboard
  decides which connection a given event lands in.
- **When to use**: you don't manage an MCC, OR you want different offers /
  networks to fire into different child accounts (e.g. agency split across
  brands).
- **Setup**:
  1. Connections → "Google Ads — Single child accounts" → **Connect**.
  2. Sign in with any Google account that has access to those children. **You
     can use an MCC user here** — we'll list every child the OAuth grant
     covers and let you tick the ones to import. Each ticked child becomes
     its own connection (so 3 ticks = 3 connections in the list).
  3. Optionally set per-child default sale / click conversion actions on each
     panel.
  4. Open an **Offer** or **Postback** detail page → **Google Ads forwarding**
     card → pick the destination child + Sale action + Click action + status
     filter → Save.
  5. Repeat for every offer / network you want to forward.

> Mixing both modes in one workspace works but **double-counts** in Google
> Ads (the MCC fires AND the child route fires). The routing card surfaces a
> warning when this is the case.

### 9.4 Outbound click forwarding

Every `/click/:offer_id` redirect is checked for a Google ad-id
(`gclid` / `gbraid` / `wbraid`). When one is present, the click is forwarded
to Google Ads as a click-side conversion using the **Click conversion action**
configured on:
- every active MCC connection that has one set, AND
- the offer-level route's child target if it has one set.

Non-Google clicks (no Google ad-id on the URL) are completely ignored — they
never produce a Google Ads API call and never write a `google_ads_uploads`
row.

### 9.5 Verifying end-to-end

1. **Without real Google traffic**: type-check both packages, boot them, open
   `/connections`, run through the OAuth flow with a Google **test account**
   (CIDs starting with `8` or in the API Center test list) and confirm a
   connection is created.
2. **With a test gclid**:
   ```bash
   # 1. trigger a click that Google would have made
   curl -i "http://localhost:3000/click/<offer_id>?aff_id=A1&gclid=TEST_GCLID"
   # → 302 redirect; backend logs `gads_upload_skipped` (or `_sent`/`_failed`)
   #   for any MCC/route configured with a click action.

   # 2. fire a postback for the resulting click_id
   curl -i "http://localhost:3000/postback/<network_id>?click_id=<click_id>&payout=10&currency=USD&status=approved"
   # → 200; backend logs `gads_upload_*` for sale forwarding.
   ```
3. In Firestore, inspect `google_ads_uploads/...` rows — the `kind` field is
   `conversion` or `click`, `status` is `sent` / `partial_failure` / `failed`
   / `skipped`, and `last_error` carries Google's response on failure.
4. In Google Ads UI: **Tools → Conversions → Uploads** shows the uploaded
   rows. Test gclids will report `Failed: GCLID not found` — that's the
   correct signal the call reached Google.

---

## 10. Troubleshooting

- **`firestore_init_skipped` at boot** — no credentials detected. Set
  `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT`. The server
  will still accept traffic, but click/conversion writes will log
  `click_persist_failed` / `conversion_persist_failed`.
- **`offer_not_found` on /click** — seed an offer doc whose id matches the
  path segment.
- **`offer_inactive`** — `offers/{id}.status` must equal `"active"`.
- **`unknown_network` (404) on /postback** — no doc at `networks/{network_id}`.
  Add one with the network's mapping fields.
- **`network_inactive`** — `networks/{id}.status` must be `"active"`.
- **`missing_click_id`** — the network's `mapping_click_id` doesn't appear
  in the incoming payload. Check the param name they actually send and
  update the doc.
- **Conversion saved with `verified: false`** — the click_id in the postback
  doesn't match any document in `clicks/`. Common causes: tester click_ids,
  the postback fired before the async click write completed, the network is
  sending stale ids. The conversion is still saved for audit.
- **302 goes to a weird URL with empty `{tokens}`** — the offer template
  contained a placeholder that had no value in the request (unknown tokens
  render as empty string). Pass the param or add it to the offer's
  `default_params`.
- **Cache staleness** — offers and networks are cached in-process for 60 s.
  Wait or restart the instance if you just edited a doc.
