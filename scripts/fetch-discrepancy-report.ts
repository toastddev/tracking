import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as xlsx from 'xlsx';
import path from 'path';
import fs from 'fs';

// ────────────────────────────────────────────────────────────────────────────
// CONFIG — edit the date range here, then run:
//   npx tsx scripts/fetch-discrepancy-report.ts
//
// Produces ONE xlsx per brand (LG / Kohls / Bed Bath & Beyond) with three
// sheets each:
//   1. "Clicks (PT)"      — raw click rows in the PT window
//   2. "Conversions (PT)" — raw conversion rows in the PT window (network_timestamp is already PST)
//   3. "Discrepancy"      — per-day, per-offer comparison of clicks vs conversions
// ────────────────────────────────────────────────────────────────────────────

// Inclusive PT date range. By default 2026-05-06 → 2026-05-28 (Pacific Time).
const FROM_DATE_PT = '2026-05-06';
const TO_DATE_PT   = '2026-05-28';

// Brand → list of offer_id slugs. Names listed for readability only.
type BrandKey = 'lg' | 'kohls' | 'bedbath';
const BRANDS: Record<BrandKey, { label: string; outFile: string; offers: { id: string; name: string }[] }> = {
  lg: {
    label: 'LG',
    outFile: 'discrepancy_LG',
    offers: [
      { id: 'lg',        name: 'Lg' },
      { id: 'direct-lg', name: 'LG Direct Redirect' },
    ],
  },
  kohls: {
    label: 'Kohls',
    outFile: 'discrepancy_Kohls',
    offers: [
      { id: 'direct-kohls',   name: 'Kohls Direct Redirect' },
      { id: 'direct-kohls-2', name: 'Kohls Direct Redirect 2' },
      { id: 'penny-khols',    name: 'Kohls-Pennywise' },
    ],
  },
  bedbath: {
    label: 'Bed Bath & Beyond',
    outFile: 'discrepancy_BedBathAndBeyond',
    offers: [
      { id: 'bedbathandbeyond',              name: 'Bed Bath and Beyond' },
      { id: 'direct-bedbathandbeyond',       name: 'Direct Redirect Bed Bath and Beyond' },
      { id: 'direct-bedbathandbeyond-com-2', name: 'Direct Redirect Bed Bath and Beyond 2' },
    ],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// PT helpers (DST-aware)
// ────────────────────────────────────────────────────────────────────────────

const PT_ZONE = 'America/Los_Angeles';

function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return asIfUtc - instant.getTime();
}

// UTC instant of `YYYY-MM-DD HH:MM:SS.mmm` interpreted as wall time in `tz`.
function ptWallClockToUtc(dateStr: string, hh: number, mm: number, ss: number, ms: number, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms));
  const offset = tzOffsetMs(tz, guess);
  return new Date(guess.getTime() - offset);
}

// "YYYY-MM-DD HH:MM:SS GMT-7" formatted in PT.
function formatInPt(d: Date): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_ZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const parts = Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

