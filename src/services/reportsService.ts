import { offerReportRepository, type OfferReportDoc } from '../firestore';

export interface ReportFilters {
  from: Date;
  to: Date;
  offer_id?: string;
  network_id?: string;
}

export interface ReportSummary {
  from: string;
  to: string;
  clicks: number;
  postbacks: number;       // all conversion rows (verified + unverified)
  conversions: number;     // verified only
  unverified: number;      // postbacks - conversions
  revenue: number;         // sum of payout across verified conversions
  // Unknown-click sub-totals — surfaced separately so the dashboard can show
  // "we received N more conversions worth $X but couldn't attribute the click".
  // Already counted inside `unverified`; NOT counted in `conversions` or `revenue`.
  unknown_click_conversions: number;
  unknown_click_revenue: number;
  cvr: number;             // conversions / clicks
  epc: number;             // revenue / clicks
}

export interface TimeseriesPoint {
  date: string;            // ISO date (YYYY-MM-DD) — bucket start in UTC
  clicks: number;
  postbacks: number;
  conversions: number;
  revenue: number;
  unknown_click_conversions: number;
  unknown_click_revenue: number;
}

export interface ReportOverview {
  summary: ReportSummary;
  points: TimeseriesPoint[];
}

// Day-level bucketing. Fine enough for the default 30-day window without
// forcing a second pass through the timeline.
const DAY_MS = 24 * 60 * 60 * 1000;

function eachDayUTC(from: Date, to: Date): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// Single row-load + reducer. summary, timeseries, and overview all funnel
// through here so a /reports page load reduces to one fetchRange call (the
// repository TTL cache then collapses any stragglers across requests).
async function loadAndReduce(f: ReportFilters): Promise<ReportOverview> {
  const rollupDocs: OfferReportDoc[] = await offerReportRepository.fetchRange({
    from: f.from,
    to: f.to,
    offer_ids: f.offer_id ? [f.offer_id] : undefined,
  });

  const buckets = new Map<string, TimeseriesPoint>();
  for (const day of eachDayUTC(f.from, f.to)) {
    buckets.set(day, {
      date: day, clicks: 0, postbacks: 0, conversions: 0, revenue: 0,
      unknown_click_conversions: 0, unknown_click_revenue: 0,
    });
  }

  let clicks = 0;
  let postbacks = 0;
  let conversions = 0;
  let revenue = 0;
  let unknown_click_conversions = 0;
  let unknown_click_revenue = 0;

  for (const r of rollupDocs) {
    // Clicks are stored under network_id = 'none'; they apply regardless of
    // network filter.
    if (r.network_id === 'none') {
      clicks += r.clicks;
    }
    // For conversions/revenue, if there's no network filter include all
    // networks; otherwise only the matching network.
    if (!f.network_id || r.network_id === f.network_id) {
      postbacks += r.postbacks;
      conversions += r.conversions;
      revenue += r.revenue;
      unknown_click_conversions += r.unknown_click_conversions;
      unknown_click_revenue += r.unknown_click_revenue;
    }

    const b = buckets.get(r.date);
    if (!b) continue;
    if (r.network_id === 'none') {
      b.clicks += r.clicks;
    }
    if (!f.network_id || r.network_id === f.network_id) {
      b.postbacks += r.postbacks;
      b.conversions += r.conversions;
      b.revenue += r.revenue;
      b.unknown_click_conversions += r.unknown_click_conversions;
      b.unknown_click_revenue += r.unknown_click_revenue;
    }
  }

  const summary: ReportSummary = {
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    clicks,
    postbacks,
    conversions,
    unverified: Math.max(0, postbacks - conversions),
    revenue,
    unknown_click_conversions,
    unknown_click_revenue,
    cvr: clicks > 0 ? conversions / clicks : 0,
    epc: clicks > 0 ? revenue / clicks : 0,
  };
  const points = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  return { summary, points };
}

export const reportsService = {
  async summary(f: ReportFilters): Promise<ReportSummary> {
    const { summary } = await loadAndReduce(f);
    return summary;
  },

  async timeseries(f: ReportFilters): Promise<TimeseriesPoint[]> {
    const { points } = await loadAndReduce(f);
    return points;
  },

  // Combined endpoint — summary + timeseries from a single rollup scan.
  // Frontend's /reports page uses this so the two stat-card and chart panels
  // draw from one HTTP round-trip and one Firestore read.
  async overview(f: ReportFilters): Promise<ReportOverview> {
    return loadAndReduce(f);
  },
};
