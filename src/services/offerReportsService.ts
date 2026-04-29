import { offerReportRepository, offerRepository, type OfferReportDoc } from '../firestore';

export interface OfferReportsFilters {
  from: Date;
  to: Date;
  offer_ids?: string[];   // when set, restrict to these offers
}

// Per-offer aggregate over the requested window.
export interface OfferReportSummary {
  offer_id: string;
  offer_name?: string;
  status?: 'active' | 'paused';
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
  cvr: number;            // conversions / clicks
  epc: number;            // revenue / clicks
  rpm: number;            // revenue * 1000 / clicks
  avg_payout: number;     // revenue / conversions
  approval_rate: number;  // approved / conversions
  // Forecast for the calendar month *that contains `to`* (UTC). Built from
  // month-to-date revenue projected linearly to the month's last day. Returns
  // 0 when `to` is outside the current month or month-to-date is empty.
  est_month_end_revenue: number;
  // Day-by-day timeline for sparklines/visualisations (optional; included).
  series: OfferDailyPoint[];
}

export interface OfferDailyPoint {
  date: string;           // YYYY-MM-DD
  clicks: number;
  postbacks: number;
  conversions: number;
  revenue: number;
}

export interface OfferReportsResponse {
  from: string;
  to: string;
  offers: OfferReportSummary[];
  // Combined totals across the returned offers — handy for the multi-select
  // UI summary cards without having to re-sum on the client.
  totals: {
    clicks: number;
    postbacks: number;
    conversions: number;
    unverified: number;
    revenue: number;
    est_month_end_revenue: number;
  };
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

// Days remaining in the calendar month containing `ref` (UTC). Inclusive of
// `ref`'s day. Used as a divisor for month-to-date forecasting.
function monthInfo(ref: Date): {
  monthStart: Date;
  monthEnd: Date;
  daysInMonth: number;
  dayOfMonth: number;
} {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 0));
  const daysInMonth = monthEnd.getUTCDate();
  return { monthStart, monthEnd, daysInMonth, dayOfMonth: ref.getUTCDate() };
}

// Linear month-end forecast based on month-to-date revenue. Skips when the
// month is over (just returns the month's actual revenue) or when there's
// nothing to project from.
function forecastMonthEnd(rows: OfferReportDoc[], reference: Date): number {
  const { monthStart, daysInMonth, dayOfMonth } = monthInfo(reference);
  const monthStartKey = dayKeyUTC(monthStart);
  const refKey = dayKeyUTC(reference);
  let mtdRevenue = 0;
  for (const r of rows) {
    if (r.date >= monthStartKey && r.date <= refKey) mtdRevenue += r.revenue;
  }
  if (dayOfMonth === 0 || daysInMonth === 0) return 0;
  // If reference is the last day of the month, MTD == final.
  if (dayOfMonth >= daysInMonth) return mtdRevenue;
  // Linear extrapolation. A more sophisticated model could weight recent
  // days higher, but linear is the right default for a small dashboard.
  return mtdRevenue * (daysInMonth / dayOfMonth);
}

export const offerReportsService = {
  // Per-offer summary + per-offer daily series for the requested window.
  // Single Firestore range scan, then bucket in-memory by offer_id.
  async perOfferSummary(f: OfferReportsFilters): Promise<OfferReportsResponse> {
    const [rows, offers] = await Promise.all([
      offerReportRepository.fetchRange({
        from: f.from,
        to: f.to,
        offer_ids: f.offer_ids,
      }),
      // Pull offer metadata so the response carries display names. List is
      // typically ≤ a few hundred — fine to fetch all.
      offerRepository.list({ limit: 100 }),
    ]);

    const offerMeta = new Map(offers.items.map((o) => [o.offer_id, o]));
    const days = eachDayKeyUTC(f.from, f.to);

    // Group raw rows by offer_id.
    const byOffer = new Map<string, OfferReportDoc[]>();
    for (const r of rows) {
      let bucket = byOffer.get(r.offer_id);
      if (!bucket) {
        bucket = [];
        byOffer.set(r.offer_id, bucket);
      }
      bucket.push(r);
    }

    // If the caller asked for a specific set of offers, surface them all even
    // when the range is empty so the table shows zeros instead of dropping
    // the row. Without an offer filter, we only emit offers that have data.
    const offerIds = f.offer_ids && f.offer_ids.length > 0
      ? f.offer_ids
      : Array.from(byOffer.keys());

    const summaries: OfferReportSummary[] = [];
    let totalClicks = 0;
    let totalPostbacks = 0;
    let totalConv = 0;
    let totalUnv = 0;
    let totalRevenue = 0;
    let totalForecast = 0;

    for (const offer_id of offerIds) {
      const meta = offerMeta.get(offer_id);
      const offerRows = byOffer.get(offer_id) ?? [];

      // Build day buckets so the series is dense (zeros included).
      const seriesMap = new Map<string, OfferDailyPoint>();
      for (const day of days) {
        seriesMap.set(day, { date: day, clicks: 0, postbacks: 0, conversions: 0, revenue: 0 });
      }
      let clicks = 0;
      let postbacks = 0;
      let conversions = 0;
      let unverified = 0;
      let approved = 0;
      let pending = 0;
      let rejected = 0;
      let revenue = 0;
      for (const r of offerRows) {
        clicks += r.clicks;
        postbacks += r.postbacks;
        conversions += r.conversions;
        unverified += r.unverified;
        approved += r.approved;
        pending += r.pending;
        rejected += r.rejected;
        revenue += r.revenue;
        const point = seriesMap.get(r.date);
        if (point) {
          point.clicks += r.clicks;
          point.postbacks += r.postbacks;
          point.conversions += r.conversions;
          point.revenue += r.revenue;
        }
      }

      // Forecast uses the MTD slice of the same window — if `to` falls in the
      // current month, we project; otherwise return 0 so the UI knows there's
      // no live forecast to show for historical ranges.
      const forecast = forecastMonthEnd(offerRows, f.to);

      summaries.push({
        offer_id,
        offer_name: meta?.name,
        status: meta?.status,
        clicks,
        postbacks,
        conversions,
        unverified,
        approved,
        pending,
        rejected,
        revenue,
        cvr: clicks > 0 ? conversions / clicks : 0,
        epc: clicks > 0 ? revenue / clicks : 0,
        rpm: clicks > 0 ? (revenue * 1000) / clicks : 0,
        avg_payout: conversions > 0 ? revenue / conversions : 0,
        approval_rate: conversions > 0 ? approved / conversions : 0,
        est_month_end_revenue: forecast,
        series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      });

      totalClicks += clicks;
      totalPostbacks += postbacks;
      totalConv += conversions;
      totalUnv += unverified;
      totalRevenue += revenue;
      totalForecast += forecast;
    }

    // Sort by revenue desc — the high-grossing offers float to the top, which
    // is what an admin scanning the table cares about most.
    summaries.sort((a, b) => b.revenue - a.revenue);

    return {
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      offers: summaries,
      totals: {
        clicks: totalClicks,
        postbacks: totalPostbacks,
        conversions: totalConv,
        unverified: totalUnv,
        revenue: totalRevenue,
        est_month_end_revenue: totalForecast,
      },
    };
  },
};
