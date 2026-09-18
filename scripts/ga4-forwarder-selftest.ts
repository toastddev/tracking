// Local self-test for ga4ForwardingService - no network, no Firestore.
// Verifies GA4 uploads follow the Google Ads upload rules
// (googleAdsForwardingService): same eligibility, same dedupe key, same
// conversion time, same audit rows (sent / failed / skipped + reason), same
// click behaviour and batch stats.
//   npx tsx scripts/ga4-forwarder-selftest.ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.GA4_API_SECRETS = 'G-ENVONLY1:env-secret';
delete process.env.GA4_UPLOAD_CURRENCY;
process.env.GOOGLE_ADS_TOKEN_ENC_KEY = randomBytes(32).toString('base64');

const { ga4UploadRepository, ga4StreamRepository, ga4SettingsRepository } = await import('../src/firestore');
const { ga4ForwardingService } = await import('../src/services/ga4ForwardingService');
const { adjustEventDateForGads } = await import('../src/services/googleAdsForwardingService');
const { encryptSecret } = await import('../src/utils/crypto');
const { resolveUploadMoney } = await import('../src/utils/fxRates');
import type { ClickRecord, ConversionRecord } from '../src/types';

// ── stubs ──
let audit: Array<Record<string, any>> = [];
Object.assign(ga4UploadRepository, { async record(u: Record<string, unknown>) { audit.push(u); return u; } });
const streams: Record<string, Record<string, unknown>> = {
  'G-4SWZDJ0XKY': { measurement_id: 'G-4SWZDJ0XKY', connection_id: 'conn-1', enabled: true, currency_code: 'INR', sale_event_name: 'purchase', api_secret_enc: encryptSecret('linked-secret') },
  'G-CLICKS001': { measurement_id: 'G-CLICKS001', connection_id: 'conn-1', enabled: true, currency_code: 'USD', sale_event_name: 'affiliate_sale', click_event_name: 'tracker_click', api_secret_enc: encryptSecret('click-secret') },
  'G-PAUSED001': { measurement_id: 'G-PAUSED001', connection_id: 'conn-1', enabled: false, api_secret_enc: encryptSecret('x') },
};
Object.assign(ga4StreamRepository, { async get(mid: string) { return streams[mid] ?? null; } });

let calls: Array<{ url: string; body: any }> = [];
let httpStatus = 204;
globalThis.fetch = (async (url: string, init: { body: string }) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return new Response(null, { status: httpStatus });
}) as typeof fetch;

const click = (extra: Record<string, string>, ad_ids: Record<string, string> = {}): ClickRecord => ({
  click_id: 'click-1', offer_id: 'offer-x', aff_id: 'aff-1', sub_params: {}, ad_ids,
  extra_params: extra, redirect_url: 'https://x', created_at: new Date().toISOString(),
});
const gaClick = click({ ga_cid: '123456789.1726549200', ga_sid: '1726549999', ga_mid: 'G-4SWZDJ0XKY' });
let n = 0;
const conv = (over: Partial<ConversionRecord> = {}): ConversionRecord => ({
  conversion_id: `conv-${++n}`, network_id: 'net', click_id: 'click-1', offer_id: 'offer-x',
  payout: 10, currency: 'USD', status: 'approved', raw_payload: {}, method: 'GET',
  verified: true, verification_reason: 'click_found', created_at: new Date().toISOString(), ...over,
});
const reset = () => { calls = []; audit = []; };
const dispatch = (c: ConversionRecord, k: ClickRecord | null = gaClick, tz?: string) =>
  ga4ForwardingService.dispatchConversion({ conversion: c, click: k, postback_timezone: tz });

