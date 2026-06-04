import { facebookConnectionRepository } from '../firestore/repositories/facebookConnectionRepository';
import { facebookBusinessChildrenRepository } from '../firestore/repositories/facebookBusinessChildrenRepository';
import { facebookCampaignReportRepository } from '../firestore/repositories/facebookCampaignReportRepository';
import { facebookSyncStateRepository } from '../firestore/repositories/facebookSyncStateRepository';
import { facebookGraphApi, buildGraphUrl, FacebookGraphError } from './facebookGraphClient';
import { decryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { toInr } from '../utils/fxRates';
import type { FacebookConnection } from '../types/facebookAds';

// Mirror of ./googleAdsCampaignSyncService.ts. Pulls daily campaign-level
// spend / clicks / impressions / cpc / ctr / cpm / reach from the Meta
// Insights API for every active connection, converts spend to INR, writes
// fb_* metrics + canonical `spend` into facebook_campaign_reports.

export interface FacebookCampaignSyncResult {
  from: string;
  to: string;
  campaigns_updated: number;
  total_spend_inr: number;
  total_clicks: number;
  total_impressions: number;
  duration_ms: number;
}

interface InsightsRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string | number;
  clicks?: string | number;
  impressions?: string | number;
  cpc?: string | number;
  ctr?: string | number;
  cpm?: string | number;
  reach?: string | number;
  account_currency?: string;
}

