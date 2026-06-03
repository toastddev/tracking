import { db } from '../../firestore/config';
import { COLLECTIONS } from '../../firestore/schema';
import { logger } from '../../utils/logger';
import { BACKFILL_SCAN_PAD_BEFORE_MS, BACKFILL_SCAN_PAD_AFTER_MS } from '../eventTime';
import { createOfferReportsHandler } from './offerReportsHandler';
import { createGoogleAdsCampaignHandler } from './googleAdsCampaignHandler';
import { createFacebookCampaignHandler } from './facebookCampaignHandler';
import {
  dayKeyUTC,
  endOfUtcDay,
  startOfUtcDay,
  tsToDate,
  type FlushResult,
  type ReconcilerHandler,
  type ReconcilerWindow,
} from './types';

// The unified reconciler: scans `clicks` and `conversions` ONCE per tick and
// dispatches every raw doc to every participating handler. The cost win:
//
//   Old design (N independent backfills):
//     N × clicks_collection_scan  +  N × conversions_collection_scan
//
//   New design (this file):
//     1 × clicks_collection_scan  +  1 × conversions_collection_scan
//
// At 3 handlers (offer + GAds + FB) that's a 3× read reduction per tick.
// Adding a 4th platform (TikTok, MS Ads, …) costs no extra Firestore reads —
// just one more handler dispatch per doc (pure CPU, free).
//
// Lifecycle (see ./types.ts for the per-handler contract):
//   1. Build the canonical window (whole UTC days).
//   2. For each handler: handler.prepare(window) — reads existing rollup,
//      builds initial bucket map. Returns participates=false to opt out.
//   3. If ANY participating handler needs clicks: scan clicks once. Dispatch
//      every doc to every handler that opted into the clicks pass.
//   4. Scan conversions once. Dispatch every doc to every handler.
//   5. Collect orphan click_ids — clicks the conversions pass needs but
//      didn't see in step 3. Each handler reports its own want list; main
//      unions them, fetches in one batched getAll, dispatches results.
//   6. Promise.all(handlers.map(h => h.flush())) — parallel writes to
//      different collections, no contention.
//
// Failure isolation: every handler method is wrapped in try/catch. A bug or
// throw in handler A doesn't abort handler B. Handler A's flush is still
// invoked but the result carries ok:false + the error.

const PAGE = 1000;
const ORPHAN_CHUNK = 300;
// Hard cap so a runaway orphan set (which would happen if every conversion in
// the window referenced an unseen click) can't blow up Firestore reads.
const ORPHAN_TOTAL_CAP = Number(process.env.RECONCILER_ORPHAN_TOTAL_CAP ?? 50_000);

export type HandlerName = 'offer_reports' | 'campaign_reports' | 'facebook_campaign_reports';

export interface UnifiedReconcilerOptions {
  from?: Date;
  to?: Date;
  // Subset of handlers to run. Default = all three. Used by the legacy
  // backfill wrappers to run a single handler from admin endpoints.
  handlers?: HandlerName[];
}

