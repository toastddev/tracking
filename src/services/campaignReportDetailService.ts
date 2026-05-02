import {
  campaignReportRepository,
  clickRepository,
  conversionRepository,
  offerRepository,
  type CampaignReportDoc,
} from '../firestore';

// Caps copied from offerReportDetailService — same memory/latency envelope.
const CLICK_FETCH_CAP = 20_000;
const CONVERSION_FETCH_CAP = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface CampaignDetailFilters {
  campaign_id: string;
  from: Date;
  to: Date;
}

export interface CampaignDetailDailyPoint {
  date: string;
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
  roas: number;
}

export interface CampaignDetailSummary {
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
}

export interface CampaignDetailDeltas {
  revenue_pct: number | null;
  spend_pct: number | null;
  profit_abs: number | null;
  clicks_pct: number | null;
  conversions_pct: number | null;
  cvr_abs: number | null;
  roas_abs: number | null;
}

export interface CampaignOfferBreakdown {
  offer_id: string;
  offer_name?: string;
  clicks: number;
  conversions: number;
  revenue: number;
  cvr: number;
  share_of_revenue: number;
}

export interface CampaignWeekdayBreakdown {
  dow: number;            // 0=Sun
  label: string;
  clicks: number;
  conversions: number;
  revenue: number;
  spend: number;
  profit: number;
}

export interface CampaignSpendDay {
  date: string;
  spend: number;
  revenue: number;
  profit: number;
}

export interface CampaignDetailFlag {
  severity: 'info' | 'success' | 'warn' | 'critical';
  title: string;
  detail: string;
}

export interface CampaignDetailResponse {
  campaign: {
    campaign_id: string;
    campaign_name?: string;
    source: string;
    first_seen?: string;
    last_seen?: string;
  };
  range: { from: string; to: string; days: number };
  previous_range: { from: string; to: string };

  summary: CampaignDetailSummary;
  previous: CampaignDetailSummary;
  deltas: CampaignDetailDeltas;

  series: CampaignDetailDailyPoint[];
  spend_days: CampaignSpendDay[];     // exact set of operator-entered spend days

  breakdowns: {
    offers: CampaignOfferBreakdown[];
    weekday: CampaignWeekdayBreakdown[];
  };

  flags: CampaignDetailFlag[];
  samples: {
    clicks_sampled: number;
    conversions_sampled: number;
    clicks_truncated: boolean;
    conversions_truncated: boolean;
  };

  best_day?: { date: string; profit: number; revenue: number; spend: number };
  worst_day?: { date: string; profit: number; revenue: number; spend: number };
}

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

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  return (curr - prev) / Math.abs(prev);
}

function summariseRows(rows: CampaignReportDoc[]): CampaignDetailSummary {
  let clicks = 0, postbacks = 0, conversions = 0, unverified = 0;
  let approved = 0, pending = 0, rejected = 0, revenue = 0, spend = 0;
  for (const r of rows) {
    clicks += r.clicks;
    postbacks += r.postbacks;
    conversions += r.conversions;
    unverified += r.unverified;
    approved += r.approved;
    pending += r.pending;
    rejected += r.rejected;
    revenue += r.revenue;
    spend += r.spend;
  }
  const profit = revenue - spend;
  return {
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
  };
}

