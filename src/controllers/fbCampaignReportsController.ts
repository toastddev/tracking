import type { Context } from 'hono';
import { facebookCampaignReportsService } from '../services/facebookCampaignReportsService';
import { facebookCampaignReportRepository } from '../firestore';
import { facebookCampaignSyncService } from '../services/facebookCampaignSyncService';
import { logger } from '../utils/logger';

// Read controller for the FB Campaigns dashboard. Same shape as the GAds
// reports endpoint family but reads from facebook_campaign_reports.

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseCampaignIds(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

export const fbCampaignReportsController = {
  async summary(c: Context) {
    const from = parseDate(c.req.query('from'));
    const to = parseDate(c.req.query('to'));
    if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400);
    if (from.getTime() > to.getTime()) return c.json({ error: 'from_after_to' }, 400);

    try {
      const result = await facebookCampaignReportsService.perCampaignSummary({
        from, to,
        campaign_ids: parseCampaignIds(c.req.query('campaign_ids')),
      });
      return c.json(result);
    } catch (err) {
      logger.error('fb_campaign_reports_summary_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async byCampaign(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    try {
      const rows = await facebookCampaignReportRepository.fetchByCampaign(id, 2000);
      return c.json({ items: rows });
    } catch (err) {
      logger.error('fb_campaign_reports_by_campaign_failed', {
        error: err instanceof Error ? err.message : String(err),
        campaign_id: id,
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Operator-entered spend override for a single campaign-day. Same shape as
  // the GAds equivalent — sync overwrites this, so it's intended for backfill
  // gaps the operator wants to fix manually.
  async setSpend(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { campaign_id?: string; date?: string; spend?: number };
    const campaign_id = String(body.campaign_id ?? '').trim();
    const date = String(body.date ?? '').trim();
    const spend = typeof body.spend === 'number' ? body.spend : Number(body.spend);
    if (!campaign_id) return c.json({ error: 'invalid_campaign_id' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid_date' }, 400);
    if (!Number.isFinite(spend) || spend < 0) return c.json({ error: 'invalid_spend' }, 400);
    try {
      await facebookCampaignReportRepository.updateSpend({ campaign_id, date, spend });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  },

  // Manual sync trigger from the dashboard's Refresh button. Same body shape
  // as facebookController.syncCampaigns — kept here so the report-page only
  // talks to one base URL.
  async sync(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { from?: string; to?: string };
    const now = new Date();
    const from = parseDate(body.from) ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const to = parseDate(body.to) ?? now;
    if (from.getTime() > to.getTime()) return c.json({ error: 'from_after_to' }, 400);
    try {
      const result = await facebookCampaignSyncService.syncCampaigns({ from, to });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error('fb_campaign_reports_sync_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },
};
