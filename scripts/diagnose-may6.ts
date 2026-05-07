/**
 * diagnose-may6.ts
 *
 * Per-offer reconciliation for ONE specific UTC day (default: 2026-05-06).
 * Compares:
 *   - conversions ingested with created_at on that day
 *   - conversions whose eventDate (network_timestamp) falls on that day
 *   - offer_reports rollup doc for date='2026-05-06'
 *
 * Plus: affiliate_api_runs that ran on that day — counts skipped_unknown_click.
 *
 * Run with:
 *   node --env-file=.env --import tsx diagnose-may6.ts [YYYY-MM-DD] 
 * node --env-file=.env --import tsx diagnose-admedia-may6.ts 2026-05-07
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sa = JSON.parse(fs.readFileSync(path.resolve('./serviceAccount.json'), 'utf8'));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore(undefined as any, process.env.FIRESTORE_DATABASE_ID || 'tracking');

const TARGET_DATE = process.argv[2] || '2026-05-06';
const dayStart = new Date(`${TARGET_DATE}T00:00:00.000Z`);
const dayEnd   = new Date(`${TARGET_DATE}T23:59:59.999Z`);

// Same logic as eventTime.eventDate()
const MAX_BACKDATE_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS   = 6  * 60 * 60 * 1000;
function eventDate(createdAt: Date, networkTs: string | undefined): Date {
  if (!networkTs) return createdAt;
  const r = new Date(networkTs);
  if (Number.isNaN(r.getTime())) return createdAt;
  const delta = r.getTime() - createdAt.getTime();
  if (delta < -MAX_BACKDATE_MS || delta > MAX_FUTURE_MS) return createdAt;
  return r;
}
function dayKeyUTC(d: Date): string { return d.toISOString().slice(0, 10); }
function fmtMoney(n: number): string { return `$${(Math.round(n*100)/100).toFixed(2)}`; }
function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  console.log(`\n=== Reconciliation for ${TARGET_DATE} (UTC) ===\n`);

  // ── Offers ────────────────────────────────────────────────────────────
  const offers = new Map<string, string>();
  for (const d of (await db.collection('offers').get()).docs) {
    offers.set(d.id, (d.data().name as string) || d.id);
  }

  // ── Conversions: pull a wide window so we can re-bucket by event-day ──
  const wideStart = new Date(dayStart.getTime() - 3 * 24 * 60 * 60 * 1000);
  const wideEnd   = new Date(dayEnd.getTime()   + 3 * 24 * 60 * 60 * 1000);
  console.log(`Loading conversions where created_at ∈ [${wideStart.toISOString()}, ${wideEnd.toISOString()}]`);
  const convSnap = await db.collection('conversions')
    .where('created_at', '>=', Timestamp.fromDate(wideStart))
    .where('created_at', '<=', Timestamp.fromDate(wideEnd))
    .get();
  console.log(`  ${convSnap.size} conversion docs in wide window`);

  type Bucket = {
    raw_total: number; raw_payout: number;
    eligible: number; eligible_payout: number;   // verified && !shadow && bucketed to TARGET_DATE
    shadow: number; shadow_payout: number;
    unverified: number;
    statuses: Record<string, number>;
    spilled_prev: number;   // event-day < TARGET (wrong bucket)
    spilled_next: number;
    payout0: number;
  };
  const byOffer = new Map<string, Bucket>();
  function bucket(offer_id: string): Bucket {
    let b = byOffer.get(offer_id);
    if (!b) {
      b = { raw_total: 0, raw_payout: 0, eligible: 0, eligible_payout: 0,
            shadow: 0, shadow_payout: 0, unverified: 0, statuses: {},
            spilled_prev: 0, spilled_next: 0, payout0: 0 };
      byOffer.set(offer_id, b);
    }
    return b;
  }

  let no_offer = 0;
  let total_eligible = 0;
  let total_eligible_payout = 0;

  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const offer_id = (x.offer_id as string) || '__no_offer__';
    if (!x.offer_id) no_offer++;
    const created = (x.created_at?.toDate?.() as Date) ?? new Date(x.created_at);
    const evtDay = dayKeyUTC(eventDate(created, x.network_timestamp));
    const inWindow = evtDay === TARGET_DATE;
    const verified = !!x.verified;
    const shadow   = !!x.shadow;
    const payout   = typeof x.payout === 'number' ? x.payout : 0;

    const b = bucket(offer_id);
    if (inWindow) {
      b.raw_total++; b.raw_payout += payout;
      const status = String(x.status ?? 'none');
      b.statuses[status] = (b.statuses[status] ?? 0) + 1;
      if (verified && !shadow) {
        b.eligible++; b.eligible_payout += payout;
        total_eligible++; total_eligible_payout += payout;
        if (payout === 0) b.payout0++;
      }
      if (shadow) { b.shadow++; b.shadow_payout += payout; }
      if (!verified) b.unverified++;
    } else {
      // Conversion landed on a different day after eventDate calculation. Only
      // care about whether it spilled relative to the target day's neighbours.
      if (evtDay < TARGET_DATE) {
        // Could still be a TARGET-day record per created_at (api lag) but
        // bucketed earlier. We only flag those whose created_at IS in target.
        if (dayKeyUTC(created) === TARGET_DATE) b.spilled_prev++;
      } else {
        if (dayKeyUTC(created) === TARGET_DATE) b.spilled_next++;
      }
    }
  }

  // ── Rollup doc(s) for TARGET_DATE ─────────────────────────────────────
  console.log(`Loading offer_reports where date='${TARGET_DATE}'…`);
  const rollSnap = await db.collection('offer_reports').where('date', '==', TARGET_DATE).get();
  console.log(`  ${rollSnap.size} rollup docs`);
  const rollupByOffer = new Map<string, { conv: number; rev: number; postbacks: number; unverified: number; clicks: number }>();
  for (const d of rollSnap.docs) {
    const x = d.data() as Record<string, any>;
    const offer_id = (x.offer_id as string) || '__no_offer__';
    let r = rollupByOffer.get(offer_id);
    if (!r) { r = { conv: 0, rev: 0, postbacks: 0, unverified: 0, clicks: 0 }; rollupByOffer.set(offer_id, r); }
    r.conv       += +(x.conversions ?? 0);
    r.rev        += +(x.revenue     ?? 0);
    r.postbacks  += +(x.postbacks   ?? 0);
    r.unverified += +(x.unverified  ?? 0);
    r.clicks     += +(x.clicks      ?? 0);
  }

  // ── affiliate_api_runs that ran on TARGET_DATE ────────────────────────
  console.log(`Loading affiliate_api_runs that touched ${TARGET_DATE}…`);
  const runSnap = await db.collection('affiliate_api_runs').get();
  let runsOnDay = 0, seen = 0, inserted = 0, dup = 0, skippedUnknown = 0, failed = 0;
  const runsForDay: Array<Record<string, any>> = [];
  for (const d of runSnap.docs) {
    const x = d.data() as Record<string, any>;
    const wf = x.window_from ? new Date(x.window_from) : null;
    const wt = x.window_to   ? new Date(x.window_to)   : null;
    if (!wf || !wt) continue;
    if (wf <= dayEnd && wt >= dayStart) {
      runsOnDay++;
      seen           += +(x.records_seen ?? 0);
      inserted       += +(x.records_inserted ?? 0);
      dup            += +(x.records_skipped_duplicate ?? 0);
      skippedUnknown += +(x.records_skipped_unknown_click ?? 0);
      failed         += +(x.records_failed ?? 0);
      runsForDay.push(x);
    }
  }
  console.log(`  ${runsOnDay} runs intersect ${TARGET_DATE}.  seen=${seen} inserted=${inserted} dup=${dup} skipped_unknown=${skippedUnknown} failed=${failed}`);

  // ── Render comparison ─────────────────────────────────────────────────
  console.log('\n┌─ Per-offer reconciliation for ' + TARGET_DATE + ' ─');
  console.log(
    pad('Offer', 28) +
    pad('Raw#', 6) +
    pad('Eligible#', 11) +
    pad('Rollup#', 9) +
    pad('Δ#', 6) +
    pad('Eligible$', 11) +
    pad('Rollup$', 11) +
    pad('Δ$', 11) +
    pad('SpillPrev', 10) +
    pad('SpillNext', 10) +
    pad('Shadow', 8) +
    pad('Unver', 7)
  );
  console.log('─'.repeat(140));

  const allIds = new Set<string>([...byOffer.keys(), ...rollupByOffer.keys()]);
  const sorted = Array.from(allIds).sort((a, b) =>
    (offers.get(a) ?? a).toLowerCase().localeCompare((offers.get(b) ?? b).toLowerCase())
  );

  let TraR = 0, TelR = 0, TroC = 0, TroR = 0, TspP = 0, TspN = 0, TshC = 0, TunC = 0;
  for (const id of sorted) {
    const b = byOffer.get(id);
    const r = rollupByOffer.get(id);
    const eligible = b?.eligible ?? 0;
    const eligiblePay = b?.eligible_payout ?? 0;
    const rollC = r?.conv ?? 0;
    const rollR = r?.rev  ?? 0;
    const dC = rollC - eligible;
    const dR = rollR - eligiblePay;
    TelR += eligiblePay; TroC += rollC; TroR += rollR; TraR += b?.raw_total ?? 0;
    TspP += b?.spilled_prev ?? 0; TspN += b?.spilled_next ?? 0;
    TshC += b?.shadow ?? 0; TunC += b?.unverified ?? 0;
    const name = (offers.get(id) ?? id).slice(0, 27);
    console.log(
      pad(name, 28) +
      pad(String(b?.raw_total ?? 0), 6) +
      pad(String(eligible), 11) +
      pad(String(rollC), 9) +
      pad((dC > 0 ? '+' : '') + dC, 6) +
      pad(fmtMoney(eligiblePay), 11) +
      pad(fmtMoney(rollR), 11) +
      pad((dR >= 0 ? '+' : '') + fmtMoney(dR), 11) +
      pad(String(b?.spilled_prev ?? 0), 10) +
      pad(String(b?.spilled_next ?? 0), 10) +
      pad(String(b?.shadow ?? 0), 8) +
      pad(String(b?.unverified ?? 0), 7)
    );
  }
  console.log('─'.repeat(140));
  console.log(
    pad('TOTAL', 28) +
    pad(String(TraR), 6) +
    pad(String(total_eligible), 11) +
    pad(String(TroC), 9) +
    pad((TroC - total_eligible > 0 ? '+' : '') + (TroC - total_eligible), 6) +
    pad(fmtMoney(total_eligible_payout), 11) +
    pad(fmtMoney(TroR), 11) +
    pad((TroR - total_eligible_payout >= 0 ? '+' : '') + fmtMoney(TroR - total_eligible_payout), 11) +
    pad(String(TspP), 10) +
    pad(String(TspN), 10) +
    pad(String(TshC), 8) +
    pad(String(TunC), 7)
  );

  // ── Detail: every conversion ON the day, broken out ───────────────────
  console.log('\n┌─ Per-conversion detail for ' + TARGET_DATE + ' (verified-non-shadow only) ─');
  let lineCount = 0;
  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const created = (x.created_at?.toDate?.() as Date) ?? new Date(x.created_at);
    const evt = eventDate(created, x.network_timestamp);
    if (dayKeyUTC(evt) !== TARGET_DATE) continue;
    if (!x.verified) continue;
    if (x.shadow) continue;
    lineCount++;
    if (lineCount <= 50) {  // cap noise
      const offer = (offers.get(x.offer_id ?? '') ?? x.offer_id ?? '?');
      console.log(`  ${created.toISOString()}  net=${x.network_id}  src=${x.source ?? '?'}  offer=${offer}  payout=${fmtMoney(x.payout ?? 0)}  status=${x.status ?? '?'}  cid=${(x.click_id ?? '').slice(0, 8)}…`);
    }
  }
  if (lineCount > 50) console.log(`  …and ${lineCount - 50} more`);
  console.log(`(total verified-non-shadow conversions bucketed to ${TARGET_DATE}: ${lineCount})`);

  // ── Spilled examples (created_at on TARGET_DATE but eventDate elsewhere)
  console.log('\n┌─ Conversions created on ' + TARGET_DATE + ' but eventDate spilled elsewhere ─');
  let spillCount = 0;
  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const created = (x.created_at?.toDate?.() as Date) ?? new Date(x.created_at);
    if (dayKeyUTC(created) !== TARGET_DATE) continue;
    const evt = eventDate(created, x.network_timestamp);
    const evtDay = dayKeyUTC(evt);
    if (evtDay === TARGET_DATE) continue;
    spillCount++;
    if (spillCount <= 30) {
      const offer = (offers.get(x.offer_id ?? '') ?? x.offer_id ?? '?');
      console.log(`  created=${created.toISOString()}  net_ts=${x.network_timestamp ?? '∅'}  bucketed=${evtDay}  offer=${offer}  payout=${fmtMoney(x.payout ?? 0)}  src=${x.source ?? '?'}`);
    }
  }
  console.log(`(total spilled out of ${TARGET_DATE} into a different day: ${spillCount})`);

  // ── Spilled INTO the day from neighbours ──────────────────────────────
  console.log('\n┌─ Conversions created elsewhere but bucketed INTO ' + TARGET_DATE + ' ─');
  let inSpill = 0;
  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const created = (x.created_at?.toDate?.() as Date) ?? new Date(x.created_at);
    if (dayKeyUTC(created) === TARGET_DATE) continue;
    const evt = eventDate(created, x.network_timestamp);
    if (dayKeyUTC(evt) !== TARGET_DATE) continue;
    inSpill++;
    if (inSpill <= 30) {
      const offer = (offers.get(x.offer_id ?? '') ?? x.offer_id ?? '?');
      console.log(`  created=${created.toISOString()}  net_ts=${x.network_timestamp ?? '∅'}  offer=${offer}  payout=${fmtMoney(x.payout ?? 0)}  src=${x.source ?? '?'}`);
    }
  }
  console.log(`(total spilled INTO ${TARGET_DATE}: ${inSpill})`);

  // ── User's expected counts ────────────────────────────────────────────
  console.log('\n┌─ Cross-check against user\'s May-6 CPC report ─');
  const expected: Array<[string, number, number]> = [
    ['BedBathBeyond', 1,    0.75],
    ['BestBuy',       23,  16.10],
    ['BrooksBrothers',38,  28.50],
    ['DellCom',       71,  56.80],
    ['kohls',         17,  10.20],
    ['LGElectronics', 2,    2.00],
    ['VividSeats',   135, 135.00],
    ['ZenniOptical',  95, 109.25],
  ];
  // Match offers by name substring to brand label
  const brandPatterns: Record<string, RegExp> = {
    BedBathBeyond:   /bed.?bath/i,
    BestBuy:         /bestbuy/i,
    BrooksBrothers:  /brooks/i,
    DellCom:         /dell/i,
    kohls:           /kohl/i,
    LGElectronics:   /(^|[^a-z])lg([^a-z]|$)/i,
    VividSeats:      /vividseat/i,
    ZenniOptical:    /zennioptical/i,
  };
  console.log(pad('Brand', 18) + pad('CPC#', 8) + pad('Track#', 9) + pad('Δ#', 6) + pad('CPC$', 10) + pad('Track$', 10) + pad('Δ$', 10));
  console.log('─'.repeat(80));
  for (const [brand, expCount, expRev] of expected) {
    const re = brandPatterns[brand]!;
    let count = 0; let rev = 0;
    for (const [id, b] of byOffer) {
      const name = offers.get(id) ?? id;
      if (!re.test(name)) continue;
      count += b.eligible;
      rev   += b.eligible_payout;
    }
    const dC = count - expCount;
    const dR = rev - expRev;
    console.log(
      pad(brand, 18) +
      pad(String(expCount), 8) +
      pad(String(count), 9) +
      pad((dC > 0 ? '+' : '') + dC, 6) +
      pad(fmtMoney(expRev), 10) +
      pad(fmtMoney(rev), 10) +
      pad((dR >= 0 ? '+' : '') + fmtMoney(dR), 10)
    );
  }

  console.log('\n=== DONE ===\n');
}
main().catch(e => { console.error(e); process.exit(1); });
