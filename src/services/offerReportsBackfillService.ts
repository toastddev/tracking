import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { logger } from '../utils/logger';
import {
  eventDateFromRaw,
  BACKFILL_SCAN_PAD_BEFORE_MS,
  BACKFILL_SCAN_PAD_AFTER_MS,
} from './eventTime';
import { normalizePayout } from '../utils/fxRates';

// Reconstructs conversion-side fields in offer_reports from source
// conversions. Click counts are intentionally not recalculated here: they are
// only incremented from the /click redirect path, which is the canonical click
// counter.
// It is idempotent: each run computes conversion totals locally, then
// overwrites only conversion-related fields in the daily rollup docs.
//
// Scope: all UTC days touched by [from, to]. The default window is the last
// 120 days (covers the 90-day TTL ceiling with a buffer).
//
// Concurrency note: live writes via postbackService/API sync also touch
// the rollup. Running this during low-traffic periods is recommended — any
// conversion that lands while the backfill is computing may be overwritten
// until the next reconciliation tick. The service emits a warning so the
// admin sees the trade-off.

const PAGE = 1000;          // Firestore page size for streaming reads
// Safety ceilings — protect against runaway costs if traffic spikes 100×
// or if a manual call passes a wide window. Tunable via env so ops can raise
// the cap deliberately for one-off historical rebuilds.
const MAX_CONVERSIONS_SCAN = Number(process.env.OFFER_REPORTS_BACKFILL_MAX_CONVERSIONS ?? 200_000);
const MAX_BUCKETS_FLUSH    = Number(process.env.OFFER_REPORTS_BACKFILL_MAX_BUCKETS     ?? 50_000);
const STATUS_BUCKETS = ['approved', 'pending', 'rejected'] as const;
type StatusBucket = (typeof STATUS_BUCKETS)[number];

interface Bucket {
  offer_id: string;
  network_id: string;
  date: string;
  postbacks: number;
  conversions: number;
  unverified: number;
  revenue: number;
  approved: number;
  pending: number;
  rejected: number;
  unknown_click_conversions: number;
  unknown_click_revenue: number;
}

