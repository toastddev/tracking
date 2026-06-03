import { unifiedReconciler } from './reconciler/unifiedReconciler';
import { campaignReportRepository } from '../firestore';
import { logger } from '../utils/logger';
import type { FlushResult } from './reconciler/types';

// Thin wrapper preserved for back-compat with admin endpoints + refreshService.
// Scan logic now lives in the unified reconciler — see ./reconciler/
// unifiedReconciler.ts for the per-tick cost analysis.
//
// When called directly, this only runs the campaign_reports handler. Used by
// the admin endpoint for "rebuild campaign reports". The orchestrated refresh
// + scheduler call runAll() so the scan is shared with offer + FB handlers.

export interface CampaignBackfillOptions {
  from?: Date;
  to?: Date;
}

export interface CampaignBackfillResult {
  from: string;
  to: string;
  clicks_scanned: number;
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
  campaign_spends?: Array<{
    campaign_id: string;
    campaign_name: string;
    total_spend: number;
  }>;
}

async function projectCampaignResult(
  handler: FlushResult,
  top: { from: string; to: string; clicks_scanned: number; duration_ms: number }
): Promise<CampaignBackfillResult> {
  // Fetch updated spend snapshot for the campaigns that participated in this
  // rebuild — same shape the old service returned, kept for the admin UI.
  let campaign_spends: CampaignBackfillResult['campaign_spends'];
  try {
    if (handler.buckets_written > 0) {
      // We don't have the bucket campaign_id list here, so fall back to a
      // window-range read. Bounded by the existing repo's fetchRange cap.
      const rows = await campaignReportRepository.fetchRange({
        from: new Date(top.from),
        to: new Date(top.to),
      });
      const byCampaign = new Map<string, { name: string; spend: number }>();
      for (const r of rows) {
        const entry = byCampaign.get(r.campaign_id) || { name: r.campaign_id, spend: 0 };
        if (r.campaign_name) entry.name = r.campaign_name;
        entry.spend += r.spend;
        byCampaign.set(r.campaign_id, entry);
      }
      campaign_spends = Array.from(byCampaign.entries()).map(([id, v]) => ({
        campaign_id: id,
        campaign_name: v.name,
        total_spend: v.spend,
      }));
    }
  } catch (e) {
    logger.warn('campaign_backfill_failed_to_fetch_spends', { error: String(e) });
  }

  return {
    from: top.from,
    to: top.to,
    clicks_scanned: top.clicks_scanned,
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
    campaign_spends,
  };
}

export const campaignReportsBackfillService = {
  async rebuild(opts: CampaignBackfillOptions = {}): Promise<CampaignBackfillResult> {
    const result = await unifiedReconciler.runAll({
      from: opts.from,
      to: opts.to,
      handlers: ['campaign_reports'],
    });
    const handler = result.handlers.find((h) => h.name === 'campaign_reports');
    if (!handler) {
      return {
        from: result.from, to: result.to,
        clicks_scanned: result.clicks_scanned,
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
    return projectCampaignResult(handler, result);
  },
};
