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

\* Either `GOOGLE_APPLICATION_CREDENTIALS` **or** `FIREBASE_SERVICE_ACCOUNT`
must be set. On GCP (Cloud Run, GKE, GCE), attached workload identity works
automatically — both can be omitted.

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

```bash
npm run dev         # hot reload via `tsx watch`
npm run typecheck   # `tsc --noEmit` — no emitted artifacts
```

Smoke test (assumes `summer_deal` offer and `kelkoo` network seeded):

```bash
# health
curl -i http://localhost:3000/health

# tracking redirect (will 302 to the rendered affiliate URL)
curl -i "http://localhost:3000/click/summer_deal?aff_id=A42&s1=fb_camp&gclid=abc123"

# postback for the kelkoo network — note the network id in the path
# and that we use Kelkoo's param names (cid / revenue / goal / tx)
curl -i "http://localhost:3000/postback/kelkoo?cid=<click_id>&revenue=12.50&currency=USD&goal=approved&tx=TX1"
```

Look at the response body — you'll see `"verified": true` if the click_id
matched a row in `clicks/`, and `"verified": false` otherwise. In both cases
the conversion is persisted; the flag is just the audit signal.

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

### Cloud Run (recommended)

```bash
gcloud run deploy tracking-backend \
  --source . \
  --region <region> \
  --allow-unauthenticated \
  --port 3000 \
  --min-instances 1 \
  --set-env-vars "NODE_ENV=production"
```

On Cloud Run, Firestore auth works via the attached service account — no key
file or env var needed.

### Behind a CDN / edge

Put the service behind Cloudflare or Google Cloud Load Balancer. The code
already reads `cf-connecting-ip`, `x-real-ip`, and the leading entry of
`x-forwarded-for` for correct client IP capture, and `cf-ipcountry` for
country tagging.

### Horizontal scale

The process is stateless apart from two 60-second in-memory caches (offers
and networks). Scale by adding instances; no sticky sessions required. Cache
TTL means admin edits to either collection propagate within a minute.

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

## 9. Troubleshooting

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
