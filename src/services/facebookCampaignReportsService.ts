import { facebookCampaignReportRepository, offerReportRepository, type FacebookCampaignReportDoc } from '../firestore';
import { toInr } from '../utils/fxRates';
import { logger } from '../utils/logger';

// Read-side service for the FB Campaigns dashboard. Mirror of
// ./campaignReportsService.ts but reads from `facebook_campaign_reports` and
// surfaces `fb_*` metrics instead of `gads_*`.

export interface FbCampaignReportsFilters {
  from: Date;
  to: Date;
  campaign_ids?: string[];
}

export interface FbCampaignDailyPoint {
  date: string;
  clicks: number;
  postbacks: number;
  conversions: number;
  revenue: number;
  spend: number;
  profit: number;
  fb_clicks: number;
  fb_impressions: number;
  fb_ctr: number;
  fb_cpc: number;
}

export interface FbCampaignReportSummary {
  campaign_id: string;
  campaign_name?: string;
  source: string;
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
  spend: number;
  profit: number;
  cvr: number;
  epc: number;
  cpc: number;
  cpa: number;
  roas: number;
  roi: number;
  approval_rate: number;
  spend_coverage: number;
  offers: string[];
  fb_clicks: number;
  fb_impressions: number;
  fb_ctr: number;
  fb_cpc: number;
  series: FbCampaignDailyPoint[];
}

export interface FbCampaignInsight {
  severity: 'info' | 'success' | 'warn' | 'critical';
  title: string;
  detail: string;
  campaign_id?: string;
}

export interface FbCampaignDailyTotal {
  date: string;
  total_revenue_inr: number | null;
}