export const campaignReportDetailService = {
  async getDetail(f: CampaignDetailFilters): Promise<CampaignDetailResponse> {
    const days = eachDayKeyUTC(f.from, f.to);
    const spanMs = f.to.getTime() - f.from.getTime();
    const prevTo = new Date(f.from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - spanMs);

    // Pull rollup for current + previous window in parallel. The previous-
    // window pull powers period-over-period deltas without touching raw docs.
    const [currentRows, previousRows, allRows] = await Promise.all([
      campaignReportRepository.fetchRange({
        from: f.from,
        to: f.to,
        campaign_ids: [f.campaign_id],
      }),
      campaignReportRepository.fetchRange({
        from: prevFrom,
        to: prevTo,
        campaign_ids: [f.campaign_id],
      }),
      campaignReportRepository.fetchByCampaign(f.campaign_id),
    ]);

    // Pull raw clicks + conversions in the window so we can build a per-offer
    // breakdown that's accurate (the rollup `offers` array is just a "saw it"
    // set — it doesn't carry per-offer revenue/CVR). Capped to keep the page
    // fast even for huge campaigns.
    const [clicks, conversions, offersList] = await Promise.all([
      clickRepository.fetchRangeForBreakdown({
        from: f.from,
        to: f.to,
        max: CLICK_FETCH_CAP,
      }),
      conversionRepository.fetchRange({
        from: f.from,
        to: f.to,
        max: CONVERSION_FETCH_CAP,
      }),
      offerRepository.list({ limit: 100 }),
    ]);

    const offerNames = new Map(offersList.items.map((o) => [o.offer_id, o.name]));

    // Filter clicks to this campaign only — match by gad_campaignid OR
    // utm_campaign so non-Google traffic is included.
    const campaignClickIds = new Set<string>();
    const clicksByOffer = new Map<string, { clicks: number; conversions: number; revenue: number }>();
    let clicksSampled = 0;
    for (const c of clicks) {
      const cid = (c.extra_params?.gad_campaignid as string | undefined) ||
                  (c.extra_params?.utm_campaign as string | undefined);
      if (cid !== f.campaign_id) continue;
      campaignClickIds.add(c.click_id);
      clicksSampled += 1;
      const offer = c.offer_id || 'unknown';
      let bucket = clicksByOffer.get(offer);
      if (!bucket) {
        bucket = { clicks: 0, conversions: 0, revenue: 0 };
        clicksByOffer.set(offer, bucket);
      }
      bucket.clicks += 1;
    }

    // Conversions whose click belongs to this campaign — collapse to the same
    // offer buckets. Unverified conversions are skipped (no click_id match,
    // so attribution to the campaign is impossible).
    let conversionsSampled = 0;
    for (const conv of conversions) {
      if (!conv.verified) continue;
      if (!conv.click_id || !campaignClickIds.has(conv.click_id)) continue;
      conversionsSampled += 1;
      const offer = conv.offer_id || 'unknown';
      let bucket = clicksByOffer.get(offer);
      if (!bucket) {
        bucket = { clicks: 0, conversions: 0, revenue: 0 };
        clicksByOffer.set(offer, bucket);
      }
      bucket.conversions += 1;
      if (typeof conv.payout === 'number' && Number.isFinite(conv.payout)) {
        bucket.revenue += conv.payout;
      }
    }

    const summary = summariseRows(currentRows);
    const previous = summariseRows(previousRows);

    const deltas: CampaignDetailDeltas = {
      revenue_pct: pctChange(summary.revenue, previous.revenue),
      spend_pct: pctChange(summary.spend, previous.spend),
      profit_abs: summary.profit - previous.profit,
      clicks_pct: pctChange(summary.clicks, previous.clicks),
      conversions_pct: pctChange(summary.conversions, previous.conversions),
      cvr_abs: summary.cvr - previous.cvr,
      roas_abs: summary.roas - previous.roas,
    };

    // Dense daily series — every day in the window, even zeros.
    const seriesMap = new Map<string, CampaignDetailDailyPoint>();
    for (const day of days) {
      seriesMap.set(day, {
        date: day,
        clicks: 0,
        postbacks: 0,
        conversions: 0,
        unverified: 0,
        approved: 0,
        pending: 0,
        rejected: 0,
        revenue: 0,
        spend: 0,
        profit: 0,
        roas: 0,
      });
    }
    for (const r of currentRows) {
      const p = seriesMap.get(r.date);
      if (!p) continue;
      p.clicks += r.clicks;
      p.postbacks += r.postbacks;
      p.conversions += r.conversions;
      p.unverified += r.unverified;
      p.approved += r.approved;
      p.pending += r.pending;
      p.rejected += r.rejected;
      p.revenue += r.revenue;
      p.spend += r.spend;
      p.profit = p.revenue - p.spend;
      p.roas = safeDiv(p.revenue, p.spend);
    }
    const series = Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Spend days — exact list of operator-entered values, separate from the
    // series so the spend editor can show "what's currently set".
    const spend_days: CampaignSpendDay[] = currentRows
      .filter((r) => r.spend > 0)
      .map((r) => ({
        date: r.date,
        spend: r.spend,
        revenue: r.revenue,
        profit: r.revenue - r.spend,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Per-offer breakdown derived from the raw scan.
    const offers: CampaignOfferBreakdown[] = Array.from(clicksByOffer.entries())
      .map(([offer_id, b]) => ({
        offer_id,
        offer_name: offerNames.get(offer_id),
        clicks: b.clicks,
        conversions: b.conversions,
        revenue: b.revenue,
        cvr: safeDiv(b.conversions, b.clicks),
        share_of_revenue: 0, // filled below
      }))
      .sort((a, b) => b.revenue - a.revenue);
    const offerRevenueTotal = offers.reduce((s, o) => s + o.revenue, 0);
    for (const o of offers) {
      o.share_of_revenue = safeDiv(o.revenue, offerRevenueTotal);
    }

    // Weekday breakdown — collapses the dense daily series into a 7-row table.
    const weekdayBuckets: CampaignWeekdayBreakdown[] = DAY_LABELS.map((label, dow) => ({
      dow,
      label,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      spend: 0,
      profit: 0,
    }));
    for (const p of series) {
      const d = new Date(`${p.date}T00:00:00Z`);
      const dow = d.getUTCDay();
      const w = weekdayBuckets[dow]!;
      w.clicks += p.clicks;
      w.conversions += p.conversions;
      w.revenue += p.revenue;
      w.spend += p.spend;
      w.profit += p.profit;
    }

    // Best / worst day by profit (only consider days with activity).
    const activeDays = series.filter((p) => p.revenue > 0 || p.spend > 0);
    let best_day: CampaignDetailResponse['best_day'];
    let worst_day: CampaignDetailResponse['worst_day'];
    if (activeDays.length > 0) {
      const top = activeDays.reduce((a, b) => (b.profit > a.profit ? b : a));
      const bot = activeDays.reduce((a, b) => (b.profit < a.profit ? b : a));
      best_day = { date: top.date, profit: top.profit, revenue: top.revenue, spend: top.spend };
      worst_day = { date: bot.date, profit: bot.profit, revenue: bot.revenue, spend: bot.spend };
    }

    // Campaign metadata — earliest & latest day with any activity.
    const allActive = allRows.filter((r) =>
      r.clicks > 0 || r.postbacks > 0 || r.spend > 0
    );
    const first_seen = allActive[0]?.date;
    const last_seen = allActive[allActive.length - 1]?.date;
    const campaign_name =
      currentRows.find((r) => r.campaign_name)?.campaign_name ??
      allRows.find((r) => r.campaign_name)?.campaign_name;
    const source = (currentRows[0]?.source ?? allRows[0]?.source ?? 'gad_campaignid');

    const flags = buildFlags({ summary, previous, series, spend_days, offers });

    return {
      campaign: {
        campaign_id: f.campaign_id,
        campaign_name,
        source,
        first_seen,
        last_seen,
      },
      range: {
        from: f.from.toISOString(),
        to: f.to.toISOString(),
        days: days.length,
      },
      previous_range: {
        from: prevFrom.toISOString(),
        to: prevTo.toISOString(),
      },
      summary,
      previous,
      deltas,
      series,
      spend_days,
      breakdowns: {
        offers,
        weekday: weekdayBuckets,
      },
      flags,
      samples: {
        clicks_sampled: clicksSampled,
        conversions_sampled: conversionsSampled,
        clicks_truncated: clicks.length >= CLICK_FETCH_CAP,
        conversions_truncated: conversions.length >= CONVERSION_FETCH_CAP,
      },
      best_day,
      worst_day,
    };
  },
};

function buildFlags(input: {
  summary: CampaignDetailSummary;
  previous: CampaignDetailSummary;
  series: CampaignDetailDailyPoint[];
  spend_days: CampaignSpendDay[];
  offers: CampaignOfferBreakdown[];
}): CampaignDetailFlag[] {
  const out: CampaignDetailFlag[] = [];
  const { summary, previous, series, spend_days, offers } = input;

  // No spend recorded at all — can't measure ROAS.
  if (summary.clicks > 0 && summary.spend === 0) {
    out.push({
      severity: 'warn',
      title: 'No ad spend recorded',
      detail: 'ROAS and ROI are unavailable until daily spend is entered. Use the spend editor below.',
    });
  }

  // Big losing day — when the worst single day's loss is larger than the
  // average daily revenue, flag it for inspection.
  const losingDays = series.filter((p) => p.spend > 0 && p.profit < 0);
  const totalLoss = losingDays.reduce((s, p) => s + p.profit, 0);
  if (losingDays.length > 0 && totalLoss < -Math.max(50, summary.revenue * 0.2)) {
    const worst = losingDays.reduce((a, b) => (b.profit < a.profit ? b : a));
    out.push({
      severity: 'critical',
      title: `${losingDays.length} loss day${losingDays.length === 1 ? '' : 's'} in this window`,
      detail:
        `Worst: ${worst.date} (lost $${(-worst.profit).toFixed(2)} on $${worst.spend.toFixed(2)} spend). ` +
        `Total losses across the window: $${(-totalLoss).toFixed(2)}.`,
    });
  }

  // ROAS direction shift — call out a swing of more than 0.5x between the
  // current and previous window. Useful when something changed mid-period.
  if (previous.spend > 0 && summary.spend > 0) {
    const swing = summary.roas - previous.roas;
    if (swing >= 0.5) {
      out.push({
        severity: 'success',
        title: 'ROAS improved vs previous period',
        detail:
          `ROAS climbed from ${previous.roas.toFixed(2)}× to ${summary.roas.toFixed(2)}× ` +
          `(+${swing.toFixed(2)}). Whatever changed, keep doing it.`,
      });
    } else if (swing <= -0.5) {
      out.push({
        severity: 'warn',
        title: 'ROAS dropped vs previous period',
        detail:
          `ROAS fell from ${previous.roas.toFixed(2)}× to ${summary.roas.toFixed(2)}× ` +
          `(${swing.toFixed(2)}). Investigate creative fatigue or audience saturation.`,
      });
    }
  }

  // Spend coverage gap — operator entered some days but not others.
  const activeDayCount = series.filter((p) => p.clicks > 0 || p.spend > 0).length;
  if (spend_days.length > 0 && activeDayCount > spend_days.length * 1.5) {
    out.push({
      severity: 'info',
      title: 'Some active days have no spend recorded',
      detail:
        `Spend entered for ${spend_days.length} of ${activeDayCount} active days. ` +
        'ROAS/ROI on the chart will look inflated for the missing days.',
    });
  }

  // Top-offer concentration on this campaign.
  if (offers.length >= 2 && summary.revenue > 0) {
    const top = offers[0]!;
    if (top.share_of_revenue >= 0.8) {
      out.push({
        severity: 'info',
        title: 'Campaign concentrates on one offer',
        detail:
          `${(top.share_of_revenue * 100).toFixed(0)}% of revenue is from ${top.offer_name ?? top.offer_id}. ` +
          'Consider whether to fan the campaign out or commit harder to this offer.',
      });
    }
  }

  // CVR drop relative to previous window — early signal of tracking break or
  // landing-page issue.
  if (previous.clicks > 50 && summary.clicks > 50) {
    const cvrDrop = previous.cvr - summary.cvr;
    if (cvrDrop > 0.005) { // >0.5pp absolute drop
      out.push({
        severity: 'warn',
        title: 'Conversion rate dropped',
        detail:
          `CVR fell from ${(previous.cvr * 100).toFixed(2)}% to ${(summary.cvr * 100).toFixed(2)}% ` +
          `(-${(cvrDrop * 100).toFixed(2)}pp). Check the landing page and tracking.`,
      });
    }
  }

  return out;
}
