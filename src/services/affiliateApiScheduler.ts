import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { affiliateApiRepository, affiliateApiRunRepository } from '../firestore';
import { runAffiliateApi } from './affiliateApiSyncService';
import { logger } from '../utils/logger';

const TICK_MS = Number(process.env.AFF_API_TICK_MS ?? 60_000);            // 1 min
const MAX_PER_TICK = Number(process.env.AFF_API_MAX_PER_TICK ?? 25);
const CONCURRENCY = Number(process.env.AFF_API_CONCURRENCY ?? 4);
// Lease covers the upper bound of one run: max_pages × per-call timeout.
// Defaults: 50 pages × 30s = 25 min worst case, so 1 hour gives breathing
// room. Crashed runners auto-unblock once the lease expires.
const LEASE_MS = Number(process.env.AFF_API_LEASE_MS ?? 60 * 60_000);     // 1 hour
// On boot, mark any run from *this instance* still in 'running' state
// older than this as aborted. 5 min by default.
const STALE_RUN_MS = Number(process.env.AFF_API_STALE_RUN_MS ?? 5 * 60_000);
// Global fallback: any run (regardless of holder) stuck at 'running' for
// longer than this is almost certainly dead. Catches orphans from instances
// that crashed permanently and never rebooted with the same holder id.
const GLOBAL_STALE_RUN_MS = Number(process.env.AFF_API_GLOBAL_STALE_RUN_MS ?? 60 * 60_000); // 1 hour

// Cloud Run can recycle hostnames across cold starts, so we include a
// random nonce to keep each incarnation's holder unique.
const HOLDER = `${hostname()}#${process.pid}#${randomBytes(3).toString('hex')}`;

let timer: NodeJS.Timeout | null = null;
let inFlight = 0;
const running = new Set<string>();

async function tick(): Promise<void> {
  let due;
  try {
    due = await affiliateApiRepository.listDue(new Date(), MAX_PER_TICK);
  } catch (err) {
    logger.warn('aff_api_scheduler_list_due_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (due.length === 0) return;

  for (const api of due) {
    if (inFlight >= CONCURRENCY) break;
    if (running.has(api.api_id)) continue;
    if (!api.schedule.enabled) continue;

    const acquired = await affiliateApiRepository.tryAcquireLock(api.api_id, HOLDER, LEASE_MS).catch((err) => {
      logger.warn('aff_api_lock_failed', { api_id: api.api_id, error: String(err) });
      return false;
    });
    if (!acquired) continue;

    inFlight++;
    running.add(api.api_id);
    void (async () => {
      try {
        const run = await runAffiliateApi(api, { triggered_by: 'schedule', holder: HOLDER });
        logger.info('aff_api_run_done', {
          api_id: api.api_id,
          run_id: run.run_id,
          status: run.status,
          inserted: run.records_inserted,
          duplicates: run.records_skipped_duplicate,
          unknown_click: run.records_skipped_unknown_click,
          failed: run.records_failed,
          http_calls: run.http_calls,
        });
      } catch (err) {
        logger.error('aff_api_scheduled_run_threw', {
          api_id: api.api_id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Best-effort: mark the orphaned run doc so it doesn't stay stuck
        // at 'running' forever and block future "Run now" requests.
        await affiliateApiRunRepository
          .markLatestRunningAsError(api.api_id, err instanceof Error ? err.message : String(err))
          .catch(() => undefined);
      } finally {
        await affiliateApiRepository.releaseLock(api.api_id, HOLDER).catch(() => undefined);
        running.delete(api.api_id);
        inFlight--;
      }
    })();
  }
}

export const affiliateApiScheduler = {
  start(): void {
    if (timer) return;
    if (process.env.AFF_API_SCHEDULER_DISABLED === '1') {
      logger.info('aff_api_scheduler_disabled');
      return;
    }
    logger.info('aff_api_scheduler_start', {
      tick_ms: TICK_MS,
      concurrency: CONCURRENCY,
      lease_ms: LEASE_MS,
      holder: HOLDER,
    });
    // ── Boot-time orphan cleanup (two-tier) ──────────────────────────
    //
    // Tier 1 — Instance-scoped (fast, safe):
    //   Mark runs tagged with THIS holder that are still 'running' and
    //   older than STALE_RUN_MS. These are orphans from a previous
    //   incarnation of this exact process (--watch reload, SIGKILL, OOM).
    //   Safe: we own them, nobody else is working on them.
    //
    // Tier 2 — Global fallback (slow, conservative):
    //   Mark ANY 'running' run older than GLOBAL_STALE_RUN_MS (default
    //   1 hour). Catches orphans from instances that crashed permanently
    //   and will never reboot with the same holder. The 1-hour threshold
    //   is deliberately generous — worst-case run (50 pages × 30s) is
    //   ~25 min, so 1 hour means the run is very certainly dead.
    void Promise.allSettled([
      affiliateApiRunRepository
        .markStaleRunningAsAborted(STALE_RUN_MS, HOLDER)
        .then((n) => {
          if (n > 0) logger.info('aff_api_orphan_runs_aborted', { scope: 'holder', count: n });
        }),
      affiliateApiRunRepository
        .markStaleRunningAsAborted(GLOBAL_STALE_RUN_MS)
        .then((n) => {
          if (n > 0) logger.info('aff_api_orphan_runs_aborted', { scope: 'global', count: n });
        }),
    ]).catch((err) => {
      logger.warn('aff_api_orphan_cleanup_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Fire once on boot so freshly-due APIs don't wait a full tick.
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  // Used by the manual-run admin endpoint when the run shouldn't wait for
  // the next tick. Shares the same in-memory running set as the scheduler
  // so a manual click can't collide with an in-flight scheduled run on the
  // same node — and the Firestore lock guards across nodes.
  async runNow(api_id: string, opts: { triggered_by: 'manual' }): Promise<{ ok: true; run_id: string } | { ok: false; reason: string }> {
    const api = await affiliateApiRepository.getById(api_id);
    if (!api) return { ok: false, reason: 'not_found' };
    if (running.has(api_id)) return { ok: false, reason: 'locked' };
    const acquired = await affiliateApiRepository.tryAcquireLock(api_id, HOLDER, LEASE_MS);
    if (!acquired) return { ok: false, reason: 'locked' };
    running.add(api_id);
    try {
      const run = await runAffiliateApi(api, { triggered_by: opts.triggered_by, holder: HOLDER });
      return { ok: true, run_id: run.run_id };
    } catch (err) {
      // Mark the orphaned run doc as error so it doesn't block the next attempt.
      await affiliateApiRunRepository
        .markLatestRunningAsError(api_id, err instanceof Error ? err.message : String(err))
        .catch(() => undefined);
      return { ok: false, reason: 'run_failed' };
    } finally {
      await affiliateApiRepository.releaseLock(api_id, HOLDER).catch(() => undefined);
      running.delete(api_id);
    }
  },
};

