import { googleAdsConnectionRepository } from '../firestore/repositories/googleAdsConnectionRepository';
import { googleAdsMccChildrenRepository } from '../firestore/repositories/googleAdsMccChildrenRepository';
import { campaignReportRepository } from '../firestore/repositories/campaignReportRepository';
import { googleAdsSyncStateRepository } from '../firestore/repositories/googleAdsSyncStateRepository';
import { buildCustomer } from './googleAdsClient';
import { logger } from '../utils/logger';
import { toInr } from '../utils/fxRates';

export interface CampaignSyncResult {
  from: string;
  to: string;
  campaigns_updated: number;
  total_spend_inr: number;     // total ad spend across the window, INR
  total_spend_micros: number;  // legacy field — kept for the existing frontend message
  total_clicks: number;
  total_impressions: number;
  duration_ms: number;
}

interface CampaignMetricsRow {
  customer?: {
    currency_code?: string;
  };
  campaign?: {
    id?: string | number | { toString(): string };
    name?: string;
  };
  segments?: {
    date?: string;
  };
  metrics?: {
    cost_micros?: string | number | { toString(): string };
    clicks?: string | number | { toString(): string };
    impressions?: string | number | { toString(): string };
    average_cpc?: string | number | { toString(): string };  // also in micros, account currency
    ctr?: string | number | { toString(): string };          // 0..1
  };
}

interface CampaignDayMetrics {
  date: string;
  spend_inr: number;
  clicks: number;
  impressions: number;
  avg_cpc_inr: number;
  ctr: number;
}

function numFromMicros(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const googleAdsCampaignSyncService = {
  async syncCampaigns(opts: { from: Date; to: Date }): Promise<CampaignSyncResult> {
    const started = Date.now();
    const fromStr = opts.from.toISOString().slice(0, 10);
    const toStr = opts.to.toISOString().slice(0, 10);

    const allConns = await googleAdsConnectionRepository.list();
    let campaignsUpdated = 0;
    let totalSpendInr = 0;
    let totalSpendMicros = 0;
    let totalClicks = 0;
    let totalImpressions = 0;

    for (const conn of allConns) {
      if (conn.status !== 'active') continue;

      const targets: { customer_id: string; login_customer_id?: string }[] = [];

      if (conn.type === 'child') {
        targets.push({
          customer_id: conn.customer_id,
          login_customer_id: conn.manager_customer_id,
        });
      } else if (conn.type === 'mcc') {
        const mccChildren = await googleAdsMccChildrenRepository.listByConnection(conn.connection_id);
        for (const child of mccChildren) {
          targets.push({
            customer_id: child.customer_id,
            login_customer_id: conn.customer_id,
          });
        }
      }

      for (const target of targets) {
        try {
          const customer = buildCustomer({
            connection: conn,
            customer_id: target.customer_id,
            login_customer_id: target.login_customer_id,
          });

          // Query: groups by campaign and date. Pulls cost, clicks, impressions,
          // avg_cpc, ctr along with the account currency so we can convert
          // monetary fields to INR before persistence.
          const query = `
            SELECT
              customer.currency_code,
              campaign.id,
              campaign.name,
              segments.date,
              metrics.cost_micros,
              metrics.clicks,
              metrics.impressions,
              metrics.average_cpc,
              metrics.ctr
            FROM campaign
            WHERE segments.date >= '${fromStr}' AND segments.date <= '${toStr}'
          `;

          const rows = (await customer.query(query)) as unknown as CampaignMetricsRow[];

          const campaignNames = new Map<string, string>();
          const campaignMetrics = new Map<string, CampaignDayMetrics[]>();
          const unknownCurrenciesSeen = new Set<string>();

          for (const row of rows) {
            const campaignId = String(row.campaign?.id || '');
            const campaignName = String(row.campaign?.name || '');
            const date = String(row.segments?.date || '');
            const currency = (row.customer?.currency_code || '').toUpperCase();

            if (!campaignId || !date) continue;

            if (campaignName) {
              campaignNames.set(campaignId, campaignName);
            }

            const costMicros = numFromMicros(row.metrics?.cost_micros);
            const clicks = Math.round(numFromMicros(row.metrics?.clicks));
            const impressions = Math.round(numFromMicros(row.metrics?.impressions));
            const avgCpcMicros = numFromMicros(row.metrics?.average_cpc);
            const ctr = numFromMicros(row.metrics?.ctr);

            // Cost / avg_cpc are reported in micros in the account's local
            // currency. Convert to INR for storage.
            const localCost = costMicros / 1_000_000;
            const inrCost = toInr(localCost, currency);
            if (inrCost === null) {
              if (!unknownCurrenciesSeen.has(currency)) {
                unknownCurrenciesSeen.add(currency);
                logger.warn('google_ads_currency_no_fx_rate', {
                  connection_id: conn.connection_id,
                  customer_id: target.customer_id,
                  currency,
                });
              }
              continue;
            }
            const localAvgCpc = avgCpcMicros / 1_000_000;
            const inrAvgCpc = toInr(localAvgCpc, currency) ?? 0;

            if (!campaignMetrics.has(campaignId)) {
              campaignMetrics.set(campaignId, []);
            }
            campaignMetrics.get(campaignId)!.push({
              date,
              spend_inr: inrCost,
              clicks,
              impressions,
              avg_cpc_inr: inrAvgCpc,
              ctr,
            });
            totalSpendInr += inrCost;
            totalSpendMicros += costMicros;
            totalClicks += clicks;
            totalImpressions += impressions;
          }

          // Apply campaign names globally
          for (const [campaignId, name] of campaignNames.entries()) {
            await campaignReportRepository.updateName({ campaign_id: campaignId, campaign_name: name });
          }

          // Apply spend + metrics strictly for their date. updateAdsMetrics
          // overwrites both gads_* and the canonical spend field — Google Ads
          // is the source of truth for ad-spend on these campaigns.
          for (const [campaignId, days] of campaignMetrics.entries()) {
            for (const d of days) {
              await campaignReportRepository.updateAdsMetrics({
                campaign_id: campaignId,
                date: d.date,
                gads_clicks: d.clicks,
                gads_impressions: d.impressions,
                gads_cost: d.spend_inr,
                gads_avg_cpc: d.avg_cpc_inr,
                gads_ctr: d.ctr,
                spend: d.spend_inr,
              });
            }
          }

          campaignsUpdated += campaignNames.size;

        } catch (err) {
          logger.warn('google_ads_campaign_sync_failed', {
            connection_id: conn.connection_id,
            customer_id: target.customer_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const result: CampaignSyncResult = {
      from: fromStr,
      to: toStr,
      campaigns_updated: campaignsUpdated,
      total_spend_inr: totalSpendInr,
      total_spend_micros: totalSpendMicros,
      total_clicks: totalClicks,
      total_impressions: totalImpressions,
      duration_ms: Date.now() - started,
    };

    await googleAdsSyncStateRepository.touchLastSynced({ from: fromStr, to: toStr });

    logger.info('google_ads_campaign_sync_completed', { ...result });
    return result;
  }
};
