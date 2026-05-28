import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as xlsx from 'xlsx';
import path from 'path';
import fs from 'fs';

// ────────────────────────────────────────────────────────────────────────────
// CONFIG — edit these two lines, then run:
//   npx tsx scripts/fetch-pst-report.ts
// ────────────────────────────────────────────────────────────────────────────

// 'clicks' | 'conversions'
const REPORT_TYPE: 'clicks' | 'conversions' = 'clicks';

// Date interpreted in Pacific Time (America/Los_Angeles, DST-aware).
// E.g. '2026-05-08' = the full PT day from 00:00 to 23:59:59.999 local.
const TARGET_DATE_PT = '2026-05-08';

// Optional slug filter. Empty array = no filter (export everything for the day).
// Matches offer_id / aff_id / campaign_id (clicks) or offer_id / network_id (conversions).
const TARGET_SLUGS: string[] = [];

// ────────────────────────────────────────────────────────────────────────────

const PT_ZONE = 'America/Los_Angeles';

/**
 * Returns the offset (in ms) that, when added to a UTC instant, gives
 * the wall-clock time in `tz`. DST-correct. For PST that's -8h; for PDT -7h.
 */
function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(instant).map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second
  );
  return asIfUtc - instant.getTime();
}

/** UTC instant of `YYYY-MM-DD HH:MM:SS.mmm` interpreted as wall time in `tz`. */
function ptWallClockToUtc(dateStr: string, hh: number, mm: number, ss: number, ms: number, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  // First guess: pretend the wall time is UTC.
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms));
  // The real UTC instant is offset back by the tz offset at that moment.
  const offset = tzOffsetMs(tz, guess);
  return new Date(guess.getTime() - offset);
}

function formatInTz(d: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const parts = Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
  // en-CA gives YYYY-MM-DD; build "YYYY-MM-DD HH:MM:SS GMT-7" style.
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

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

  const startUtc = ptWallClockToUtc(TARGET_DATE_PT, 0, 0, 0, 0, PT_ZONE);
  const endUtc = ptWallClockToUtc(TARGET_DATE_PT, 23, 59, 59, 999, PT_ZONE);

  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Report type    : ${REPORT_TYPE}`);
  console.log(`Target PT day  : ${TARGET_DATE_PT} 00:00:00 → 23:59:59.999 (${PT_ZONE})`);
  console.log(`PT window      : ${formatInTz(startUtc, PT_ZONE)}  →  ${formatInTz(endUtc, PT_ZONE)}`);
  console.log(`UTC window     : ${startUtc.toISOString()}  →  ${endUtc.toISOString()}`);
  console.log('─────────────────────────────────────────────────────────────');

  const collectionName = REPORT_TYPE;
  const colRef = db.collection(collectionName);

  // Query as Date — Firestore Admin SDK will compare against Timestamp fields.
  let snapshot = await colRef
    .where('created_at', '>=', startUtc)
    .where('created_at', '<=', endUtc)
    .get();

  let docs = snapshot.docs;
  if (docs.length === 0) {
    console.log('No docs via Timestamp query — retrying with ISO-string comparison…');
    const strSnap = await colRef
      .where('created_at', '>=', startUtc.toISOString())
      .where('created_at', '<=', endUtc.toISOString())
      .get();
    docs = strSnap.docs;
  }

  console.log(`Fetched ${docs.length} ${REPORT_TYPE} in window.`);

  const rows = docs.map((doc) => {
    const data = doc.data() as Record<string, any>;

    const createdAt = data.created_at;
    let createdAtUtc = '';
    let createdAtDate: Date | null = null;
    if (createdAt && typeof createdAt.toDate === 'function') {
      createdAtDate = createdAt.toDate();
      createdAtUtc = createdAtDate!.toISOString();
    } else if (typeof createdAt === 'string') {
      createdAtUtc = createdAt;
      const parsed = new Date(createdAt);
      if (!Number.isNaN(parsed.getTime())) createdAtDate = parsed;
    }
    const createdAtPt = createdAtDate ? formatInTz(createdAtDate, PT_ZONE) : '';

    if (REPORT_TYPE === 'clicks') {
      return {
        click_id: doc.id,
        offer_id: data.offer_id || '',
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
        created_at_utc: createdAtUtc,
        created_at_pt: createdAtPt,
      };
    }

    // conversions
    let networkTsUtc = '';
    let networkTsPt = '';
    if (typeof data.network_timestamp === 'string' && data.network_timestamp) {
      const ndate = new Date(data.network_timestamp);
      if (!Number.isNaN(ndate.getTime())) {
        networkTsUtc = ndate.toISOString();
        networkTsPt = formatInTz(ndate, PT_ZONE);
      } else {
        networkTsUtc = data.network_timestamp;
      }
    }

    return {
      conversion_id: doc.id,
      network_id: data.network_id || '',
      offer_id: data.offer_id || '',
      click_id: data.click_id || '',
      payout: data.payout ?? 0,
      currency: data.currency || '',
      status: data.status || '',
      txn_id: data.txn_id || '',
      verified: data.verified ?? false,
      verification_reason: data.verification_reason || '',
      method: data.method || '',
      source_ip: data.source_ip || '',
      network_timestamp_utc: networkTsUtc,
      network_timestamp_pt: networkTsPt,
      created_at_utc: createdAtUtc,
      created_at_pt: createdAtPt,
    };
  });

  const filtered = TARGET_SLUGS.length
    ? rows.filter((r: any) =>
        TARGET_SLUGS.includes(r.offer_id) ||
        TARGET_SLUGS.includes(r.aff_id ?? '') ||
        TARGET_SLUGS.includes(r.campaign_id ?? '') ||
        TARGET_SLUGS.includes(r.network_id ?? '')
      )
    : rows;

  if (TARGET_SLUGS.length) {
    console.log(`After slug filter: ${filtered.length} rows.`);
  }

  if (filtered.length === 0) {
    console.log('Nothing to export.');
    return;
  }

  const ws = xlsx.utils.json_to_sheet(filtered);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, REPORT_TYPE);
  const outName = `${REPORT_TYPE}_${TARGET_DATE_PT}_PT.xlsx`;
  const outPath = path.resolve(outName);
  xlsx.writeFile(wb, outPath);
  console.log(`✔ Wrote ${filtered.length} rows → ${outPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
