import {
  offerReportRepository,
  drilldownRepository,
  offerRepository,
  conversionRepository,
} from '../firestore';
import type { OfferReportDoc } from '../firestore';

// Hard caps on raw doc materialisation. Each click ~1–4 KB, each conversion
// ~1–6 KB. 20k clicks ≈ 30–80 MB transferred from Firestore — the upper edge
// of "snappy" for a single request. Above this we truncate and surface the
// fact in the response so the UI can warn the operator.
const CLICK_FETCH_CAP = 20_000;
const CONVERSION_FETCH_CAP = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OfferDetailFilters {
  offer_id: string;
  from: Date;
  to: Date;
}

export interface DetailDailyPoint {
  date: string;
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
}

export interface DetailSummary {
  clicks: number;
  postbacks: number;
  conversions: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
  cvr: number;
  epc: number;
  rpm: number;
  avg_payout: number;
  approval_rate: number;
}

export interface DetailDeltas {
  // null when the previous period had zero in the denominator.
  revenue_pct: number | null;
  clicks_pct: number | null;
  conversions_pct: number | null;
  cvr_abs: number | null;            // absolute change in CVR (current - prev)
  epc_pct: number | null;
  approval_rate_abs: number | null;
}

export interface AffiliateBreakdown {
  aff_id: string;
  clicks: number;
  conversions: number;
  revenue: number;
  cvr: number;
  epc: number;
}

export interface CountryBreakdown {
  country: string;
  clicks: number;
  conversions: number;
  revenue: number;
  cvr: number;
}

export interface SubIdBreakdown {
  value: string;
  clicks: number;
  conversions: number;
  revenue: number;
  cvr: number;
}

export interface NetworkBreakdown {
  network_id: string;
  conversions: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
  approval_rate: number;
}

export interface AdPlatformBreakdown {
  platform: 'google' | 'facebook' | 'tiktok' | 'microsoft' | 'organic';
  clicks: number;
  conversions: number;
  revenue: number;
  cvr: number;
}

// 7×24 grid: heatmap[dayOfWeek 0=Sun][hour 0-23] = click count
export type HourHeatmap = number[][];

export interface PayoutBucket {
  label: string;     // "$0–10", "$10–25", …
  count: number;
  revenue: number;
}

export type FlagSeverity = 'info' | 'warn' | 'critical';
export interface DetailFlag {
  severity: FlagSeverity;
  title: string;
  detail: string;
}

export interface DetailSamples {
  clicks_sampled: number;
  conversions_sampled: number;
  clicks_truncated: boolean;       // true when we hit CLICK_FETCH_CAP
  conversions_truncated: boolean;  // true when we hit CONVERSION_FETCH_CAP
}

export interface RecentConversion {
  conversion_id: string;
  network_id: string;
  status?: string;
  payout?: number;
  currency?: string;
  verified: boolean;
  created_at: string;
  click_id: string;
}

export interface OfferDetailResponse {
  offer: {
    offer_id: string;
    name?: string;
    status?: 'active' | 'paused';
    base_url?: string;
    created_at?: string;
    updated_at?: string;
  };
  range: { from: string; to: string; days: number };
  // The previous period is the same length as the requested window, ending
  // at `from`. Used to compute deltas.
  previous_range: { from: string; to: string };

  summary: DetailSummary;
  previous: DetailSummary;
  deltas: DetailDeltas;

  series: DetailDailyPoint[];
  funnel: { clicks: number; postbacks: number; verified: number; approved: number };

  breakdowns: {
    affiliates: AffiliateBreakdown[];
    countries: CountryBreakdown[];
    sub_ids: { s1: SubIdBreakdown[]; s2: SubIdBreakdown[] };
    networks: NetworkBreakdown[];
    ad_platforms: AdPlatformBreakdown[];
    hour_heatmap: HourHeatmap;
  };

  payout_histogram: PayoutBucket[];
  flags: DetailFlag[];
  samples: DetailSamples;

