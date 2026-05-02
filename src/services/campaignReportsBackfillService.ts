import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { campaignReportRepository } from '../firestore';
import { logger } from '../utils/logger';

// Reconstructs the campaign_reports rollup from the source clicks +
// conversions collections. Idempotent — each run computes totals locally and
// writes them with `set({...}, { merge: true })`. The merge intentionally
// omits the operator-entered `spend` and `campaign_name` fields so a rebuild
// never overwrites manually entered ad-spend or display names.
//
// Scope: clicks/conversions whose created_at falls in [from, to]. The default
// window is the last 120 days (covers the 90-day TTL ceiling with a buffer).
//
// Click → campaign mapping: every click carries its own extra_params, so the
// click pass is direct. Conversions only carry click_id; we resolve their
// campaign by looking the click up in the in-memory map first, then falling
// back to a single Firestore read per miss (capped — see CONVERSION_LOOKUP_CAP).
//
// Concurrency: live writes via clickService/postbackService also touch the
// rollup. Running this during low-traffic windows is recommended — any click
// or conversion that lands while the backfill is computing may be lost when
// the backfill writes the bucket. The operator-entered `spend` field is
// preserved across reruns thanks to the merge strategy above.

const PAGE = 1000;
const CONVERSION_LOOKUP_CAP = 5000;
const STATUS_BUCKETS = ['approved', 'pending', 'rejected'] as const;
type StatusBucket = (typeof STATUS_BUCKETS)[number];
type CampaignSource = 'gad_campaignid' | 'utm_campaign';

interface Bucket {
  campaign_id: string;
  source: CampaignSource;
  date: string;
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  revenue: number;
  approved: number;
  pending: number;
  rejected: number;
  offers: Set<string>;
}

interface ClickMeta {
  campaign_id: string;
  source: CampaignSource;
  offer_id: string;
}

function emptyBucket(campaign_id: string, source: CampaignSource, date: string): Bucket {
  return {
    campaign_id,
    source,
    date,
    clicks: 0,
    postbacks: 0,
    conversions: 0,
    unverified: 0,
    revenue: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    offers: new Set<string>(),
  };
}

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function statusBucket(status: string | undefined): StatusBucket {
  const s = (status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'reversed') return 'rejected';
  return 'approved';
}

