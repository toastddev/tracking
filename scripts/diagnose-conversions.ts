/**
 * diagnose-conversions.ts
 *
 * Compares per-offer totals from three different sources to explain why the
 * dashboard shows fewer / lower-value conversions than the operator's
 * "actual conversions" / CPC source:
 *
 *   1. `conversions` collection (raw rows)        -> ground truth
 *   2. `offer_reports` collection (daily rollup)  -> what the dashboard reads
 *   3. `google_ads_uploads` collection            -> what was uploaded as CPC
 *
 * Run with:
 *   cd tracking-backend
 *   node --env-file=.env --import tsx diagnose-conversions.ts
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Init ──────────────────────────────────────────────────────────────────
const saPath = path.resolve('./serviceAccount.json');
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
if (getApps().length === 0) {
  initializeApp({ credential: cert(sa) });
}
const databaseId = process.env.FIRESTORE_DATABASE_ID || 'tracking';
const db = getFirestore(undefined as any, databaseId);

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtMoney(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function rpad(n: number, w: number): string { return pad(String(n), w); }

interface PerOfferConv {
  total: number;
  total_payout: number;
  verified: number;
  verified_payout: number;
  unverified: number;
  unverified_payout: number;
  shadow: number;
  shadow_payout: number;
  // verified, NOT shadow — what *should* increment the rollup
  rollupCandidate: number;
  rollupCandidatePayout: number;
  byStatus: Record<string, { n: number; payout: number }>;
  byNetwork: Record<string, number>;
  bySource: Record<string, number>;       // postback | api | undefined
  zeroPayout: number;                     // verified rows w/ payout 0/null
  unknownClickIdRows: number;             // verification_reason = unknown_click_id
}
interface PerOfferRollup {
  conversions: number;        // verified only — same field the dashboard sums
  postbacks: number;
  unverified: number;
  revenue: number;
  approved: number;
  pending: number;
  rejected: number;
  clicks: number;
}
interface PerOfferUploads {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // 1. Offer name lookup
  const offerSnap = await db.collection('offers').get();
  const offerName = new Map<string, string>();
  for (const d of offerSnap.docs) {
    const data = d.data();
    offerName.set(d.id, (data.name as string) || d.id);
  }

  // 2. Walk all conversions
  console.log('Loading conversions…');
  const convSnap = await db.collection('conversions').get();
  console.log(`  ${convSnap.size} conversion docs.`);
  const convByOffer = new Map<string, PerOfferConv>();
  let conversionsWithoutOffer = 0;

  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const offer_id = (x.offer_id as string) || '__no_offer__';
    if (!x.offer_id) conversionsWithoutOffer++;
    let row = convByOffer.get(offer_id);
    if (!row) {
      row = {
        total: 0, total_payout: 0,
        verified: 0, verified_payout: 0,
        unverified: 0, unverified_payout: 0,
        shadow: 0, shadow_payout: 0,
        rollupCandidate: 0, rollupCandidatePayout: 0,
        byStatus: {}, byNetwork: {}, bySource: {},
        zeroPayout: 0, unknownClickIdRows: 0,
      };
      convByOffer.set(offer_id, row);
    }
    const payout = typeof x.payout === 'number' ? x.payout : 0;
    row.total++;
    row.total_payout += payout;
    const verified = !!x.verified;
    const shadow = !!x.shadow;
    if (verified) { row.verified++; row.verified_payout += payout; }
    else { row.unverified++; row.unverified_payout += payout; }
    if (shadow) { row.shadow++; row.shadow_payout += payout; }
    if (verified && !shadow) {
      row.rollupCandidate++;
      row.rollupCandidatePayout += payout;
    }
    if (verified && payout === 0) row.zeroPayout++;
    if (x.verification_reason === 'unknown_click_id') row.unknownClickIdRows++;
    const status = (x.status as string) || 'none';
    const sBucket = row.byStatus[status] ?? { n: 0, payout: 0 };
    sBucket.n++; sBucket.payout += payout;
    row.byStatus[status] = sBucket;
    const net = (x.network_id as string) || 'none';
    row.byNetwork[net] = (row.byNetwork[net] ?? 0) + 1;
    const src = (x.source as string) || 'unknown';
    row.bySource[src] = (row.bySource[src] ?? 0) + 1;
  }

  // 3. Walk all offer_reports docs
  console.log('Loading offer_reports rollup…');
  const rollSnap = await db.collection('offer_reports').get();
  console.log(`  ${rollSnap.size} rollup docs.`);
  const rollupByOffer = new Map<string, PerOfferRollup>();
  for (const d of rollSnap.docs) {
    const x = d.data() as Record<string, any>;
    const offer_id = (x.offer_id as string) || '__no_offer__';
    let row = rollupByOffer.get(offer_id);
    if (!row) {
      row = { conversions: 0, postbacks: 0, unverified: 0, revenue: 0,
              approved: 0, pending: 0, rejected: 0, clicks: 0 };
      rollupByOffer.set(offer_id, row);
    }
    row.conversions += +(x.conversions ?? 0);
    row.postbacks   += +(x.postbacks   ?? 0);
    row.unverified  += +(x.unverified  ?? 0);
    row.revenue     += +(x.revenue     ?? 0);
    row.approved    += +(x.approved    ?? 0);
    row.pending     += +(x.pending     ?? 0);
    row.rejected    += +(x.rejected    ?? 0);
    row.clicks      += +(x.clicks      ?? 0);
  }

  // 4. Walk google_ads_uploads (the "CPC" source)
  console.log('Loading google_ads_uploads…');
  const upSnap = await db.collection('google_ads_uploads')
    .where('kind', '==', 'conversion').get();
  console.log(`  ${upSnap.size} upload docs (kind=conversion).`);
  const uploadsByOffer = new Map<string, PerOfferUploads>();
  // To map upload → offer, we need to read its conversion. Avoid N+1: build a
  // map of conversion_id -> offer_id from the conversions snapshot above.
  const convOfferLookup = new Map<string, string>();
  for (const d of convSnap.docs) {
    convOfferLookup.set(d.id, (d.data().offer_id as string) || '__no_offer__');
  }
  for (const d of upSnap.docs) {
    const x = d.data() as Record<string, any>;
    const cid = x.conversion_id as string | undefined;
    const offer_id = (cid && convOfferLookup.get(cid)) || '__no_offer_or_orphan__';
    let row = uploadsByOffer.get(offer_id);
    if (!row) {
      row = { total: 0, sent: 0, skipped: 0, failed: 0, pending: 0 };
      uploadsByOffer.set(offer_id, row);
    }
    row.total++;
    const status = String(x.status ?? 'pending');
    if (status === 'sent') row.sent++;
    else if (status === 'skipped') row.skipped++;
    else if (status === 'failed' || status === 'partial_failure') row.failed++;
    else row.pending++;
  }

  // 5. Affiliate API runs — count records_skipped_unknown_click. THIS IS THE
  //    BIG ONE: rows the API pulled that we couldn't verify against a click.
  console.log('Loading affiliate_api_runs…');
  let totalSkippedUnknownClick = 0;
  let totalRecordsSeen = 0;
  let totalRecordsInserted = 0;
  try {
    const runsSnap = await db.collection('affiliate_api_runs').get();
    for (const d of runsSnap.docs) {
      const x = d.data() as Record<string, any>;
      totalSkippedUnknownClick += +(x.records_skipped_unknown_click ?? 0);
      totalRecordsSeen         += +(x.records_seen                  ?? 0);
      totalRecordsInserted     += +(x.records_inserted              ?? 0);
    }
    console.log(`  ${runsSnap.size} runs. records_seen=${totalRecordsSeen}, records_inserted=${totalRecordsInserted}, records_skipped_unknown_click=${totalSkippedUnknownClick}`);
  } catch {
    console.log('  affiliate_api_runs collection missing or unreadable.');
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  const allOfferIds = new Set<string>([
    ...convByOffer.keys(),
    ...rollupByOffer.keys(),
    ...uploadsByOffer.keys(),
  ]);
  const sortedOffers = Array.from(allOfferIds).sort((a, b) => {
    const an = (offerName.get(a) ?? a).toLowerCase();
    const bn = (offerName.get(b) ?? b).toLowerCase();
    return an.localeCompare(bn);
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('Per-offer summary');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(
    pad('Offer',                26) +
    pad('Convs(raw)',           12) +
    pad('Verified',             10) +
    pad('Unver',                 8) +
    pad('Shadow',                8) +
    pad('RollupCand',           12) +
    pad('Rollup.conv',          12) +
    pad('Rollup.rev',           12) +
    pad('Uploads(sent)',        14)
  );
  console.log('───────────────────────────────────────────────────────────────────────────────────────────────────────────────');

  for (const id of sortedOffers) {
    const c = convByOffer.get(id);
    const r = rollupByOffer.get(id);
    const u = uploadsByOffer.get(id);
    const name = offerName.get(id) ?? id;
    console.log(
      pad(name.slice(0, 25), 26) +
      pad(c ? `${c.total} (${fmtMoney(c.total_payout)})` : '-', 12) +
      pad(c ? `${c.verified}` : '-', 10) +
      pad(c ? `${c.unverified}` : '-', 8) +
      pad(c ? `${c.shadow}` : '-', 8) +
      pad(c ? `${c.rollupCandidate} (${fmtMoney(c.rollupCandidatePayout)})` : '-', 12) +
      pad(r ? `${r.conversions}` : '-', 12) +
      pad(r ? fmtMoney(r.revenue) : '-', 12) +
      pad(u ? `${u.total}/${u.sent}` : '-', 14)
    );
  }

  // ─── Drift report — rollup vs raw ────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('Rollup vs raw drift (rollup.conversions / revenue   vs   verified-non-shadow conversions)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(
    pad('Offer',         26) +
    pad('RawVerified',   14) +
    pad('Rollup',        14) +
    pad('Δcount',        10) +
    pad('RawRev',        12) +
    pad('RollupRev',     12) +
    pad('ΔRev',          12)
  );
  console.log('───────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  let totalRollupConv = 0, totalRollupRev = 0, totalRawConv = 0, totalRawRev = 0;
  for (const id of sortedOffers) {
    const c = convByOffer.get(id);
    const r = rollupByOffer.get(id);
    const rawConv = c?.rollupCandidate ?? 0;
    const rawRev = c?.rollupCandidatePayout ?? 0;
    const rollConv = r?.conversions ?? 0;
    const rollRev = r?.revenue ?? 0;
    totalRollupConv += rollConv; totalRollupRev += rollRev;
    totalRawConv += rawConv;     totalRawRev += rawRev;
    const dCount = rollConv - rawConv;
    const dRev = rollRev - rawRev;
    const name = offerName.get(id) ?? id;
    console.log(
      pad(name.slice(0, 25), 26) +
      pad(`${rawConv}`, 14) +
      pad(`${rollConv}`, 14) +
      pad(`${dCount > 0 ? '+' : ''}${dCount}`, 10) +
      pad(fmtMoney(rawRev), 12) +
      pad(fmtMoney(rollRev), 12) +
      pad(`${dRev >= 0 ? '+' : ''}${fmtMoney(dRev)}`, 12)
    );
  }
  console.log('───────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log(
    pad('TOTAL', 26) +
    pad(`${totalRawConv}`, 14) +
    pad(`${totalRollupConv}`, 14) +
    pad(`${totalRollupConv - totalRawConv > 0 ? '+' : ''}${totalRollupConv - totalRawConv}`, 10) +
    pad(fmtMoney(totalRawRev), 12) +
    pad(fmtMoney(totalRollupRev), 12) +
    pad(`${totalRollupRev - totalRawRev >= 0 ? '+' : ''}${fmtMoney(totalRollupRev - totalRawRev)}`, 12)
  );

  // ─── Per-offer status / source / network breakdown ───────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('Per-offer breakdown (status / source / network / verification)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  for (const id of sortedOffers) {
    const c = convByOffer.get(id);
    if (!c) continue;
    const name = offerName.get(id) ?? id;
    console.log(`\n■ ${name}  (offer_id=${id})`);
    console.log(`   total=${c.total}  payout=${fmtMoney(c.total_payout)}`);
    console.log(`   verified=${c.verified} (${fmtMoney(c.verified_payout)})  unverified=${c.unverified} (${fmtMoney(c.unverified_payout)})`);
    console.log(`   shadow=${c.shadow} (${fmtMoney(c.shadow_payout)})  rollup-eligible (verified & !shadow)=${c.rollupCandidate} (${fmtMoney(c.rollupCandidatePayout)})`);
    console.log(`   verified rows w/ payout=0: ${c.zeroPayout}`);
    console.log(`   verification_reason=unknown_click_id: ${c.unknownClickIdRows}`);
    console.log(`   sources: ${Object.entries(c.bySource).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log(`   networks: ${Object.entries(c.byNetwork).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log(`   statuses: ${Object.entries(c.byStatus).map(([k, v]) => `${k}=${v.n} (${fmtMoney(v.payout)})`).join('  ')}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`Conversions docs without offer_id: ${conversionsWithoutOffer}`);
  console.log(`Total skipped_unknown_click across affiliate_api_runs: ${totalSkippedUnknownClick}`);
  console.log(`(Those rows are NOT written to "conversions" — they vanish silently. See affiliateApiSyncService.ts:500-503)`);
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
