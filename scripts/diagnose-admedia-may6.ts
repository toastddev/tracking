/**
 * diagnose-admedia-may6.ts
 *
 * Drills only into AdMedia data for one day:
 *   - Lists every affiliate_api_runs row that ran admedia and intersected
 *     2026-05-06 (or the day passed as argv[2]).
 *   - Counts records_seen / inserted / duplicate / skipped_unknown_click /
 *     failed per run.
 *   - Pulls every conversion with network_id='admedia' bucketed by
 *     eventDate to the target day.
 *   - Loads the offer_reports docs for date='2026-05-06' AND
 *     network_id='admedia'. Compares conv counts and revenue.
 *   - For each offer, shows raw verified-non-shadow vs rollup; flags
 *     offers where the rollup is short (= dashboard will under-count).
 *
 * Run: node --env-file=.env --import tsx diagnose-admedia-may6.ts [YYYY-MM-DD]
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sa = JSON.parse(fs.readFileSync(path.resolve('./serviceAccount.json'), 'utf8'));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore(undefined as any, process.env.FIRESTORE_DATABASE_ID || 'tracking');

const TARGET = process.argv[2] || '2026-05-06';
const dayStart = new Date(`${TARGET}T00:00:00.000Z`);
const dayEnd   = new Date(`${TARGET}T23:59:59.999Z`);
const NET = 'admedia';

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
function rpad(n: number, w: number): string { return pad(String(n), w); }

async function main() {
  console.log(`\n=== AdMedia diagnostic for ${TARGET} (UTC) ===\n`);

  // ── Offers ────────────────────────────────────────────────────────────
  const offerName = new Map<string, string>();
  for (const d of (await db.collection('offers').get()).docs) {
    offerName.set(d.id, (d.data().name as string) || d.id);
  }

  // ── Affiliate API runs for AdMedia on TARGET ──────────────────────────
  console.log(`▌Loading affiliate_api_runs that intersect ${TARGET}…`);
  const runs = (await db.collection('affiliate_api_runs').get()).docs
    .map(d => ({ id: d.id, ...(d.data() as Record<string, any>) }))
    .filter(r => r.api_id === NET || r.network_id === NET || (r.window_from || '').includes(''));

  // The runs collection doesn't necessarily have a network filter — runs are
  // per-API. Filter where either api_id is admedia, or where window touches
  // the target day, then we'll narrow further. For ground-truth, assume
  // api_id='admedia' was used.
  const dayRuns = runs.filter(r => {
    if (!(r.api_id === NET) && !((r.api_id ?? '').toLowerCase().includes('admedia'))) return false;
    const wf = r.window_from ? new Date(r.window_from) : null;
    const wt = r.window_to   ? new Date(r.window_to)   : null;
    if (!wf || !wt) return false;
    return wf <= dayEnd && wt >= dayStart;
  });
  console.log(`  ${dayRuns.length} AdMedia runs intersect ${TARGET}\n`);

  console.log(pad('run_id', 30) + pad('window_from', 22) + pad('window_to', 22) + pad('seen', 6) + pad('insert', 7) + pad('dup', 6) + pad('skipUnk', 9) + pad('fail', 6) + pad('status', 8));
  console.log('─'.repeat(120));
  let SUM = { seen: 0, inserted: 0, dup: 0, skip: 0, fail: 0 };
  for (const r of dayRuns) {
    SUM.seen     += +(r.records_seen ?? 0);
    SUM.inserted += +(r.records_inserted ?? 0);
    SUM.dup      += +(r.records_skipped_duplicate ?? 0);
    SUM.skip     += +(r.records_skipped_unknown_click ?? 0);
    SUM.fail     += +(r.records_failed ?? 0);
    console.log(
      pad(r.run_id ?? r.id, 30) +
      pad((r.window_from ?? '').slice(0, 19), 22) +
      pad((r.window_to ?? '').slice(0, 19), 22) +
      rpad(+(r.records_seen ?? 0), 6) +
      rpad(+(r.records_inserted ?? 0), 7) +
      rpad(+(r.records_skipped_duplicate ?? 0), 6) +
      rpad(+(r.records_skipped_unknown_click ?? 0), 9) +
      rpad(+(r.records_failed ?? 0), 6) +
      pad(String(r.status ?? '?'), 8)
    );
  }
  console.log('─'.repeat(120));
  console.log(
    pad('TOTAL', 74) +
    rpad(SUM.seen, 6) +
    rpad(SUM.inserted, 7) +
    rpad(SUM.dup, 6) +
    rpad(SUM.skip, 9) +
    rpad(SUM.fail, 6)
  );
  console.log('');
  console.log(`AdMedia on ${TARGET}:`);
  console.log(`  conversions seen by API:     ${SUM.seen}`);
  console.log(`  newly written to DB:         ${SUM.inserted}`);
  console.log(`  already in DB (dedupe):      ${SUM.dup}`);
  console.log(`  ► DROPPED (unknown click_id): ${SUM.skip}   ← these never reach 'conversions'`);
  console.log(`  ► FAILED  (mapping/insert):   ${SUM.fail}   ← these never reach 'conversions'`);

  // ── Conversions for AdMedia in a wide window, then re-bucket ──────────
  const wideStart = new Date(dayStart.getTime() - 3 * 24 * 60 * 60 * 1000);
  const wideEnd   = new Date(dayEnd.getTime()   + 3 * 24 * 60 * 60 * 1000);
  console.log(`\n▌Loading conversions in [${wideStart.toISOString()}, ${wideEnd.toISOString()}], filtering admedia in-memory…`);
  const convSnapAll = await db.collection('conversions')
    .where('created_at', '>=', Timestamp.fromDate(wideStart))
    .where('created_at', '<=', Timestamp.fromDate(wideEnd))
    .get();
  const convDocs = convSnapAll.docs.filter(d => (d.data() as Record<string, any>).network_id === NET);
  // Mock the snap shape we use below.
  const convSnap = { size: convDocs.length, docs: convDocs };
  console.log(`  ${convSnapAll.size} total conversion docs in window; ${convSnap.size} for admedia\n`);

  type B = { raw: number; payout: number; eligible: number; eligible_payout: number; verified: number; shadow: number; statuses: Record<string, number>; clickIds: Set<string>; dupesByClick: number };
  const byOffer = new Map<string, B>();
  function bucket(id: string): B {
    let b = byOffer.get(id);
    if (!b) { b = { raw: 0, payout: 0, eligible: 0, eligible_payout: 0, verified: 0, shadow: 0, statuses: {}, clickIds: new Set(), dupesByClick: 0 }; byOffer.set(id, b); }
    return b;
  }

  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const created = (x.created_at?.toDate?.() as Date) ?? new Date(x.created_at);
    const evt = eventDate(created, x.network_timestamp);
    if (dayKeyUTC(evt) !== TARGET) continue;
    const offer_id = (x.offer_id as string) || '__no_offer__';
    const b = bucket(offer_id);
    const payout = typeof x.payout === 'number' ? x.payout : 0;
    b.raw++; b.payout += payout;
    if (x.verified) b.verified++;
    if (x.shadow) b.shadow++;
    if (x.verified && !x.shadow) {
      b.eligible++; b.eligible_payout += payout;
    }
    const s = String(x.status ?? 'none');
    b.statuses[s] = (b.statuses[s] ?? 0) + 1;
    const cid = String(x.click_id ?? '');
    if (cid) {
      if (b.clickIds.has(cid)) b.dupesByClick++;
      else b.clickIds.add(cid);
    }
  }

  // ── Rollup docs for TARGET + admedia ──────────────────────────────────
  console.log(`▌Loading offer_reports where date='${TARGET}' AND network_id='${NET}'`);
  const rollSnap = await db.collection('offer_reports')
    .where('date', '==', TARGET)
    .where('network_id', '==', NET)
    .get();
  console.log(`  ${rollSnap.size} rollup docs\n`);

  const rollupByOffer = new Map<string, { conv: number; rev: number; postbacks: number; unverified: number; approved: number; pending: number; rejected: number }>();
  for (const d of rollSnap.docs) {
    const x = d.data() as Record<string, any>;
    const id = (x.offer_id as string) || '__no_offer__';
    let r = rollupByOffer.get(id);
    if (!r) { r = { conv: 0, rev: 0, postbacks: 0, unverified: 0, approved: 0, pending: 0, rejected: 0 }; rollupByOffer.set(id, r); }
    r.conv      += +(x.conversions ?? 0);
    r.rev       += +(x.revenue     ?? 0);
    r.postbacks += +(x.postbacks   ?? 0);
    r.unverified+= +(x.unverified  ?? 0);
    r.approved  += +(x.approved    ?? 0);
    r.pending   += +(x.pending     ?? 0);
    r.rejected  += +(x.rejected    ?? 0);
  }

  // ── Per-offer comparison ──────────────────────────────────────────────
  console.log('▌Per-offer reconciliation (raw vs rollup) — AdMedia only, ' + TARGET);
  console.log('');
  console.log(
    pad('Offer', 35) +
    pad('Raw#', 6) +
    pad('Eligible#', 11) +
    pad('Rollup#', 9) +
    pad('Δ#', 6) +
    pad('RawRev', 11) +
    pad('RollupRev', 11) +
    pad('Δ$', 11) +
    pad('Verified', 9) +
    pad('Shadow', 7) +
    pad('Dupes', 6)
  );
  console.log('─'.repeat(135));

  const allIds = new Set<string>([...byOffer.keys(), ...rollupByOffer.keys()]);
  const sorted = Array.from(allIds).sort((a, b) =>
    (offerName.get(a) ?? a).toLowerCase().localeCompare((offerName.get(b) ?? b).toLowerCase())
  );

  let TOT = { raw: 0, eligible: 0, eligible_pay: 0, rollup: 0, rollup_pay: 0 };
  for (const id of sorted) {
    const b = byOffer.get(id);
    const r = rollupByOffer.get(id);
    const eligible = b?.eligible ?? 0;
    const eligiblePay = b?.eligible_payout ?? 0;
    const rollC = r?.conv ?? 0;
    const rollR = r?.rev  ?? 0;
    TOT.raw += b?.raw ?? 0;
    TOT.eligible += eligible; TOT.eligible_pay += eligiblePay;
    TOT.rollup += rollC; TOT.rollup_pay += rollR;
    const dC = rollC - eligible;
    const dR = rollR - eligiblePay;
    const name = (offerName.get(id) ?? id).slice(0, 34);
    console.log(
      pad(name, 35) +
      rpad(b?.raw ?? 0, 6) +
      rpad(eligible, 11) +
      rpad(rollC, 9) +
      pad((dC > 0 ? '+' : '') + dC, 6) +
      pad(fmtMoney(eligiblePay), 11) +
      pad(fmtMoney(rollR), 11) +
      pad((dR >= 0 ? '+' : '') + fmtMoney(dR), 11) +
      rpad(b?.verified ?? 0, 9) +
      rpad(b?.shadow ?? 0, 7) +
      rpad(b?.dupesByClick ?? 0, 6)
    );
  }
  console.log('─'.repeat(135));
  console.log(
    pad('TOTAL', 35) +
    rpad(TOT.raw, 6) +
    rpad(TOT.eligible, 11) +
    rpad(TOT.rollup, 9) +
    pad((TOT.rollup - TOT.eligible > 0 ? '+' : '') + (TOT.rollup - TOT.eligible), 6) +
    pad(fmtMoney(TOT.eligible_pay), 11) +
    pad(fmtMoney(TOT.rollup_pay), 11) +
    pad((TOT.rollup_pay - TOT.eligible_pay >= 0 ? '+' : '') + fmtMoney(TOT.rollup_pay - TOT.eligible_pay), 11)
  );

  // ── Dell drill-down ────────────────────────────────────────────────────
  console.log('\n\n▌Dell drill-down (every Dell admedia conversion bucketed to ' + TARGET + ')');
  let dellCount = 0;
  for (const d of convSnap.docs) {
    const x = d.data() as Record<string, any>;
    const offer_id = String(x.offer_id ?? '');
    if (!offer_id.toLowerCase().includes('dell')) continue;
    const created = (x.created_at?.toDate?.() as Date) ?? new Date(x.created_at);
    const evt = eventDate(created, x.network_timestamp);
    if (dayKeyUTC(evt) !== TARGET) continue;
    dellCount++;
    if (dellCount <= 100) {
      console.log(
        `  ${dellCount.toString().padStart(2,' ')}  conv=${(d.id).slice(0, 8)}…  net_ts=${(x.network_timestamp ?? '∅').padEnd(20)}  created=${created.toISOString()}  payout=${fmtMoney(+(x.payout ?? 0))}  status=${x.status}  verified=${x.verified}  shadow=${x.shadow}  cid=${(x.click_id ?? '').slice(0, 12)}…  ext=${(x.external_id ?? '').slice(0, 12)}`
      );
    }
  }
  console.log(`  → ${dellCount} Dell admedia conversion(s) bucketed to ${TARGET}`);

  // ── Per-offer status breakdown for AdMedia day ────────────────────────
  console.log('\n▌Per-offer status breakdown (AdMedia, ' + TARGET + ')');
  for (const id of sorted) {
    const b = byOffer.get(id);
    if (!b || b.raw === 0) continue;
    const name = offerName.get(id) ?? id;
    console.log(`  ${name}:  raw=${b.raw}  verified=${b.verified}  shadow=${b.shadow}  eligible=${b.eligible} (${fmtMoney(b.eligible_payout)})  statuses=${Object.entries(b.statuses).map(([k,v]) => `${k}=${v}`).join(' ')}  dupes_by_click=${b.dupesByClick}`);
  }

  // ── Confirm the dashboard reads the rollup ─────────────────────────────
  console.log('\n▌Sanity: aggregate the raw inserted vs SUM in runs');
  console.log(`  affiliate_api_runs.records_inserted (sum on ${TARGET}): ${SUM.inserted}`);
  console.log(`  Total admedia conv docs found in DB this day-window:   ${convSnap.size}`);
  console.log(`  Total admedia conv eligibly bucketed to ${TARGET}:     ${TOT.eligible}`);

  console.log('\n=== DONE ===\n');
}
main().catch(e => { console.error(e); process.exit(1); });