function tsToDate(v: unknown): Date | null {
  if (v && typeof v === 'object' && 'toDate' in (v as object)) {
    try { return (v as { toDate: () => Date }).toDate(); } catch { return null; }
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Single shared rule for picking a campaign tag off a click's extra_params.
// gad_campaignid wins; utm_campaign is the cross-platform fallback.
function extractCampaign(
  extra: unknown
): { campaign_id: string; source: CampaignSource } | null {
  if (!extra || typeof extra !== 'object') return null;
  const e = extra as Record<string, unknown>;
  const gad = e.gad_campaignid;
  if (typeof gad === 'string' && gad.trim()) {
    return { campaign_id: gad.trim(), source: 'gad_campaignid' };
  }
  const utm = e.utm_campaign;
  if (typeof utm === 'string' && utm.trim()) {
    return { campaign_id: utm.trim(), source: 'utm_campaign' };
  }
  return null;
}

export interface CampaignBackfillOptions {
  from?: Date;
  to?: Date;
}

export interface CampaignBackfillResult {
  from: string;
  to: string;
  clicks_scanned: number;
  clicks_with_campaign: number;
  conversions_scanned: number;
  conversions_with_campaign: number;
  conversions_orphan_lookups: number;
  buckets_written: number;
  duration_ms: number;
  campaign_spends?: Array<{
    campaign_id: string;
    campaign_name: string;
    total_spend: number;
  }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const campaignReportsBackfillService = {
  async rebuild(opts: CampaignBackfillOptions = {}): Promise<CampaignBackfillResult> {
    const started = Date.now();
    const to = opts.to ?? new Date();
    const from = opts.from ?? new Date(to.getTime() - 120 * DAY_MS);
    logger.info('campaign_reports_backfill_started', {
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const buckets = new Map<string, Bucket>();
    const bucketFor = (campaign_id: string, source: CampaignSource, date: string): Bucket => {
      const key = `${campaign_id}__${date}`;
      let b = buckets.get(key);
      if (!b) { b = emptyBucket(campaign_id, source, date); buckets.set(key, b); }
      return b;
    };

    // click_id → { campaign_id, source, offer_id } so the conversions pass
    // can attribute payouts without re-reading the click. Memory cost is
    // ~100 bytes/click → 100 MB at 1M clicks, which is well within the
    // backend's envelope. For larger windows we'd shard, but 120 days at
    // current scale is fine.
    const clickMeta = new Map<string, ClickMeta>();

    // ── 1. clicks ────────────────────────────────────────────────────
    let clicks_scanned = 0;
    let clicks_with_campaign = 0;
    {
      let cursor: Date | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CLICKS)
          .where('created_at', '>=', from)
          .where('created_at', '<=', to)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          const at = tsToDate(raw.created_at);
          const offer_id = String(raw.offer_id ?? '');
          if (!at || !offer_id) continue;
          clicks_scanned += 1;
          const campaign = extractCampaign(raw.extra_params);
          if (!campaign) continue;
          clicks_with_campaign += 1;
          // Remember for the conversions pass.
          clickMeta.set(d.id, {
            campaign_id: campaign.campaign_id,
            source: campaign.source,
            offer_id,
          });
          const bucket = bucketFor(campaign.campaign_id, campaign.source, dayKeyUTC(at));
          bucket.clicks += 1;
          bucket.offers.add(offer_id);
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    // ── 2. conversions ───────────────────────────────────────────────
    // For each conversion, we need the click's extra_params. Fast path: the
    // in-memory map. Slow path: read the click doc once, capped at
    // CONVERSION_LOOKUP_CAP misses to bound runtime on huge datasets.
    let conversions_scanned = 0;
    let conversions_with_campaign = 0;
    let orphan_lookups = 0;
    {
      let cursor: Date | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CONVERSIONS)
          .where('created_at', '>=', from)
          .where('created_at', '<=', to)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          // Skip shadow rows — audit-only postbacks for API-backed networks,
          // same exclusion rule as the offer_reports backfill.
          if (raw.shadow === true) continue;
          const at = tsToDate(raw.created_at);
          if (!at) continue;
          const verified = Boolean(raw.verified);
          const click_id = (raw.click_id as string | undefined) || '';
          conversions_scanned += 1;
          // Unverified conversions have no click match → no campaign → skip.
          if (!verified || !click_id) continue;

          let meta = clickMeta.get(click_id);
          if (!meta && orphan_lookups < CONVERSION_LOOKUP_CAP) {
            // Single-doc read for a click outside the window or evicted.
            try {
              const cs = await db().collection(COLLECTIONS.CLICKS).doc(click_id).get();
              orphan_lookups += 1;
              if (cs.exists) {
                const cdata = cs.data() as Record<string, unknown>;
                const campaign = extractCampaign(cdata.extra_params);
                if (campaign) {
                  meta = {
                    campaign_id: campaign.campaign_id,
                    source: campaign.source,
                    offer_id: String(cdata.offer_id ?? ''),
                  };
                  // Cache so a second conversion for the same click doesn't
                  // re-fetch.
                  clickMeta.set(click_id, meta);
                }
              }
            } catch (err) {
              logger.warn('campaign_backfill_click_lookup_failed', {
                click_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (!meta) continue;

          const offer_id = (raw.offer_id as string | undefined) || meta.offer_id || 'unknown';
          const payout = typeof raw.payout === 'number' ? (raw.payout as number) : 0;
          const status = raw.status as string | undefined;

          const b = bucketFor(meta.campaign_id, meta.source, dayKeyUTC(at));
          b.postbacks += 1;
          b.conversions += 1;
          if (Number.isFinite(payout)) b.revenue += payout;
          b[statusBucket(status)] += 1;
          if (offer_id) b.offers.add(offer_id);
          conversions_with_campaign += 1;
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    // ── 3. flush ─────────────────────────────────────────────────────
    // Merge-write so operator-entered `spend` and `campaign_name` survive a
    // rebuild. Note: this overwrites any concurrent hot-path increment —
    // re-running during low traffic is recommended.
    let buckets_written = 0;
    if (buckets.size > 0) {
      const writer = db().bulkWriter();
      writer.onWriteError((err) => err.failedAttempts < 5);
      for (const b of buckets.values()) {
        const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(`${b.campaign_id}__${b.date}`);
        writer.set(ref, {
          campaign_id: b.campaign_id,
          source: b.source,
          date: b.date,
          clicks: b.clicks,
          postbacks: b.postbacks,
          conversions: b.conversions,
          unverified: b.unverified,
          revenue: b.revenue,
          approved: b.approved,
          pending: b.pending,
          rejected: b.rejected,
          offers: Array.from(b.offers),
          updated_at: FieldValue.serverTimestamp(),
          backfilled_at: FieldValue.serverTimestamp(),
          // NOTE: deliberately omitting `spend` and `campaign_name` — the
          // merge keeps whatever the operator entered.
        }, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
        buckets_written += 1;
      }
      await writer.close();
    }

    const updatedCampaignIds = Array.from(new Set(Array.from(buckets.values()).map(b => b.campaign_id)));
    let campaign_spends: CampaignBackfillResult['campaign_spends'];
    if (updatedCampaignIds.length > 0) {
      try {
        const rows = await campaignReportRepository.fetchRange({
          from,
          to,
          campaign_ids: updatedCampaignIds,
        });
        const byCampaign = new Map<string, { name: string; spend: number }>();
        for (const r of rows) {
          const entry = byCampaign.get(r.campaign_id) || { name: r.campaign_id, spend: 0 };
          if (r.campaign_name) entry.name = r.campaign_name;
          entry.spend += r.spend;
          byCampaign.set(r.campaign_id, entry);
        }
        campaign_spends = updatedCampaignIds.map((id) => ({
          campaign_id: id,
          campaign_name: byCampaign.get(id)?.name || id,
          total_spend: byCampaign.get(id)?.spend || 0,
        }));
      } catch (e) {
        logger.warn('campaign_backfill_failed_to_fetch_spends', { error: String(e) });
      }
    }

    const result: CampaignBackfillResult = {
      from: from.toISOString(),
      to: to.toISOString(),
      clicks_scanned,
      clicks_with_campaign,
      conversions_scanned,
      conversions_with_campaign,
      conversions_orphan_lookups: orphan_lookups,
      buckets_written,
      duration_ms: Date.now() - started,
      campaign_spends,
    };
    logger.info('campaign_reports_backfill_completed', { ...result, campaign_spends: undefined });
    return result;
  },
};
