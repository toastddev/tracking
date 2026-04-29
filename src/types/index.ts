export interface Offer {
  offer_id: string;
  name: string;
  base_url: string;
  status: 'active' | 'paused';
  default_params?: Record<string, string>;
  created_at?: string;
  updated_at?: string;
}

export interface AdIds {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;
  [key: string]: string | undefined;
}

export interface ClickRecord {
  click_id: string;
  offer_id: string;
  aff_id: string;
  sub_params: Record<string, string>;
  ad_ids: AdIds;
  // Anything else passed on the click URL — utm_*, partner-specific keys,
  // custom campaign tags. Captured so reports are complete and so offer URL
  // templates can reference them via {{utm_source}}-style placeholders.
  extra_params?: Record<string, string>;
  ip?: string;
  user_agent?: string;
  referrer?: string;
  country?: string;
  redirect_url: string;
  created_at: string;
}

// Per-network postback parameter mapping. Editable from the admin UI by
// updating the doc — no code change required to onboard a new network.
export interface Network {
  network_id: string;
  name: string;
  status: 'active' | 'paused';
  // Each mapping_* value is the parameter name the network actually sends.
  // E.g. Kelkoo posts back with `cid` for the click id, so mapping_click_id = "cid".
  mapping_click_id: string;
  mapping_payout?: string;
  mapping_currency?: string;
  mapping_status?: string;
  mapping_txn_id?: string;
  mapping_timestamp?: string;
  // Additional network-specific parameters. Key is the canonical name used
  // in the example URL placeholder; value is the parameter name the network sends.
  extra_mappings?: Record<string, string>;
  default_status?: string;
  // When set and the referenced affiliate API is active, the API pull is the
  // source of truth for conversions/reports for this network. Postbacks still
  // arrive and are persisted as audit-only (verified=true, shadow=true) so we
  // never lose the network's signal — but reporting prefers the API rows.
  postback_api_id?: string;
  created_at?: string;
  updated_at?: string;
}

export type VerificationReason =
  | 'click_found'
  | 'unknown_click_id';

export type ConversionSource = 'postback' | 'api';

export interface ConversionRecord {
  conversion_id: string;
  network_id: string;
  click_id: string;
  offer_id?: string;            // denormalised from the click when verified
  payout?: number;
  currency?: string;
  status?: string;
  txn_id?: string;
  network_timestamp?: string;   // event time as reported by the network, if mapped
  raw_payload: Record<string, unknown>;
  source_ip?: string;
  method: 'GET' | 'POST';
  verified: boolean;            // true iff click_id resolved to an existing click doc
  verification_reason: VerificationReason;
  source?: ConversionSource;    // 'postback' (default) or 'api'
  // Audit-only postback when the network is mapped to an API. Excluded from
  // reporting aggregates so the API pull stays the single source of truth.
  shadow?: boolean;
  aff_api_id?: string;          // FK to AffiliateApi when source='api'
  external_id?: string;         // dedupe key from the API response
  created_at: string;
}

// ── Affiliate API integration ─────────────────────────────────────────
// Each doc describes one upstream API we poll for conversions. The mapping
// engine is generic so kelkoo/admedia/etc. all share one code path.

export type AffiliateApiKind = 'rest' | 'graphql';
export type AffiliateApiResponseFormat = 'json' | 'xml' | 'auto';
export type AffiliateApiAuthType =
  | 'none'
  | 'api_key'      // { in: 'header'|'query', key_name, value }
  | 'bearer'       // Authorization: Bearer <value>
  | 'basic'        // Authorization: Basic base64(user:pass)  — value = "user:pass"
  | 'custom';      // free-form headers map

export type AffiliateApiPaginationType = 'none' | 'page' | 'offset' | 'cursor';

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface AffiliateApiAuthConfig {
  type: AffiliateApiAuthType;
  in?: 'header' | 'query';   // for api_key
  key_name?: string;         // header/query name for api_key, "Authorization" for bearer/basic
  username?: string;         // basic auth — username portion (password is in value_enc)
  // Encrypted secret blob (api key value, bearer token, basic-auth password).
  // Decrypted only at request time — never returned to the admin UI.
  value_enc?: EncryptedBlob;
}

