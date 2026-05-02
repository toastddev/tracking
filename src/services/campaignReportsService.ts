import { campaignReportRepository, type CampaignReportDoc } from '../firestore';

export interface CampaignReportsFilters {
  from: Date;
  to: Date;
  campaign_ids?: string[];
}

export interface CampaignDailyPoint {
  date: string;
  clicks: number;
  postbacks: number;
  conversions: number;
  revenue: number;
  spend: number;
  profit: number;          // revenue - spend
}

export interface CampaignReportSummary {
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
  profit: number;          // revenue - spend
  cvr: number;             // conversions / clicks
  epc: number;             // revenue / clicks
  cpc: number;             // spend / clicks
  cpa: number;             // spend / conversions
  roas: number;            // revenue / spend (0 when no spend)
  roi: number;             // (revenue - spend) / spend (0 when no spend)
  approval_rate: number;
  spend_coverage: number;  // share of active days that have spend recorded (0..1)
  offers: string[];        // distinct offer_ids seen
  series: CampaignDailyPoint[];
}

// Top-level insight band — the operator's "what should I do today?" digest.
// Built from the same aggregated dataset as the table so it's free.
export interface CampaignInsight {
  severity: 'info' | 'success' | 'warn' | 'critical';
  title: string;
  detail: string;
  campaign_id?: string;
}

