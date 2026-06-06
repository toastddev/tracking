import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import { TTLCache } from '../../utils/ttlCache';
import { toInr } from '../../utils/fxRates';
import { logger } from '../../utils/logger';

// 60s read-through cache for fetchRange. Mirrors offerReportRepository — see
// the comment there for the rationale.
const fetchRangeCache = new TTLCache<CampaignReportDoc[]>({ ttlMs: 60_000, maxEntries: 128 });
const distinctCache = new TTLCache<Array<{ campaign_id: string; campaign_name?: string; source: string }>>({ ttlMs: 5 * 60_000, maxEntries: 8 });

// Per-campaign daily rollup. Doc id = `{campaign_id}__{YYYY-MM-DD}` (UTC day).
// `campaign_id` is sourced from the `gad_campaignid` URL param (Google Ads)
// with `utm_campaign` as a fallback for non-Google traffic. Spend is operator-
// entered (per-day) for now; a future Google Ads API pull can write to the
// same `spend` field. The collection survives the 90-day TTL on raw clicks /
// conversions just like `offer_reports`.
//
// Writes are atomic FieldValue.increment from the click + postback hot paths,
// so concurrent writers compose correctly without an upfront read.
export interface CampaignReportDoc {
  campaign_id: string;
  campaign_name?: string;
  source: string;          // 'gad_campaignid' | 'utm_campaign' — for filtering
  date: string;            // ISO date YYYY-MM-DD (UTC)
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  revenue: number;
  spend: number;           // operator-entered or Google Ads API (INR)
  approved: number;
  pending: number;
  rejected: number;
  offers: string[];        // distinct offers seen on this campaign-day
  // GAds-side daily metrics pulled from googleAdsCampaignSyncService. Stored
  // raw (clicks/impressions as integers; CTR is impressions-derived so we keep
  // both inputs and recompute at aggregation time).
  gads_clicks?: number;
  gads_impressions?: number;
  gads_cost?: number;      // same as `spend` (INR) — denormalised for clarity at the GAds layer
  // Average CPC reported by GAds for this campaign-day in INR. Useful as a
  // sanity check vs computed cost/clicks but we always recompute on read so
  // weighted averages aggregate correctly.
  gads_avg_cpc?: number;
  // CTR is daily: impressions == 0 means undefined. We persist what GAds
  // reports for the day, but aggregate by recomputing clicks/impressions.
  gads_ctr?: number;
  updated_at?: string;
}

function docId(campaign_id: string, date: string): string {
  return `${campaign_id}__${date}`;
}

function statusBucket(status: string | undefined): 'approved' | 'pending' | 'rejected' {
  const s = (status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'reversed') return 'rejected';
  return 'approved';
}

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type CampaignSource = 'gad_campaignid' | 'utm_campaign';

export interface IncrementClickInput {
  campaign_id: string;
  source: CampaignSource;
  at: Date;
  offer_id?: string;
  // Optional friendly name — set by the synthetic `gads_untagged` fallback
  // (gclid-only clicks) so the campaigns table doesn't show the raw id.
  // Real campaigns get their name from the Google Ads sync; passing
  // campaign_name here is only meant for cases where no later sync will
  // populate it.
  campaign_name?: string;
}

export interface IncrementConversionInput {
  campaign_id: string;
  source: CampaignSource;
  at: Date;
  verified: boolean;
  status?: string;
  payout?: number;
  // Currency the `payout` arrived in (per the postback / affiliate API).
  // Campaign revenue is canonically INR, so the repository converts via
  // `fxRates.toInr` before the FieldValue.increment. Empty / unknown is
  // treated as USD here — postback / affiliate-API payouts are USD by
  // convention (offer_reports store them raw, in USD), and assuming INR
  // would skip the conversion and leave raw USD in the INR field.
  currency?: string;
  offer_id?: string;
  // Same semantics as IncrementClickInput.campaign_name — synthetic-fallback only.
  campaign_name?: string;
}

export interface CampaignReportRangeOptions {
  from: Date;
  to: Date;
  campaign_ids?: string[];
  max?: number;
}