export interface AffiliateApiPagination {
  type: AffiliateApiPaginationType;
  // page-based:
  page_param?: string;          // default "page"
  start_page?: number;          // default 1
  // offset-based:
  offset_param?: string;        // default "offset"
  // cursor-based:
  cursor_param?: string;        // request param name carrying the cursor
  next_cursor_path?: string;    // dot-path inside response to the next cursor
  // common:
  size_param?: string;          // page-size param name (e.g. "limit", "per_page")
  page_size?: number;           // default 100
  max_pages?: number;           // safety cap, default 50
}

export interface AffiliateApiIncremental {
  enabled: boolean;
  from_param?: string;
  to_param?: string;
  format?: 'iso' | 'unix_ms' | 'unix_s' | 'date';   // default 'iso'
  lookback_minutes?: number;    // overlap with previous run, default 30
}

// Field mapping. Each *_path is a dot/bracket path inside an item. For
// GraphQL connection-style responses, items_path = "data.<field>.edges" and
// fields are read from "node.<field>".
export interface AffiliateApiMapping {
  items_path: string;                 // path to array of conversion items in response
  external_id_path: string;           // dedupe key (network's transaction id)
  click_id_path: string;              // path to our click_id
  payout_path?: string;
  currency_path?: string;
  status_path?: string;
  txn_id_path?: string;
  event_time_path?: string;
  // Map upstream status string → canonical "approved" | "pending" | "rejected" etc.
  status_map?: Record<string, string>;
  default_status?: string;
}

export interface AffiliateApiSchedule {
  enabled: boolean;
  runs_per_day: number;          // 1, 2, 4, 6, 12, 24, 48, 96 — anything 1-1440
  next_run_at?: string;          // ISO; populated on save and after each run
  last_run_at?: string;
  last_status?: 'ok' | 'partial' | 'error';
}

export interface AffiliateApiRequestConfig {
  // REST:
  http_method?: 'GET' | 'POST';
  query_params?: Record<string, string>;
  body_template?: string | null;        // raw JSON template; supports {{from}} {{to}} {{page}} placeholders
  headers?: Record<string, string>;     // non-secret headers
  // GraphQL:
  graphql_query?: string;
  graphql_variables?: Record<string, unknown>;
}

export interface AffiliateApi {
  api_id: string;
  name: string;
  status: 'active' | 'paused';
  kind: AffiliateApiKind;
  // How to parse the upstream response. 'auto' (default for back-compat with
  // existing docs) sniffs Content-Type and falls back to body shape. 'json'
  // and 'xml' force the parser regardless of headers.
  response_format?: AffiliateApiResponseFormat;
  base_url: string;
  network_id?: string;                  // optional FK to Network (drives postback fallback)
  auth: AffiliateApiAuthConfig;
  request: AffiliateApiRequestConfig;
  pagination: AffiliateApiPagination;
  incremental: AffiliateApiIncremental;
  mapping: AffiliateApiMapping;
  schedule: AffiliateApiSchedule;
  timeout_ms?: number;                  // per-HTTP-call timeout, default 30s
  max_records_per_run?: number;         // hard cap, default 50_000
  // Lock for distributed-friendly scheduler — single instance can hold it.
  lock_holder?: string;
  lock_until?: string;                  // ISO; cleared on release
  created_at?: string;
  updated_at?: string;
}

export type AffiliateApiRunStatus = 'ok' | 'partial' | 'error' | 'running' | 'skipped';

export interface AffiliateApiRunRecord {
  run_id: string;
  api_id: string;
  status: AffiliateApiRunStatus;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  pages_fetched?: number;
  records_seen?: number;
  records_inserted?: number;
  records_skipped_duplicate?: number;
  records_skipped_unknown_click?: number;
  records_failed?: number;
  http_calls?: number;
  error?: string;
  window_from?: string;
  window_to?: string;
  triggered_by?: 'schedule' | 'manual';
}
