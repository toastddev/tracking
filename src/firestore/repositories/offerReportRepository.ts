import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';

// Offer-level pre-aggregated daily metrics. Doc id = `{offer_id}__{YYYY-MM-DD}`
// (UTC day). This collection survives the 90-day TTL on clicks/conversions —
// the source rows can be deleted after 90 days but reports stay queryable.
//
// Writes are atomic increments (FieldValue.increment) issued from the click
// and postback hot paths. Reads use a single (offer_id, date) range scan.
export interface OfferReportDoc {
  offer_id: string;
  date: string;          // ISO date YYYY-MM-DD (UTC)
  clicks: number;
  postbacks: number;     // verified + unverified, excluding shadow rows
  conversions: number;   // verified only
  unverified: number;    // postbacks - conversions
  revenue: number;       // sum of payout for verified
  approved: number;      // verified with status approved
  pending: number;       // verified with status pending
  rejected: number;      // verified with status rejected
  unique_aff_ids?: number; // approximate distinct aff_ids (best-effort, not strict)
  updated_at?: string;
}

function docId(offer_id: string, date: string): string {
  return `${offer_id}__${date}`;
}

// Coerce status string → bucket key. Anything not in the canonical list rolls
// into 'approved' since most networks default to approved when status is
// missing.
function statusBucket(status: string | undefined): 'approved' | 'pending' | 'rejected' {
  const s = (status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'reversed') return 'rejected';
  return 'approved';
}

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface IncrementClickInput {
  offer_id: string;
  at: Date;
}

export interface IncrementConversionInput {
  offer_id: string;
  at: Date;
  verified: boolean;
  status?: string;
  payout?: number;
}

export interface OfferReportRangeOptions {
  from: Date;
  to: Date;
  offer_ids?: string[];   // optional restrict
  max?: number;
}

export const offerReportRepository = {
  // Atomic upsert. `set({...}, { merge: true })` handles the create-on-first-write
  // case; FieldValue.increment is associative across concurrent writers.
  async incrementClick(input: IncrementClickInput): Promise<void> {
    const date = dayKeyUTC(input.at);
    const ref = db().collection(COLLECTIONS.OFFER_REPORTS).doc(docId(input.offer_id, date));
    await ref.set(
      {
        offer_id: input.offer_id,
        date,
        clicks: FieldValue.increment(1),
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  },

  async incrementConversion(input: IncrementConversionInput): Promise<void> {
    const date = dayKeyUTC(input.at);
    const ref = db().collection(COLLECTIONS.OFFER_REPORTS).doc(docId(input.offer_id, date));
    const patch: Record<string, unknown> = {
      offer_id: input.offer_id,
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
    await ref.set(patch, { merge: true });
  },

  // Bulk variant for the affiliate API sync flush. One BulkWriter pass, one
  // increment per offer/day. Saves a Firestore RTT per record on big runs.
  async incrementConversionsBulk(rows: IncrementConversionInput[]): Promise<void> {
    if (rows.length === 0) return;
    // Aggregate increments per (offer_id, date) so we issue one write per bucket.
    type Bucket = {
      offer_id: string;
      date: string;
      postbacks: number;
      conversions: number;
      unverified: number;
      revenue: number;
      approved: number;
      pending: number;
      rejected: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const date = dayKeyUTC(r.at);
      const key = `${r.offer_id}|${date}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          offer_id: r.offer_id,
          date,
          postbacks: 0,
          conversions: 0,
          unverified: 0,
          revenue: 0,
          approved: 0,
          pending: 0,
          rejected: 0,
        };
        buckets.set(key, b);
      }
      b.postbacks += 1;
      if (r.verified) {
        b.conversions += 1;
        if (typeof r.payout === 'number' && Number.isFinite(r.payout)) b.revenue += r.payout;
        const sb = statusBucket(r.status);
        b[sb] += 1;
      } else {
        b.unverified += 1;
      }
    }

    const writer = db().bulkWriter();
    for (const b of buckets.values()) {
      const ref = db().collection(COLLECTIONS.OFFER_REPORTS).doc(docId(b.offer_id, b.date));
      const patch: Record<string, unknown> = {
        offer_id: b.offer_id,
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
      writer.set(ref, patch, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
    }
    writer.onWriteError((err) => err.failedAttempts < 5);
    await writer.close();
  },

  // Range fetch in date order. Optionally restricted to a set of offers.
  // Without `offer_ids`, returns all docs in the range — caller filters.
  async fetchRange(opts: OfferReportRangeOptions): Promise<OfferReportDoc[]> {
    const fromKey = dayKeyUTC(opts.from);
    const toKey = dayKeyUTC(opts.to);
    const max = Math.max(1, Math.min(opts.max ?? 50_000, 200_000));

    if (opts.offer_ids && opts.offer_ids.length > 0) {
      // Fan out per offer — Firestore "in" supports up to 30 values, and we
      // need ordered date scans anyway. Parallel queries are cheap.
      const out: OfferReportDoc[] = [];
      const promises = opts.offer_ids.map(async (offer_id) => {
        const snap = await db()
          .collection(COLLECTIONS.OFFER_REPORTS)
          .where('offer_id', '==', offer_id)
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
      .collection(COLLECTIONS.OFFER_REPORTS)
      .where('date', '>=', fromKey)
      .where('date', '<=', toKey)
      .orderBy('date', 'asc')
      .limit(max)
      .get();
    return snap.docs.map((d) => hydrate(d.data() as Record<string, unknown>));
  },
};

function hydrate(raw: Record<string, unknown>): OfferReportDoc {
  return {
    offer_id: String(raw.offer_id ?? ''),
    date: String(raw.date ?? ''),
    clicks: numOr0(raw.clicks),
    postbacks: numOr0(raw.postbacks),
    conversions: numOr0(raw.conversions),
    unverified: numOr0(raw.unverified),
    revenue: numOr0(raw.revenue),
    approved: numOr0(raw.approved),
    pending: numOr0(raw.pending),
    rejected: numOr0(raw.rejected),
    updated_at:
      raw.updated_at instanceof Timestamp
        ? (raw.updated_at as Timestamp).toDate().toISOString()
        : (raw.updated_at as string | undefined),
  };
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