export interface UnifiedReconcilerResult {
  from: string;
  to: string;
  // Aggregate counts across the single scan — gives the operator a sense of
  // raw read cost regardless of which handlers participated.
  clicks_scanned: number;
  conversions_scanned: number;
  orphan_clicks_fetched: number;
  duration_ms: number;
  // Per-handler results, in the order they were dispatched. ok:false means
  // the handler caught an exception or truncated; flush either skipped or
  // partial.
  handlers: FlushResult[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function buildHandlers(filter: HandlerName[] | undefined): ReconcilerHandler[] {
  const all: ReconcilerHandler[] = [
    createOfferReportsHandler(),
    createGoogleAdsCampaignHandler(),
    createFacebookCampaignHandler(),
  ];
  if (!filter || filter.length === 0) return all;
  const want = new Set<string>(filter);
  return all.filter((h) => want.has(h.name as HandlerName));
}

export const unifiedReconciler = {
  async runAll(opts: UnifiedReconcilerOptions = {}): Promise<UnifiedReconcilerResult> {
    const started = Date.now();
    const requestedTo = opts.to ?? new Date();
    const requestedFrom = opts.from ?? new Date(requestedTo.getTime() - 120 * DAY_MS);

    const from = startOfUtcDay(requestedFrom);
    const to = endOfUtcDay(requestedTo);
    const window: ReconcilerWindow = {
      from, to,
      fromDay: dayKeyUTC(from),
      toDay: dayKeyUTC(to),
      scanFrom: new Date(from.getTime() - BACKFILL_SCAN_PAD_BEFORE_MS),
      scanTo: new Date(to.getTime() + BACKFILL_SCAN_PAD_AFTER_MS),
    };

    const allHandlers = buildHandlers(opts.handlers);
    logger.info('unified_reconciler_started', {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      handlers: allHandlers.map((h) => h.name),
    });

    // ── 1. prepare (per-handler existing-rollup read) ────────────────
    // Each handler reads its own collection's existing rollup docs to seed
    // its bucket map. These reads are necessarily per-collection (different
    // collections) — that's the one cost we can't share.
    const active: ReconcilerHandler[] = [];
    for (const h of allHandlers) {
      try {
        const res = await h.prepare(window);
        if (res.participates) {
          active.push(h);
        } else {
          logger.warn('unified_reconciler_handler_skipped', {
            handler: h.name,
            truncated: res.truncated,
            truncated_reason: res.truncated_reason,
          });
        }
      } catch (err) {
        logger.error('unified_reconciler_handler_prepare_failed', {
          handler: h.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (active.length === 0) {
      // Nothing to do — every handler opted out. Still write the run record
      // so caller sees the empty result.
      return {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        clicks_scanned: 0,
        conversions_scanned: 0,
        orphan_clicks_fetched: 0,
        duration_ms: Date.now() - started,
        handlers: allHandlers.map<FlushResult>((h) => ({
          name: h.name, ok: false, buckets_written: 0,
          truncated: true, truncated_reason: 'prepare_skipped',
        })),
      };
    }

    // ── 2. clicks pass (only if any active handler asked for it) ─────
    let clicks_scanned = 0;
    const needsClickScan = active.some((h) => h.needsClickScan);
    if (needsClickScan) {
      let cursor: Date | null = null;
      let pages = 0;
      const phaseStart = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CLICKS)
          .where('created_at', '>=', window.from)
          .where('created_at', '<=', window.to)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          const at = tsToDate(raw.created_at);
          if (!at) continue;
          clicks_scanned += 1;
          // Dispatch — synchronous, pure CPU per handler. try/catch isolates
          // a buggy handler from killing the scan.
          for (const h of active) {
            if (!h.needsClickScan) continue;
            try {
              h.processClick(d.id, raw);
            } catch (err) {
              logger.error('unified_reconciler_processClick_failed', {
                handler: h.name, click_id: d.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        pages += 1;
        if (pages % 5 === 0) {
          logger.info('unified_reconciler_clicks_scan_progress', {
            pages, scanned: clicks_scanned,
            elapsed_ms: Date.now() - phaseStart,
          });
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
      logger.info('unified_reconciler_clicks_scan_done', {
        pages, scanned: clicks_scanned,
        elapsed_ms: Date.now() - phaseStart,
      });
    }

    // ── 3. conversions pass ──────────────────────────────────────────
    let conversions_scanned = 0;
    let orphan_clicks_fetched = 0;
    {
      let cursor: Date | null = null;
      let pages = 0;
      const phaseStart = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CONVERSIONS)
          .where('created_at', '>=', window.scanFrom)
          .where('created_at', '<=', window.scanTo)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;

        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          conversions_scanned += 1;
          for (const h of active) {
            try {
              h.processConversion(d.id, raw);
            } catch (err) {
              logger.error('unified_reconciler_processConversion_failed', {
                handler: h.name, conversion_id: d.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        // After each page, drain orphan click lookups. We do this per-page
        // (not once at the end) so the orphanWants sets stay bounded and we
        // can resolve deferred conversions sooner.
        const orphanUnion = new Set<string>();
        for (const h of active) {
          // Walk this handler's deferred set via needsOrphanLookup. We don't
          // expose the set directly — handlers answer per-id. To collect, we
          // sample the conversion docs we just saw for their click_ids and
          // ask each handler.
          for (const d of snap.docs) {
            const raw = d.data() as Record<string, unknown>;
            const click_id = (raw.click_id as string | undefined) || '';
            if (!click_id) continue;
            if (h.needsOrphanLookup(click_id)) orphanUnion.add(click_id);
          }
        }

        if (orphanUnion.size > 0 && orphan_clicks_fetched < ORPHAN_TOTAL_CAP) {
          const remaining = ORPHAN_TOTAL_CAP - orphan_clicks_fetched;
          const ids = Array.from(orphanUnion).slice(0, remaining);
          for (let i = 0; i < ids.length; i += ORPHAN_CHUNK) {
            const chunk = ids.slice(i, i + ORPHAN_CHUNK);
            const refs = chunk.map((id) => db().collection(COLLECTIONS.CLICKS).doc(id));
            try {
              const docs = await db().getAll(...refs);
              for (const cs of docs) {
                orphan_clicks_fetched += 1;
                if (!cs.exists) continue;
                const cdata = cs.data() as Record<string, unknown>;
                for (const h of active) {
                  try {
                    h.processOrphanClick(cs.id, cdata);
                  } catch (err) {
                    logger.error('unified_reconciler_processOrphanClick_failed', {
                      handler: h.name, click_id: cs.id,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }
              }
            } catch (err) {
              logger.warn('unified_reconciler_orphan_batch_failed', {
                chunk_size: chunk.length,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        pages += 1;
        logger.info('unified_reconciler_conv_scan_progress', {
          pages, scanned: conversions_scanned,
          orphan_clicks_fetched,
          elapsed_ms: Date.now() - phaseStart,
        });
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
      logger.info('unified_reconciler_conv_scan_done', {
        pages, scanned: conversions_scanned,
        orphan_clicks_fetched,
        elapsed_ms: Date.now() - phaseStart,
      });
    }

    // ── 4. flush in parallel ────────────────────────────────────────
    // Each handler writes to a different collection so Promise.all is safe.
    // try/catch around each so one handler's write failure doesn't tank the
    // others' results (we still surface them in the per-handler FlushResult).
    const flushResults = await Promise.all(
      active.map((h) =>
        h.flush().catch((err): FlushResult => ({
          name: h.name, ok: false, buckets_written: 0,
          error: err instanceof Error ? err.message : String(err),
        }))
      )
    );

    // Re-attach FlushResults for handlers that opted out at prepare-time so
    // the caller's result shape stays stable.
    const byName = new Map<string, FlushResult>(flushResults.map((r) => [r.name, r]));
    const handlers: FlushResult[] = allHandlers.map<FlushResult>((h) =>
      byName.get(h.name) ?? {
        name: h.name, ok: false, buckets_written: 0,
        truncated: true, truncated_reason: 'prepare_skipped',
      }
    );

    const result: UnifiedReconcilerResult = {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      clicks_scanned,
      conversions_scanned,
      orphan_clicks_fetched,
      duration_ms: Date.now() - started,
      handlers,
    };
    logger.info('unified_reconciler_completed', {
      clicks_scanned,
      conversions_scanned,
      orphan_clicks_fetched,
      duration_ms: result.duration_ms,
      handlers: handlers.map((h) => ({
        name: h.name, ok: h.ok, buckets_written: h.buckets_written,
        truncated: h.truncated,
      })),
    });
    return result;
  },
};
