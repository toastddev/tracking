import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';

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
  spend: number;           // operator-entered or Google Ads API
  approved: number;
  pending: number;
  rejected: number;
  offers: string[];        // distinct offers seen on this campaign-day
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
}

export interface IncrementConversionInput {
  campaign_id: string;
  source: CampaignSource;
  at: Date;
  verified: boolean;
  status?: string;
  payout?: number;
  offer_id?: string;
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
    if (input.verified) {
      patch.conversions = FieldValue.increment(1);
      if (typeof input.payout === 'number' && Number.isFinite(input.payout)) {
        patch.revenue = FieldValue.increment(input.payout);
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
      b.postbacks += 1;
      if (r.verified) {
        b.conversions += 1;
        if (typeof r.payout === 'number' && Number.isFinite(r.payout)) b.revenue += r.payout;
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
    updated_at:
      raw.updated_at instanceof Timestamp
        ? (raw.updated_at as Timestamp).toDate().toISOString()
        : (raw.updated_at as string | undefined),
  };
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
