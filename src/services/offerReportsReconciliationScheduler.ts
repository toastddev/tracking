// Periodic, in-process reconciliation of the offer_reports rollup against the
// raw clicks/conversions collections.
//
// Why this exists:
//   The hot-path rollup writes (postbackService, affiliateApiSyncService) use
//   FieldValue.increment which is non-idempotent: a flaky write that retries
//   over-counts, a flaky write with no retry under-counts. In production the
//   net effect was ~10-15 conversions/day going missing and a sporadic
//   over-count from manual backfills. This scheduler is the safety net that
//   makes the rollup *eventually correct* regardless of hot-path behaviour.
//
// Design:
//   - Two cadences:
//       FAST_INTERVAL_MS  → rebuild "last 24h"  (catches recent drift quickly)
//       SLOW_INTERVAL_MS  → rebuild "last 7d"   (corrects mid-tail and lets a
//                                                 daily run heal anything that
//                                                 hot-path missed earlier)
//   - Single-flight: a tick that takes longer than the interval is allowed to
//     finish; the next tick is scheduled relative to its end, not start.
//   - Safe to run alongside live writes. Backfill `set()`s — see
//     offerReportsBackfillService for the race trade-off (it warns).
//   - Disabled via OFFER_REPORTS_RECON_DISABLED=1 (ops kill-switch).
//
// Cost on Cloud Run / Firestore (at $0.06 per 100k reads):
//   At a measured volume of ~600 clicks/day + ~200 conversions/day, defaults
//   below come out to ≈ $0.30/month. Hard scan caps in
//   offerReportsBackfillService make sure a 100× traffic spike still tops
//   out at a few dollars/month rather than running away.
//   Multi-instance Cloud Run will run the scheduler on every instance — that's
//   safe (set() is last-writer-wins on identical data) but multiplies reads
//   linearly. If you have N instances always-on, expect N× the cost above.
//   To squeeze cost when scaling out, raise OFFER_REPORTS_RECON_FAST_MS or
//   set OFFER_REPORTS_RECON_DISABLED=1 on all but one instance.

import { offerReportsBackfillService } from './offerReportsBackfillService';
import { logger } from '../utils/logger';

// Defaults sized for the current low traffic — fast heal, near-zero bill.
// Override via env if traffic grows or you spin up many Cloud Run instances.
const FAST_INTERVAL_MS = Number(process.env.OFFER_REPORTS_RECON_FAST_MS ?? 30 * 60_000);   // 30 min
const SLOW_INTERVAL_MS = Number(process.env.OFFER_REPORTS_RECON_SLOW_MS ?? 24 * 60 * 60_000); // 24 h

const FAST_LOOKBACK_MS = Number(process.env.OFFER_REPORTS_RECON_FAST_LOOKBACK_MS ?? 24 * 60 * 60_000); // last 24 h
const SLOW_LOOKBACK_MS = Number(process.env.OFFER_REPORTS_RECON_SLOW_LOOKBACK_MS ?? 7 * 24 * 60 * 60_000); // last 7 d

// Cap on a single tick's wallclock duration. If a tick is still running at the
// next interval, the scheduler logs a warning and the tick continues, but we
// also refuse to start additional ticks for this many ms after a tick begins
// (single-flight). This prevents a slow run + future deadline accumulation.
const TICK_TIMEOUT_MS = Number(process.env.OFFER_REPORTS_RECON_TICK_TIMEOUT_MS ?? 10 * 60_000); // 10 min

// Initial delay before the first FAST tick. Lets the server boot complete and
// avoids running at the same instant as the affiliate API scheduler's first
// tick (which fires immediately on boot).
const FIRST_TICK_DELAY_MS = Number(process.env.OFFER_REPORTS_RECON_FIRST_DELAY_MS ?? 90_000); // 90 s

let fastInFlight = false;
let slowInFlight = false;
let fastTimer: NodeJS.Timeout | null = null;
let slowTimer: NodeJS.Timeout | null = null;
let fastStartedAt = 0;
let slowStartedAt = 0;

