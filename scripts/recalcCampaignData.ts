// Recalculates aggregated reports (campaign_reports + offer_reports) from
// raw clicks + conversions, then re-syncs Google Ads so spend is stored in
// INR (with gads_clicks / gads_impressions / gads_ctr / gads_avg_cpc / gads_cost
// populated) for the chosen window.
//
// Use this after the USD → INR switch, or any time the rollups are
// suspected of drifting from source data.
//
// What this script does NOT touch:
//   - Operator-entered ad spend on utm_campaign rows. We can't reliably know
//     what currency a manual "100" was, so historical operator entries are
//     left alone. Use the campaign detail page to fix them by hand.
//   - The `clicks` counter on campaign_reports / offer_reports. Click counters
//     are only ever incremented from the /click redirect path — never
//     reconstructed from a backfill (would double-count after the 90-day TTL).
//
// Idempotent — safe to re-run.

import { parseArgs } from 'node:util';
import { initFirestore } from '../src/firestore';
import { offerReportsBackfillService } from '../src/services/offerReportsBackfillService';
import { campaignReportsBackfillService } from '../src/services/campaignReportsBackfillService';
import { googleAdsCampaignSyncService } from '../src/services/googleAdsCampaignSyncService';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
  }
  return d;
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'skip-gads': { type: 'boolean', default: false },
      'skip-offers': { type: 'boolean', default: false },
      'skip-campaigns': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
Usage: npm run recalc -- [options]

Options:
  --days N             Recalculate the last N days (default: 120).
  --from YYYY-MM-DD    Start of window (overrides --days).
  --to YYYY-MM-DD      End of window (default: today).
  --skip-offers        Skip the offer_reports rebuild.
  --skip-campaigns     Skip the campaign_reports rebuild.
  --skip-gads          Skip the Google Ads sync (use if no GAds connection).
  -h, --help           Show this help.

Examples:
  npm run recalc                     # Last 120 days, everything
  npm run recalc -- --days 30        # Last 30 days
  npm run recalc -- --from 2026-01-01 --to 2026-04-30
  npm run recalc -- --skip-gads      # Skip Google Ads sync only
`);
    return;
  }

  // Resolve the window. Defaults are aligned with the in-app backfill button
  // (120 days). When --from is supplied, --days is ignored.
  const days = values.days ? Number(values.days) : 120;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid --days: ${values.days}`);
  }
  const explicitFrom = parseDateArg(values.from);
  const explicitTo = parseDateArg(values.to);

  const to = explicitTo ?? new Date();
  const from = explicitFrom ?? new Date(to.getTime() - days * DAY_MS);
  if (from.getTime() > to.getTime()) {
    throw new Error(`--from (${from.toISOString()}) is after --to (${to.toISOString()})`);
  }

  console.log('Initializing Firestore…');
  initFirestore();

  console.log('');
  console.log('============================================================');
  console.log('Recalculating reports from raw clicks + conversions');
  console.log('============================================================');
  console.log(`Window: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  console.log(`Steps: ${[
    !values['skip-offers'] && 'offer_reports',
    !values['skip-campaigns'] && 'campaign_reports',
    !values['skip-gads'] && 'google_ads_sync',
  ].filter(Boolean).join(', ') || '(nothing — all steps skipped)'}`);
  console.log('');

  const startedAt = Date.now();

  // 1. offer_reports — rebuilds conversion-side fields (postbacks,
  // conversions, revenue, status counters) from source conversions. Click
  // counts are left untouched.
  if (!values['skip-offers']) {
    console.log('── [1/3] Rebuilding offer_reports…');
    const t0 = Date.now();
    try {
      const result = await offerReportsBackfillService.rebuild({ from, to });
      console.log(`   ✓ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`     - conversions_scanned : ${result.conversions_scanned.toLocaleString()}`);
      console.log(`     - buckets_written     : ${result.buckets_written.toLocaleString()}`);
      if (result.truncated) {
        console.warn(`   ! Truncated: ${result.truncated_reason}`);
      }
    } catch (err) {
      console.error('   ✗ offer_reports rebuild failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
    console.log('');
  }

  // 2. campaign_reports — same idea for the per-campaign rollup. Preserves
  // operator-entered spend, campaign_name, and all gads_* fields (which
  // come from the Google Ads sync below).
  if (!values['skip-campaigns']) {
    console.log('── [2/3] Rebuilding campaign_reports…');
    const t0 = Date.now();
    try {
      const result = await campaignReportsBackfillService.rebuild({ from, to });
      console.log(`   ✓ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`     - conversions_scanned       : ${result.conversions_scanned.toLocaleString()}`);
      console.log(`     - conversions_with_campaign : ${result.conversions_with_campaign.toLocaleString()}`);
      console.log(`     - clicks_scanned_for_meta   : ${result.click_metadata_scanned.toLocaleString()}`);
      console.log(`     - buckets_written           : ${result.buckets_written.toLocaleString()}`);
      if (result.truncated) {
        console.warn(`   ! Truncated: ${result.truncated_reason}`);
      }
      if (result.campaign_spends && result.campaign_spends.length > 0) {
        console.log(`     - campaigns_with_spend      : ${result.campaign_spends.length}`);
      }
    } catch (err) {
      console.error('   ✗ campaign_reports rebuild failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
    console.log('');
  }

  // 3. Google Ads sync — pulls per-campaign-per-day cost + clicks + impressions
  // + average_cpc + ctr from every connected Google Ads account, converts
  // monetary fields to INR via fxRates.toInr, and overwrites spend +
  // gads_* fields on the matching campaign_reports docs. After this step,
  // campaign spend is canonical INR.
  if (!values['skip-gads']) {
    console.log('── [3/3] Syncing Google Ads (spend → INR + GADS metrics)…');
    const t0 = Date.now();
    try {
      const result = await googleAdsCampaignSyncService.syncCampaigns({ from, to });
      console.log(`   ✓ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`     - campaigns_updated  : ${result.campaigns_updated.toLocaleString()}`);
      console.log(`     - total_spend (INR)  : ₹${result.total_spend_inr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
      console.log(`     - total_clicks       : ${result.total_clicks.toLocaleString()}`);
      console.log(`     - total_impressions  : ${result.total_impressions.toLocaleString()}`);
    } catch (err) {
      console.error('   ✗ Google Ads sync failed:', err instanceof Error ? err.message : err);
      console.error('     (campaign spend will keep its previous values)');
      process.exitCode = 1;
    }
    console.log('');
  }

  console.log('============================================================');
  console.log(`All done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  console.log('============================================================');
}

main().catch((err) => {
  console.error('Recalc failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