export interface CampaignReportsResponse {
  from: string;
  to: string;
  campaigns: CampaignReportSummary[];
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
    spend_coverage: number;     // share of campaigns with any spend recorded
  };
  insights: CampaignInsight[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

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

// Crude ordinary-least-squares slope on the (index, value) pairs. Used to
// describe a "trending up vs down" signal in the insight band — not for
// charting. Returns 0 when fewer than 3 datapoints.
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

export const campaignReportsService = {
  async perCampaignSummary(f: CampaignReportsFilters): Promise<CampaignReportsResponse> {
    const rows = await campaignReportRepository.fetchRange({
      from: f.from,
      to: f.to,
      campaign_ids: f.campaign_ids,
    });

    const days = eachDayKeyUTC(f.from, f.to);

    // Group raw rows by campaign_id.
    const byCampaign = new Map<string, CampaignReportDoc[]>();
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

    const summaries: CampaignReportSummary[] = [];
    let totalClicks = 0;
    let totalPostbacks = 0;
    let totalConv = 0;
    let totalUnv = 0;
    let totalRevenue = 0;
    let totalSpend = 0;
    let profitableCampaigns = 0;
    let unprofitableCampaigns = 0;
    let campaignsWithSpend = 0;

    for (const campaign_id of campaignIds) {
      const cRows = byCampaign.get(campaign_id) ?? [];

      const seriesMap = new Map<string, CampaignDailyPoint>();
      for (const day of days) {
        seriesMap.set(day, {
          date: day,
          clicks: 0,
          postbacks: 0,
          conversions: 0,
          revenue: 0,
          spend: 0,
          profit: 0,
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
      let campaign_name: string | undefined;
      let source = 'gad_campaignid';
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
        series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      });

      totalClicks += clicks;
      totalPostbacks += postbacks;
      totalConv += conversions;
      totalUnv += unverified;
      totalRevenue += revenue;
      totalSpend += spend;
    }

    // Highest revenue surfaces first — same convention as offer reports.
    summaries.sort((a, b) => b.revenue - a.revenue);

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
    };

    const insights = buildInsights(summaries, totals);

    return {
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      campaigns: summaries,
      totals,
      insights,
    };
  },
};

function buildInsights(
  campaigns: CampaignReportSummary[],
  totals: CampaignReportsResponse['totals']
): CampaignInsight[] {
  const out: CampaignInsight[] = [];

  if (campaigns.length === 0) return out;

  // Spend coverage — silent unless we know something is missing.
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
        `${Math.round(totals.spend_coverage * 100)}% of campaigns have spend entered.` +
        ` Without spend, ROAS and ROI are unavailable. Add daily spend on the campaign detail page.${missingText}`,
    });
  }

  // Best ROAS — only report when we have meaningful spend (>$10) so a single
  // dollar of spend with one conversion doesn't crown a vanity winner.
  const withSpend = campaigns.filter((c) => c.spend >= 10);
  if (withSpend.length > 0) {
    const bestRoas = withSpend.reduce((a, b) => (b.roas > a.roas ? b : a));
    if (bestRoas.roas >= 1.5) {
      out.push({
        severity: 'success',
        title: `Top ROAS: ${bestRoas.campaign_name ?? bestRoas.campaign_id}`,
        detail:
          `${bestRoas.roas.toFixed(2)}× return ($${bestRoas.revenue.toFixed(2)} on $${bestRoas.spend.toFixed(2)} spend, ` +
          `profit $${bestRoas.profit.toFixed(2)}). Consider scaling budget here.`,
        campaign_id: bestRoas.campaign_id,
      });
    }

    // Worst ROAS — flag campaigns that are bleeding money. Only when loss
    // is material (spend > revenue by at least $20).
    const worstRoas = withSpend
      .filter((c) => c.spend - c.revenue >= 20)
      .reduce<CampaignReportSummary | undefined>((acc, c) => {
        if (!acc) return c;
        return c.roas < acc.roas ? c : acc;
      }, undefined);
    if (worstRoas) {
      out.push({
        severity: 'critical',
        title: `Losing money: ${worstRoas.campaign_name ?? worstRoas.campaign_id}`,
        detail:
          `ROAS ${worstRoas.roas.toFixed(2)}× — burning $${(-worstRoas.profit).toFixed(2)} ` +
          `(spent $${worstRoas.spend.toFixed(2)}, earned $${worstRoas.revenue.toFixed(2)}). ` +
          'Review creatives, geo or pause.',
        campaign_id: worstRoas.campaign_id,
      });
    }
  }

  // Profit concentration — Pareto check. If the top campaign carries more
  // than 60% of total profit (and there's at least 3 active campaigns), we
  // call out the dependency risk.
  if (campaigns.length >= 3 && totals.profit > 0) {
    const topByProfit = [...campaigns].sort((a, b) => b.profit - a.profit)[0]!;
    const share = topByProfit.profit / totals.profit;
    if (share >= 0.6) {
      out.push({
        severity: 'warn',
        title: 'Profit concentrated in one campaign',
        detail:
          `${(share * 100).toFixed(0)}% of total profit comes from ` +
          `${topByProfit.campaign_name ?? topByProfit.campaign_id}. ` +
          'Diversifying reduces single-campaign risk.',
        campaign_id: topByProfit.campaign_id,
      });
    }
  }

  // Spend with no revenue — burn-no-return campaigns. Flagged once we've
  // spent at least $25 and the campaign hasn't generated a single conversion.
  const burning = campaigns.filter((c) => c.spend >= 25 && c.conversions === 0);
  if (burning.length > 0) {
    const worst = burning.reduce((a, b) => (b.spend > a.spend ? b : a));
    out.push({
      severity: 'critical',
      title: `${burning.length} campaign${burning.length === 1 ? '' : 's'} spending without conversions`,
      detail:
        `Top loser: ${worst.campaign_name ?? worst.campaign_id} ` +
        `($${worst.spend.toFixed(2)} spent, 0 conversions). Tracking break or wrong audience.`,
      campaign_id: worst.campaign_id,
    });
  }

  // Trend signal on the highest-revenue campaign — is the line going up or
  // down across the window? Useful when the operator just changed bids.
  const top = campaigns[0]!;
  if (top.series.length >= 7 && top.revenue > 0) {
    const revSlope = slope(top.series.map((p) => p.revenue));
    const avgRev = top.revenue / top.series.length;
    const relSlope = avgRev > 0 ? revSlope / avgRev : 0;
    if (relSlope >= 0.05) {
      out.push({
        severity: 'success',
        title: `${top.campaign_name ?? top.campaign_id} trending up`,
        detail: `Revenue line is climbing across the window (slope ≈ $${revSlope.toFixed(2)}/day). Keep going.`,
        campaign_id: top.campaign_id,
      });
    } else if (relSlope <= -0.05) {
      out.push({
        severity: 'warn',
        title: `${top.campaign_name ?? top.campaign_id} trending down`,
        detail: `Revenue line is falling (slope ≈ $${revSlope.toFixed(2)}/day). Investigate before it accelerates.`,
        campaign_id: top.campaign_id,
      });
    }
  }

  // Headline OK message when all signals are quiet — gives the operator
  // confidence that the dashboard is alive and just has nothing to flag.
  if (out.length === 0 && totals.revenue > 0) {
    out.push({
      severity: 'info',
      title: 'No anomalies detected',
      detail:
        `${totals.campaigns} campaign${totals.campaigns === 1 ? '' : 's'} active in this window. ` +
        `Total profit $${totals.profit.toFixed(2)} on $${totals.spend.toFixed(2)} spend.`,
    });
  }

  return out;
}
