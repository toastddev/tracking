import { googleAdsConnectionRepository } from '../firestore/repositories/googleAdsConnectionRepository';
import { googleAdsMccChildrenRepository } from '../firestore/repositories/googleAdsMccChildrenRepository';
import { campaignReportRepository } from '../firestore/repositories/campaignReportRepository';
import { googleAdsSyncStateRepository } from '../firestore/repositories/googleAdsSyncStateRepository';
import { buildCustomer } from './googleAdsClient';
import { logger } from '../utils/logger';
import { fxRates } from '../utils/fxRates';

// When GOOGLE_ADS_UPLOAD_CURRENCY is set (e.g. "INR"), the dashboard displays
// all monetary values in that currency. The Google Ads sync converts account
// currency → display currency (through USD as pivot when needed).
export function displayCurrency(): string {
  return (process.env.GOOGLE_ADS_UPLOAD_CURRENCY ?? 'USD').trim().toUpperCase();
}

// Convert an amount from a source currency to the configured display currency.
// Rates are stored as "units per USD", so conversion goes: source → USD → display.
function toDisplayCurrency(amount: number, sourceCurrency: string): number | null {
  const source = (sourceCurrency || 'USD').toUpperCase().trim();
  const target = displayCurrency();
  if (source === target) return amount;

  const rates = fxRates();
  const sourceRate = source === 'USD' ? 1 : rates[source];
  const targetRate = target === 'USD' ? 1 : rates[target];
  if (!sourceRate || sourceRate <= 0 || !targetRate || targetRate <= 0) return null;

  const usd = amount / sourceRate;
  return Number((usd * targetRate).toFixed(6));
}

export interface CampaignSyncResult {
  from: string;
  to: string;
  campaigns_updated: number;
  total_spend_micros: number;
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
    ctr?: string | number | { toString(): string };
    average_cpc?: string | number | { toString(): string };
  };
}

export const googleAdsCampaignSyncService = {
  async syncCampaigns(opts: { from: Date; to: Date }): Promise<CampaignSyncResult> {
    const started = Date.now();
    const fromStr = opts.from.toISOString().slice(0, 10);
    const toStr = opts.to.toISOString().slice(0, 10);

    const allConns = await googleAdsConnectionRepository.list();
    let campaignsUpdated = 0;
    let totalSpendMicros = 0;

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
            login_customer_id: conn.customer_id, // For MCC connections, the MCC is the login customer
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

        // The query groups by campaign and date. customer.currency_code is
        // pulled per row so spend can be converted from the account's local
        // currency to the display currency before persistence.
        // Now also pulling clicks, impressions, ctr, average_cpc for the
        // GADS columns in the campaign table.
        const query = `
          SELECT customer.currency_code, campaign.id, campaign.name, segments.date,
                 metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc
          FROM campaign
          WHERE segments.date >= '${fromStr}' AND segments.date <= '${toStr}'
        `;

        const rows = (await customer.query(query)) as unknown as CampaignMetricsRow[];

        const campaignNames = new Map<string, string>();
        interface CampaignDayMetrics {
          date: string;
          spend: number;
          gads_clicks: number;
          gads_impressions: number;
          gads_ctr: number;
          gads_cpc: number;
          gads_cost_micros: number;
        }
        const campaignMetrics = new Map<string, CampaignDayMetrics[]>();
        const unknownCurrenciesSeen = new Set<string>();

        for (const row of rows) {
          const campaignId = String(row.campaign?.id || '');
          const campaignName = String(row.campaign?.name || '');
          const date = String(row.segments?.date || '');
          const costMicros = Number(row.metrics?.cost_micros || 0);
          const gadsClicks = Number(row.metrics?.clicks || 0);
          const gadsImpressions = Number(row.metrics?.impressions || 0);
          const gadsCtr = Number(row.metrics?.ctr || 0);
          const avgCpcMicros = Number(row.metrics?.average_cpc || 0);
          const currency = (row.customer?.currency_code || '').toUpperCase();

          if (!campaignId || !date) continue;

          if (campaignName) {
            campaignNames.set(campaignId, campaignName);
          }

          const localAmount = costMicros / 1_000_000;
          const converted = toDisplayCurrency(localAmount, currency);
          if (converted === null) {
            // No FX rate configured for this currency. Skip rather than
            // mislabel local-currency spend; surface once per sync.
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

          // Convert CPC to display currency as well
          const localCpc = avgCpcMicros / 1_000_000;
          const convertedCpc = toDisplayCurrency(localCpc, currency) ?? 0;

          if (!campaignMetrics.has(campaignId)) {
            campaignMetrics.set(campaignId, []);
          }
          campaignMetrics.get(campaignId)!.push({
            date,
            spend: converted,
            gads_clicks: gadsClicks,
            gads_impressions: gadsImpressions,
            gads_ctr: gadsCtr,
            gads_cpc: convertedCpc,
            gads_cost_micros: costMicros,
          });
          totalSpendMicros += costMicros;
        }

        // Apply campaign names globally
        for (const [campaignId, name] of campaignNames.entries()) {
          await campaignReportRepository.updateName({ campaign_id: campaignId, campaign_name: name });
        }

        // Apply metrics (spend + GADS clicks/impressions/ctr/cpc) for each day
        for (const [campaignId, metrics] of campaignMetrics.entries()) {
          for (const m of metrics) {
            await campaignReportRepository.updateGadsMetrics({
              campaign_id: campaignId,
              date: m.date,
              spend: m.spend,
              gads_clicks: m.gads_clicks,
              gads_impressions: m.gads_impressions,
              gads_ctr: m.gads_ctr,
              gads_cpc: m.gads_cpc,
              gads_cost_micros: m.gads_cost_micros,
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
      total_spend_micros: totalSpendMicros,
      duration_ms: Date.now() - started,
    };

    await googleAdsSyncStateRepository.touchLastSynced({ from: fromStr, to: toStr });

    logger.info('google_ads_campaign_sync_completed', { ...result });
    return result;
  }
};
