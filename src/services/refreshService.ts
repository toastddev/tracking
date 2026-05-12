import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { affiliateApiRepository } from '../firestore';
import { affiliateApiScheduler } from './affiliateApiScheduler';
import { offerReportsBackfillService } from './offerReportsBackfillService';
import { campaignReportsBackfillService } from './campaignReportsBackfillService';
import { generateConversionId } from '../utils/idGenerator';
import { logger } from '../utils/logger';

// Orchestrated "refresh everything" used by the operator's Refresh button on
// the reports pages.
//
// ── Sequence ───────────────────────────────────────────────────────
//   1. Acquire a leased Firestore lock so concurrent refresh attempts (from
//      another Cloud Run instance or a double-clicking operator) get rejected
//      with the in-progress run_id instead of stomping on each other.
//   2. Create a `refresh_runs/{run_id}` doc — the source of truth that the UI
//      polls for live progress. Any Cloud Run instance can serve those polls.
//   3. Walk every configured affiliate API and run each sequentially (manual
//      triggered_by). Sequential — not parallel — so we don't blow through
//      third-party rate limits during a manual nudge. After each API the run
//      doc is updated with success/failure status and any error message.
//   4. Read the last successful refresh timestamp from app_state. Backfill
//      offer_reports + campaign_reports from that timestamp -> now. If no
//      previous refresh exists, default to the last 7 days. Both backfills
//      stream progress into the run doc.
//   5. Stamp app_state with the new timestamp so the next refresh covers
//      only the missing slice. Release the lock.
//
// ── Cloud Run safety ───────────────────────────────────────────────
// The lease (LEASE_MS, default 30 min) bounds how long a crashed instance
// can hold the lock — long enough to cover a worst-case run, short enough
// that a permanently-dead instance doesn't strand the next attempt. While
// the run is in flight, the lease is auto-extended every LEASE_EXTEND_MS so
// even a 60-min run won't be considered stale.

const REFRESH_STATE_DOC = 'refresh_state';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = Number(process.env.REFRESH_DEFAULT_LOOKBACK_DAYS ?? 7);
const MAX_LOOKBACK_DAYS = Number(process.env.REFRESH_MAX_LOOKBACK_DAYS ?? 120);
const LEASE_MS = Number(process.env.REFRESH_LEASE_MS ?? 30 * 60_000);
const LEASE_EXTEND_MS = Number(process.env.REFRESH_LEASE_EXTEND_MS ?? 5 * 60_000);
// Maximum age before considering a run "stale" even without an explicit
// finished_at — defensive cleanup for orphans from instances that crashed
// before they could write the final state.
const RUN_STALE_MS = Number(process.env.REFRESH_RUN_STALE_MS ?? 2 * 60 * 60_000);

// Per-process unique holder so we can attribute lock acquisition + reject
// our own stale state on boot. Random nonce because Cloud Run can reuse
// hostnames across cold starts.
const HOLDER = `${hostname()}#${process.pid}#${randomBytes(3).toString('hex')}`;

export type RefreshStep =
  | { kind: 'init'; label: string }
  | { kind: 'api'; api_id: string; name: string; ok: boolean; run_id?: string; reason?: string; duration_ms: number }
  | { kind: 'backfill_offers'; ok: boolean; conversions_scanned?: number; buckets_written?: number; duration_ms?: number; error?: string; truncated?: boolean; truncated_reason?: string }
  | { kind: 'backfill_campaigns'; ok: boolean; conversions_scanned?: number; buckets_written?: number; duration_ms?: number; error?: string; truncated?: boolean; truncated_reason?: string; campaign_spends_updated?: number };

export type RefreshRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type RefreshPhase =
  | 'init'
  | 'apis'
  | 'backfill_offers'
  | 'backfill_campaigns'
  | 'finalising'
  | 'done';