  recent: {
    rejected: RecentConversion[];
    unverified: RecentConversion[];
  };
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

// status string → canonical bucket. Mirrors offerReportRepository's coercion
// so totals from the rollup line up with status mix in this view.
function statusBucket(s: string | undefined): 'approved' | 'pending' | 'rejected' {
  const v = (s ?? '').toLowerCase();
  if (v === 'pending') return 'pending';
  if (v === 'rejected' || v === 'declined' || v === 'reversed') return 'rejected';
  return 'approved';
}

function rollupToSummary(rows: OfferReportDoc[]): DetailSummary {
  let clicks = 0, postbacks = 0, conversions = 0, unverified = 0;
  let approved = 0, pending = 0, rejected = 0, revenue = 0;
  for (const r of rows) {
    clicks += r.clicks;
    postbacks += r.postbacks;
    conversions += r.conversions;
    unverified += r.unverified;
    approved += r.approved;
    pending += r.pending;
    rejected += r.rejected;
    revenue += r.revenue;
  }
  return {
    clicks, postbacks, conversions, unverified, approved, pending, rejected, revenue,
    cvr: clicks > 0 ? conversions / clicks : 0,
    epc: clicks > 0 ? revenue / clicks : 0,
    rpm: clicks > 0 ? (revenue * 1000) / clicks : 0,
    avg_payout: conversions > 0 ? revenue / conversions : 0,
    // Approval rate = approved verified conversions / all verified conversions.
    approval_rate: conversions > 0 ? approved / conversions : 0,
  };
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return (curr - prev) / prev;
}

function absDelta(curr: number, prev: number): number | null {
  // Return null when neither period has any signal — the delta is meaningless.
  if (curr === 0 && prev === 0) return null;
  return curr - prev;
}

function buildSeries(rows: OfferReportDoc[], from: Date, to: Date): DetailDailyPoint[] {
  const days = eachDayKeyUTC(from, to);
  const bucket = new Map<string, DetailDailyPoint>();
  for (const day of days) {
    bucket.set(day, {
      date: day, clicks: 0, postbacks: 0, conversions: 0,
      unverified: 0, approved: 0, pending: 0, rejected: 0, revenue: 0,
    });
  }
  for (const r of rows) {
    const p = bucket.get(r.date);
    if (!p) continue;
    p.clicks += r.clicks;
    p.postbacks += r.postbacks;
    p.conversions += r.conversions;
    p.unverified += r.unverified;
    p.approved += r.approved;
    p.pending += r.pending;
    p.rejected += r.rejected;
    p.revenue += r.revenue;
  }
  return Array.from(bucket.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function detectAdPlatform(ad_ids: Record<string, string | undefined>): AdPlatformBreakdown['platform'] {
  // gbraid/wbraid/gclid all originate from Google (Web/App/Ads) — bucketed
  // together so the operator sees one Google number rather than three thin slices.
  if (ad_ids.gclid || ad_ids.gbraid || ad_ids.wbraid) return 'google';
  if (ad_ids.fbclid) return 'facebook';
  if (ad_ids.ttclid) return 'tiktok';
  if (ad_ids.msclkid) return 'microsoft';
  return 'organic';
}

const PAYOUT_EDGES = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, Infinity];
function payoutBucketLabel(value: number): { idx: number; label: string } {
  for (let i = 0; i < PAYOUT_EDGES.length - 1; i++) {
    const lo = PAYOUT_EDGES[i]!;
    const hi = PAYOUT_EDGES[i + 1]!;
    if (value >= lo && value < hi) {
      const label = hi === Infinity ? `$${lo}+` : `$${lo}–${hi}`;
      return { idx: i, label };
    }
  }
  return { idx: PAYOUT_EDGES.length - 2, label: '$1000+' };
}

export const offerReportDetailService = {
  async getDetail(f: OfferDetailFilters): Promise<OfferDetailResponse> {
    const { offer_id, from, to } = f;
    const periodMs = to.getTime() - from.getTime();
    // Previous-period bounds — same length, ending at `from`.
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - periodMs);

    // Pull rollup, prev-period rollup, offer meta, drilldowns, and recent samples
    const [offer, rollupRows, prevRollupRows, drilldowns, recentConversionsRaw] = await Promise.all([
      offerRepository.getById(offer_id),
      offerReportRepository.fetchRange({ from, to, offer_ids: [offer_id] }),
      offerReportRepository.fetchRange({ from: prevFrom, to: prevTo, offer_ids: [offer_id] }),
      drilldownRepository.fetchOfferDrilldowns(offer_id, from, to),
      conversionRepository.listAll({
        offer_id,
        from,
        to,
        limit: 50,
      }).then(r => r.items),
    ]);
    const recentConversions = recentConversionsRaw as RecentConversion[];

    const summary = rollupToSummary(rollupRows);
    const previous = rollupToSummary(prevRollupRows);
    const deltas: DetailDeltas = {
      revenue_pct: pctDelta(summary.revenue, previous.revenue),
      clicks_pct: pctDelta(summary.clicks, previous.clicks),
      conversions_pct: pctDelta(summary.conversions, previous.conversions),
      cvr_abs: absDelta(summary.cvr, previous.cvr),
      epc_pct: pctDelta(summary.epc, previous.epc),
      approval_rate_abs: absDelta(summary.approval_rate, previous.approval_rate),
    };

    const series = buildSeries(rollupRows, from, to);

    // ── Aggregation from Drilldown docs
    const affAgg = new Map<string, AffiliateBreakdown>();
    const countryAgg = new Map<string, CountryBreakdown>();
    const s1Agg = new Map<string, SubIdBreakdown>();
    const s2Agg = new Map<string, SubIdBreakdown>();
    const platformAgg = new Map<AdPlatformBreakdown['platform'], AdPlatformBreakdown>();
    const heatmap: HourHeatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    const payoutHistogramRaw = new Map<number, { label: string; count: number; revenue: number }>();

    function bumpAgg<T extends { clicks: number; conversions: number; revenue: number }>(
      map: Map<string, T>,
      key: string,
      metrics: { clicks?: number; conversions?: number; revenue?: number },
      factory: (id: string) => T
    ) {
      let row = map.get(key);
      if (!row) {
        row = factory(key);
        map.set(key, row);
      }
      row.clicks += metrics.clicks ?? 0;
      row.conversions += metrics.conversions ?? 0;
      row.revenue += metrics.revenue ?? 0;
    }

    for (const d of drilldowns) {
      if (d.affiliates) {
        for (const [k, v] of Object.entries(d.affiliates)) {
          bumpAgg(affAgg, k, v, (id) => ({ aff_id: id, clicks: 0, conversions: 0, revenue: 0, cvr: 0, epc: 0 }));
        }
      }
      if (d.countries) {
        for (const [k, v] of Object.entries(d.countries)) {
          bumpAgg(countryAgg, k, v, (id) => ({ country: id, clicks: 0, conversions: 0, revenue: 0, cvr: 0 }));
        }
      }
      if (d.s1) {
        for (const [k, v] of Object.entries(d.s1)) {
          bumpAgg(s1Agg, k, v, (id) => ({ value: id, clicks: 0, conversions: 0, revenue: 0, cvr: 0 }));
        }
      }
      if (d.s2) {
        for (const [k, v] of Object.entries(d.s2)) {
          bumpAgg(s2Agg, k, v, (id) => ({ value: id, clicks: 0, conversions: 0, revenue: 0, cvr: 0 }));
        }
      }
      if (d.ad_platforms) {
        for (const [k, v] of Object.entries(d.ad_platforms)) {
          const plat = k as AdPlatformBreakdown['platform'];
          bumpAgg(platformAgg, plat, v, (id) => ({ platform: id as AdPlatformBreakdown['platform'], clicks: 0, conversions: 0, revenue: 0, cvr: 0 }));
        }
      }
      if (d.heatmap) {
        for (const [k, count] of Object.entries(d.heatmap)) {
          const [dowStr, hourStr] = k.split('_');
          const dow = Number(dowStr);
          const hour = Number(hourStr);
          if (dow >= 0 && dow <= 6 && hour >= 0 && hour <= 23) {
            heatmap[dow]![hour]! += count;
          }
        }
      }
      if (d.payout_histogram) {
        for (const [kStr, v] of Object.entries(d.payout_histogram)) {
          const idx = Number(kStr);
          const lo = PAYOUT_EDGES[idx]!;
          const hi = PAYOUT_EDGES[idx + 1]!;
          const label = hi === Infinity ? `$${lo}+` : `$${lo}–${hi}`;
          const cur = payoutHistogramRaw.get(idx) ?? { label, count: 0, revenue: 0 };
          cur.count += v.count ?? 0;
          cur.revenue += v.revenue ?? 0;
          payoutHistogramRaw.set(idx, cur);
        }
      }
    }

    // ── Network aggregation from Rollup Rows
    const networkAgg = new Map<string, NetworkBreakdown>();
    let pendingAgingRevenue = 0;
    let pendingAgingCount = 0;
    const NOW = Date.now();
    const FOURTEEN_DAYS = 14 * DAY_MS;

    for (const r of rollupRows) {
      if (r.network_id && r.network_id !== 'none') {
        let n = networkAgg.get(r.network_id);
        if (!n) {
          n = { network_id: r.network_id, conversions: 0, unverified: 0, approved: 0, pending: 0, rejected: 0, revenue: 0, approval_rate: 0 };
          networkAgg.set(r.network_id, n);
        }
        n.conversions += r.conversions;
        n.unverified += r.unverified;
        n.approved += r.approved;
        n.pending += r.pending;
        n.rejected += r.rejected;
        n.revenue += r.revenue;
      }

      // Pending aging — money owed but unconfirmed > 14 days.
      if (r.pending > 0) {
        const t = new Date(r.date).getTime();
        if (!Number.isNaN(t) && (NOW - t) > FOURTEEN_DAYS) {
          pendingAgingCount += r.pending;
          // Approximate pending revenue based on offer's avg_payout, since the rollup row's revenue only includes approved.
          pendingAgingRevenue += r.pending * summary.avg_payout;
        }
      }
    }

    // Finalise computed metrics on each breakdown.
    for (const r of affAgg.values()) {
      r.cvr = r.clicks > 0 ? r.conversions / r.clicks : 0;
      r.epc = r.clicks > 0 ? r.revenue / r.clicks : 0;
    }
    for (const r of countryAgg.values()) {
      r.cvr = r.clicks > 0 ? r.conversions / r.clicks : 0;
    }
    for (const r of s1Agg.values()) {
      r.cvr = r.clicks > 0 ? r.conversions / r.clicks : 0;
    }
    for (const r of s2Agg.values()) {
      r.cvr = r.clicks > 0 ? r.conversions / r.clicks : 0;
    }
    for (const r of platformAgg.values()) {
      r.cvr = r.clicks > 0 ? r.conversions / r.clicks : 0;
    }
    for (const r of networkAgg.values()) {
      r.approval_rate = r.conversions > 0 ? r.approved / r.conversions : 0;
    }

    const TOP = 10;
    const topAffiliates = Array.from(affAgg.values())
      .sort((a, b) => b.revenue - a.revenue || b.clicks - a.clicks)
      .slice(0, TOP);
    const topCountries = Array.from(countryAgg.values())
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, TOP);
    const topS1 = Array.from(s1Agg.values()).sort((a, b) => b.clicks - a.clicks).slice(0, TOP);
    const topS2 = Array.from(s2Agg.values()).sort((a, b) => b.clicks - a.clicks).slice(0, TOP);
    const networks = Array.from(networkAgg.values()).sort((a, b) => b.revenue - a.revenue);
    const adPlatforms = Array.from(platformAgg.values()).sort((a, b) => b.clicks - a.clicks);

    const payoutHistogram: PayoutBucket[] = [];
    for (let i = 0; i < PAYOUT_EDGES.length - 1; i++) {
      const entry = payoutHistogramRaw.get(i);
      if (entry) {
        payoutHistogram.push(entry);
      } else {
        const lo = PAYOUT_EDGES[i]!;
        const hi = PAYOUT_EDGES[i + 1]!;
        const label = hi === Infinity ? `$${lo}+` : `$${lo}–${hi}`;
        payoutHistogram.push({ label, count: 0, revenue: 0 });
      }
    }

    // ── Diagnostic flags
    const flags: DetailFlag[] = [];

    const zeroConvAffs = topAffiliates.filter((a) => a.clicks >= 50 && a.conversions === 0);
    if (zeroConvAffs.length > 0) {
      flags.push({
        severity: 'warn',
        title: `${zeroConvAffs.length} affiliate${zeroConvAffs.length === 1 ? '' : 's'} sending traffic with zero conversions`,
        detail: zeroConvAffs.slice(0, 3)
          .map((a) => `${a.aff_id} (${a.clicks} clicks)`).join(', ') +
          (zeroConvAffs.length > 3 ? ' …' : ''),
      });
    }

    const baseCvr = summary.cvr;
    if (baseCvr > 0) {
      const suspect = Array.from(affAgg.values()).filter(
        (a) => a.clicks >= 5 && a.cvr > baseCvr * 3
      );
      if (suspect.length > 0) {
        flags.push({
          severity: 'warn',
          title: `${suspect.length} affiliate${suspect.length === 1 ? '' : 's'} with suspiciously high CVR`,
          detail: suspect.slice(0, 3)
            .map((a) => `${a.aff_id} (${(a.cvr * 100).toFixed(1)}% vs offer avg ${(baseCvr * 100).toFixed(1)}%)`).join(', ') +
            (suspect.length > 3 ? ' …' : ''),
        });
      }
    }

    if (pendingAgingCount > 0) {
      flags.push({
        severity: 'info',
        title: `${pendingAgingCount} pending conversion${pendingAgingCount === 1 ? '' : 's'} older than 14 days`,
        detail: `~ $${pendingAgingRevenue.toFixed(2)} unconfirmed — chase the network for status updates.`,
      });
    }

    if (rollupRows.length >= 4) {
      const sortedDates = rollupRows.slice().sort((a, b) => a.date.localeCompare(b.date));
      const mid = Math.floor(sortedDates.length / 2);
      const first = sortedDates.slice(0, mid);
      const second = sortedDates.slice(mid);
      const firstRej = first.reduce((s, r) => s + r.rejected, 0);
      const firstTot = first.reduce((s, r) => s + r.conversions, 0);
      const secondRej = second.reduce((s, r) => s + r.rejected, 0);
      const secondTot = second.reduce((s, r) => s + r.conversions, 0);
      const r1 = firstTot > 0 ? firstRej / firstTot : 0;
      const r2 = secondTot > 0 ? secondRej / secondTot : 0;
      if (firstTot >= 10 && secondTot >= 10 && r2 > r1 + 0.05 && r2 > 0.1) {
        flags.push({
          severity: 'critical',
          title: 'Rejection rate trending up',
          detail: `${(r1 * 100).toFixed(1)}% → ${(r2 * 100).toFixed(1)}% across the window. Network may be tightening approval criteria.`,
        });
      }
    }

    const unverifiedSeries = series.map((p) => p.unverified).slice().sort((a, b) => a - b);
    if (unverifiedSeries.length >= 3) {
      const median = unverifiedSeries[Math.floor(unverifiedSeries.length / 2)] ?? 0;
      if (median > 0) {
        const spikes = series.filter((p) => p.unverified > median * 2 && p.unverified >= 5);
        if (spikes.length > 0) {
          flags.push({
            severity: 'warn',
            title: `${spikes.length} day${spikes.length === 1 ? '' : 's'} with unusually high unverified postbacks`,
            detail: `Tracking may have broken on: ${spikes.map((p) => p.date).slice(0, 3).join(', ')}${spikes.length > 3 ? ' …' : ''}`,
          });
        }
      }
    }

    // ── Recent activity samples
    const recentRejected: RecentConversion[] = [];
    const recentUnverified: RecentConversion[] = [];
    for (const c of recentConversions) {
      if (c.verified && statusBucket(c.status) === 'rejected' && recentRejected.length < 5) {
        recentRejected.push(c);
      }
      if (!c.verified && recentUnverified.length < 5) {
        recentUnverified.push(c);
      }
      if (recentRejected.length >= 5 && recentUnverified.length >= 5) break;
    }

    return {
      offer: {
        offer_id: offer?.offer_id ?? offer_id,
        name: offer?.name,
        status: offer?.status,
        base_url: offer?.base_url,
        created_at: offer?.created_at,
        updated_at: offer?.updated_at,
      },
      range: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: Math.max(1, Math.round(periodMs / DAY_MS)),
      },
      previous_range: {
        from: prevFrom.toISOString(),
        to: prevTo.toISOString(),
      },
      summary,
      previous,
      deltas,
      series,
      funnel: {
        clicks: summary.clicks,
        postbacks: summary.postbacks,
        verified: summary.conversions,
        approved: summary.approved,
      },
      breakdowns: {
        affiliates: topAffiliates,
        countries: topCountries,
        sub_ids: { s1: topS1, s2: topS2 },
        networks,
        ad_platforms: adPlatforms,
        hour_heatmap: heatmap,
      },
      payout_histogram: payoutHistogram,
      flags,
      samples: {
        clicks_sampled: summary.clicks,
        conversions_sampled: summary.conversions + summary.unverified,
        clicks_truncated: false,
        conversions_truncated: false,
      },
      recent: {
        rejected: recentRejected,
        unverified: recentUnverified,
      },
    };
  },
};
