import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firestore/config';
import { COLLECTIONS } from '../../firestore/schema';
import { logger } from '../../utils/logger';
import { toUsd, defaultConversionCurrency } from '../../utils/fxRates';
import { eventDateFromRaw } from '../eventTime';
import {
  dayKeyUTC,
  statusBucket,
  tsToDate,
  type FlushResult,
  type PrepareResult,
  type ReconcilerHandler,
  type ReconcilerWindow,
} from './types';

// Handler for `offer_reports`. Mirror of the existing offerReportsBackfillService
// logic, refactored to fit the unified reconciler's per-doc dispatch shape.
//
// Doesn't scan clicks — offer rollups don't need click metadata.

const MAX_CONVERSIONS_SCAN = Number(process.env.OFFER_REPORTS_BACKFILL_MAX_CONVERSIONS ?? 200_000);
const MAX_BUCKETS_FLUSH = Number(process.env.OFFER_REPORTS_BACKFILL_MAX_BUCKETS ?? 50_000);

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
    offer_id, network_id, date,
    postbacks: 0, conversions: 0, unverified: 0, revenue: 0,
    approved: 0, pending: 0, rejected: 0,
    unknown_click_conversions: 0, unknown_click_revenue: 0,
  };
}

// Throttled across the whole run — one line per unratable currency.
const fxWarnCache = new Set<string>();

export function createOfferReportsHandler(): ReconcilerHandler {
  const buckets = new Map<string, Bucket>();
  let window: ReconcilerWindow | null = null;
  let existing_buckets_scanned = 0;
  let conversions_scanned = 0;
  let revenue_fx_skipped = 0;
  let truncated = false;
  let truncated_reason: string | undefined;
  const started = Date.now();

  const bucketFor = (offer_id: string, network_id: string, date: string): Bucket => {
    const key = `${offer_id}__${network_id}__${date}`;
    let b = buckets.get(key);
    if (!b) { b = emptyBucket(offer_id, network_id, date); buckets.set(key, b); }
    return b;
  };

  // offer_reports.revenue is canonically USD. Payouts arrive in mixed
  // currencies, so every one is converted before it joins the total —
  // summing raw payouts would add a ¥100 row as if it were $100.
  function payoutToUsd(payout: number, currency: string | undefined): number | null {
    const code = (currency ?? '').trim() || defaultConversionCurrency();
    const usd = toUsd(payout, code);
    if (usd == null) {
      revenue_fx_skipped += 1;
      const key = `offer_backfill_fx:${code}`;
      if (!fxWarnCache.has(key)) {
        fxWarnCache.add(key);
        logger.warn('offer_reports_backfill_revenue_fx_missing', {
          currency: code,
          hint: 'Add this code to FX_RATES in src/utils/fxRates.constants.ts (units per USD).',
        });
      }
      return null;
    }
    return usd;
  }

  return {
    name: 'offer_reports',
    needsClickScan: false,

    async prepare(w: ReconcilerWindow): Promise<PrepareResult> {
      window = w;
      const snap = await db()
        .collection(COLLECTIONS.OFFER_REPORTS)
        .where('date', '>=', w.fromDay)
        .where('date', '<=', w.toDay)
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
        return { participates: false, existing_buckets_scanned, truncated, truncated_reason };
      }
      for (const d of snap.docs) {
        const raw = d.data() as Record<string, unknown>;
        const offer_id = String(raw.offer_id ?? '').trim();
        const network_id = String(raw.network_id ?? 'none').trim() || 'none';
        const date = String(raw.date ?? '').trim();
        if (!offer_id || !date) continue;
        bucketFor(offer_id, network_id, date);
      }
      return { participates: true, existing_buckets_scanned };
    },

    processClick(): void { /* offer reports don't scan clicks */ },

    processConversion(_id: string, raw: Record<string, unknown>): void {
      if (!window) return;
      if (raw.shadow === true) return;
      if (conversions_scanned >= MAX_CONVERSIONS_SCAN) {
        if (!truncated) {
          truncated = true;
          truncated_reason = `conversions_cap_reached (${MAX_CONVERSIONS_SCAN})`;
          logger.warn('offer_reports_backfill_conversions_cap_hit', {
            scanned: conversions_scanned,
            cap: MAX_CONVERSIONS_SCAN,
          });
        }
        return;
      }
      const verified = Boolean(raw.verified);
      let offer_id = raw.offer_id as string | undefined;
      if (!offer_id) {
        if (verified) return;
        offer_id = 'unknown';
      }
      const at = tsToDate(raw.created_at);
      if (!at) return;
      const eventAt = eventDateFromRaw(at, raw.network_timestamp);
      const eventDay = dayKeyUTC(eventAt);
      if (eventDay < window.fromDay || eventDay > window.toDay) return;

      const payout = typeof raw.payout === 'number' ? raw.payout : 0;
      const status = raw.status as string | undefined;
      const network_id = (raw.network_id as string | undefined) || 'none';
      const verification_reason = raw.verification_reason as string | undefined;
      const currency = (raw.currency as string | undefined) || '';
      const usd = Number.isFinite(payout) ? payoutToUsd(payout, currency) : null;

      const b = bucketFor(offer_id, network_id, eventDay);
      b.postbacks += 1;
      if (verified) {
        b.conversions += 1;
        if (usd != null) b.revenue += usd;
        b[statusBucket(status)] += 1;
      } else {
        b.unverified += 1;
        if (verification_reason === 'unknown_click_id') {
          b.unknown_click_conversions += 1;
          if (usd != null) b.unknown_click_revenue += usd;
        }
      }
      conversions_scanned += 1;
    },

    needsOrphanLookup(): boolean { return false; },
    processOrphanClick(): void { /* not needed */ },

    async flush(): Promise<FlushResult> {
      if (truncated) {
        return {
          name: 'offer_reports', ok: false,
          buckets_written: 0,
          conversions_scanned,
          existing_buckets_scanned,
          truncated, truncated_reason,
          duration_ms: Date.now() - started,
        };
      }
      if (buckets.size > MAX_BUCKETS_FLUSH) {
        truncated = true;
        truncated_reason = `bucket_cap_reached (${buckets.size}/${MAX_BUCKETS_FLUSH})`;
        logger.warn('offer_reports_backfill_bucket_cap_hit', {
          bucket_count: buckets.size, cap: MAX_BUCKETS_FLUSH,
        });
        return {
          name: 'offer_reports', ok: false,
          buckets_written: 0,
          conversions_scanned,
          existing_buckets_scanned,
          truncated, truncated_reason,
          duration_ms: Date.now() - started,
        };
      }
      let buckets_written = 0;
      if (buckets.size > 0) {
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
      return {
        name: 'offer_reports', ok: true,
        buckets_written,
        conversions_scanned,
        existing_buckets_scanned,
        revenue_fx_skipped,
        duration_ms: Date.now() - started,
      };
    },
  };
}