export interface RefreshRunDoc {
  run_id: string;
  holder: string;
  status: RefreshRunStatus;
  // High-level phase the operator can read at a glance.
  phase: RefreshPhase;
  // One-line human description of what's happening right now.
  current_step: string;
  // Numerical progress for affiliate API walk (so the UI can render N / total).
  apis_total: number;
  apis_done: number;
  apis_succeeded: number;
  apis_failed: number;
  apis_skipped: number;
  // Step history — appended as the run progresses. Bounded by the number of
  // distinct steps (count of APIs + 2 backfills + init) so the doc stays
  // small even on big accounts.
  steps: RefreshStep[];
  // Errors accumulated across the run. Even a successful run can have errors
  // (one API failed but others succeeded) — surface those distinctly from a
  // top-level failure.
  errors: Array<{ phase: RefreshPhase; message: string; at: string }>;
  backfill_from: string | null;
  backfill_to: string | null;
  previous_refresh_at: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

interface RefreshStateDoc {
  // The lock + last-successful pointer share a doc so a single transactional
  // read covers both.
  active_run_id?: string;
  active_holder?: string;
  active_lease_until?: Timestamp;
  last_refresh_at?: Timestamp;
  updated_at?: Timestamp;
}

function timestampToIso(ts: Timestamp | undefined): string | null {
  return ts ? ts.toDate().toISOString() : null;
}

function hydrateRun(raw: Record<string, unknown>): RefreshRunDoc {
  return {
    run_id: String(raw.run_id ?? ''),
    holder: String(raw.holder ?? ''),
    status: (raw.status as RefreshRunStatus) ?? 'pending',
    phase: (raw.phase as RefreshPhase) ?? 'init',
    current_step: String(raw.current_step ?? ''),
    apis_total: Number(raw.apis_total ?? 0),
    apis_done: Number(raw.apis_done ?? 0),
    apis_succeeded: Number(raw.apis_succeeded ?? 0),
    apis_failed: Number(raw.apis_failed ?? 0),
    apis_skipped: Number(raw.apis_skipped ?? 0),
    steps: Array.isArray(raw.steps) ? (raw.steps as RefreshStep[]) : [],
    errors: Array.isArray(raw.errors)
      ? (raw.errors as Array<{ phase: RefreshPhase; message: string; at: string }>)
      : [],
    backfill_from: (raw.backfill_from as string | null | undefined) ?? null,
    backfill_to: (raw.backfill_to as string | null | undefined) ?? null,
    previous_refresh_at: timestampToIso(raw.previous_refresh_at as Timestamp | undefined),
    started_at:
      timestampToIso(raw.started_at as Timestamp | undefined) ?? new Date().toISOString(),
    finished_at: timestampToIso(raw.finished_at as Timestamp | undefined),
    duration_ms:
      typeof raw.duration_ms === 'number' ? (raw.duration_ms as number) : null,
  };
}

function stateRef() {
  return db().collection(COLLECTIONS.APP_STATE).doc(REFRESH_STATE_DOC);
}

function runRef(run_id: string) {
  return db().collection(COLLECTIONS.REFRESH_RUNS).doc(run_id);
}

export interface AcquireResult {
  ok: boolean;
  run_id?: string;
  // When ok=false, the existing run that holds the lock (so the UI can attach
  // to its progress instead of waiting blind).
  active_run_id?: string;
  active_started_at?: string;
}

// Acquire the global refresh lock via Firestore transaction. Returns the
// new run_id on success; on failure (lock held & lease not expired) returns
// the active run_id so the UI can poll it.
async function acquireLock(): Promise<AcquireResult> {
  const run_id = generateConversionId();
  const now = Date.now();
  const result = await db().runTransaction<AcquireResult>(async (tx) => {
    const snap = await tx.get(stateRef());
    const data = (snap.data() as RefreshStateDoc | undefined) ?? {};
    const heldUntil = data.active_lease_until?.toMillis();
    const stillHeld =
      data.active_run_id && heldUntil && heldUntil > now;
    if (stillHeld) {
      // Belt-and-suspenders: cross-check the run doc to ensure it actually
      // exists and is in a non-terminal state. A stranded lease + missing
      // run doc (extremely rare race) is treated as "lock free".
      const runSnap = await tx.get(runRef(data.active_run_id!));
      if (runSnap.exists) {
        const runData = runSnap.data() as Record<string, unknown>;
        const status = String(runData.status ?? '');
        if (status === 'pending' || status === 'running') {
          return {
            ok: false,
            active_run_id: data.active_run_id,
            active_started_at:
              timestampToIso(runData.started_at as Timestamp | undefined) ?? undefined,
          };
        }
      }
    }
    tx.set(
      stateRef(),
      {
        active_run_id: run_id,
        active_holder: HOLDER,
        active_lease_until: Timestamp.fromMillis(now + LEASE_MS),
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.set(runRef(run_id), {
      run_id,
      holder: HOLDER,
      status: 'running' as RefreshRunStatus,
      phase: 'init' as RefreshPhase,
      current_step: 'Starting refresh',
      apis_total: 0,
      apis_done: 0,
      apis_succeeded: 0,
      apis_failed: 0,
      apis_skipped: 0,
      steps: [{ kind: 'init', label: 'Acquired refresh lock' }],
      errors: [],
      backfill_from: null,
      backfill_to: null,
      previous_refresh_at: data.last_refresh_at ?? null,
      started_at: FieldValue.serverTimestamp(),
      finished_at: null,
      duration_ms: null,
    });
    return { ok: true, run_id };
  });
  return result;
}

async function extendLease(run_id: string): Promise<void> {
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(stateRef());
    const data = (snap.data() as RefreshStateDoc | undefined) ?? {};
    // Only extend if we still hold the lock. Otherwise something already
    // forced us off — don't reclaim it silently.
    if (data.active_run_id !== run_id || data.active_holder !== HOLDER) return;
    tx.update(stateRef(), {
      active_lease_until: Timestamp.fromMillis(Date.now() + LEASE_MS),
      updated_at: FieldValue.serverTimestamp(),
    });
  });
}

async function releaseLock(run_id: string, success: boolean): Promise<void> {
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(stateRef());
    const data = (snap.data() as RefreshStateDoc | undefined) ?? {};
    if (data.active_run_id !== run_id) return; // Not ours — leave it.
    const patch: Record<string, unknown> = {
      active_run_id: FieldValue.delete(),
      active_holder: FieldValue.delete(),
      active_lease_until: FieldValue.delete(),
      updated_at: FieldValue.serverTimestamp(),
    };
    if (success) patch.last_refresh_at = FieldValue.serverTimestamp();
    tx.update(stateRef(), patch);
  });
}

