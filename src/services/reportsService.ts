import { clickRepository, conversionRepository } from '../firestore';

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
  cvr: number;             // conversions / clicks
  epc: number;             // revenue / clicks
}

export interface TimeseriesPoint {
  date: string;            // ISO date (YYYY-MM-DD) — bucket start in UTC
  clicks: number;
  postbacks: number;
  conversions: number;
  revenue: number;
}

// Day-level bucketing. Fine enough for the default 30-day window without
// forcing a second pass through the timeline.
const DAY_MS = 24 * 60 * 60 * 1000;

// Ceiling on how many docs we pull when building the timeseries. Counts +
// revenue use aggregate queries (no fetch limit), but the bucketing pass
// has to read each doc. At ~5k/day this covers ~90 days of real traffic.
const MAX_FETCH = 20_000;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDayUTC(from: Date, to: Date): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export const reportsService = {
  async summary(f: ReportFilters): Promise<ReportSummary> {
    // Parallelise the four aggregates — Firestore bills by doc read, not by
    // query count, so the cost is the same as fetching once.
    const [clicks, postbacks, conversions, revenue] = await Promise.all([
      clickRepository.countRange({ from: f.from, to: f.to, offer_id: f.offer_id }),
      conversionRepository.countRange({
        from: f.from,
        to: f.to,
        offer_id: f.offer_id,
        network_id: f.network_id,
      }),
      conversionRepository.countRange({
        from: f.from,
        to: f.to,
        offer_id: f.offer_id,
        network_id: f.network_id,
        verified: true,
      }),
      conversionRepository.sumPayout({
        from: f.from,
        to: f.to,
        offer_id: f.offer_id,
        network_id: f.network_id,
        verified: true,
      }),
    ]);

    return {
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      clicks,
      postbacks,
      conversions,
      unverified: Math.max(0, postbacks - conversions),
      revenue,
      cvr: clicks > 0 ? conversions / clicks : 0,
      epc: clicks > 0 ? revenue / clicks : 0,
    };
  },

  async timeseries(f: ReportFilters): Promise<TimeseriesPoint[]> {
    const [clickDocs, convDocs] = await Promise.all([
      clickRepository.fetchRange({
        from: f.from,
        to: f.to,
        offer_id: f.offer_id,
        max: MAX_FETCH,
      }),
      conversionRepository.fetchRange({
        from: f.from,
        to: f.to,
        offer_id: f.offer_id,
        network_id: f.network_id,
        max: MAX_FETCH,
      }),
    ]);

    const buckets = new Map<string, TimeseriesPoint>();
    for (const day of eachDayUTC(f.from, f.to)) {
      buckets.set(day, { date: day, clicks: 0, postbacks: 0, conversions: 0, revenue: 0 });
    }

    for (const c of clickDocs) {
      if (!c.created_at) continue;
      const key = dayKey(new Date(c.created_at));
      const b = buckets.get(key);
      if (b) b.clicks += 1;
    }

    for (const c of convDocs) {
      if (!c.created_at) continue;
      const key = dayKey(new Date(c.created_at));
      const b = buckets.get(key);
      if (!b) continue;
      b.postbacks += 1;
      if (c.verified) {
        b.conversions += 1;
        if (typeof c.payout === 'number') b.revenue += c.payout;
      }
    }

    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  },
};
