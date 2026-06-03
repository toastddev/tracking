// Periodic, in-process reconciliation of the rollup tables (offer_reports,
// campaign_reports, facebook_campaign_reports) against the raw clicks /
// conversions collections.
//
// Single-scan design: one tick scans clicks once + conversions once and
// dispatches every doc to every platform handler. With three handlers today
// (offer, GAds campaign, FB campaign) that's a 3× Firestore-read reduction
// per tick vs the old per-platform schedulers. Adding a 4th platform costs
// no extra Firestore reads — see ./reconciler/unifiedReconciler.ts.
//
// Cadences:
//   FAST_INTERVAL_MS  → rebuild "last 24h"  (catches recent drift quickly)
//   SLOW_INTERVAL_MS  → rebuild "last 7d"   (twice-daily safety net for the
//                                            long tail)
//
// Single-flight: a tick that overruns the interval is allowed to finish; the
// next tick is scheduled relative to its end. Stale flag-detection (
// TICK_TIMEOUT_MS) defends against a hung rebuild promise.
//
// Safe to run alongside live writes. Handlers `set(..., {merge:true})` —
// last-writer-wins on identical data. Multi-instance Cloud Run will run the
// scheduler on every instance; that's safe but multiplies reads linearly.
// Combine this with a Firestore lease lock (see refreshService.ts pattern) if
// you scale beyond 1 instance and want to avoid the multiplier.
//
// Kill-switch: OFFER_REPORTS_RECON_DISABLED=1

import { unifiedReconciler } from './reconciler/unifiedReconciler';
import { logger } from '../utils/logger';

const FAST_INTERVAL_MS = Number(process.env.OFFER_REPORTS_RECON_FAST_MS ?? 60 * 60_000);   // 1 h
const SLOW_INTERVAL_MS = Number(process.env.OFFER_REPORTS_RECON_SLOW_MS ?? 12 * 60 * 60_000); // 12 h

const FAST_LOOKBACK_MS = Number(process.env.OFFER_REPORTS_RECON_FAST_LOOKBACK_MS ?? 24 * 60 * 60_000);
const SLOW_LOOKBACK_MS = Number(process.env.OFFER_REPORTS_RECON_SLOW_LOOKBACK_MS ?? 7 * 24 * 60 * 60_000);

const TICK_TIMEOUT_MS = Number(process.env.OFFER_REPORTS_RECON_TICK_TIMEOUT_MS ?? 10 * 60_000);
const FIRST_TICK_DELAY_MS = Number(process.env.OFFER_REPORTS_RECON_FIRST_DELAY_MS ?? 90_000);

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = Number(
  process.env.OFFER_REPORTS_RECON_CONSECUTIVE_FAILURE_THRESHOLD ?? 3,
);

let fastInFlight = false;
let slowInFlight = false;
let fastTimer: NodeJS.Timeout | null = null;
let slowTimer: NodeJS.Timeout | null = null;
let fastStartedAt = 0;
let slowStartedAt = 0;
let fastConsecutiveFailures = 0;
let slowConsecutiveFailures = 0;

function tickStale(startedAt: number): boolean {
  return startedAt > 0 && Date.now() - startedAt > TICK_TIMEOUT_MS;
}

