/**
 * Firestore Schema
 * ─────────────────
 *
 * Collections:
 *
 *  offers/{offer_id}
 *    offer_id       string   (mirrored doc id, human-readable)
 *    name           string
 *    base_url       string   template URL, e.g.
 *                            "https://network.com/r/abc?cid={click_id}&s1={s1}&gclid={gclid}"
 *    status         string   "active" | "paused"
 *    default_params map      optional default template values
 *    created_at     timestamp
 *    updated_at     timestamp
 *
 *  networks/{network_id}
 *    network_id        string   mirrored doc id, e.g. "kelkoo", "admedia"
 *    name              string   display name e.g. "Kelkoo"
 *    status            string   "active" | "paused"
 *    mapping_click_id  string   incoming param name carrying the click id (e.g. "cid")
 *    mapping_payout    string   incoming param name for payout/revenue (e.g. "revenue")
 *    mapping_currency  string   optional
 *    mapping_status    string   optional — incoming param name for conversion status
 *    mapping_txn_id    string   optional — incoming param name for transaction id
 *    mapping_timestamp string   optional — incoming param name for the event timestamp
 *    default_status    string   optional fallback when mapping_status is absent / empty
 *    created_at        timestamp
 *    updated_at        timestamp
 *
 *  clicks/{click_id}
 *    click_id       string   UUID v7 — time-ordered
 *    offer_id       string
 *    aff_id         string
 *    sub_params     map      { s1, s2, s3, ... }
 *    ad_ids         map      { gclid, gbraid, wbraid, fbclid, ttclid, msclkid }
 *    ip             string
 *    user_agent     string
 *    referrer       string
 *    country        string
 *    redirect_url   string   rendered affiliate URL (audit trail)
 *    created_at     timestamp
 *
 *  conversions/{conversion_id}
 *    conversion_id       string   UUID v7
 *    network_id          string   network doc that produced this postback
 *    click_id            string   lookup key against clicks
 *    offer_id            string   denormalised from the click when verified
 *    payout              number
 *    currency            string
 *    status              string   "approved" | "pending" | "rejected" | ...
 *    txn_id              string
 *    network_timestamp   string   event time as reported by network (if mapped)
 *    raw_payload         map      full incoming GET/POST payload (audit/debug)
 *    source_ip           string
 *    method              string   "GET" | "POST"
 *    verified            bool     true iff click_id matched a click doc
 *    verification_reason string   "click_found" | "unknown_click_id"
 *    created_at          timestamp
 *
 * ID strategy:
 *   - offers / networks: human-readable IDs assigned by ops.
 *   - clicks & conversions: UUID v7 (time-ordered) — see utils/idGenerator.ts.
 */

/**
 * Google Ads integration collections
 * ──────────────────────────────────
 *
 *  google_ads_connections/{connection_id}        — one connection = one destination
 *    type                'mcc' | 'child'
 *    google_user_email   string
 *    refresh_token_enc   { ciphertext, iv, tag }   AES-256-GCM blob, never logged
 *    customer_id         string                    10-digit CID this connection points at
 *    manager_customer_id string?                   MCC CID for type='child' accessed through MCC
 *                                                  (becomes login-customer-id header)
 *    descriptive_name    string                    Account name from API
 *    currency_code       string
 *    time_zone           string
 *    sale_conversion_action_resource  string?      Cross-account upload-clicks action (MCC) or default (child)
 *    sale_conversion_action_name      string?
 *    click_conversion_action_resource string?      Outbound-click upload-clicks action
 *    click_conversion_action_name     string?
 *    scopes              string[]
 *    status              'active' | 'revoked' | 'error'
 *    last_error          string?
 *    created_at, updated_at
 *
 *  google_ads_mcc_children/{ga_child_id}         — display-only snapshot of an MCC's children
 *    ga_child_id     "{connection_id}_{customer_id}"
 *    connection_id   string                       FK to MCC connection
 *    customer_id     string
 *    descriptive_name, currency_code, time_zone   string
 *    created_at, updated_at
 *
 *  google_ads_routes/{route_id}                  route_id = "{scope_type}_{scope_id}"
 *    scope_type            'offer' | 'network'
 *    scope_id              string
 *    target_connection_id  string                 FK -> google_ads_connections (must be type='child')
 *    sale_conversion_action_resource  string?
 *    sale_conversion_action_name      string?
 *    click_conversion_action_resource string?
 *    click_conversion_action_name     string?
 *    enabled               boolean
 *    created_at, updated_at
 *
 *  google_ads_uploads/{upload_id}                upload_id = uuidv7 (one per attempt destination)
 *    kind                       'conversion' | 'click'
 *    source_id                  string            conversion_id OR click_id
 *    conversion_id, click_id    string?           denormalised
 *    connection_id, customer_id string?
 *    identifier_type            'gclid' | 'gbraid' | 'wbraid'
 *    identifier_value           string?
 *    conversion_action_resource string?
 *    status                     'pending'|'sent'|'partial_failure'|'failed'|'skipped'
 *    attempts                   number
 *    last_error, skip_reason    string?
 *    google_response            map?
 *    sent_at, created_at, updated_at
 */

export const COLLECTIONS = {
  OFFERS: 'offers',
  NETWORKS: 'networks',
  CLICKS: 'clicks',
  CONVERSIONS: 'conversions',
  GOOGLE_ADS_CONNECTIONS: 'google_ads_connections',
  GOOGLE_ADS_MCC_CHILDREN: 'google_ads_mcc_children',
  GOOGLE_ADS_ROUTES: 'google_ads_routes',
  GOOGLE_ADS_UPLOADS: 'google_ads_uploads',
  AFFILIATE_APIS: 'affiliate_apis',
  AFFILIATE_API_RUNS: 'affiliate_api_runs',
  // Pre-aggregated daily metrics per offer. Survives the 90-day TTL on
  // clicks/conversions so historical reports keep working after source rows
  // expire. Doc id = `{offer_id}__{YYYY-MM-DD}` (UTC). Writes are atomic
  // FieldValue.increment from the click/postback hot paths.
  OFFER_REPORTS: 'offer_reports',
  OFFER_DRILLDOWNS: 'offer_drilldowns',
  POSTBACK_DRILLDOWNS: 'postback_drilldowns',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
