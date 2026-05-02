/**
 * Firestore Index Strategy
 * ─────────────────────────
 *
 * Single-field indexes are auto-created by Firestore. Composite indexes listed
 * below must be declared in firestore.indexes.json and deployed with:
 *     firebase deploy --only firestore:indexes
 *
 * clicks
 *   (offer_id ASC, created_at DESC)                  recent clicks per offer
 *   (aff_id ASC, created_at DESC)                    affiliate dashboards
 *   (offer_id ASC, aff_id ASC, created_at DESC)      combined filter
 *
 * conversions
 *   (click_id ASC, created_at DESC)                  dedupe / join back to click
 *   (offer_id ASC, created_at DESC)                  offer-level reporting
 *   (status ASC, created_at DESC)                    pending / approved queues
 *   (network_id ASC, created_at DESC)                per-network reporting
 *   (verified ASC, created_at DESC)                  unverified-postback triage
 *   (network_id ASC, verified ASC, created_at DESC)  unverified per network
 *
 * networks
 *   (status ASC, updated_at DESC)                    active networks list
 *
 * offers
 *   (status ASC, updated_at DESC)                    active offers list
 *
 * Hot-key notes:
 *   - clicks/conversions use UUID v7 ids — time-ordered, with a millisecond
 *     prefix. Burst writes within the same ms share a partition prefix; the
 *     74 random bits in the suffix split the load and Firestore auto-splits
 *     hot ranges within seconds.
 *   - Do not index a lone created_at on a high-write collection without a
 *     partition prefix; pair with offer_id/aff_id/network_id.
 */

export const INDEXES = [
  { collection: 'clicks',      fields: ['offer_id ASC', 'created_at DESC'] },
  { collection: 'clicks',      fields: ['aff_id ASC', 'created_at DESC'] },
  { collection: 'clicks',      fields: ['offer_id ASC', 'aff_id ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['click_id ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['offer_id ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['status ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['network_id ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['verified ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['network_id ASC', 'verified ASC', 'created_at DESC'] },
  // Aff API source filtering — keep reports clean by excluding shadow rows.
  { collection: 'conversions', fields: ['shadow ASC', 'created_at DESC'] },
  { collection: 'conversions', fields: ['aff_api_id ASC', 'created_at DESC'] },
  { collection: 'networks',    fields: ['status ASC', 'updated_at DESC'] },
  { collection: 'offers',      fields: ['status ASC', 'updated_at DESC'] },
  // Scheduler reads: due-now lookup and per-status listing.
  { collection: 'affiliate_apis',     fields: ['status ASC', 'schedule.next_run_at ASC'] },
  { collection: 'affiliate_api_runs', fields: ['api_id ASC', 'started_at DESC'] },
  // Pre-aggregated offer metrics — per-offer date scans + range scan.
  { collection: 'offer_reports', fields: ['offer_id ASC', 'date ASC'] },
  { collection: 'offer_reports', fields: ['date ASC'] },
  // Pre-aggregated campaign metrics — same pattern as offer_reports.
  { collection: 'campaign_reports', fields: ['campaign_id ASC', 'date ASC'] },
  { collection: 'campaign_reports', fields: ['date ASC'] },
] as const;
