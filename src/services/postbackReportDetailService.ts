import { networkRepository, conversionRepository } from '../firestore';
import type { ConversionRecord } from '../types';

// A postback drill-down is much cheaper than an offer drill-down because we
// don't need raw clicks — every signal lives on the conversion document
// (network_id, status, verified, source, method, payout, click_id, raw_payload,
// network_timestamp). One range scan filtered by network_id is enough.
const CONVERSION_FETCH_CAP = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PostbackDetailFilters {
  network_id: string;
  from: Date;
  to: Date;
}

// Daily timeline. The split between verified and unverified is the operator's
// primary health signal — they should be able to read "did fires drop today?
// did the match rate fall off?" from one chart.
export interface PostbackDetailDailyPoint {
  date: string;
  postbacks: number;
  verified: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;
}

// Window-level summary. Note `match_rate` (verified / postbacks) — this is the
// core KPI for a postback report; it's the inverse of "tracking break rate".
export interface PostbackDetailSummary {
  postbacks: number;          // total fires (verified + unverified, exc. shadow)
  verified: number;
  unverified: number;
  approved: number;
  pending: number;
  rejected: number;
  revenue: number;            // sum of verified payouts
  avg_payout: number;         // revenue / verified
  match_rate: number;         // verified / postbacks — fraction matched a click
  approval_rate: number;      // approved / verified — fraction the network honoured
  unique_offers: number;      // distinct offer_ids seen on verified rows
  unique_click_ids: number;   // distinct click_ids matched (verified)
  duplicate_click_ids: number; // verified rows hitting an already-matched click
}

export interface PostbackDetailDeltas {
  postbacks_pct: number | null;
  verified_pct: number | null;
  match_rate_abs: number | null;        // absolute change (current - prev) in match_rate
  approval_rate_abs: number | null;
  revenue_pct: number | null;
}

// "How does this network split fires across our offers?" Catches a network
// that's mostly firing for a single offer (concentration risk) or a network
// that's silent on some offers despite traffic (mapping bug).
export interface PostbackOfferBreakdown {
  offer_id: string;
  postbacks: number;
  verified: number;
  unverified: number;
  approved: number;
  rejected: number;
  revenue: number;
  match_rate: number;
}

// "How are fires arriving — direct S2S postback, or our pull-based affiliate
// API?" Each source has a different operational owner; mixing them in totals
// hides which surface broke.
export interface PostbackSourceBreakdown {
  source: 'postback' | 'api' | 'unknown';
  postbacks: number;
  verified: number;
  match_rate: number;
}

// HTTP method split. A network that suddenly starts POSTing when it always
// GETs (or vice versa) is a smoking-gun for an upstream config change.
export interface PostbackMethodBreakdown {
  method: 'GET' | 'POST';
  postbacks: number;
  verified: number;
}

// Status bucket detail. Same buckets as offer reports but framed as
// "the network's grading of our leads" rather than "offer outcomes".
export interface PostbackStatusBreakdown {
  status: 'approved' | 'pending' | 'rejected';
  count: number;
  revenue: number;
  share: number;        // count / verified
}

// 7×24 grid of fire counts (UTC). Postbacks often arrive in batches —
// surfacing the network's processing window helps anticipate latency.
export type PostbackHourHeatmap = number[][];

export type FlagSeverity = 'info' | 'warn' | 'critical';
export interface PostbackDetailFlag {
  severity: FlagSeverity;
  title: string;
  detail: string;
}

// Sample of unmatched fires — what the operator clicks into when the match
// rate dips. Includes the raw_payload so they can spot a mis-mapped field.
export interface UnmatchedSample {
  conversion_id: string;
  created_at: string;
  click_id: string;
  status?: string;
  payout?: number;
  currency?: string;
  source?: 'postback' | 'api';
  method?: 'GET' | 'POST';
  raw_payload_keys: string[]; // keys only — values may contain PII
}

export interface RecentVerifiedSample {
  conversion_id: string;
  created_at: string;
  offer_id?: string;
  status?: string;
  payout?: number;
  currency?: string;
  source?: 'postback' | 'api';
  method?: 'GET' | 'POST';
  click_id: string;
}

// Latency = (conversion received) − (network's reported event_time, when
// present). Distinguishes "network is slow" from "tracking broke and
// they're firing months-old conversions."
export interface PostbackLatency {
  count: number;        // conversions that had a network_timestamp to compare against
  p50_minutes: number | null;
  p95_minutes: number | null;
  median_minutes: number | null;
}

