import { unifiedReconciler } from './reconciler/unifiedReconciler';
import type { FlushResult } from './reconciler/types';

// Thin wrapper preserved for back-compat with admin endpoints + refreshService.
// All scan logic lives in the unified reconciler now — see ./reconciler/
// unifiedReconciler.ts for why (single scan, multiple handlers).
//
// When called directly, this only runs the offer_reports handler. That means
// admin-triggered "rebuild offer reports" still works but pays for one full
// conversions scan. When the scheduler / refreshService calls runAll() with
// every handler, ALL three rollups share that single scan.

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
  truncated?: boolean;
  truncated_reason?: string;
}

function projectOfferResult(handler: FlushResult, top: { from: string; to: string; clicks_scanned: number; conversions_scanned: number; duration_ms: number }): BackfillResult {
  return {
    from: top.from,
    to: top.to,
    clicks_scanned: top.clicks_scanned,
    clicks_untouched: true,
    existing_buckets_scanned: handler.existing_buckets_scanned ?? 0,
    conversions_scanned: handler.conversions_scanned ?? top.conversions_scanned,
    buckets_written: handler.buckets_written,
    duration_ms: handler.duration_ms ?? top.duration_ms,
    ...(handler.truncated ? { truncated: handler.truncated, truncated_reason: handler.truncated_reason } : {}),
  };
}

export const offerReportsBackfillService = {
  async rebuild(opts: BackfillOptions = {}): Promise<BackfillResult> {
    const result = await unifiedReconciler.runAll({
      from: opts.from,
      to: opts.to,
      handlers: ['offer_reports'],
    });
    const offer = result.handlers.find((h) => h.name === 'offer_reports');
    if (!offer) {
      return {
        from: result.from, to: result.to,
        clicks_scanned: result.clicks_scanned,
        clicks_untouched: true,
        existing_buckets_scanned: 0,
        conversions_scanned: result.conversions_scanned,
        buckets_written: 0,
        duration_ms: result.duration_ms,
      };
    }
    return projectOfferResult(offer, result);
  },
};