export const campaignReportRepository = {
  async incrementClick(input: IncrementClickInput): Promise<void> {
    const date = dayKeyUTC(input.at);
    const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(docId(input.campaign_id, date));
    const patch: Record<string, unknown> = {
      campaign_id: input.campaign_id,
      source: input.source,
      date,
      clicks: FieldValue.increment(1),
      updated_at: FieldValue.serverTimestamp(),
    };
    if (input.campaign_name) patch.campaign_name = input.campaign_name;
    if (input.offer_id) {
      // arrayUnion is idempotent — repeat clicks for the same offer don't
      // bloat the array. Caps at a few-hundred distinct offers per campaign-
      // day, which is fine.
      patch.offers = FieldValue.arrayUnion(input.offer_id);
    }
    await ref.set(patch, { merge: true });
  },

  async incrementConversion(input: IncrementConversionInput): Promise<void> {
    const date = dayKeyUTC(input.at);
    const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(docId(input.campaign_id, date));
    const patch: Record<string, unknown> = {
      campaign_id: input.campaign_id,
      source: input.source,
      date,
      postbacks: FieldValue.increment(1),
      updated_at: FieldValue.serverTimestamp(),
    };
    if (input.campaign_name) patch.campaign_name = input.campaign_name;
    if (input.verified) {
      patch.conversions = FieldValue.increment(1);
      if (typeof input.payout === 'number' && Number.isFinite(input.payout)) {
        const inr = payoutToInr(input.payout, input.currency, input.campaign_id);
        if (inr != null) patch.revenue = FieldValue.increment(inr);
      }
      const bucket = statusBucket(input.status);
      patch[bucket] = FieldValue.increment(1);
    } else {
      patch.unverified = FieldValue.increment(1);
    }
    if (input.offer_id) patch.offers = FieldValue.arrayUnion(input.offer_id);
    await ref.set(patch, { merge: true });
  },

  // Bulk variant for the affiliate API sync flush. Mirrors offerReportRepository.
  async incrementConversionsBulk(rows: IncrementConversionInput[]): Promise<void> {
    if (rows.length === 0) return;
    type Bucket = {
      campaign_id: string;
      source: CampaignSource;
      date: string;
      postbacks: number;
      conversions: number;
      unverified: number;
      revenue: number;
      approved: number;
      pending: number;
      rejected: number;
      offers: Set<string>;
      campaign_name?: string;
    };
    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const date = dayKeyUTC(r.at);
      const key = `${r.campaign_id}|${date}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          campaign_id: r.campaign_id,
          source: r.source,
          date,
          postbacks: 0,
          conversions: 0,
          unverified: 0,
          revenue: 0,
          approved: 0,
          pending: 0,
          rejected: 0,
          offers: new Set<string>(),
        };
        buckets.set(key, b);
      }
      if (r.campaign_name && !b.campaign_name) b.campaign_name = r.campaign_name;
      b.postbacks += 1;
      if (r.verified) {
        b.conversions += 1;
        if (typeof r.payout === 'number' && Number.isFinite(r.payout)) {
          const inr = payoutToInr(r.payout, r.currency, r.campaign_id);
          if (inr != null) b.revenue += inr;
        }
        b[statusBucket(r.status)] += 1;
      } else {
        b.unverified += 1;
      }
      if (r.offer_id) b.offers.add(r.offer_id);
    }

    const writer = db().bulkWriter();
    for (const b of buckets.values()) {
      const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(docId(b.campaign_id, b.date));
      const patch: Record<string, unknown> = {
        campaign_id: b.campaign_id,
        source: b.source,
        date: b.date,
        postbacks: FieldValue.increment(b.postbacks),
        updated_at: FieldValue.serverTimestamp(),
      };
      if (b.campaign_name) patch.campaign_name = b.campaign_name;
      if (b.conversions) patch.conversions = FieldValue.increment(b.conversions);
      if (b.unverified) patch.unverified = FieldValue.increment(b.unverified);
      if (b.revenue) patch.revenue = FieldValue.increment(b.revenue);
      if (b.approved) patch.approved = FieldValue.increment(b.approved);
      if (b.pending) patch.pending = FieldValue.increment(b.pending);
      if (b.rejected) patch.rejected = FieldValue.increment(b.rejected);
      if (b.offers.size > 0) patch.offers = FieldValue.arrayUnion(...Array.from(b.offers));
      writer.set(ref, patch, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
    }
    writer.onWriteError((err) => err.failedAttempts < 5);
    await writer.close();
  },

  // Bulk overwrite of GAds metrics for a single campaign-day. Called by the
  // googleAdsCampaignSyncService when it pulls daily metrics from Google Ads.
  // Idempotent — a fresh sync overwrites the previous values (these come from
  // the canonical GAds API, not user-entered).
  async updateAdsMetrics(input: {
    campaign_id: string;
    date: string;
    gads_clicks: number;
    gads_impressions: number;
    gads_cost: number;
    gads_avg_cpc: number;
    gads_ctr: number;
    spend?: number; // when set, also overwrite the canonical spend field
  }): Promise<void> {
    if (!Number.isFinite(input.gads_clicks) || input.gads_clicks < 0) {
      throw new Error('invalid_gads_clicks');
    }
    if (!Number.isFinite(input.gads_impressions) || input.gads_impressions < 0) {
      throw new Error('invalid_gads_impressions');
    }
    const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(docId(input.campaign_id, input.date));
    const patch: Record<string, unknown> = {
      campaign_id: input.campaign_id,
      date: input.date,
      gads_clicks: input.gads_clicks,
      gads_impressions: input.gads_impressions,
      gads_cost: input.gads_cost,
      gads_avg_cpc: input.gads_avg_cpc,
      gads_ctr: input.gads_ctr,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (typeof input.spend === 'number' && Number.isFinite(input.spend) && input.spend >= 0) {
      patch.spend = input.spend;
    }
    await ref.set(patch, { merge: true });
  },

  // Set/update operator-entered ad spend for a single campaign-day. Idempotent:
  // a fresh value overwrites the previous (this is a true "set", not increment)
  // because spend comes from a manual entry that the operator can edit.
  async updateSpend(input: { campaign_id: string; date: string; spend: number }): Promise<void> {
    if (!Number.isFinite(input.spend) || input.spend < 0) {
      throw new Error('invalid_spend');
    }
    const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(docId(input.campaign_id, input.date));
    await ref.set(
      {
        campaign_id: input.campaign_id,
        date: input.date,
        spend: input.spend,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  },

  // Patch the human-readable name for a campaign. Stored on every doc for that
  // campaign so a single read of a date row carries the display name.
  async updateName(input: { campaign_id: string; campaign_name: string }): Promise<void> {
    const name = String(input.campaign_name).trim().slice(0, 200);
    if (!name) throw new Error('invalid_campaign_name');
    // Touch every doc for the campaign with the new name. The number of docs
    // is small (one per active day) — a bulk writer is overkill but keeps the
    // pattern consistent.
    const snap = await db()
      .collection(COLLECTIONS.CAMPAIGN_REPORTS)
      .where('campaign_id', '==', input.campaign_id)
      .get();
    if (snap.empty) {
      // Create a placeholder doc keyed at "today" so the name persists.
      const today = dayKeyUTC(new Date());
      await db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(docId(input.campaign_id, today)).set(
        {
          campaign_id: input.campaign_id,
          campaign_name: name,
          date: today,
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return;
    }
    const writer = db().bulkWriter();
    for (const d of snap.docs) {
      writer.set(d.ref, { campaign_name: name, updated_at: FieldValue.serverTimestamp() }, { merge: true })
        .catch(() => { /* surfaced via onWriteError */ });
    }
    writer.onWriteError((err) => err.failedAttempts < 5);
    await writer.close();
  },

  async fetchRange(opts: CampaignReportRangeOptions): Promise<CampaignReportDoc[]> {
    const fromKey = dayKeyUTC(opts.from);
    const toKey = dayKeyUTC(opts.to);
    const max = Math.max(1, Math.min(opts.max ?? 50_000, 200_000));
    const idsKey = opts.campaign_ids && opts.campaign_ids.length > 0
      ? [...opts.campaign_ids].sort().join(',')
      : '';
    const cacheKey = `${fromKey}|${toKey}|${max}|${idsKey}`;

    return fetchRangeCache.getOrLoad(cacheKey, async () => {
      if (opts.campaign_ids && opts.campaign_ids.length > 0) {
        const out: CampaignReportDoc[] = [];
        const promises = opts.campaign_ids.map(async (campaign_id) => {
          const snap = await db()
            .collection(COLLECTIONS.CAMPAIGN_REPORTS)
            .where('campaign_id', '==', campaign_id)
            .where('date', '>=', fromKey)
            .where('date', '<=', toKey)
            .orderBy('date', 'asc')
            .limit(max)
            .get();
          return snap.docs.map((d) => hydrate(d.data() as Record<string, unknown>));
        });
        const chunks = await Promise.all(promises);
        for (const c of chunks) out.push(...c);
        return out;
      }

      const snap = await db()
        .collection(COLLECTIONS.CAMPAIGN_REPORTS)
        .where('date', '>=', fromKey)
        .where('date', '<=', toKey)
        .orderBy('date', 'asc')
        .limit(max)
        .get();
      return snap.docs.map((d) => hydrate(d.data() as Record<string, unknown>));
    });
  },

  // Distinct (campaign_id, campaign_name, source) pairs across the whole
  // collection. Powers the offer-linkage form's campaign picker — the
  // operator types a few characters and we surface every campaign that has
  // ever recorded data on the GAds (or utm) side. We page through the doc
  // index since there's no native distinct in Firestore; the work is bounded
  // by `max` and cached for 5 minutes so it doesn't get expensive.
  async listDistinct(max = 5000): Promise<Array<{ campaign_id: string; campaign_name?: string; source: string }>> {
    const cacheKey = `distinct|${max}`;
    return distinctCache.getOrLoad(cacheKey, async () => {
      const snap = await db()
        .collection(COLLECTIONS.CAMPAIGN_REPORTS)
        .orderBy('campaign_id', 'asc')
        .limit(max)
        .get();
      const seen = new Map<string, { campaign_id: string; campaign_name?: string; source: string }>();
      for (const d of snap.docs) {
        const raw = d.data() as Record<string, unknown>;
        const id = String(raw.campaign_id ?? '');
        if (!id || seen.has(id)) continue;
        seen.set(id, {
          campaign_id: id,
          campaign_name: typeof raw.campaign_name === 'string' ? raw.campaign_name : undefined,
          source: String(raw.source ?? 'gad_campaignid'),
        });
      }
      return [...seen.values()];
    });
  },

  // Convenience read for the detail page. Single campaign across the full
  // window, with no date filter — useful when the operator wants to see the
  // campaign's complete history regardless of the active range filter.
  async fetchByCampaign(campaign_id: string, max = 1000): Promise<CampaignReportDoc[]> {
    const snap = await db()
      .collection(COLLECTIONS.CAMPAIGN_REPORTS)
      .where('campaign_id', '==', campaign_id)
      .orderBy('date', 'asc')
      .limit(max)
      .get();
    return snap.docs.map((d) => hydrate(d.data() as Record<string, unknown>));
  },
};

function hydrate(raw: Record<string, unknown>): CampaignReportDoc {
  return {
    campaign_id: String(raw.campaign_id ?? ''),
    campaign_name: typeof raw.campaign_name === 'string' ? raw.campaign_name : undefined,
    source: String(raw.source ?? 'gad_campaignid'),
    date: String(raw.date ?? ''),
    clicks: numOr0(raw.clicks),
    postbacks: numOr0(raw.postbacks),
    conversions: numOr0(raw.conversions),
    unverified: numOr0(raw.unverified),
    revenue: numOr0(raw.revenue),
    spend: numOr0(raw.spend),
    approved: numOr0(raw.approved),
    pending: numOr0(raw.pending),
    rejected: numOr0(raw.rejected),
    offers: Array.isArray(raw.offers) ? (raw.offers as unknown[]).map(String) : [],
    gads_clicks: typeof raw.gads_clicks === 'number' ? raw.gads_clicks : undefined,
    gads_impressions: typeof raw.gads_impressions === 'number' ? raw.gads_impressions : undefined,
    gads_cost: typeof raw.gads_cost === 'number' ? raw.gads_cost : undefined,
    gads_avg_cpc: typeof raw.gads_avg_cpc === 'number' ? raw.gads_avg_cpc : undefined,
    gads_ctr: typeof raw.gads_ctr === 'number' ? raw.gads_ctr : undefined,
    updated_at:
      raw.updated_at instanceof Timestamp
        ? (raw.updated_at as Timestamp).toDate().toISOString()
        : (raw.updated_at as string | undefined),
  };
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Throttled warn so a misconfigured FX rate (or unknown currency from a single
// network) doesn't flood the logs while still surfacing the problem once.
const fxWarnCache = new Set<string>();

// Converts a postback/API payout into INR for storage on campaign_reports.
// Postback/affiliate-API payouts are USD by system convention (offer_reports
// store them raw, in USD). Campaign revenue is canonically INR, so an
// empty / missing currency is treated as USD here — otherwise toInr would
// short-circuit and leave the raw USD figure sitting in the INR-denominated
// `revenue` field (the exact regression that bit us when the reconciler tick
// kept reverting the field back to USD-as-INR).
function payoutToInr(
  payout: number,
  currency: string | undefined,
  campaign_id: string,
): number | null {
  const code = (currency ?? '').toUpperCase().trim() || 'USD';
  const inr = toInr(payout, code);
  if (inr == null) {
    const key = `campaign_revenue_fx:${code}`;
    if (!fxWarnCache.has(key)) {
      fxWarnCache.add(key);
      logger.warn('campaign_revenue_fx_missing', {
        currency: code,
        campaign_id,
        hint: 'Set GOOGLE_ADS_FX_RATES env var (e.g. INR:93,EUR:100) for this code.',
      });
    }
    return null;
  }
  return inr;
}