function emptyBucket(offer_id: string, network_id: string, date: string): Bucket {
  return {
    offer_id,
    network_id,
    date,
    postbacks: 0,
    conversions: 0,
    unverified: 0,
    revenue: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    unknown_click_conversions: 0,
    unknown_click_revenue: 0,
  };
}

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
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
  clicks_untouched: true;
  existing_buckets_scanned: number;
  conversions_scanned: number;
  buckets_written: number;
  duration_ms: number;
  truncated?: boolean;       // true if any safety cap was hit
  truncated_reason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const offerReportsBackfillService = {
  async rebuild(opts: BackfillOptions = {}): Promise<BackfillResult> {
    const started = Date.now();
    const requestedTo = opts.to ?? new Date();
    const requestedFrom = opts.from ?? new Date(requestedTo.getTime() - 120 * DAY_MS);

    // The target docs are daily rollups. If we scan only "last 6 hours" and
    // then `set()` a YYYY-MM-DD doc, we replace the full day's count with a
    // partial count. Normalize the scan to whole UTC days before overwriting.
    const from = startOfUtcDay(requestedFrom);
    const to = endOfUtcDay(requestedTo);
    logger.info('offer_reports_backfill_started', {
      requested_from: requestedFrom.toISOString(),
      requested_to: requestedTo.toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const fromDay = dayKeyUTC(from);
    const toDay = dayKeyUTC(to);
    const buckets = new Map<string, Bucket>();
    const bucketFor = (offer_id: string, network_id: string, date: string): Bucket => {
      const key = `${offer_id}__${network_id}__${date}`;
      let b = buckets.get(key);
      if (!b) { b = emptyBucket(offer_id, network_id, date); buckets.set(key, b); }
      return b;
    };

    // ── 1. existing daily docs ───────────────────────────────────────
    // Seed buckets from current rollup docs so conversion fields can be
    // zeroed when raw conversions no longer exist for that bucket. We do not
    // read or write click counts here.
    const clicks_scanned = 0;
    let existing_buckets_scanned = 0;
    let truncated = false;
    let truncated_reason: string | undefined;
    {
      const snap = await db()
        .collection(COLLECTIONS.OFFER_REPORTS)
        .where('date', '>=', fromDay)
        .where('date', '<=', toDay)
        .orderBy('date', 'asc')
        .limit(MAX_BUCKETS_FLUSH + 1)
        .get();
      existing_buckets_scanned = snap.size;
      if (snap.size > MAX_BUCKETS_FLUSH) {
        truncated = true;
        truncated_reason = `bucket_cap_reached (${snap.size}/${MAX_BUCKETS_FLUSH})`;
        logger.warn('offer_reports_backfill_existing_bucket_cap_hit', {
          bucket_count: snap.size,
          cap: MAX_BUCKETS_FLUSH,
        });
      } else {
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          const offer_id = String(raw.offer_id ?? '').trim();
          const network_id = String(raw.network_id ?? 'none').trim() || 'none';
          const date = String(raw.date ?? '').trim();
          if (!offer_id || !date) continue;
          bucketFor(offer_id, network_id, date);
        }
      }
    }

    // ── 2. conversions ───────────────────────────────────────────────
    let conversions_scanned = 0;
    {
      // Widen the receipt-time scan to catch rows whose event-day falls
      // inside [from, to] but whose receipt-day spills outside (late API
      // pulls). The event-day bounds check inside the loop discards rows
      // outside the requested window.
      const scanFrom = new Date(from.getTime() - BACKFILL_SCAN_PAD_BEFORE_MS);
      const scanTo = new Date(to.getTime() + BACKFILL_SCAN_PAD_AFTER_MS);
      let cursor: Date | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (conversions_scanned >= MAX_CONVERSIONS_SCAN) {
          truncated = true;
          truncated_reason = `conversions_cap_reached (${MAX_CONVERSIONS_SCAN})`;
          logger.warn('offer_reports_backfill_conversions_cap_hit', {
            scanned: conversions_scanned,
            cap: MAX_CONVERSIONS_SCAN,
          });
          break;
        }
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CONVERSIONS)
          .where('created_at', '>=', scanFrom)
          .where('created_at', '<=', scanTo)
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
          // Unknown-click rows are kept (bucketed under offer_id='unknown')
          // so reports can show them tagged via unknown_click_* counters.
          // Verified rows without an offer_id (very rare legacy bug) are
          // dropped — there's nowhere sane to attribute them.
          const verified = Boolean(raw.verified);
          let offer_id = (raw.offer_id as string | undefined);
          if (!offer_id) {
            if (verified) continue;
            offer_id = 'unknown';
          }
          const at = tsToDate(raw.created_at);
          if (!at) continue;
          const eventAt = eventDateFromRaw(at, raw.network_timestamp);
          const eventDay = dayKeyUTC(eventAt);
          if (eventDay < fromDay || eventDay > toDay) continue;
          const rawPayout = typeof raw.payout === 'number' ? (raw.payout as number) : 0;
          const currency = typeof raw.currency === 'string' ? raw.currency : undefined;
          const payout = normalizePayout(rawPayout, currency) ?? 0;
          const status = raw.status as string | undefined;
          const network_id = (raw.network_id as string | undefined) || 'none';
          const verification_reason = raw.verification_reason as string | undefined;

          const b = bucketFor(offer_id, network_id, eventDay);
          b.postbacks += 1;
          if (verified) {
            b.conversions += 1;
            if (Number.isFinite(payout)) b.revenue += payout;
            b[statusBucket(status)] += 1;
          } else {
            b.unverified += 1;
            if (verification_reason === 'unknown_click_id') {
              b.unknown_click_conversions += 1;
              if (Number.isFinite(payout)) b.unknown_click_revenue += payout;
            }
          }
          conversions_scanned += 1;
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    // ── 3. flush ─────────────────────────────────────────────────────
    // Merge-write conversion fields only. Existing click counters are left
    // untouched, including on docs that also hold network_id='none' data.
    let buckets_written = 0;
    if (buckets.size > MAX_BUCKETS_FLUSH) {
      truncated = true;
      truncated_reason = `bucket_cap_reached (${buckets.size}/${MAX_BUCKETS_FLUSH})`;
      logger.warn('offer_reports_backfill_bucket_cap_hit', {
        bucket_count: buckets.size,
        cap: MAX_BUCKETS_FLUSH,
      });
    }
    if (!truncated && buckets.size > 0 && buckets.size <= MAX_BUCKETS_FLUSH) {
      const writer = db().bulkWriter();
      writer.onWriteError((err) => err.failedAttempts < 5);
      for (const b of buckets.values()) {
        const ref = db().collection(COLLECTIONS.OFFER_REPORTS).doc(`${b.offer_id}__${b.network_id}__${b.date}`);
        writer.set(ref, {
          offer_id: b.offer_id,
          network_id: b.network_id,
          date: b.date,
          postbacks: b.postbacks,
          conversions: b.conversions,
          unverified: b.unverified,
          revenue: b.revenue,
          approved: b.approved,
          pending: b.pending,
          rejected: b.rejected,
          unknown_click_conversions: b.unknown_click_conversions,
          unknown_click_revenue: b.unknown_click_revenue,
          updated_at: FieldValue.serverTimestamp(),
          backfilled_at: FieldValue.serverTimestamp(),
        }, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
        buckets_written += 1;
      }
      await writer.close();
    }

    const result: BackfillResult = {
      from: from.toISOString(),
      to: to.toISOString(),
      clicks_scanned,
      clicks_untouched: true,
      existing_buckets_scanned,
      conversions_scanned,
      buckets_written,
      duration_ms: Date.now() - started,
      ...(truncated ? { truncated, truncated_reason } : {}),
    };
    logger.info('offer_reports_backfill_completed', { ...result });
    return result;
  },
};
