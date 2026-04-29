import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { logger } from '../utils/logger';

// Reconstructs the offer_reports rollup collection from the source clicks
// and conversions data. Idempotent — each run computes the totals locally,
// then overwrites the rollup docs with `set` (no FieldValue.increment).
//
// Scope: clicks/conversions whose created_at falls in [from, to]. The default
// window is the last 120 days (covers the 90-day TTL ceiling with a buffer).
//
// Concurrency note: live writes via clickService/postbackService also touch
// the rollup. Running this during low-traffic periods is recommended — any
// click/conversion that lands while the backfill is computing may be lost
// when the backfill writes the bucket. The service emits a warning so the
// admin sees the trade-off.

const PAGE = 1000;          // Firestore page size for streaming reads
const STATUS_BUCKETS = ['approved', 'pending', 'rejected'] as const;
type StatusBucket = (typeof STATUS_BUCKETS)[number];

interface Bucket {
  offer_id: string;
  date: string;
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  revenue: number;
  approved: number;
  pending: number;
  rejected: number;
}

function emptyBucket(offer_id: string, date: string): Bucket {
  return {
    offer_id,
    date,
    clicks: 0,
    postbacks: 0,
    conversions: 0,
    unverified: 0,
    revenue: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
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

export interface BackfillOptions {
  from?: Date;
  to?: Date;
}

export interface BackfillResult {
  from: string;
  to: string;
  clicks_scanned: number;
  conversions_scanned: number;
  buckets_written: number;
  duration_ms: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const offerReportsBackfillService = {
  async rebuild(opts: BackfillOptions = {}): Promise<BackfillResult> {
    const started = Date.now();
    const to = opts.to ?? new Date();
    const from = opts.from ?? new Date(to.getTime() - 120 * DAY_MS);
    logger.info('offer_reports_backfill_started', { from: from.toISOString(), to: to.toISOString() });

    const buckets = new Map<string, Bucket>();
    const bucketFor = (offer_id: string, date: string): Bucket => {
      const key = `${offer_id}__${date}`;
      let b = buckets.get(key);
      if (!b) { b = emptyBucket(offer_id, date); buckets.set(key, b); }
      return b;
    };

    // ── 1. clicks ────────────────────────────────────────────────────
    let clicks_scanned = 0;
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
          bucketFor(offer_id, dayKeyUTC(at)).clicks += 1;
          clicks_scanned += 1;
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    // ── 2. conversions ───────────────────────────────────────────────
    let conversions_scanned = 0;
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
          // Skip shadow rows — those are audit-only postbacks for API-backed
          // networks and should not double-count against the API source.
          if (raw.shadow === true) continue;
          const offer_id = (raw.offer_id as string | undefined) ?? '';
          if (!offer_id) continue;     // unverified rows without an offer can't be attributed
          const at = tsToDate(raw.created_at);
          if (!at) continue;
          const verified = Boolean(raw.verified);
          const payout = typeof raw.payout === 'number' ? (raw.payout as number) : 0;
          const status = raw.status as string | undefined;
          const b = bucketFor(offer_id, dayKeyUTC(at));
          b.postbacks += 1;
          if (verified) {
            b.conversions += 1;
            if (Number.isFinite(payout)) b.revenue += payout;
            b[statusBucket(status)] += 1;
          } else {
            b.unverified += 1;
          }
          conversions_scanned += 1;
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    // ── 3. flush ─────────────────────────────────────────────────────
    // Plain `set` (overwrite). Re-running the backfill simply recomputes
    // the same totals; live increments racing with the backfill window may
    // be lost — see file-header note.
    let buckets_written = 0;
    if (buckets.size > 0) {
      const writer = db().bulkWriter();
      writer.onWriteError((err) => err.failedAttempts < 5);
      for (const b of buckets.values()) {
        const ref = db().collection(COLLECTIONS.OFFER_REPORTS).doc(`${b.offer_id}__${b.date}`);
        writer.set(ref, {
          offer_id: b.offer_id,
          date: b.date,
          clicks: b.clicks,
          postbacks: b.postbacks,
          conversions: b.conversions,
          unverified: b.unverified,
          revenue: b.revenue,
          approved: b.approved,
          pending: b.pending,
          rejected: b.rejected,
          updated_at: FieldValue.serverTimestamp(),
          backfilled_at: FieldValue.serverTimestamp(),
        }).catch(() => { /* surfaced via onWriteError */ });
        buckets_written += 1;
      }
      await writer.close();
    }

    const result: BackfillResult = {
      from: from.toISOString(),
      to: to.toISOString(),
      clicks_scanned,
      conversions_scanned,
      buckets_written,
      duration_ms: Date.now() - started,
    };
    logger.info('offer_reports_backfill_completed', { ...result });
    return result;
  },
};