export interface FbCampaignReportsResponse {
  from: string;
  to: string;
  campaigns: FbCampaignReportSummary[];
  totals: {
    clicks: number;
    postbacks: number;
    conversions: number;
    unverified: number;
    revenue: number;
    spend: number;
    profit: number;
    cvr: number;
    epc: number;
    roas: number;
    roi: number;
    campaigns: number;
    profitable_campaigns: number;
    unprofitable_campaigns: number;
    spend_coverage: number;
    fb_clicks: number;
    fb_impressions: number;
    fb_ctr: number;
    fb_cpc: number;
    total_revenue_inr: number;
  };
  daily_totals: FbCampaignDailyTotal[];
  insights: FbCampaignInsight[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function eachDayKeyUTC(from: Date, to: Date): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function safeDiv(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

function slope(values: number[]): number {
  if (values.length < 3) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

export const facebookCampaignReportsService = {
  async perCampaignSummary(f: FbCampaignReportsFilters): Promise<FbCampaignReportsResponse> {
    const [rows, offerRows] = await Promise.all([
      facebookCampaignReportRepository.fetchRange({
        from: f.from,
        to: f.to,
        campaign_ids: f.campaign_ids,
      }),
      offerReportRepository.fetchRange({ from: f.from, to: f.to }),
    ]);

    const days = eachDayKeyUTC(f.from, f.to);

    const byCampaign = new Map<string, FacebookCampaignReportDoc[]>();
    for (const r of rows) {
      let bucket = byCampaign.get(r.campaign_id);
      if (!bucket) {
        bucket = [];
        byCampaign.set(r.campaign_id, bucket);
      }
      bucket.push(r);
    }

    const campaignIds = f.campaign_ids && f.campaign_ids.length > 0
      ? f.campaign_ids
      : Array.from(byCampaign.keys());

    const summaries: FbCampaignReportSummary[] = [];
    let totalClicks = 0;
    let totalPostbacks = 0;
    let totalConv = 0;
    let totalUnv = 0;
    let totalRevenue = 0;
    let totalSpend = 0;
    let profitableCampaigns = 0;
    let unprofitableCampaigns = 0;
    let campaignsWithSpend = 0;
    let totalFbClicks = 0;
    let totalFbImpressions = 0;

    for (const campaign_id of campaignIds) {
      const cRows = byCampaign.get(campaign_id) ?? [];

      const seriesMap = new Map<string, FbCampaignDailyPoint>();
      for (const day of days) {
        seriesMap.set(day, {
          date: day,
          clicks: 0,
          postbacks: 0,
          conversions: 0,
          revenue: 0,
          spend: 0,
          profit: 0,
          fb_clicks: 0,
          fb_impressions: 0,
          fb_ctr: 0,
          fb_cpc: 0,
        });
      }

      let clicks = 0;
      let postbacks = 0;
      let conversions = 0;
      let unverified = 0;
      let approved = 0;
      let pending = 0;
      let rejected = 0;
      let revenue = 0;
      let spend = 0;
      let activeDays = 0;
      let daysWithSpend = 0;
      let fbClicks = 0;
      let fbImpressions = 0;
      let campaign_name: string | undefined;
      let source = 'fb_campaign_id';
      const offers = new Set<string>();

      for (const r of cRows) {
        clicks += r.clicks;
        postbacks += r.postbacks;
        conversions += r.conversions;
        unverified += r.unverified;
        approved += r.approved;
        pending += r.pending;
        rejected += r.rejected;
        revenue += r.revenue;
        spend += r.spend;
        fbClicks += r.fb_clicks ?? 0;
        fbImpressions += r.fb_impressions ?? 0;
        if (r.campaign_name) campaign_name = r.campaign_name;
        if (r.source) source = r.source;
        for (const o of r.offers) offers.add(o);
        const point = seriesMap.get(r.date);
        if (point) {
          point.clicks += r.clicks;
          point.postbacks += r.postbacks;
          point.conversions += r.conversions;
          point.revenue += r.revenue;
          point.spend += r.spend;
          point.profit = point.revenue - point.spend;
          point.fb_clicks += r.fb_clicks ?? 0;
          point.fb_impressions += r.fb_impressions ?? 0;
          point.fb_ctr = safeDiv(point.fb_clicks, point.fb_impressions);
          point.fb_cpc = safeDiv(point.spend, point.fb_clicks);
        }
        const isActive = r.clicks > 0 || r.postbacks > 0 || r.spend > 0;
        if (isActive) activeDays += 1;
        if (r.spend > 0) daysWithSpend += 1;
      }

      const profit = revenue - spend;
      if (spend > 0) {
        campaignsWithSpend += 1;
        if (profit > 0) profitableCampaigns += 1;
        else if (profit < 0) unprofitableCampaigns += 1;
      }

      summaries.push({
        campaign_id,
        campaign_name,
        source,
        clicks,
        postbacks,
        conversions,
        unverified,
        approved,
        pending,
        rejected,
        revenue,
        spend,
        profit,
        cvr: safeDiv(conversions, clicks),
        epc: safeDiv(revenue, clicks),
        cpc: safeDiv(spend, clicks),
        cpa: safeDiv(spend, conversions),
        roas: safeDiv(revenue, spend),
        roi: spend > 0 ? (revenue - spend) / spend : 0,
        approval_rate: safeDiv(approved, conversions),
        spend_coverage: safeDiv(daysWithSpend, Math.max(activeDays, 1)),
        offers: Array.from(offers).sort(),
        fb_clicks: fbClicks,
        fb_impressions: fbImpressions,
        fb_ctr: safeDiv(fbClicks, fbImpressions),
        fb_cpc: safeDiv(spend, fbClicks),
        series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      });

      totalClicks += clicks;
      totalPostbacks += postbacks;
      totalConv += conversions;
      totalUnv += unverified;
      totalRevenue += revenue;
      totalSpend += spend;
      totalFbClicks += fbClicks;
      totalFbImpressions += fbImpressions;
    }

    summaries.sort((a, b) => b.revenue - a.revenue);

    const dailyRevenueByDate = new Map<string, { inr: number; fxMissing: boolean }>();
    const fxWarnedCurrencies = new Set<string>();
    let totalRevenueInr = 0;
    for (const r of offerRows) {
      const inr = toInr(r.revenue, 'USD');
      const entry = dailyRevenueByDate.get(r.date) ?? { inr: 0, fxMissing: false };
      if (inr == null) {
        entry.fxMissing = true;
        if (!fxWarnedCurrencies.has('USD')) {
          fxWarnedCurrencies.add('USD');
          logger.warn('fb_campaign_reports_daily_total_fx_missing', {
            hint: 'Set GOOGLE_ADS_FX_RATES env var (e.g. INR:93,EUR:100) for USD→INR conversion.',
          });
        }
      } else {
        entry.inr += inr;
        totalRevenueInr += inr;
      }
      dailyRevenueByDate.set(r.date, entry);
    }
    const daily_totals: FbCampaignDailyTotal[] = days.map((date) => {
      const entry = dailyRevenueByDate.get(date);
      if (!entry) return { date, total_revenue_inr: 0 };
      if (entry.fxMissing && entry.inr === 0) return { date, total_revenue_inr: null };
      return { date, total_revenue_inr: entry.inr };
    });

    const totalProfit = totalRevenue - totalSpend;
    const totals = {
      clicks: totalClicks,
      postbacks: totalPostbacks,
      conversions: totalConv,
      unverified: totalUnv,
      revenue: totalRevenue,
      spend: totalSpend,
      profit: totalProfit,
      cvr: safeDiv(totalConv, totalClicks),
      epc: safeDiv(totalRevenue, totalClicks),
      roas: safeDiv(totalRevenue, totalSpend),
      roi: totalSpend > 0 ? (totalRevenue - totalSpend) / totalSpend : 0,
      campaigns: summaries.length,
      profitable_campaigns: profitableCampaigns,
      unprofitable_campaigns: unprofitableCampaigns,
      spend_coverage: safeDiv(campaignsWithSpend, Math.max(summaries.length, 1)),
      fb_clicks: totalFbClicks,
      fb_impressions: totalFbImpressions,
      fb_ctr: safeDiv(totalFbClicks, totalFbImpressions),
      fb_cpc: safeDiv(totalSpend, totalFbClicks),
      total_revenue_inr: totalRevenueInr,
    };

    const insights = buildInsights(summaries, totals);

    return {
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      campaigns: summaries,
      totals,
      daily_totals,
      insights,
    };
  },
};

function fmtInr(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)} L`;
  if (abs >= 1_000) return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  return `${sign}₹${abs.toFixed(2)}`;
}

function buildInsights(
  campaigns: FbCampaignReportSummary[],
  totals: FbCampaignReportsResponse['totals']
): FbCampaignInsight[] {
  const out: FbCampaignInsight[] = [];
  if (campaigns.length === 0) return out;

  if (totals.spend_coverage < 0.5 && totals.revenue > 0) {
    const missingSpend = campaigns.filter((c) => c.spend === 0 && (c.revenue > 0 || c.clicks > 0));
    const missingNames = missingSpend.slice(0, 5).map((c) => c.campaign_name ?? c.campaign_id).join(', ');
    const moreCount = Math.max(0, missingSpend.length - 5);
    const missingText = missingSpend.length > 0
      ? ` Missing in: ${missingNames}${moreCount > 0 ? ` and ${moreCount} more` : ''}.`
      : '';
    out.push({
      severity: 'warn',
      title: 'Spend not recorded for most campaigns',
      detail:
        `${Math.round(totals.spend_coverage * 100)}% of FB campaigns have spend entered.` +
        ` Without spend, ROAS and ROI are unavailable. Run the Insights sync or add daily spend on the detail page.${missingText}`,
    });
  }

  const withSpend = campaigns.filter((c) => c.spend >= 10);
  if (withSpend.length > 0) {
    const bestRoas = withSpend.reduce((a, b) => (b.roas > a.roas ? b : a));
    if (bestRoas.roas >= 1.5) {
      out.push({
        severity: 'success',
        title: `Top ROAS: ${bestRoas.campaign_name ?? bestRoas.campaign_id}`,
        detail:
          `${bestRoas.roas.toFixed(2)}× return (${fmtInr(bestRoas.revenue)} on ${fmtInr(bestRoas.spend)} spend, ` +
          `profit ${fmtInr(bestRoas.profit)}). Consider scaling budget here.`,
        campaign_id: bestRoas.campaign_id,
      });
    }
    const worstRoas = withSpend
      .filter((c) => c.spend - c.revenue >= 20)
      .reduce<FbCampaignReportSummary | undefined>((acc, c) => {
        if (!acc) return c;
        return c.roas < acc.roas ? c : acc;
      }, undefined);
    if (worstRoas) {
      out.push({
        severity: 'critical',
        title: `Losing money: ${worstRoas.campaign_name ?? worstRoas.campaign_id}`,
        detail:
          `ROAS ${worstRoas.roas.toFixed(2)}× — burning ${fmtInr(-worstRoas.profit)} ` +
          `(spent ${fmtInr(worstRoas.spend)}, earned ${fmtInr(worstRoas.revenue)}). Review creatives or pause.`,
        campaign_id: worstRoas.campaign_id,
      });
    }
  }

  const top = campaigns[0]!;
  if (top.series.length >= 7 && top.revenue > 0) {
    const revSlope = slope(top.series.map((p) => p.revenue));
    const avgRev = top.revenue / top.series.length;
    const relSlope = avgRev > 0 ? revSlope / avgRev : 0;
    if (relSlope >= 0.05) {
      out.push({
        severity: 'success',
        title: `${top.campaign_name ?? top.campaign_id} trending up`,
        detail: `Revenue line is climbing across the window (slope ≈ ${fmtInr(revSlope)}/day). Keep going.`,
        campaign_id: top.campaign_id,
      });
    } else if (relSlope <= -0.05) {
      out.push({
        severity: 'warn',
        title: `${top.campaign_name ?? top.campaign_id} trending down`,
        detail: `Revenue line is falling (slope ≈ ${fmtInr(revSlope)}/day). Investigate before it accelerates.`,
        campaign_id: top.campaign_id,
      });
    }
  }

  if (out.length === 0 && totals.revenue > 0) {
    out.push({
      severity: 'info',
      title: 'No anomalies detected',
      detail:
        `${totals.campaigns} FB campaign${totals.campaigns === 1 ? '' : 's'} active in this window. ` +
        `Total profit ${fmtInr(totals.profit)} on ${fmtInr(totals.spend)} spend.`,
    });
  }
  return out;
}