// 1. Verified conversion with GA ids → purchase; transaction_id = conversion_id (≈ order_id);
//    value converted to the property currency; audit row 'sent'.
reset();
let c = conv();
await dispatch(c);
assert.equal(calls.length, 1);
let ev = calls[0]!.body.events[0];
assert.match(calls[0]!.url, /measurement_id=G-4SWZDJ0XKY&api_secret=linked-secret$/);
assert.equal(ev.name, 'purchase');
assert.equal(ev.params.transaction_id, c.conversion_id);
assert.equal(ev.params.session_id, 1726549999);
assert.equal(ev.params.currency, 'INR');
const inr = resolveUploadMoney(10, 'USD', 'INR');
assert.equal(ev.params.value, inr.value);
assert.equal(audit.length, 1);
assert.equal(audit[0]!.status, 'sent');
assert.equal(audit[0]!.kind, 'conversion');
assert.equal(audit[0]!.transaction_id, c.conversion_id);
assert.equal(audit[0]!.identifier_value, '123456789.1726549200');
console.log('✓ conversion → purchase, transaction_id = conversion_id, property currency, audit "sent"');

// 2. No status rules (like Google Ads): pending / rejected / unknown / missing all upload.
reset();
for (const status of ['pending', 'OPEN', 'rejected', 'REJECTED', '{commission_state}', undefined]) {
  await dispatch(conv({ status }));
}
assert.equal(calls.length, 6);
assert.ok(calls.every((x) => x.body.events[0].name === 'purchase'));
console.log('✓ every verified conversion uploads regardless of status (same as Google Ads)');

// 3. Repeat postbacks are separate conversion_ids → separate transactions (same as order_id).
reset();
await dispatch(conv({ txn_id: 'T-1' }));
await dispatch(conv({ txn_id: 'T-1' }));
assert.equal(calls.length, 2);
assert.notEqual(calls[0]!.body.events[0].params.transaction_id, calls[1]!.body.events[0].params.transaction_id);
console.log('✓ dedupe key is conversion_id only (txn_id not used, same as Google Ads)');

// 4. Conversion time = adjustEventDateForGads() for every timestamp shape.
const recent = new Date(Date.now() - 2 * 3_600_000);
const wall = `${recent.toISOString().slice(0, 10)} ${recent.toISOString().slice(11, 19)}`;
for (const [network_timestamp, tz] of [
  [undefined, undefined],
  [String(recent.getTime()), undefined],
  [recent.toISOString(), undefined],
  [wall, 'UTC'],
  ['{commission_date}', 'America/New_York'],
] as Array<[string | undefined, string | undefined]>) {
  reset();
  const cc = conv({ network_timestamp });
  await dispatch(cc, gaClick, tz);
  const expected = adjustEventDateForGads(cc, tz).getTime();
  const age = Date.now() - expected;
  if (age >= 0 && age <= 71 * 3_600_000) {
    assert.equal(calls[0]!.body.timestamp_micros, expected * 1000, `time for ${network_timestamp}`);
  } else {
    assert.equal(calls[0]!.body.timestamp_micros, undefined);
  }
}
console.log('✓ conversion time identical to Google Ads (adjustEventDateForGads)');

// 5. GA4-only limit: older than 72h → sent without timestamp, still audited 'sent'.
reset();
await dispatch(conv({ created_at: new Date(Date.now() - 5 * 86_400_000).toISOString() }));
assert.equal(calls[0]!.body.timestamp_micros, undefined);
assert.equal(audit[0]!.status, 'sent');
assert.equal(audit[0]!.event_time, undefined);
console.log('✓ >72h conversion sent without timestamp (GA4 limit)');

// 6. Skip rows with the Google Ads reasons.
reset();
await dispatch(conv({ verified: false }));
await dispatch(conv(), null);
await dispatch(conv(), click({}, { gclid: 'G' }));
await dispatch(conv(), click({ ga_cid: '1.2', ga_mid: 'G-PAUSED001' }));
await dispatch(conv(), click({ ga_cid: '1.2', ga_mid: 'G-UNLINKED1' }));
assert.equal(calls.length, 0);
assert.deepEqual(audit.map((a) => [a.status, a.skip_reason]), [
  ['skipped', 'unverified_or_no_click'],
  ['skipped', 'unverified_or_no_click'],
  ['skipped', 'no_click_identifier'],
  ['skipped', 'connection_not_active'],
  ['skipped', 'no_destination_configured'],
]);
console.log('✓ skips audited with Google Ads reasons');