// YYYY-MM-DD portion of the date when viewed in PT.
function ptDateKey(d: Date): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Iterate inclusive YYYY-MM-DD keys in the configured PT range.
function ptDateKeysInRange(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Firestore fetch
// ────────────────────────────────────────────────────────────────────────────

interface ClickRow {
  click_id: string;
  offer_id: string;
  offer_name: string;
  aff_id: string;
  campaign_id: string;
  country: string;
  ip: string;
  user_agent: string;
  referrer: string;
  redirect_url: string;
  gclid: string;
  gbraid: string;
  wbraid: string;
  s1: string;
  s2: string;
  pt_day: string;
  created_at_pt: string;
  created_at_utc: string;
}

interface ConversionRow {
  conversion_id: string;
  network_id: string;
  offer_id: string;
  offer_name: string;
  click_id: string;
  payout: number;
  currency: string;
  status: string;
  txn_id: string;
  verified: boolean;
  verification_reason: string;
  method: string;
  source_ip: string;
  pt_day: string;
  network_timestamp_raw: string;
  network_timestamp_pt: string;
  created_at_pt: string;
  created_at_utc: string;
}

async function fetchInWindow(
  db: FirebaseFirestore.Firestore,
  collection: 'clicks' | 'conversions',
  startUtc: Date,
  endUtc: Date,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const col = db.collection(collection);
  let snap = await col
    .where('created_at', '>=', startUtc)
    .where('created_at', '<=', endUtc)
    .get();
  if (snap.empty) {
    // Fallback: some legacy rows store created_at as ISO strings.
    const strSnap = await col
      .where('created_at', '>=', startUtc.toISOString())
      .where('created_at', '<=', endUtc.toISOString())
      .get();
    return strSnap.docs;
  }
  return snap.docs;
}

function getCreatedAtDate(data: Record<string, any>): Date | null {
  const v = data.created_at;
  if (v && typeof v.toDate === 'function') return v.toDate();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Network sends timestamps already in PST. We parse the YYYY-MM-DD portion
// as-is and treat the wall-clock hours as PT. If unparseable, returns null.
function parseNetworkTimestampAsPt(raw: string | undefined): { dateKey: string; formatted: string } | null {
  if (!raw) return null;
  // Accept the common forms: "YYYY-MM-DD HH:MM:SS" and ISO "YYYY-MM-DDTHH:MM:SS[Z]".
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, hh, mi, ss] = m;
    return {
      dateKey: `${y}-${mo}-${d}`,
      formatted: `${y}-${mo}-${d} ${hh}:${mi}:${ss} PT`,
    };
  }
  // Bare date "YYYY-MM-DD".
  const m2 = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const [, y, mo, d] = m2;
    return { dateKey: `${y}-${mo}-${d}`, formatted: `${y}-${mo}-${d} 00:00:00 PT` };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function run() {
  const serviceAccountPath = path.resolve('serviceAccount.json');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account file not found at ${serviceAccountPath}`);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  const db = getFirestore('tracking');

  // PT window covers full days, inclusive on both ends.
  const startUtc = ptWallClockToUtc(FROM_DATE_PT, 0, 0, 0, 0, PT_ZONE);
  const endUtc   = ptWallClockToUtc(TO_DATE_PT, 23, 59, 59, 999, PT_ZONE);

  console.log('─────────────────────────────────────────────────────────────');
  console.log(`PT range : ${FROM_DATE_PT} 00:00:00  →  ${TO_DATE_PT} 23:59:59.999  (${PT_ZONE})`);
  console.log(`UTC range: ${startUtc.toISOString()}  →  ${endUtc.toISOString()}`);
  console.log('─────────────────────────────────────────────────────────────');

  // Build offer_id → { name, brand } lookups.
  const offerIdToName = new Map<string, string>();
  const offerIdToBrand = new Map<string, BrandKey>();
  (Object.keys(BRANDS) as BrandKey[]).forEach((brand) => {
    for (const o of BRANDS[brand].offers) {
      offerIdToName.set(o.id, o.name);
      offerIdToBrand.set(o.id, brand);
    }
  });
  const allOfferIds = new Set(offerIdToName.keys());

  // Fetch the full window once, partition by brand in memory.
  console.log('Fetching clicks…');
  const clickDocs = await fetchInWindow(db, 'clicks', startUtc, endUtc);
  console.log(`  → ${clickDocs.length} click docs in window`);

  console.log('Fetching conversions…');
  const conversionDocs = await fetchInWindow(db, 'conversions', startUtc, endUtc);
  console.log(`  → ${conversionDocs.length} conversion docs in window`);

  // ─── Click rows ──────────────────────────────────────────────────────────
  const clicksByBrand: Record<BrandKey, ClickRow[]> = { lg: [], kohls: [], bedbath: [] };
  for (const doc of clickDocs) {
    const data = doc.data() as Record<string, any>;
    const offerId: string = data.offer_id || '';
    if (!allOfferIds.has(offerId)) continue;
    const brand = offerIdToBrand.get(offerId)!;

    const createdAtDate = getCreatedAtDate(data);
    const createdAtUtc = createdAtDate ? createdAtDate.toISOString() : '';
    const createdAtPt = createdAtDate ? formatInPt(createdAtDate) : '';
    const ptDay = createdAtDate ? ptDateKey(createdAtDate) : '';

    clicksByBrand[brand].push({
      click_id: doc.id,
      offer_id: offerId,
      offer_name: offerIdToName.get(offerId) || '',
      aff_id: data.aff_id || '',
      campaign_id:
        data.extra_params?.gad_campaignid ||
        data.extra_params?.utm_campaign ||
        '',
      country: data.country || '',
      ip: data.ip || '',
      user_agent: data.user_agent || '',
      referrer: data.referrer || '',
      redirect_url: data.redirect_url || '',
      gclid: data.ad_ids?.gclid || '',
      gbraid: data.ad_ids?.gbraid || '',
      wbraid: data.ad_ids?.wbraid || '',
      s1: data.sub_params?.s1 || '',
      s2: data.sub_params?.s2 || '',
      pt_day: ptDay,
      created_at_pt: createdAtPt,
      created_at_utc: createdAtUtc,
    });
  }

  // ─── Conversion rows ─────────────────────────────────────────────────────
  // A conversion only attaches to a brand if its offer_id is one of the brand's
  // offer slugs (offer_id is denormalised from the click on verification).
  // Unverified conversions with no offer_id are skipped — they cannot be
  // attributed to a brand.
  const conversionsByBrand: Record<BrandKey, ConversionRow[]> = { lg: [], kohls: [], bedbath: [] };
  for (const doc of conversionDocs) {
    const data = doc.data() as Record<string, any>;
    const offerId: string = data.offer_id || '';
    if (!allOfferIds.has(offerId)) continue;
    const brand = offerIdToBrand.get(offerId)!;

    const createdAtDate = getCreatedAtDate(data);
    const createdAtUtc = createdAtDate ? createdAtDate.toISOString() : '';
    const createdAtPt = createdAtDate ? formatInPt(createdAtDate) : '';

    const rawNetworkTs: string = typeof data.network_timestamp === 'string' ? data.network_timestamp : '';
    const parsedNetworkTs = parseNetworkTimestampAsPt(rawNetworkTs);
    // Bucket by network_timestamp PT when available (it's already PST), else by
    // created_at converted to PT.
    const ptDay = parsedNetworkTs?.dateKey ?? (createdAtDate ? ptDateKey(createdAtDate) : '');

    conversionsByBrand[brand].push({
      conversion_id: doc.id,
      network_id: data.network_id || '',
      offer_id: offerId,
      offer_name: offerIdToName.get(offerId) || '',
      click_id: data.click_id || '',
      payout: typeof data.payout === 'number' ? data.payout : 0,
      currency: data.currency || '',
      status: data.status || '',
      txn_id: data.txn_id || '',
      verified: data.verified === true,
      verification_reason: data.verification_reason || '',
      method: data.method || '',
      source_ip: data.source_ip || '',
      pt_day: ptDay,
      network_timestamp_raw: rawNetworkTs,
      network_timestamp_pt: parsedNetworkTs?.formatted ?? '',
      created_at_pt: createdAtPt,
      created_at_utc: createdAtUtc,
    });
  }

  // ─── Build discrepancy + write one workbook per brand ────────────────────
  const dateKeys = ptDateKeysInRange(FROM_DATE_PT, TO_DATE_PT);

  for (const brand of Object.keys(BRANDS) as BrandKey[]) {
    const { label, outFile, offers } = BRANDS[brand];
    const clicks = clicksByBrand[brand];
    const convs = conversionsByBrand[brand];

    console.log(`\n[${label}] clicks=${clicks.length}  conversions=${convs.length}`);

    // Per-(date, offer) counters.
    const clickCount = new Map<string, number>();   // key = `${date}__${offer_id}`
    const convCount = new Map<string, number>();
    const convRevenue = new Map<string, number>();
    for (const c of clicks) {
      if (!c.pt_day) continue;
      const k = `${c.pt_day}__${c.offer_id}`;
      clickCount.set(k, (clickCount.get(k) ?? 0) + 1);
    }
    for (const c of convs) {
      if (!c.pt_day) continue;
      const k = `${c.pt_day}__${c.offer_id}`;
      convCount.set(k, (convCount.get(k) ?? 0) + 1);
      convRevenue.set(k, (convRevenue.get(k) ?? 0) + (Number.isFinite(c.payout) ? c.payout : 0));
    }

    // Long-form discrepancy rows: one row per (date × offer_id).
    type DiscRow = {
      pt_date: string;
      offer_id: string;
      offer_name: string;
      clicks: number;
      conversions: number;
      diff_clicks_minus_conv: number;
      conv_rate_pct: number | string;
      revenue: number;
    };
    const discRows: DiscRow[] = [];
    const perOfferTotals = new Map<string, { clicks: number; conv: number; rev: number }>();
    let grandClicks = 0;
    let grandConv = 0;
    let grandRev = 0;

    for (const dk of dateKeys) {
      for (const o of offers) {
        const k = `${dk}__${o.id}`;
        const cl = clickCount.get(k) ?? 0;
        const cv = convCount.get(k) ?? 0;
        const rev = convRevenue.get(k) ?? 0;
        discRows.push({
          pt_date: dk,
          offer_id: o.id,
          offer_name: o.name,
          clicks: cl,
          conversions: cv,
          diff_clicks_minus_conv: cl - cv,
          conv_rate_pct: cl > 0 ? +((cv / cl) * 100).toFixed(2) : '',
          revenue: +rev.toFixed(2),
        });
        const t = perOfferTotals.get(o.id) ?? { clicks: 0, conv: 0, rev: 0 };
        t.clicks += cl;
        t.conv += cv;
        t.rev += rev;
        perOfferTotals.set(o.id, t);
        grandClicks += cl;
        grandConv += cv;
        grandRev += rev;
      }
    }

    // Build the Discrepancy sheet as a 2-D AOA so we can layer in headers
    // and summary blocks above the daily breakdown.
    const aoa: (string | number)[][] = [];
    aoa.push([`Discrepancy Report — ${label}`]);
    aoa.push([`PT range`, `${FROM_DATE_PT}  →  ${TO_DATE_PT}`]);
    aoa.push([]);
    aoa.push(['Summary by offer']);
    aoa.push(['offer_id', 'offer_name', 'clicks', 'conversions', 'diff (clicks − conv)', 'conv rate %', 'revenue']);
    for (const o of offers) {
      const t = perOfferTotals.get(o.id) ?? { clicks: 0, conv: 0, rev: 0 };
      aoa.push([
        o.id,
        o.name,
        t.clicks,
        t.conv,
        t.clicks - t.conv,
        t.clicks > 0 ? +((t.conv / t.clicks) * 100).toFixed(2) : '',
        +t.rev.toFixed(2),
      ]);
    }
    aoa.push([
      'TOTAL',
      '',
      grandClicks,
      grandConv,
      grandClicks - grandConv,
      grandClicks > 0 ? +((grandConv / grandClicks) * 100).toFixed(2) : '',
      +grandRev.toFixed(2),
    ]);
    aoa.push([]);
    aoa.push(['Daily breakdown (PT)']);
    aoa.push(['pt_date', 'offer_id', 'offer_name', 'clicks', 'conversions', 'diff (clicks − conv)', 'conv rate %', 'revenue']);
    for (const r of discRows) {
      aoa.push([
        r.pt_date,
        r.offer_id,
        r.offer_name,
        r.clicks,
        r.conversions,
        r.diff_clicks_minus_conv,
        r.conv_rate_pct,
        r.revenue,
      ]);
    }

    const wb = xlsx.utils.book_new();
    const wsDisc = xlsx.utils.aoa_to_sheet(aoa);
    xlsx.utils.book_append_sheet(wb, wsDisc, 'Discrepancy');

    const wsClicks = xlsx.utils.json_to_sheet(clicks);
    xlsx.utils.book_append_sheet(wb, wsClicks, 'Clicks (PT)');

    const wsConv = xlsx.utils.json_to_sheet(convs);
    xlsx.utils.book_append_sheet(wb, wsConv, 'Conversions (PT)');

    const outName = `${outFile}_${FROM_DATE_PT}_to_${TO_DATE_PT}_PT.xlsx`;
    const outPath = path.resolve(outName);
    xlsx.writeFile(wb, outPath);
    console.log(`  ✔ Wrote ${outPath}`);
    console.log(`    clicks=${grandClicks}  conversions=${grandConv}  diff=${grandClicks - grandConv}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