// Mapping coverage tells the operator how reliably we'll extract fields. If a
// network's `mapping_payout` is unset every fire arrives with payout=0, which
// kills the revenue chart and the avg_payout KPI.
export interface PostbackMappingHealth {
  has_payout_mapping: boolean;
  has_status_mapping: boolean;
  has_currency_mapping: boolean;
  has_txn_id_mapping: boolean;
  has_timestamp_mapping: boolean;
  fires_with_payout: number;
  fires_with_status: number;
  fires_with_txn_id: number;
}

export interface PostbackDetailResponse {
  network: {
    network_id: string;
    name?: string;
    status?: 'active' | 'paused';
    mapping_click_id?: string;
    default_status?: string;
    has_postback_api?: boolean;
    created_at?: string;
    updated_at?: string;
  };
  range: { from: string; to: string; days: number };
  previous_range: { from: string; to: string };

  summary: PostbackDetailSummary;
  previous: PostbackDetailSummary;
  deltas: PostbackDetailDeltas;

  series: PostbackDetailDailyPoint[];

  breakdowns: {
    offers: PostbackOfferBreakdown[];
    sources: PostbackSourceBreakdown[];
    methods: PostbackMethodBreakdown[];
    statuses: PostbackStatusBreakdown[];
    hour_heatmap: PostbackHourHeatmap;
  };

  latency: PostbackLatency;
  mapping_health: PostbackMappingHealth;

  flags: PostbackDetailFlag[];
  samples: {
    conversions_sampled: number;
    truncated: boolean;
  };

  recent: {
    verified: RecentVerifiedSample[];
    unmatched: UnmatchedSample[];
  };
}

function eachDayKeyUTC(from: Date, to: Date): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function statusBucket(s: string | undefined): 'approved' | 'pending' | 'rejected' {
  const v = (s ?? '').toLowerCase();
  if (v === 'pending') return 'pending';
  if (v === 'rejected' || v === 'declined' || v === 'reversed') return 'rejected';
  return 'approved';
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return (curr - prev) / prev;
}
function absDelta(curr: number, prev: number): number | null {
  if (curr === 0 && prev === 0) return null;
  return curr - prev;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx]!;
}

type ConvForReport = Awaited<ReturnType<typeof conversionRepository.fetchRange>>[number];

function summarise(rows: ConvForReport[]): PostbackDetailSummary {
  let postbacks = 0, verified = 0, unverified = 0, approved = 0, pending = 0, rejected = 0, revenue = 0;
  const offers = new Set<string>();
  const matchedClickIds = new Map<string, number>();
  for (const r of rows) {
    if (r.shadow) continue;
    postbacks += 1;
    if (r.verified) {
      verified += 1;
      const bucket = statusBucket(r.status);
      if (bucket === 'approved') approved += 1;
      else if (bucket === 'pending') pending += 1;
      else rejected += 1;
      revenue += r.payout ?? 0;
      if (r.offer_id) offers.add(r.offer_id);
      if (r.click_id) matchedClickIds.set(r.click_id, (matchedClickIds.get(r.click_id) ?? 0) + 1);
    } else {
      unverified += 1;
    }
  }
  let duplicates = 0;
  for (const count of matchedClickIds.values()) if (count > 1) duplicates += count - 1;
  return {
    postbacks,
    verified,
    unverified,
    approved,
    pending,
    rejected,
    revenue,
    avg_payout: verified > 0 ? revenue / verified : 0,
    match_rate: postbacks > 0 ? verified / postbacks : 0,
    approval_rate: verified > 0 ? approved / verified : 0,
    unique_offers: offers.size,
    unique_click_ids: matchedClickIds.size,
    duplicate_click_ids: duplicates,
  };
}

