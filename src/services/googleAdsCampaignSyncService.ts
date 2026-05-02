import { googleAdsConnectionRepository } from '../firestore/repositories/googleAdsConnectionRepository';
import { googleAdsMccChildrenRepository } from '../firestore/repositories/googleAdsMccChildrenRepository';
import { campaignReportRepository } from '../firestore/repositories/campaignReportRepository';
import { buildCustomer } from './googleAdsClient';
import { logger } from '../utils/logger';

export interface CampaignSyncResult {
  from: string;
  to: string;
  campaigns_updated: number;
  total_spend_micros: number;
  duration_ms: number;
}

interface CampaignMetricsRow {
  campaign?: {
    id?: string | number | { toString(): string };
    name?: string;
  };
  segments?: {
    date?: string;
  };
  metrics?: {
    cost_micros?: string | number | { toString(): string };
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

        // The query groups by campaign and date.
        const query = `
          SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros
          FROM campaign
          WHERE segments.date >= '${fromStr}' AND segments.date <= '${toStr}'
        `;

        const rows = (await customer.query(query)) as unknown as CampaignMetricsRow[];
        
        const campaignNames = new Map<string, string>();
        const campaignSpends = new Map<string, { date: string; spend: number }[]>();

        for (const row of rows) {
          const campaignId = String(row.campaign?.id || '');
          const campaignName = String(row.campaign?.name || '');
          const date = String(row.segments?.date || '');
          const costMicros = Number(row.metrics?.cost_micros || 0);

          if (!campaignId || !date) continue;

          if (campaignName) {
            campaignNames.set(campaignId, campaignName);
          }

          if (costMicros > 0) {
            const spendDollars = costMicros / 1_000_000;
            if (!campaignSpends.has(campaignId)) {
              campaignSpends.set(campaignId, []);
            }
            campaignSpends.get(campaignId)!.push({ date, spend: spendDollars });
            totalSpendMicros += costMicros;
          }
        }

        // Apply campaign names globally
        for (const [campaignId, name] of campaignNames.entries()) {
          await campaignReportRepository.updateName({ campaign_id: campaignId, campaign_name: name });
        }

        // Apply spends strictly for their date
        for (const [campaignId, spends] of campaignSpends.entries()) {
          for (const s of spends) {
            await campaignReportRepository.updateSpend({ campaign_id: campaignId, date: s.date, spend: s.spend });
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

    logger.info('google_ads_campaign_sync_completed', { ...result });
    return result;
  }
};