// 7. Env fallback destination; missing ga_sid still uploads; property currency absent → USD.
reset();
await dispatch(conv(), click({ ga_cid: '1.2', ga_mid: 'G-ENVONLY1' }));
assert.match(calls[0]!.url, /api_secret=env-secret$/);
assert.equal(calls[0]!.body.events[0].params.session_id, undefined);
assert.equal(calls[0]!.body.events[0].params.currency, 'USD');
console.log('✓ env fallback secret, no session id, USD default');

// 8. HTTP failure → audit 'failed' with error (retry endpoint re-dispatches).
reset();
httpStatus = 500;
await dispatch(conv());
httpStatus = 204;
assert.equal(audit[0]!.status, 'failed');
assert.match(audit[0]!.last_error, /HTTP 500/);
console.log('✓ failure audited as "failed"');

// 9. Outbound clicks: only when the stream has a click event (≈ click conversion action).
reset();
await ga4ForwardingService.dispatchClick({ click: gaClick });
assert.equal(calls.length, 0);
assert.equal(audit.length, 0);
const clickWithEvent = click({ ga_cid: '5.6', ga_sid: '77', ga_mid: 'G-CLICKS001' });
await ga4ForwardingService.dispatchClick({ click: clickWithEvent });
assert.equal(calls.length, 1);
assert.equal(calls[0]!.body.events[0].name, 'tracker_click');
assert.equal(calls[0]!.body.events[0].params.offer_id, 'offer-x');
assert.equal(audit[0]!.kind, 'click');
assert.equal(audit[0]!.source_id, 'click-1');
assert.equal(audit[0]!.value, 0);
await ga4ForwardingService.dispatchClick({ click: click({}) });
assert.equal(calls.length, 1);
console.log('✓ clicks uploaded only with a click event configured; non-GA clicks ignored silently');

// 10. Per-stream sale event name.
reset();
await dispatch(conv(), clickWithEvent);
assert.equal(calls[0]!.body.events[0].name, 'affiliate_sale');
assert.equal(calls[0]!.body.events[0].params.currency, 'USD');
console.log('✓ per-stream sale event name + currency');

// 11. Batch stats (same shape as Google Ads): ineligible → skipped (no audit rows).
reset();
const batch = await ga4ForwardingService.dispatchConversionsBatch([
  { conversion: conv(), click: gaClick },
  { conversion: conv(), click: clickWithEvent },
  { conversion: conv({ verified: false }), click: gaClick },
  { conversion: conv(), click: click({}) },
  { conversion: conv(), click: click({ ga_cid: '1.2', ga_mid: 'G-UNLINKED1' }) },
]);
assert.deepEqual(batch, { sent: 2, skipped: 3, failed: 0, errors: [] });
assert.equal(audit.length, 2);
console.log('✓ batch', batch);

// 12. Audit toggle off → still uploads, writes nothing to ga4_uploads.
reset();
let auditOn = false;
Object.assign(ga4SettingsRepository, { async auditEnabled() { return auditOn; } });
await dispatch(conv());
await dispatch(conv(), click({}));
assert.equal(calls.length, 1, 'still uploaded with audit off');
assert.equal(audit.length, 0, 'no audit rows written with audit off');
auditOn = true;
reset();
await dispatch(conv());
assert.equal(audit.length, 1, 'audit rows return when toggled back on');
console.log('✓ audit toggle off = uploads unchanged, no ga4_uploads rows');

console.log('\nAll GA4 forwarder checks passed.');