function numFromStr(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const facebookCampaignSyncService = {
  async syncCampaigns(opts: { from: Date; to: Date }): Promise<FacebookCampaignSyncResult> {
    const started = Date.now();
    const fromStr = opts.from.toISOString().slice(0, 10);
    const toStr = opts.to.toISOString().slice(0, 10);

    const allConns = await facebookConnectionRepository.list();
    let campaignsUpdated = 0;
    let totalSpendInr = 0;
    let totalClicks = 0;
    let totalImpressions = 0;

    for (const conn of allConns) {
      if (conn.status !== 'active' && conn.status !== 'expiring') continue;

      // Build the target ad-account list:
      //   - For ad_account connections: just the one ad account.
      //   - For business connections: expand to the cached children list.
      const targets: string[] = [];
      if (conn.type === 'ad_account') {
        targets.push(conn.ad_account_id);
      } else if (conn.type === 'business') {
        const children = await facebookBusinessChildrenRepository.listByConnection(conn.connection_id);
        for (const child of children) {
          if (child.ad_account_id) targets.push(child.ad_account_id);
        }
        // Fall back to the connection's own ad_account_id (the BM admin's
        // default) when no children have been snapshotted yet.
        if (targets.length === 0 && conn.ad_account_id) targets.push(conn.ad_account_id);
      }

      for (const adAccountId of targets) {
        try {
          const rows = await fetchInsights(conn, adAccountId, fromStr, toStr);
          const unknownCurrenciesSeen = new Set<string>();

          // Apply names eagerly per campaign — small writes, makes the UI snappy.

          // Pass 1: Insights names. Written first because the same campaigns
          // will get spend / clicks rows from updateAdsMetrics below, so it's
          // fine if updateName creates a today placeholder for any that
          // somehow lack a doc.
          const insightsNames = new Map<string, string>();
          for (const r of rows) {
            const cid = String(r.campaign_id ?? '');
            const name = String(r.campaign_name ?? '');
            if (cid && name) insightsNames.set(cid, name);
          }
          for (const [cid, name] of insightsNames.entries()) {
            await facebookCampaignReportRepository.updateName({ campaign_id: cid, campaign_name: name });
          }

          // Pass 2: name backfill from /campaigns. Insights only returns
          // campaigns that had activity in the queried window, so a campaign
          // referenced by a click's utm_id / utm_campaign but with no recent
          // spend would never get a name. /{ad_account_id}/campaigns returns
          // every campaign in the account (paused, ended, no-spend) — that's
          // what makes the FB dashboard render real names instead of bare ids
          // like "120247890393410531". Gated with only_if_exists so we don't
          // create empty rows for campaigns we never saw a click for.
          let backfillNames = 0;
          try {
            const allCampaigns = await fetchAllCampaignNames(conn, adAccountId);
            for (const c of allCampaigns) {
              if (!c.id || !c.name) continue;
              if (insightsNames.has(c.id)) continue;  // already named above
              await facebookCampaignReportRepository.updateName({
                campaign_id: c.id,
                campaign_name: c.name,
                only_if_exists: true,
              });
              backfillNames += 1;
            }
          } catch (err) {
            logger.warn('facebook_campaign_names_fetch_failed', {
              connection_id: conn.connection_id,
              ad_account_id: adAccountId,
              error: err instanceof Error ? err.message : String(err),
            });
            // Non-fatal — Insights still fills names for active campaigns.
          }

          for (const r of rows) {
            const campaignId = String(r.campaign_id ?? '');
            // Meta's `date_start` is the daily bucket key when time_increment=1.
            const date = String(r.date_start ?? '');
            const currency = (r.account_currency || conn.currency_code || '').toUpperCase();

            if (!campaignId || !date) continue;

            const localSpend = numFromStr(r.spend);
            const clicks = Math.round(numFromStr(r.clicks));
            const impressions = Math.round(numFromStr(r.impressions));
            const localCpc = numFromStr(r.cpc);
            const ctr = numFromStr(r.ctr) / 100;   // Meta returns CTR as a percentage; normalise to 0..1
            const localCpm = numFromStr(r.cpm);
            const reach = Math.round(numFromStr(r.reach));

            const inrSpend = toInr(localSpend, currency);
            if (inrSpend === null) {
              if (!unknownCurrenciesSeen.has(currency)) {
                unknownCurrenciesSeen.add(currency);
                logger.warn('facebook_currency_no_fx_rate', {
                  connection_id: conn.connection_id,
                  ad_account_id: adAccountId,
                  currency,
                });
              }
              continue;
            }
            const inrCpc = toInr(localCpc, currency) ?? 0;
            const inrCpm = toInr(localCpm, currency) ?? 0;

            await facebookCampaignReportRepository.updateAdsMetrics({
              campaign_id: campaignId,
              date,
              fb_clicks: clicks,
              fb_impressions: impressions,
              fb_spend: inrSpend,
              fb_cpc: inrCpc,
              fb_ctr: ctr,
              fb_cpm: inrCpm,
              fb_reach: reach,
              spend: inrSpend,
            });

            totalSpendInr += inrSpend;
            totalClicks += clicks;
            totalImpressions += impressions;
          }

          campaignsUpdated += insightsNames.size + backfillNames;
        } catch (err) {
          logger.warn('facebook_campaign_sync_failed', {
            connection_id: conn.connection_id,
            ad_account_id: adAccountId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Auth-class Graph error → mark connection 'error' so the UI surfaces it.
          if (err instanceof FacebookGraphError && isAuthError(err)) {
            await facebookConnectionRepository.update(conn.connection_id, {
              status: 'error',
              last_error: err.message.slice(0, 4000),
            });
          }
        }
      }
    }

    const result: FacebookCampaignSyncResult = {
      from: fromStr,
      to: toStr,
      campaigns_updated: campaignsUpdated,
      total_spend_inr: totalSpendInr,
      total_clicks: totalClicks,
      total_impressions: totalImpressions,
      duration_ms: Date.now() - started,
    };

    await facebookSyncStateRepository.touchLastSynced({ from: fromStr, to: toStr });
    logger.info('facebook_campaign_sync_completed', { ...result });
    return result;
  },
};

async function fetchInsights(
  conn: FacebookConnection,
  adAccountId: string,
  fromStr: string,
  toStr: string
): Promise<InsightsRow[]> {
  const token = decryptSecret(conn.access_token_enc);
  const fields = [
    'campaign_id',
    'campaign_name',
    'spend',
    'clicks',
    'impressions',
    'cpc',
    'ctr',
    'cpm',
    'reach',
    'account_currency',
  ].join(',');

  let url = buildGraphUrl(`/${adAccountId}/insights`, {
    level: 'campaign',
    time_increment: 1,
    time_range: JSON.stringify({ since: fromStr, until: toStr }),
    fields,
    limit: 500,
    access_token: token,
  });

  const out: InsightsRow[] = [];
  // Insights paginates with `paging.next` (a full URL). Walk all pages so a
  // long window doesn't silently drop rows past the first 500.
  let safety = 0;
  while (url && safety < 50) {
    const res = await facebookGraphApi.get<{ data?: InsightsRow[]; paging?: { next?: string } }>(url);
    if (res.data) out.push(...res.data);
    url = res.paging?.next ?? '';
    safety++;
  }
  return out;
}

function isAuthError(err: FacebookGraphError): boolean {
  // Meta uses code 190 (OAuthException) for token problems, 200 for permission.
  if (err.code === 190) return true;
  if (err.code === 200 || err.code === 102 || err.code === 2500) return true;
  return /OAuthException|expired|access_token|permission/i.test(err.message);
}

// Lists every campaign id + name in an ad account, regardless of spend or
// activity. Paginates via `paging.next`. Used to seed names for campaigns
// that appear in our postback data (via utm_id) but produced no Insights
// rows for the synced window (paused / ended / zero-spend campaigns).
async function fetchAllCampaignNames(
  conn: FacebookConnection,
  adAccountId: string,
): Promise<{ id: string; name: string }[]> {
  const token = decryptSecret(conn.access_token_enc);
  let url = buildGraphUrl(`/${adAccountId}/campaigns`, {
    fields: 'id,name',
    limit: 500,
    access_token: token,
  });
  const out: { id: string; name: string }[] = [];
  // Same safety cap as the Insights walker — a runaway page-loop should not
  // burn the connection's rate-limit budget.
  let safety = 0;
  while (url && safety < 50) {
    const res = await facebookGraphApi.get<{
      data?: { id?: string; name?: string }[];
      paging?: { next?: string };
    }>(url);
    if (res.data) {
      for (const c of res.data) {
        const id = String(c.id ?? '').trim();
        const name = String(c.name ?? '').trim();
        if (id && name) out.push({ id, name });
      }
    }
    url = res.paging?.next ?? '';
    safety++;
  }
  return out;
}
