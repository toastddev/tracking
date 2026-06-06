import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import { TTLCache } from '../../utils/ttlCache';
import { toInr } from '../../utils/fxRates';
import { logger } from '../../utils/logger';

// Per-campaign daily rollup for FACEBOOK ads — separate collection from
// `campaign_reports` per project instruction. Doc id = `{campaign_id}__{date}`.
//
// campaign_id is sourced from FB-specific URL params (`fb_campaign_id`,
// fallback `utm_campaign` when `utm_source` looks Facebook-ish — see
// services/facebookCampaignExtractor.ts). Storage shape mirrors the GAds
// repo but with `fb_*` prefixed ad-platform metrics so a `gads_*` field and
// an `fb_*` field can never collide if one of these collections is ever
// joined alongside the other downstream.
//
// Writes from the hot path are atomic FieldValue.increment, same as GAds.

const fetchRangeCache = new TTLCache<FacebookCampaignReportDoc[]>({ ttlMs: 60_000, maxEntries: 128 });
const distinctCache = new TTLCache<Array<{ campaign_id: string; campaign_name?: string; source: string }>>({ ttlMs: 5 * 60_000, maxEntries: 8 });

export interface FacebookCampaignReportDoc {
  campaign_id: string;
  campaign_name?: string;
  source: string;          // 'fb_campaign_id' | 'utm_campaign'
  date: string;            // YYYY-MM-DD (UTC)
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  revenue: number;
  spend: number;           // INR — operator-entered or Meta Insights
  approved: number;
  pending: number;
  rejected: number;
  offers: string[];
  // FB-side daily metrics pulled from facebookCampaignSyncService (INR).
  fb_clicks?: number;
  fb_impressions?: number;
  fb_spend?: number;       // ≡ `spend` — denormalised for clarity at the FB layer
  fb_cpc?: number;
  fb_ctr?: number;
  fb_cpm?: number;
  fb_reach?: number;
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

// `no_match` is the grey-bucket source: clicks with utm_* but no fbclid and no
// gclid/gbraid/wbraid that didn't resolve to a real FB or GAds campaign. Lives
// in this collection for convenience (one less repository), but the read-side
// service strips it out of `totals` so neither dashboard inflates from it.
export type FacebookCampaignSource = 'fb_campaign_id' | 'utm_id' | 'utm_campaign' | 'no_match';

// Synthetic campaign id for the grey bucket. Kept here next to the type so the
// extractor, reconciler, and read-side filter all share one source of truth.
export const NO_MATCH_CAMPAIGN_ID = 'no_match_no_fbclid_or_gclid';
export const NO_MATCH_CAMPAIGN_NAME = 'No match (no fbclid / gclid)';

export interface FbIncrementClickInput {
  campaign_id: string;
  source: FacebookCampaignSource;
  at: Date;
  offer_id?: string;
  campaign_name?: string;
}

export interface FbIncrementConversionInput {
  campaign_id: string;
  source: FacebookCampaignSource;
  at: Date;
  verified: boolean;
  status?: string;
  payout?: number;
  currency?: string;
  offer_id?: string;
  campaign_name?: string;
}

export interface FacebookCampaignReportRangeOptions {
  from: Date;
  to: Date;
  campaign_ids?: string[];
  max?: number;
}

export const facebookCampaignReportRepository = {
  async incrementClick(input: FbIncrementClickInput): Promise<void> {
    const date = dayKeyUTC(input.at);
    const ref = db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(docId(input.campaign_id, date));
    const patch: Record<string, unknown> = {
      campaign_id: input.campaign_id,
      source: input.source,
      date,
      clicks: FieldValue.increment(1),
      updated_at: FieldValue.serverTimestamp(),
    };
    if (input.campaign_name) patch.campaign_name = input.campaign_name;
    if (input.offer_id) patch.offers = FieldValue.arrayUnion(input.offer_id);
    await ref.set(patch, { merge: true });
  },

  async incrementConversion(input: FbIncrementConversionInput): Promise<void> {
    const date = dayKeyUTC(input.at);
    const ref = db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(docId(input.campaign_id, date));
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

  async incrementConversionsBulk(rows: FbIncrementConversionInput[]): Promise<void> {
    if (rows.length === 0) return;
    type Bucket = {
      campaign_id: string;
      source: FacebookCampaignSource;
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
      const ref = db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(docId(b.campaign_id, b.date));
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

  async updateAdsMetrics(input: {
    campaign_id: string;
    date: string;
    fb_clicks: number;
    fb_impressions: number;
    fb_spend: number;
    fb_cpc: number;
    fb_ctr: number;
    fb_cpm?: number;
    fb_reach?: number;
    spend?: number;
  }): Promise<void> {
    if (!Number.isFinite(input.fb_clicks) || input.fb_clicks < 0) {
      throw new Error('invalid_fb_clicks');
    }
    if (!Number.isFinite(input.fb_impressions) || input.fb_impressions < 0) {
      throw new Error('invalid_fb_impressions');
    }
    const ref = db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(docId(input.campaign_id, input.date));
    const patch: Record<string, unknown> = {
      campaign_id: input.campaign_id,
      date: input.date,
      fb_clicks: input.fb_clicks,
      fb_impressions: input.fb_impressions,
      fb_spend: input.fb_spend,
      fb_cpc: input.fb_cpc,
      fb_ctr: input.fb_ctr,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (typeof input.fb_cpm === 'number' && Number.isFinite(input.fb_cpm)) patch.fb_cpm = input.fb_cpm;
    if (typeof input.fb_reach === 'number' && Number.isFinite(input.fb_reach)) patch.fb_reach = input.fb_reach;
    if (typeof input.spend === 'number' && Number.isFinite(input.spend) && input.spend >= 0) {
      patch.spend = input.spend;
    }
    await ref.set(patch, { merge: true });
  },

  async updateSpend(input: { campaign_id: string; date: string; spend: number }): Promise<void> {
    if (!Number.isFinite(input.spend) || input.spend < 0) {
      throw new Error('invalid_spend');
    }
    const ref = db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(docId(input.campaign_id, input.date));
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

  async updateName(input: {
    campaign_id: string;
    campaign_name: string;
    // When true, skip the today-placeholder fallback for campaigns that have
    // no existing row. Used by the /campaigns name-backfill pass so we don't
    // create empty rows for every paused/never-clicked campaign in an ad
    // account. The Insights pass leaves this default (writes a placeholder)
    // because it will follow up immediately with spend / clicks for the day.
    only_if_exists?: boolean;
  }): Promise<void> {
    const name = String(input.campaign_name).trim().slice(0, 200);
    if (!name) throw new Error('invalid_campaign_name');
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
      .where('campaign_id', '==', input.campaign_id)
      .get();
    if (snap.empty) {
      if (input.only_if_exists) return;
      const today = dayKeyUTC(new Date());
      await db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(docId(input.campaign_id, today)).set(
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

  async fetchRange(opts: FacebookCampaignReportRangeOptions): Promise<FacebookCampaignReportDoc[]> {
    const fromKey = dayKeyUTC(opts.from);
    const toKey = dayKeyUTC(opts.to);
    const max = Math.max(1, Math.min(opts.max ?? 50_000, 200_000));
    const idsKey = opts.campaign_ids && opts.campaign_ids.length > 0
      ? [...opts.campaign_ids].sort().join(',')
      : '';
    const cacheKey = `${fromKey}|${toKey}|${max}|${idsKey}`;

    return fetchRangeCache.getOrLoad(cacheKey, async () => {
      if (opts.campaign_ids && opts.campaign_ids.length > 0) {
        const out: FacebookCampaignReportDoc[] = [];
        const promises = opts.campaign_ids.map(async (campaign_id) => {
          const snap = await db()
            .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
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
        .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
        .where('date', '>=', fromKey)
        .where('date', '<=', toKey)
        .orderBy('date', 'asc')
        .limit(max)
        .get();
      return snap.docs.map((d) => hydrate(d.data() as Record<string, unknown>));
    });
  },

  async fetchByCampaign(campaign_id: string, max = 1000): Promise<FacebookCampaignReportDoc[]> {
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
      .where('campaign_id', '==', campaign_id)
      .orderBy('date', 'asc')
      .limit(max)
      .get();
    return snap.docs.map((d) => hydrate(d.data() as Record<string, unknown>));
  },

  // Distinct (campaign_id, campaign_name, source) pairs across the FB
  // collection. Mirrors campaignReportRepository.listDistinct — same caching
  // strategy and same use case (offer-linkage form picker).
  async listDistinct(max = 5000): Promise<Array<{ campaign_id: string; campaign_name?: string; source: string }>> {
    const cacheKey = `fb-distinct|${max}`;
    return distinctCache.getOrLoad(cacheKey, async () => {
      const snap = await db()
        .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
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
          source: String(raw.source ?? 'fb_campaign_id'),
        });
      }
      return [...seen.values()];
    });
  },
};

function hydrate(raw: Record<string, unknown>): FacebookCampaignReportDoc {
  return {
    campaign_id: String(raw.campaign_id ?? ''),
    campaign_name: typeof raw.campaign_name === 'string' ? raw.campaign_name : undefined,
    source: String(raw.source ?? 'fb_campaign_id'),
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
    fb_clicks: typeof raw.fb_clicks === 'number' ? raw.fb_clicks : undefined,
    fb_impressions: typeof raw.fb_impressions === 'number' ? raw.fb_impressions : undefined,
    fb_spend: typeof raw.fb_spend === 'number' ? raw.fb_spend : undefined,
    fb_cpc: typeof raw.fb_cpc === 'number' ? raw.fb_cpc : undefined,
    fb_ctr: typeof raw.fb_ctr === 'number' ? raw.fb_ctr : undefined,
    fb_cpm: typeof raw.fb_cpm === 'number' ? raw.fb_cpm : undefined,
    fb_reach: typeof raw.fb_reach === 'number' ? raw.fb_reach : undefined,
    updated_at:
      raw.updated_at instanceof Timestamp
        ? (raw.updated_at as Timestamp).toDate().toISOString()
        : (raw.updated_at as string | undefined),
  };
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const fxWarnCache = new Set<string>();

function payoutToInr(
  payout: number,
  currency: string | undefined,
  campaign_id: string,
): number | null {
  const code = (currency ?? '').toUpperCase().trim() || 'USD';
  const inr = toInr(payout, code);
  if (inr == null) {
    const key = `fb_campaign_revenue_fx:${code}`;
    if (!fxWarnCache.has(key)) {
      fxWarnCache.add(key);
      logger.warn('fb_campaign_revenue_fx_missing', {
        currency: code,
        campaign_id,
        hint: 'Set GOOGLE_ADS_FX_RATES env var (e.g. INR:93,EUR:100) for this code.',
      });
    }
    return null;
  }
  return inr;
}
