// Periodic reconciliation of facebook_campaign_reports against the raw
// clicks/conversions collections. Mirror of ./offerReportsReconciliationScheduler.ts
// but for the FB rollup only — offer_reports is already covered by that
// scheduler regardless of platform.
//
// Stagger note: the GAds reconciler fires its first tick at +90s. We fire at
// +120s so both schedulers don't pile on the same instance at boot.

import { facebookCampaignReportsBackfillService } from './facebookCampaignReportsBackfillService';
import { logger } from '../utils/logger';

const FAST_INTERVAL_MS = Number(process.env.FB_CAMPAIGN_REPORTS_RECON_FAST_MS ?? 60 * 60_000);
const SLOW_INTERVAL_MS = Number(process.env.FB_CAMPAIGN_REPORTS_RECON_SLOW_MS ?? 12 * 60 * 60_000);

const FAST_LOOKBACK_MS = Number(process.env.FB_CAMPAIGN_REPORTS_RECON_FAST_LOOKBACK_MS ?? 24 * 60 * 60_000);
const SLOW_LOOKBACK_MS = Number(process.env.FB_CAMPAIGN_REPORTS_RECON_SLOW_LOOKBACK_MS ?? 7 * 24 * 60 * 60_000);

const TICK_TIMEOUT_MS = Number(process.env.FB_CAMPAIGN_REPORTS_RECON_TICK_TIMEOUT_MS ?? 10 * 60_000);
const FIRST_TICK_DELAY_MS = Number(process.env.FB_CAMPAIGN_REPORTS_RECON_FIRST_DELAY_MS ?? 120_000);

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = Number(
  process.env.FB_CAMPAIGN_REPORTS_RECON_CONSECUTIVE_FAILURE_THRESHOLD ?? 3,
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
    scheduler: 'facebook_campaign_reports_recon_fast',
    tick_ms: FAST_INTERVAL_MS,
  });
  if (fastInFlight && !tickStale(fastStartedAt)) {
    logger.info('facebook_campaign_reports_recon_fast_skipped_in_flight');
    return;
  }
  if (fastInFlight && tickStale(fastStartedAt)) {
    logger.warn('facebook_campaign_reports_recon_fast_force_unblock', {
      stuck_for_ms: Date.now() - fastStartedAt,
    });
  }
  fastInFlight = true;
  fastStartedAt = Date.now();
  const now = new Date();
  const from = new Date(now.getTime() - FAST_LOOKBACK_MS);
  let tickHadFailure = false;
  try {
    const result = await facebookCampaignReportsBackfillService.rebuild({ from, to: now });
    logger.info('facebook_campaign_reports_recon_fast_done', {
      from: result.from, to: result.to,
      click_metadata_scanned: result.click_metadata_scanned,
      existing_buckets_scanned: result.existing_buckets_scanned,
      conversions_scanned: result.conversions_scanned,
      conversions_with_campaign: result.conversions_with_campaign,
      buckets_written: result.buckets_written,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
      truncated_reason: result.truncated_reason,
    });
  } catch (err) {
    tickHadFailure = true;
    const count = fastConsecutiveFailures + 1;
    const level = count >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD ? 'critical' : 'error';
    logger[level]('facebook_campaign_reports_recon_fast_failed', {
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
    scheduler: 'facebook_campaign_reports_recon_slow',
    tick_ms: SLOW_INTERVAL_MS,
  });
  if (slowInFlight && !tickStale(slowStartedAt)) {
    logger.info('facebook_campaign_reports_recon_slow_skipped_in_flight');
    return;
  }
  if (slowInFlight && tickStale(slowStartedAt)) {
    logger.warn('facebook_campaign_reports_recon_slow_force_unblock', {
      stuck_for_ms: Date.now() - slowStartedAt,
    });
  }
  slowInFlight = true;
  slowStartedAt = Date.now();
  const now = new Date();
  const from = new Date(now.getTime() - SLOW_LOOKBACK_MS);
  let tickHadFailure = false;
  try {
    const result = await facebookCampaignReportsBackfillService.rebuild({ from, to: now });
    logger.info('facebook_campaign_reports_recon_slow_done', {
      from: result.from, to: result.to,
      click_metadata_scanned: result.click_metadata_scanned,
      existing_buckets_scanned: result.existing_buckets_scanned,
      conversions_scanned: result.conversions_scanned,
      conversions_with_campaign: result.conversions_with_campaign,
      buckets_written: result.buckets_written,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
      truncated_reason: result.truncated_reason,
    });
  } catch (err) {
    tickHadFailure = true;
    const count = slowConsecutiveFailures + 1;
    const level = count >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD ? 'critical' : 'error';
    logger[level]('facebook_campaign_reports_recon_slow_failed', {
      consecutive_failures: count,
      error: err,
    });
  } finally {
    slowConsecutiveFailures = tickHadFailure ? slowConsecutiveFailures + 1 : 0;
    slowInFlight = false;
    slowStartedAt = 0;
  }
}

export const facebookReportsReconciliationScheduler = {
  start(): void {
    if (process.env.FB_CAMPAIGN_REPORTS_RECON_DISABLED === '1') {
      logger.info('facebook_campaign_reports_recon_disabled');
      return;
    }
    if (fastTimer || slowTimer) return;
    logger.info('facebook_campaign_reports_recon_start', {
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
