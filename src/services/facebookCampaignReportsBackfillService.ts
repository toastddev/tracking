import { unifiedReconciler } from './reconciler/unifiedReconciler';
import type { FlushResult } from './reconciler/types';

// Thin wrapper preserved for back-compat with refreshService. Scan logic now
// lives in the unified reconciler — see ./reconciler/unifiedReconciler.ts.
//
// When called directly, this only runs the facebook_campaign_reports handler.
// The orchestrated refresh + scheduler call runAll() so the scan is shared.

export interface FbCampaignBackfillOptions {
  from?: Date;
  to?: Date;
}

export interface FbCampaignBackfillResult {
  from: string;
  to: string;
  clicks_untouched: true;
  click_metadata_scanned: number;
  clicks_with_campaign: number;
  existing_buckets_scanned: number;
  conversions_scanned: number;
  conversions_with_campaign: number;
  conversions_orphan_lookups: number;
  revenue_fx_skipped: number;
  buckets_written: number;
  duration_ms: number;
  truncated?: boolean;
  truncated_reason?: string;
}

function projectFbResult(
  handler: FlushResult,
  top: { from: string; to: string; clicks_scanned: number; duration_ms: number }
): FbCampaignBackfillResult {
  return {
    from: top.from,
    to: top.to,
    clicks_untouched: true,
    click_metadata_scanned: top.clicks_scanned,
    clicks_with_campaign: handler.clicks_with_campaign ?? 0,
    existing_buckets_scanned: handler.existing_buckets_scanned ?? 0,
    conversions_scanned: handler.conversions_scanned ?? 0,
    conversions_with_campaign: handler.conversions_with_campaign ?? 0,
    conversions_orphan_lookups: handler.conversions_orphan_lookups ?? 0,
    revenue_fx_skipped: handler.revenue_fx_skipped ?? 0,
    buckets_written: handler.buckets_written,
    duration_ms: handler.duration_ms ?? top.duration_ms,
    ...(handler.truncated ? { truncated: handler.truncated, truncated_reason: handler.truncated_reason } : {}),
  };
}

export const facebookCampaignReportsBackfillService = {
  async rebuild(opts: FbCampaignBackfillOptions = {}): Promise<FbCampaignBackfillResult> {
    const result = await unifiedReconciler.runAll({
      from: opts.from,
      to: opts.to,
      handlers: ['facebook_campaign_reports'],
    });
    const handler = result.handlers.find((h) => h.name === 'facebook_campaign_reports');
    if (!handler) {
      return {
        from: result.from, to: result.to,
        clicks_untouched: true,
        click_metadata_scanned: 0,
        clicks_with_campaign: 0,
        existing_buckets_scanned: 0,
        conversions_scanned: result.conversions_scanned,
        conversions_with_campaign: 0,
        conversions_orphan_lookups: 0,
        revenue_fx_skipped: 0,
        buckets_written: 0,
        duration_ms: result.duration_ms,
      };
    }
    return projectFbResult(handler, result);
  },
};