async function runFastTick(): Promise<void> {
  logger.info('scheduler_heartbeat', {
    scheduler: 'reports_recon_fast',
    tick_ms: FAST_INTERVAL_MS,
  });
  if (fastInFlight && !tickStale(fastStartedAt)) {
    logger.info('reports_recon_fast_skipped_in_flight');
    return;
  }
  if (fastInFlight && tickStale(fastStartedAt)) {
    logger.warn('reports_recon_fast_force_unblock', {
      stuck_for_ms: Date.now() - fastStartedAt,
    });
  }
  fastInFlight = true;
  fastStartedAt = Date.now();
  const now = new Date();
  const from = new Date(now.getTime() - FAST_LOOKBACK_MS);
  let tickHadFailure = false;
  try {
    // ONE scan, all handlers. Result includes per-handler stats so any single
    // handler's failure is surfaced separately without aborting the others.
    const result = await unifiedReconciler.runAll({ from, to: now });
    logger.info('reports_recon_fast_done', {
      from: result.from, to: result.to,
      clicks_scanned: result.clicks_scanned,
      conversions_scanned: result.conversions_scanned,
      orphan_clicks_fetched: result.orphan_clicks_fetched,
      duration_ms: result.duration_ms,
      handlers: result.handlers.map((h) => ({
        name: h.name, ok: h.ok, buckets_written: h.buckets_written,
        truncated: h.truncated,
      })),
    });
    // If ANY handler failed, count as tick failure for the alert escalation.
    if (result.handlers.some((h) => !h.ok)) tickHadFailure = true;
  } catch (err) {
    tickHadFailure = true;
    const count = fastConsecutiveFailures + 1;
    const level = count >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD ? 'critical' : 'error';
    logger[level]('reports_recon_fast_failed', {
      consecutive_failures: count,
      error: err,
    });
  } finally {
    fastConsecutiveFailures = tickHadFailure ? fastConsecutiveFailures + 1 : 0;
    fastInFlight = false;
    fastStartedAt = 0;
  }
}

async function runSlowTick(): Promise<void> {
  logger.info('scheduler_heartbeat', {
    scheduler: 'reports_recon_slow',
    tick_ms: SLOW_INTERVAL_MS,
  });
  if (slowInFlight && !tickStale(slowStartedAt)) {
    logger.info('reports_recon_slow_skipped_in_flight');
    return;
  }
  if (slowInFlight && tickStale(slowStartedAt)) {
    logger.warn('reports_recon_slow_force_unblock', {
      stuck_for_ms: Date.now() - slowStartedAt,
    });
  }
  slowInFlight = true;
  slowStartedAt = Date.now();
  const now = new Date();
  const from = new Date(now.getTime() - SLOW_LOOKBACK_MS);
  let tickHadFailure = false;
  try {
    const result = await unifiedReconciler.runAll({ from, to: now });
    logger.info('reports_recon_slow_done', {
      from: result.from, to: result.to,
      clicks_scanned: result.clicks_scanned,
      conversions_scanned: result.conversions_scanned,
      orphan_clicks_fetched: result.orphan_clicks_fetched,
      duration_ms: result.duration_ms,
      handlers: result.handlers.map((h) => ({
        name: h.name, ok: h.ok, buckets_written: h.buckets_written,
        truncated: h.truncated,
      })),
    });
    if (result.handlers.some((h) => !h.ok)) tickHadFailure = true;
  } catch (err) {
    tickHadFailure = true;
    const count = slowConsecutiveFailures + 1;
    const level = count >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD ? 'critical' : 'error';
    logger[level]('reports_recon_slow_failed', {
      consecutive_failures: count,
      error: err,
    });
  } finally {
    slowConsecutiveFailures = tickHadFailure ? slowConsecutiveFailures + 1 : 0;
    slowInFlight = false;
    slowStartedAt = 0;
  }
}

export const offerReportsReconciliationScheduler = {
  start(): void {
    if (process.env.OFFER_REPORTS_RECON_DISABLED === '1') {
      logger.info('reports_recon_disabled');
      return;
    }
    if (fastTimer || slowTimer) return;
    logger.info('reports_recon_start', {
      fast_interval_ms: FAST_INTERVAL_MS,
      slow_interval_ms: SLOW_INTERVAL_MS,
      fast_lookback_ms: FAST_LOOKBACK_MS,
      slow_lookback_ms: SLOW_LOOKBACK_MS,
    });
    setTimeout(() => void runFastTick(), FIRST_TICK_DELAY_MS).unref?.();
    fastTimer = setInterval(() => void runFastTick(), FAST_INTERVAL_MS);
    fastTimer.unref?.();
    slowTimer = setInterval(() => void runSlowTick(), SLOW_INTERVAL_MS);
    slowTimer.unref?.();
  },

  stop(): void {
    if (fastTimer) clearInterval(fastTimer);
    if (slowTimer) clearInterval(slowTimer);
    fastTimer = null;
    slowTimer = null;
  },

  async runFastNow(): Promise<void> { return runFastTick(); },
  async runSlowNow(): Promise<void> { return runSlowTick(); },
};