async function patchRun(run_id: string, patch: Record<string, unknown>): Promise<void> {
  await runRef(run_id).set(
    {
      ...patch,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function appendStep(run_id: string, step: RefreshStep): Promise<void> {
  await runRef(run_id).set(
    {
      steps: FieldValue.arrayUnion(step),
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function appendError(
  run_id: string,
  phase: RefreshPhase,
  message: string
): Promise<void> {
  await runRef(run_id).set(
    {
      errors: FieldValue.arrayUnion({ phase, message, at: new Date().toISOString() }),
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// Force-release leases whose owning run is unambiguously dead. Called from
// the controller on read so a crashed Cloud Run instance doesn't strand the
// lock for the full LEASE_MS window. Returns the cleaned run_id if it did
// anything.
async function reapStaleLockIfNeeded(): Promise<string | null> {
  const reaped = await db().runTransaction<string | null>(async (tx) => {
    const snap = await tx.get(stateRef());
    const data = (snap.data() as RefreshStateDoc | undefined) ?? {};
    if (!data.active_run_id) return null;
    const now = Date.now();
    const heldUntil = data.active_lease_until?.toMillis();
    // If the lease is still alive, leave it alone.
    if (heldUntil && heldUntil > now) return null;
    // Lease has expired. Look at the run doc — if it's terminal, just clear
    // the lock. If it's still 'running' but the lease has expired, the
    // owning instance crashed: mark the run failed and clear the lock.
    const runSnap = await tx.get(runRef(data.active_run_id));
    const updates: Record<string, unknown> = {
      active_run_id: FieldValue.delete(),
      active_holder: FieldValue.delete(),
      active_lease_until: FieldValue.delete(),
      updated_at: FieldValue.serverTimestamp(),
    };
    tx.update(stateRef(), updates);
    if (runSnap.exists) {
      const runData = runSnap.data() as Record<string, unknown>;
      const status = String(runData.status ?? '');
      if (status === 'pending' || status === 'running') {
        tx.update(runRef(data.active_run_id), {
          status: 'failed' as RefreshRunStatus,
          phase: 'done' as RefreshPhase,
          current_step: 'Aborted: owning instance died (lease expired)',
          errors: FieldValue.arrayUnion({
            phase: 'finalising',
            message: 'Owning Cloud Run instance lost lease before completing the run',
            at: new Date().toISOString(),
          }),
          finished_at: FieldValue.serverTimestamp(),
        });
      }
    }
    return data.active_run_id;
  });
  if (reaped) logger.warn('refresh_lock_reaped', { run_id: reaped, holder: HOLDER });
  return reaped;
}

export interface RefreshStartResult {
  ok: boolean;
  run_id?: string;
  reason?: 'already_running';
  active_run_id?: string;
  active_started_at?: string;
}

export const refreshService = {
  // ── Status reads ────────────────────────────────────────────────
  async getStatus(): Promise<{
    last_refresh_at: string | null;
    active_run_id: string | null;
  }> {
    // Opportunistically reap a stale lock so the UI's status read self-heals
    // after an instance crash — no separate scheduler needed.
    await reapStaleLockIfNeeded().catch(() => undefined);
    const snap = await stateRef().get();
    const data = (snap.data() as RefreshStateDoc | undefined) ?? {};
    return {
      last_refresh_at: timestampToIso(data.last_refresh_at),
      active_run_id: data.active_run_id ?? null,
    };
  },

  async getRun(run_id: string): Promise<RefreshRunDoc | null> {
    const snap = await runRef(run_id).get();
    if (!snap.exists) return null;
    return hydrateRun(snap.data() as Record<string, unknown>);
  },

  // Admin force-unlock. The auto-reaper only fires once the lease expires
  // (default 30 min). When an operator knows the holding instance is dead
  // (e.g. they killed their local dev server mid-refresh), this clears the
  // lock immediately so the next refresh can start.
  async forceUnlock(): Promise<{ ok: true; cleared_run_id: string | null }> {
    const cleared = await db().runTransaction<string | null>(async (tx) => {
      const snap = await tx.get(stateRef());
      const data = (snap.data() as RefreshStateDoc | undefined) ?? {};
      if (!data.active_run_id) return null;
      const active_run_id = data.active_run_id;
      tx.update(stateRef(), {
        active_run_id: FieldValue.delete(),
        active_holder: FieldValue.delete(),
        active_lease_until: FieldValue.delete(),
        updated_at: FieldValue.serverTimestamp(),
      });
      const runSnap = await tx.get(runRef(active_run_id));
      if (runSnap.exists) {
        const status = String((runSnap.data() as Record<string, unknown>).status ?? '');
        if (status === 'pending' || status === 'running') {
          tx.update(runRef(active_run_id), {
            status: 'failed' as RefreshRunStatus,
            phase: 'done' as RefreshPhase,
            current_step: 'Aborted: admin force-unlocked',
            errors: FieldValue.arrayUnion({
              phase: 'finalising',
              message: 'Refresh lock force-released by admin',
              at: new Date().toISOString(),
            }),
            finished_at: FieldValue.serverTimestamp(),
          });
        }
      }
      return active_run_id;
    });
    logger.warn('refresh_force_unlocked', { run_id: cleared, holder: HOLDER });
    return { ok: true, cleared_run_id: cleared };
  },

  // ── Acquire-and-run ─────────────────────────────────────────────
  // Tries to take the lock and run a refresh. If the lock is held by another
  // instance, returns {ok:false, reason:'already_running', active_run_id}.
  // The caller (HTTP handler) blocks on the actual work and the run doc
  // streams progress in parallel.
  async refreshAll(): Promise<RefreshStartResult> {
    await reapStaleLockIfNeeded().catch(() => undefined);
    const acquired = await acquireLock();
    if (!acquired.ok) {
      logger.info('refresh_rejected_already_running', {
        holder: HOLDER,
        active_run_id: acquired.active_run_id,
      });
      return {
        ok: false,
        reason: 'already_running',
        active_run_id: acquired.active_run_id,
        active_started_at: acquired.active_started_at,
      };
    }
    const run_id = acquired.run_id!;
    logger.info('refresh_started', { run_id, holder: HOLDER });

    // Auto-extend the lease while the run is in flight so a long run can't
    // be reaped from under us.
    const extendTimer = setInterval(() => {
      void extendLease(run_id).catch((err) => {
        logger.warn('refresh_lease_extend_failed', {
          run_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, LEASE_EXTEND_MS);
    extendTimer.unref?.();

    try {
      await this.runWithProgress(run_id);
      return { ok: true, run_id };
    } finally {
      clearInterval(extendTimer);
    }
  },

  // ── The actual work — writes progress as it goes ───────────────
  async runWithProgress(run_id: string): Promise<void> {
    const started = Date.now();

    // ── 1. Affiliate APIs ─────────────────────────────────────────
    let apis: Awaited<ReturnType<typeof affiliateApiRepository.list>>['items'] = [];
    try {
      const all = await affiliateApiRepository.list({ limit: 100 });
      apis = all.items;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await appendError(run_id, 'apis', `Failed to list affiliate APIs: ${message}`);
      logger.warn('refresh_list_apis_failed', { run_id, error: message });
    }

    await patchRun(run_id, {
      phase: 'apis' as RefreshPhase,
      current_step:
        apis.length === 0
          ? 'No affiliate APIs configured'
          : `Running ${apis.length} affiliate API${apis.length === 1 ? '' : 's'}`,
      apis_total: apis.length,
    });

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < apis.length; i++) {
      const api = apis[i]!;
      const idx = i + 1;
      // Live "what are we doing right now" update before kicking off the API.
      await patchRun(run_id, {
        current_step: `Running affiliate API ${idx}/${apis.length}: ${api.name}`,
      });

      // Paused APIs are skipped on the orchestrated refresh — the operator
      // paused them deliberately and a manual nudge shouldn't override that.
      if (api.status === 'paused') {
        const step: RefreshStep = {
          kind: 'api',
          api_id: api.api_id,
          name: api.name,
          ok: false,
          reason: 'paused',
          duration_ms: 0,
        };
        await appendStep(run_id, step);
        skipped += 1;
        await patchRun(run_id, {
          apis_done: idx,
          apis_skipped: skipped,
        });
        continue;
      }

      const t0 = Date.now();
      let stepResult: RefreshStep;
      try {
        const result = await affiliateApiScheduler.runNow(api.api_id, { triggered_by: 'manual' });
        const duration_ms = Date.now() - t0;
        if (result.ok) {
          stepResult = {
            kind: 'api',
            api_id: api.api_id,
            name: api.name,
            ok: true,
            run_id: result.run_id,
            duration_ms,
          };
          succeeded += 1;
        } else {
          stepResult = {
            kind: 'api',
            api_id: api.api_id,
            name: api.name,
            ok: false,
            reason: result.reason,
            duration_ms,
          };
          failed += 1;
          await appendError(run_id, 'apis', `${api.name}: ${result.reason}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stepResult = {
          kind: 'api',
          api_id: api.api_id,
          name: api.name,
          ok: false,
          reason: message,
          duration_ms: Date.now() - t0,
        };
        failed += 1;
        await appendError(run_id, 'apis', `${api.name}: ${message}`);
        logger.warn('refresh_api_threw', { run_id, api_id: api.api_id, error: message });
      }
      await appendStep(run_id, stepResult);
      await patchRun(run_id, {
        apis_done: idx,
        apis_succeeded: succeeded,
        apis_failed: failed,
        apis_skipped: skipped,
      });
    }

    // ── 2. Backfills ─────────────────────────────────────────────
    // Default window: last_refresh_at -> now, clamped to MAX_LOOKBACK_DAYS.
    // First-run fallback: DEFAULT_LOOKBACK_DAYS so we don't accidentally
    // re-scan the full 120-day default.
    const stateSnap = await stateRef().get();
    const previousRefresh = (stateSnap.data() as RefreshStateDoc | undefined)?.last_refresh_at?.toDate();

    let backfillFrom: Date;
    if (previousRefresh) {
      backfillFrom = previousRefresh;
    } else {
      backfillFrom = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS);
    }
    const minFrom = new Date(Date.now() - MAX_LOOKBACK_DAYS * DAY_MS);
    if (backfillFrom < minFrom) backfillFrom = minFrom;
    const backfillTo = new Date();

    await patchRun(run_id, {
      phase: 'backfill_offers' as RefreshPhase,
      current_step: `Backfilling offer reports (${backfillFrom.toISOString().slice(0, 10)} → ${backfillTo.toISOString().slice(0, 10)})`,
      backfill_from: backfillFrom.toISOString(),
      backfill_to: backfillTo.toISOString(),
    });

    let offerOk = false;
    let offerStep: RefreshStep;
    try {
      const r = await offerReportsBackfillService.rebuild({ from: backfillFrom, to: backfillTo });
      offerOk = true;
      offerStep = {
        kind: 'backfill_offers',
        ok: true,
        conversions_scanned: r.conversions_scanned,
        buckets_written: r.buckets_written,
        duration_ms: r.duration_ms,
        ...(r.truncated ? { truncated: r.truncated, truncated_reason: r.truncated_reason } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      offerStep = { kind: 'backfill_offers', ok: false, error: message };
      await appendError(run_id, 'backfill_offers', message);
      logger.error('refresh_offer_backfill_failed', { run_id, error: message });
    }
    await appendStep(run_id, offerStep);

    await patchRun(run_id, {
      phase: 'backfill_campaigns' as RefreshPhase,
      current_step: `Backfilling campaign reports (${backfillFrom.toISOString().slice(0, 10)} → ${backfillTo.toISOString().slice(0, 10)})`,
    });

    let campaignOk = false;
    let campaignStep: RefreshStep;
    try {
      const r = await campaignReportsBackfillService.rebuild({ from: backfillFrom, to: backfillTo });
      campaignOk = true;
      campaignStep = {
        kind: 'backfill_campaigns',
        ok: true,
        conversions_scanned: r.conversions_scanned,
        buckets_written: r.buckets_written,
        duration_ms: r.duration_ms,
        ...(r.truncated ? { truncated: r.truncated, truncated_reason: r.truncated_reason } : {}),
        campaign_spends_updated: r.campaign_spends?.length ?? 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      campaignStep = { kind: 'backfill_campaigns', ok: false, error: message };
      await appendError(run_id, 'backfill_campaigns', message);
      logger.error('refresh_campaign_backfill_failed', { run_id, error: message });
    }
    await appendStep(run_id, campaignStep);

    // ── 3. Finalise ──────────────────────────────────────────────
    await patchRun(run_id, {
      phase: 'finalising' as RefreshPhase,
      current_step: 'Releasing lock',
    });

    const success = offerOk && campaignOk;
    const finished = new Date();
    await releaseLock(run_id, success);

    await patchRun(run_id, {
      status: success ? ('completed' as RefreshRunStatus) : ('failed' as RefreshRunStatus),
      phase: 'done' as RefreshPhase,
      current_step: success
        ? `Refresh complete in ${((finished.getTime() - started) / 1000).toFixed(1)}s`
        : `Refresh finished with errors in ${((finished.getTime() - started) / 1000).toFixed(1)}s`,
      finished_at: FieldValue.serverTimestamp(),
      duration_ms: finished.getTime() - started,
    });

    logger.info('refresh_completed', {
      run_id,
      duration_ms: finished.getTime() - started,
      apis_succeeded: succeeded,
      apis_failed: failed,
      apis_skipped: skipped,
      offer_ok: offerOk,
      campaign_ok: campaignOk,
    });
  },
};

// Re-exported for tests.
export const __refreshInternals = {
  HOLDER,
  LEASE_MS,
  RUN_STALE_MS,
  reapStaleLockIfNeeded,
};
