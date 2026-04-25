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

export const COLLECTIONS = {
  OFFERS: 'offers',
  NETWORKS: 'networks',
  CLICKS: 'clicks',
  CONVERSIONS: 'conversions',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
