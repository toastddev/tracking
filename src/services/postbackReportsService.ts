import { networkRepository, offerReportRepository } from '../firestore';

// Per-network postback summary for the requested window.
//
// Now backed by the `offer_reports` collection which is grouped by 
// both `offer_id` and `network_id`. This eliminates the need to fetch 
// raw conversions.
//
// Cost characteristics:
//   - One indexed Firestore range scan over offer_reports in the window.
//   - O(Rollups) in-memory pass to bucket by network_id + day.
//   - No per-network range query (would be O(N_networks) round-trips).
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PostbackReportsFilters {
  from: Date;
  to: Date;
  network_ids?: string[];
}

export interface PostbackDailyPoint {
  date: string;
  postbacks: number;
  verified: number;
  unverified: number;
  revenue: number;
}

// Per-network summary. Match-rate is the postback equivalent of CVR — it's
// what an operator scans the table for when something feels off.
export interface PostbackNetworkSummary {
  network_id: string;
  network_name?: string;
  status?: 'active' | 'paused';
  postbacks: number;
  verified: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
  match_rate: number;        // verified / postbacks — primary health KPI
  approval_rate: number;     // approved / verified — network's grading
  avg_payout: number;        // revenue / verified
  unique_offers: number;     // distinct offer_ids on verified rows
  series: PostbackDailyPoint[];
}

export interface PostbackReportsResponse {
  from: string;
  to: string;
  networks: PostbackNetworkSummary[];
  totals: {
    postbacks: number;
    verified: number;
    unverified: number;
    revenue: number;
    networks: number;
  };
  truncated: boolean;       // always false now as we use rollups
  conversions_scanned: number;
}

function eachDayKeyUTC(from: Date, to: Date): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export const postbackReportsService = {
  async perNetworkSummary(f: PostbackReportsFilters): Promise<PostbackReportsResponse> {
    const [rows, networks] = await Promise.all([
      offerReportRepository.fetchRange({ from: f.from, to: f.to }),
      // Pull network metadata for names/status. Few hundred at most.
      networkRepository.list({ limit: 100 }),
    ]);

    const meta = new Map(networks.items.map((n) => [n.network_id, n]));
    const days = eachDayKeyUTC(f.from, f.to);

    interface Bucket {
      summary: PostbackNetworkSummary;
      offers: Set<string>;
      seriesMap: Map<string, PostbackDailyPoint>;
    }
    const buckets = new Map<string, Bucket>();

    function bucketFor(network_id: string): Bucket {
      let b = buckets.get(network_id);
      if (b) return b;
      const m = meta.get(network_id);
      const seriesMap = new Map<string, PostbackDailyPoint>();
      for (const d of days) {
        seriesMap.set(d, { date: d, postbacks: 0, verified: 0, unverified: 0, revenue: 0 });
      }
      b = {
        summary: {
          network_id,
          network_name: m?.name,
          status: m?.status,
          postbacks: 0, verified: 0, unverified: 0,
          approved: 0, pending: 0, rejected: 0, revenue: 0,
          match_rate: 0, approval_rate: 0, avg_payout: 0,
          unique_offers: 0,
          series: [],
        },
        offers: new Set<string>(),
        seriesMap,
      };
      buckets.set(network_id, b);
      return b;
    }

    let totalPostbacks = 0, totalVerified = 0, totalUnverified = 0, totalRevenue = 0;

    const filterSet = f.network_ids && f.network_ids.length > 0 ? new Set(f.network_ids) : null;

    for (const r of rows) {
      // If it's purely a click rollup (no postbacks/conversions), skip it
      if (r.network_id === 'none' && r.postbacks === 0 && r.conversions === 0 && r.unverified === 0) continue;

      // Legacy rows (recorded before the network_id schema change) will have network_id = 'none' 
      // but will contain postback/conversion data. Group them under '(unknown)'.
      const network_id = r.network_id === 'none' ? '(unknown)' : r.network_id;
      if (filterSet && !filterSet.has(network_id)) continue;
      const b = bucketFor(network_id);

      b.summary.postbacks += r.postbacks;
      totalPostbacks += r.postbacks;

      b.summary.verified += r.conversions;
      totalVerified += r.conversions;

      b.summary.approved += r.approved;
      b.summary.pending += r.pending;
      b.summary.rejected += r.rejected;
      
      b.summary.revenue += r.revenue;
      totalRevenue += r.revenue;

      if (r.conversions > 0 && r.offer_id) b.offers.add(r.offer_id);

      b.summary.unverified += r.unverified;
      totalUnverified += r.unverified;

      const point = b.seriesMap.get(r.date);
      if (point) {
        point.postbacks += r.postbacks;
        point.verified += r.conversions;
        point.unverified += r.unverified;
        point.revenue += r.revenue;
      }
    }

    // If the caller requested a specific set of networks, surface the rest as
    // zero rows so the table is stable even when the network had no fires.
    if (filterSet) {
      for (const id of filterSet) bucketFor(id);
    }

    // Finalise computed metrics.
    for (const b of buckets.values()) {
      const s = b.summary;
      s.match_rate = s.postbacks > 0 ? s.verified / s.postbacks : 0;
      s.approval_rate = s.verified > 0 ? s.approved / s.verified : 0;
      s.avg_payout = s.verified > 0 ? s.revenue / s.verified : 0;
      s.unique_offers = b.offers.size;
      s.series = Array.from(b.seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    const summaries = Array.from(buckets.values())
      .map((b) => b.summary)
      // Postbacks-first sort. Revenue would over-weight networks that match
      // few clicks but pay heavily; the operator cares about delivery health.
      .sort((a, b) => b.postbacks - a.postbacks);

    return {
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      networks: summaries,
      totals: {
        postbacks: totalPostbacks,
        verified: totalVerified,
        unverified: totalUnverified,
        revenue: totalRevenue,
        networks: summaries.length,
      },
      truncated: false,
      conversions_scanned: rows.length,
    };
  },
};