// Reset an in-flight flag if it's been stuck for more than TICK_TIMEOUT_MS.
// Defends against the rare case where the rebuild() promise hangs (gRPC
// deadlock / Firestore stream stall) and never resolves — without this the
// flag would stay 'true' forever and the scheduler would never tick again.
function tickStale(startedAt: number): boolean {
  return startedAt > 0 && Date.now() - startedAt > TICK_TIMEOUT_MS;
}

async function runFastTick(): Promise<void> {
  if (fastInFlight && !tickStale(fastStartedAt)) {
    logger.info('offer_reports_recon_fast_skipped_in_flight');
    return;
  }
  if (fastInFlight && tickStale(fastStartedAt)) {
    logger.warn('offer_reports_recon_fast_force_unblock', {
      stuck_for_ms: Date.now() - fastStartedAt,
    });
  }
  fastInFlight = true;
  fastStartedAt = Date.now();
  const now = new Date();
  const from = new Date(now.getTime() - FAST_LOOKBACK_MS);
  try {
    const result = await offerReportsBackfillService.rebuild({ from, to: now });
    logger.info('offer_reports_recon_fast_done', {
      from: result.from,
      to: result.to,
      clicks_scanned: result.clicks_scanned,
      conversions_scanned: result.conversions_scanned,
      buckets_written: result.buckets_written,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
      truncated_reason: result.truncated_reason,
    });
  } catch (err) {
    logger.error('offer_reports_recon_fast_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fastInFlight = false;
    fastStartedAt = 0;
  }
}

async function runSlowTick(): Promise<void> {
  if (slowInFlight && !tickStale(slowStartedAt)) {
    logger.info('offer_reports_recon_slow_skipped_in_flight');
    return;
  }
  if (slowInFlight && tickStale(slowStartedAt)) {
    logger.warn('offer_reports_recon_slow_force_unblock', {
      stuck_for_ms: Date.now() - slowStartedAt,
    });
  }
  slowInFlight = true;
  slowStartedAt = Date.now();
  const now = new Date();
  const from = new Date(now.getTime() - SLOW_LOOKBACK_MS);
  try {
    const result = await offerReportsBackfillService.rebuild({ from, to: now });
    logger.info('offer_reports_recon_slow_done', {
      from: result.from,
      to: result.to,
      clicks_scanned: result.clicks_scanned,
      conversions_scanned: result.conversions_scanned,
      buckets_written: result.buckets_written,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
      truncated_reason: result.truncated_reason,
    });
  } catch (err) {
    logger.error('offer_reports_recon_slow_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    slowInFlight = false;
    slowStartedAt = 0;
  }
}

export const offerReportsReconciliationScheduler = {
  start(): void {
    if (process.env.OFFER_REPORTS_RECON_DISABLED === '1') {
      logger.info('offer_reports_recon_disabled');
      return;
    }
    if (fastTimer || slowTimer) return;
    logger.info('offer_reports_recon_start', {
      fast_interval_ms: FAST_INTERVAL_MS,
      slow_interval_ms: SLOW_INTERVAL_MS,
      fast_lookback_ms: FAST_LOOKBACK_MS,
      slow_lookback_ms: SLOW_LOOKBACK_MS,
    });
    // Stagger the first runs so they don't pile on at boot.
    setTimeout(() => void runFastTick(), FIRST_TICK_DELAY_MS).unref?.();
    fastTimer = setInterval(() => void runFastTick(), FAST_INTERVAL_MS);
    fastTimer.unref?.();
    // Slow tick fires for the first time after one full SLOW_INTERVAL_MS —
    // FAST_INTERVAL handles initial post-deploy heal.
    slowTimer = setInterval(() => void runSlowTick(), SLOW_INTERVAL_MS);
    slowTimer.unref?.();
  },

  stop(): void {
    if (fastTimer) clearInterval(fastTimer);
    if (slowTimer) clearInterval(slowTimer);
    fastTimer = null;
    slowTimer = null;
  },

  // Exposed for ops/tests — forces a fast tick immediately.
  async runFastNow(): Promise<void> {
    return runFastTick();
  },

  async runSlowNow(): Promise<void> {
    return runSlowTick();
  },
};