function buildSeries(rows: ConvForReport[], from: Date, to: Date): PostbackDetailDailyPoint[] {
  const days = eachDayKeyUTC(from, to);
  const bucket = new Map<string, PostbackDetailDailyPoint>();
  for (const d of days) {
    bucket.set(d, {
      date: d,
      postbacks: 0, verified: 0, unverified: 0,
      approved: 0, pending: 0, rejected: 0, revenue: 0,
    });
  }
  for (const r of rows) {
    if (r.shadow) continue;
    const day = (r.created_at || '').slice(0, 10);
    const p = bucket.get(day);
    if (!p) continue;
    p.postbacks += 1;
    if (r.verified) {
      p.verified += 1;
      const b = statusBucket(r.status);
      if (b === 'approved') p.approved += 1;
      else if (b === 'pending') p.pending += 1;
      else p.rejected += 1;
      p.revenue += r.payout ?? 0;
    } else {
      p.unverified += 1;
    }
  }
  return Array.from(bucket.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export const postbackReportDetailService = {
  async getDetail(f: PostbackDetailFilters): Promise<PostbackDetailResponse> {
    const { network_id, from, to } = f;
    const periodMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - periodMs);

    const [network, rows, prevRows] = await Promise.all([
      networkRepository.getById(network_id),
      conversionRepository.fetchRange({ network_id, from, to, max: CONVERSION_FETCH_CAP }),
      conversionRepository.fetchRange({ network_id, from: prevFrom, to: prevTo, max: CONVERSION_FETCH_CAP }),
    ]);

    // Source/method live on the raw conversion doc, not on the trimmed type
    // returned by fetchRange. We need a second pass against the by-id getter
    // would be too many reads — instead use listAll which returns full records
    // for *this* network in the window. fetchRange already filters by
    // network_id, but its return type is intentionally minimal. For the small
    // breakdowns (sources/methods), pull a denormalised slice off the same
    // docs by re-fetching as full ConversionRecords via listAll with no
    // pagination cursor — capped at CONVERSION_FETCH_CAP.
    const fullRows = await conversionRepository.listAll({
      network_id, from, to, limit: 200,
    });
    // fullRows.items is at most 200 — we already iterated rows above for the
    // exact totals. Use rows for everything that doesn't need source/method
    // (which is the bulk of the response), and use fullRows.items only for
    // the source/method breakdowns and the recent samples.
    // This trade keeps cost bounded: one indexed fetchRange + one paginated
    // listAll first page, both already optimised in their respective repos.

    const summary = summarise(rows);
    const previous = summarise(prevRows);
    const deltas: PostbackDetailDeltas = {
      postbacks_pct: pctDelta(summary.postbacks, previous.postbacks),
      verified_pct: pctDelta(summary.verified, previous.verified),
      match_rate_abs: absDelta(summary.match_rate, previous.match_rate),
      approval_rate_abs: absDelta(summary.approval_rate, previous.approval_rate),
      revenue_pct: pctDelta(summary.revenue, previous.revenue),
    };

    const series = buildSeries(rows, from, to);

    // ── Breakdowns
    const offerAgg = new Map<string, PostbackOfferBreakdown>();
    const heatmap: PostbackHourHeatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    const matchedClickIds = new Set<string>();
    const latencies: number[] = [];

    for (const r of rows) {
      if (r.shadow) continue;
      const key = r.offer_id ?? '(unattributed)';
      let row = offerAgg.get(key);
      if (!row) {
        row = {
          offer_id: key,
          postbacks: 0, verified: 0, unverified: 0,
          approved: 0, rejected: 0, revenue: 0, match_rate: 0,
        };
        offerAgg.set(key, row);
      }
      row.postbacks += 1;
      if (r.verified) {
        row.verified += 1;
        const b = statusBucket(r.status);
        if (b === 'approved') row.approved += 1;
        else if (b === 'rejected') row.rejected += 1;
        row.revenue += r.payout ?? 0;
        if (r.click_id) matchedClickIds.add(r.click_id);
      } else {
        row.unverified += 1;
      }

      // Hour heatmap on receive-time (UTC).
      const t = r.created_at ? new Date(r.created_at) : null;
      if (t && !Number.isNaN(t.getTime())) {
        heatmap[t.getUTCDay()]![t.getUTCHours()]! += 1;
      }
    }
    for (const row of offerAgg.values()) {
      row.match_rate = row.postbacks > 0 ? row.verified / row.postbacks : 0;
    }

    // ── Source / method / latency / mapping coverage from the full-record sample
    const sourceAgg = new Map<'postback' | 'api' | 'unknown', PostbackSourceBreakdown>();
    const methodAgg = new Map<'GET' | 'POST', PostbackMethodBreakdown>();
    const recentVerified: RecentVerifiedSample[] = [];
    const recentUnmatched: UnmatchedSample[] = [];
    let firesWithPayout = 0;
    let firesWithStatus = 0;
    let firesWithTxnId = 0;

    for (const r of fullRows.items as ConversionRecord[]) {
      if (r.shadow) continue;

      const src: 'postback' | 'api' | 'unknown' =
        r.source === 'postback' ? 'postback' :
        r.source === 'api' ? 'api' : 'unknown';
      let s = sourceAgg.get(src);
      if (!s) { s = { source: src, postbacks: 0, verified: 0, match_rate: 0 }; sourceAgg.set(src, s); }
      s.postbacks += 1;
      if (r.verified) s.verified += 1;

      if (r.method === 'GET' || r.method === 'POST') {
        let m = methodAgg.get(r.method);
        if (!m) { m = { method: r.method, postbacks: 0, verified: 0 }; methodAgg.set(r.method, m); }
        m.postbacks += 1;
        if (r.verified) m.verified += 1;
      }

      // Mapping coverage is a property of *every* fire we've seen, not just
      // the recent slice — but reading raw_payload requires the full record.
      // The 200-row sample is a conservative proxy; for a healthier signal
      // the future could materialise the full set, but this is enough to
      // surface a "no payout ever extracted" warning.
      if (typeof r.payout === 'number') firesWithPayout += 1;
      if (r.status) firesWithStatus += 1;
      if (r.txn_id) firesWithTxnId += 1;

      // Latency (verified only — unmatched fires usually have no usable
      // event_time, and even if they did, the result is meaningless without
      // a click anchor).
      if (r.verified && r.network_timestamp) {
        const networkAt = new Date(r.network_timestamp).getTime();
        const receivedAt = new Date(r.created_at).getTime();
        if (Number.isFinite(networkAt) && Number.isFinite(receivedAt) && receivedAt >= networkAt) {
          latencies.push((receivedAt - networkAt) / 60_000); // minutes
        }
      }

      // Recent samples — first occurrence wins because listAll is desc by created_at.
      if (r.verified && recentVerified.length < 6) {
        recentVerified.push({
          conversion_id: r.conversion_id,
          created_at: r.created_at,
          offer_id: r.offer_id,
          status: r.status,
          payout: r.payout,
          currency: r.currency,
          source: r.source,
          method: r.method,
          click_id: r.click_id,
        });
      } else if (!r.verified && recentUnmatched.length < 6) {
        recentUnmatched.push({
          conversion_id: r.conversion_id,
          created_at: r.created_at,
          click_id: r.click_id,
          status: r.status,
          payout: r.payout,
          currency: r.currency,
          source: r.source,
          method: r.method,
          // Keys only — payloads can hold PII (IPs, emails). Useful for spotting
          // the field a network started/stopped sending without exposing values.
          raw_payload_keys: Object.keys(r.raw_payload ?? {}).slice(0, 20),
        });
      }
    }
    for (const s of sourceAgg.values()) {
      s.match_rate = s.postbacks > 0 ? s.verified / s.postbacks : 0;
    }

    // ── Status breakdown (from `rows` so it covers the full window, not just the 200-row slice)
    const statusBreakdown: PostbackStatusBreakdown[] = (
      [
        { status: 'approved' as const, count: summary.approved },
        { status: 'pending' as const, count: summary.pending },
        { status: 'rejected' as const, count: summary.rejected },
      ].map((b) => {
        const subset = rows.filter((r) => !r.shadow && r.verified && statusBucket(r.status) === b.status);
        return {
          status: b.status,
          count: b.count,
          revenue: subset.reduce((s, r) => s + (r.payout ?? 0), 0),
          share: summary.verified > 0 ? b.count / summary.verified : 0,
        };
      })
    );

    // ── Latency
    latencies.sort((a, b) => a - b);
    const latency: PostbackLatency = {
      count: latencies.length,
      p50_minutes: percentile(latencies, 50),
      p95_minutes: percentile(latencies, 95),
      median_minutes: percentile(latencies, 50),
    };

    // ── Mapping health
    const mapping_health: PostbackMappingHealth = {
      has_payout_mapping: !!network?.mapping_payout,
      has_status_mapping: !!network?.mapping_status,
      has_currency_mapping: !!network?.mapping_currency,
      has_txn_id_mapping: !!network?.mapping_txn_id,
      has_timestamp_mapping: !!network?.mapping_timestamp,
      fires_with_payout: firesWithPayout,
      fires_with_status: firesWithStatus,
      fires_with_txn_id: firesWithTxnId,
    };

    // ── Flags
    const flags: PostbackDetailFlag[] = [];

    // Match-rate is the canary for a tracking break. A network that historically
    // matches 90% of fires suddenly dropping to 50% means click_ids changed,
    // mapping_click_id is wrong, or the click TTL purged the matching clicks.
    if (summary.postbacks >= 20 && summary.match_rate < 0.5) {
      flags.push({
        severity: summary.match_rate < 0.2 ? 'critical' : 'warn',
        title: `Match rate is ${(summary.match_rate * 100).toFixed(1)}%`,
        detail: `${summary.unverified.toLocaleString()} of ${summary.postbacks.toLocaleString()} fires didn't resolve to a tracked click. ` +
          `Check that mapping_click_id="${network?.mapping_click_id ?? '?'}" matches the parameter the network actually sends.`,
      });
    } else if (previous.match_rate > 0 && summary.match_rate < previous.match_rate - 0.15 && summary.postbacks >= 20) {
      flags.push({
        severity: 'warn',
        title: 'Match rate dropping',
        detail: `${(previous.match_rate * 100).toFixed(1)}% → ${(summary.match_rate * 100).toFixed(1)}% vs the previous period. ` +
          `Likely a click_id format change or a TTL expiry on older clicks.`,
      });
    }

    // Mapping gap: fires arriving but `payout` never extracted. Causes the
    // revenue chart to flat-line even when conversions exist.
    if (summary.verified >= 10 && !mapping_health.has_payout_mapping && firesWithPayout === 0) {
      flags.push({
        severity: 'warn',
        title: 'No payout being extracted from this network',
        detail: 'mapping_payout is unset and no fire arrived with a typed payout. Set mapping_payout in the postback config so revenue can be tracked.',
      });
    }

    // No fires for half the window — silent network or paused integration.
    const daysSeen = new Set(rows.map((r) => (r.created_at || '').slice(0, 10))).size;
    const totalDays = Math.max(1, Math.round(periodMs / DAY_MS));
    if (totalDays >= 7 && daysSeen <= totalDays / 2 && summary.postbacks > 0) {
      flags.push({
        severity: 'info',
        title: 'Fires concentrated on a few days',
        detail: `Activity on ${daysSeen} of ${totalDays} days. Network may batch its fires — or only fire a handful per week.`,
      });
    } else if (totalDays >= 3 && summary.postbacks === 0) {
      flags.push({
        severity: 'critical',
        title: 'No postbacks received in this window',
        detail: 'The network has fired zero conversions across the entire range. Either the integration is paused on their side, or our endpoint isn\'t reachable.',
      });
    }

    // High duplicate rate — same click_id matched many times. Real for some
    // products (subscriptions; multi-event funnels) but if the network expects
    // dedup-on-txn_id and we aren't dedup'ing it leads to inflated counts.
    if (summary.verified > 0 && summary.duplicate_click_ids > 0) {
      const dupShare = summary.duplicate_click_ids / summary.verified;
      if (dupShare > 0.1) {
        flags.push({
          severity: 'info',
          title: `${summary.duplicate_click_ids} duplicate click matches`,
          detail: `${(dupShare * 100).toFixed(1)}% of verified fires hit a click that was already matched. ` +
            (mapping_health.has_txn_id_mapping
              ? 'Likely fine for multi-event flows.'
              : 'Consider mapping a transaction id so we can dedupe on it.'),
        });
      }
    }

    // Sample truncation banner.
    if (rows.length >= CONVERSION_FETCH_CAP) {
      flags.push({
        severity: 'info',
        title: `Showing the most recent ${CONVERSION_FETCH_CAP.toLocaleString()} fires`,
        detail: 'Older fires in this range aren\'t included in the breakdowns. Totals at the top are exact for the sample.',
      });
    }

    const offerBreakdown = Array.from(offerAgg.values())
      .sort((a, b) => b.postbacks - a.postbacks)
      .slice(0, 10);

    return {
      network: {
        network_id: network?.network_id ?? network_id,
        name: network?.name,
        status: network?.status,
        mapping_click_id: network?.mapping_click_id,
        default_status: network?.default_status,
        has_postback_api: !!network?.postback_api_id,
        created_at: network?.created_at,
        updated_at: network?.updated_at,
      },
      range: { from: from.toISOString(), to: to.toISOString(), days: totalDays },
      previous_range: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
      summary,
      previous,
      deltas,
      series,
      breakdowns: {
        offers: offerBreakdown,
        sources: Array.from(sourceAgg.values()).sort((a, b) => b.postbacks - a.postbacks),
        methods: Array.from(methodAgg.values()).sort((a, b) => b.postbacks - a.postbacks),
        statuses: statusBreakdown,
        hour_heatmap: heatmap,
      },
      latency,
      mapping_health,
      flags,
      samples: {
        conversions_sampled: rows.length,
        truncated: rows.length >= CONVERSION_FETCH_CAP,
      },
      recent: {
        verified: recentVerified,
        unmatched: recentUnmatched,
      },
    };
  },
};
